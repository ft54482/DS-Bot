/**
 * Shared setup for the L15 cross-package contracts.
 *
 * This module is glue only. Every state decision, HTTP route, executor lookup
 * and cost aggregation comes from the merged packages through the L9 runtime
 * composition root (`createRuntime`); nothing here re-implements a guard or a
 * projection. Each contract gets its own temporary directory and real SQLite
 * file, so persistence and the API/CLI read paths are exercised for real.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { createRuntime } from '../../../packages/runtime/src/index.js';
// Reuse the merged L5 e2e fixture vocabulary instead of defining a second one.
import { EXECUTION_ITEMS } from '../../e2e/support/harness.js';
import { requestJson } from './contract.js';

export { EXECUTION_ITEMS };

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.auto_v1',
  version: 1,
  items: [...EXECUTION_ITEMS],
});

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.objective_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

const CONTRACT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(CONTRACT_DIR, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'bin', 'cli.js');

/** Deterministic, manually advanced clock (no sleeps, no wall-clock races). */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

export function createIds(start = 0) {
  let counter = start;
  return { next: (prefix) => `${prefix}-${++counter}` };
}

/**
 * A mock executor with one scripted completion and an explicit usage record.
 * `cancelVerification: 'unverified'` is the adapter-side proof that a cancel
 * could not be verified.
 */
export function createExecutor({
  usage,
  cancelVerification = 'verified',
  completeAt = 100,
  artifact = '# draft v1',
} = {}) {
  const clock = createClock(0);
  const adapter = createMockAdapter({
    now: clock.now,
    usage,
    cancelVerification,
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: completeAt,
        type: 'complete',
        summary: 'contract fixture completed',
        artifacts: [{ path: 'article.md', content: artifact }],
      },
    ],
  });
  return { adapter, clock };
}

/**
 * Register the same mock executor under a different production executor kind.
 * The mock adapter reports `kind: 'mock'`; the runtime registry requires the
 * registration name to match that field, so tests may relabel the copy.
 */
export function relabel(adapter, kind) {
  return { ...adapter, kind };
}

/**
 * Create a runtime over a fresh temp-directory SQLite file and register
 * cleanup. Returns the runtime, its db path and a lazily started loopback API.
 */
export function createContractRuntime(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-contract-'));
  const dbPath = join(dir, 'contract.sqlite');
  const runtime = createRuntime({ dbPath, ...options });

  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let startedUrl = null;
  return {
    runtime,
    dbPath,
    dir,
    async apiUrl() {
      if (startedUrl === null) startedUrl = await runtime.api.start();
      return startedUrl;
    },
  };
}

/** Create the goal → business → execution tree through the runtime facade. */
export function createTree(runtime, { title = '写一篇关于 AI 的文章' } = {}) {
  const goal = runtime.tasks.create({ level: 'goal', title, acceptanceProfile: GOAL_PROFILE });
  const business = runtime.tasks.delegate({
    parentTaskId: goal.id,
    title: '内容 BOT：拆解并交付稿件',
  });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: '写稿 + 自检',
    acceptanceProfile: EXECUTION_PROFILE,
  });
  return { goal, business, execution };
}

/** A structurally valid execution claim (40-hex commit, 64-hex manifest hash). */
export function makeClaim({ nonce, summary = 'contract fixture delivered' } = {}) {
  if (!nonce) throw new TypeError('makeClaim requires a nonce');
  return {
    commit: createHash('sha256').update(`contract:${nonce}`).digest('hex').slice(0, 40),
    dirty: false,
    manifest: [
      {
        path: 'article.md',
        sha256: createHash('sha256').update(`artifact:${nonce}`).digest('hex'),
      },
    ],
    nonce,
    summary,
  };
}

/** Run an execution task through dispatch → executor ack. */
export async function startRun(runtime, execution, { executorKind = 'mock' } = {}) {
  const dispatched = runtime.tasks.dispatch({ taskId: execution.id, executorKind });
  const accepted = await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  if (accepted.accepted !== true) {
    throw new Error(
      `contract fixture could not dispatch run ${dispatched.run.id}: ${JSON.stringify(accepted)}`,
    );
  }
  const acked = runtime.runs.ack({ runId: dispatched.run.id });
  return { run: acked.run, task: acked.task };
}

export async function fetchTask(url, taskId) {
  return requestJson(url, `/v1/tasks/${encodeURIComponent(taskId)}`);
}

export async function fetchRun(url, runId) {
  return requestJson(url, `/v1/runs/${encodeURIComponent(runId)}`);
}

export async function fetchAcceptance(url, acceptanceId) {
  return requestJson(url, `/v1/acceptances/${encodeURIComponent(acceptanceId)}`);
}

/**
 * Invoke the operator CLI as a real child process over the same temp SQLite
 * file. This is what makes the CLI/API cost contract a cross-process check
 * rather than a second call to the same object graph.
 */
export function runCliCost(dbPath, taskId) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'cost', taskId, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SUPERAGENT_DB_PATH: dbPath },
    timeout: 60_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
