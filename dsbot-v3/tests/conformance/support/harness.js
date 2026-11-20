/**
 * Conformance harness.
 *
 * Everything that touches the task ledger goes through the merged runtime
 * composition root (`createRuntime`) and, where the rule is about the public
 * contract, the real loopback API. There is no second state machine and no
 * copied implementation here: the helpers below only create deterministic
 * inputs and drive the same facade the CLI and API use.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { createRuntime } from '../../../packages/runtime/src/index.js';

export const EXECUTION_ITEMS = Object.freeze([
  { key: 'auto.contract', class: 'auto', required: true },
  { key: 'independent.review', class: 'independent', required: true },
]);

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.auto_v1',
  version: 1,
  items: [...EXECUTION_ITEMS],
});

export const BUSINESS_PROFILE = Object.freeze({
  id: 'business.product_v1',
  version: 1,
  items: [{ key: 'auto.children_gate', class: 'auto', required: true }],
});

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.objective_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

export const TEST_USAGE = Object.freeze({
  tokens_in: 100,
  tokens_out: 50,
  tokens_cached: 10,
  cost_cny: 0.05,
});

/** Deterministic, manually advanced clock (no timers, no sleeps). */
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

/** Deterministic ids so a failure reads the same on every run. */
export function createIds(start = 0) {
  let counter = start;
  return {
    next: (prefix) => `${prefix}-${++counter}`,
  };
}

/** A mock executor; `cancelVerification: 'unverified'` exercises stop_unknown. */
export function createExecutor({
  clock = createClock(0),
  completeAt = 100,
  cancelVerification = 'verified',
  usage = TEST_USAGE,
} = {}) {
  const adapter = createMockAdapter({
    now: clock.now,
    cancelVerification,
    usage,
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: completeAt,
        type: 'complete',
        summary: 'mock completed',
        artifacts: [{ path: 'article.md', content: '# draft' }],
      },
    ],
  });
  return { adapter, clock };
}

/**
 * Open a runtime over an in-memory SQLite ledger with the mock adapter and
 * close it after the test. Callers may pass a workspace (stop verification).
 */
export function openRuntime(t, { adapter, workspacePath = null, quiescenceMs } = {}) {
  const clock = createClock();
  const ids = createIds();
  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: adapter ? { mock: adapter } : {},
    clock: clock.now,
    idFactory: ids.next,
    workspacePath,
    ...(quiescenceMs === undefined ? {} : { quiescenceMs }),
  });
  t.after(() => runtime.close());
  return { runtime, clock, ids };
}

/** Create the goal→business→execution chain through the runtime facade. */
export function createTree(runtime, { title = '写一篇关于 AI 的文章' } = {}) {
  const goal = runtime.tasks.create({
    level: 'goal',
    title,
    acceptanceProfile: GOAL_PROFILE,
  });
  const business = runtime.tasks.delegate({
    parentTaskId: goal.id,
    title: '内容 BOT：拆解并交付稿件',
    acceptanceProfile: BUSINESS_PROFILE,
  });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: '写稿 + 自检',
    acceptanceProfile: EXECUTION_PROFILE,
  });
  return { goal, business, execution };
}

/** Dispatch, hand to the mock executor and ack so a claim becomes legal. */
export async function startRun(runtime, executionId) {
  const dispatched = runtime.tasks.dispatch({ taskId: executionId, executorKind: 'mock' });
  const accepted = await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  if (accepted.accepted !== true) {
    throw new Error(`mock executor did not accept run ${dispatched.run.id}: ${accepted.reason}`);
  }
  const acked = runtime.runs.ack({ runId: dispatched.run.id });
  return { run: acked.run, task: acked.task };
}

/** A structurally valid execution claim; the author's self-report only. */
export function claimFor(runId, nonce) {
  return {
    commit: createHash('sha256').update(`${runId}:${nonce}`).digest('hex').slice(0, 40),
    dirty: false,
    manifest: [
      { path: 'article.md', sha256: createHash('sha256').update('draft').digest('hex') },
    ],
    nonce,
    summary: 'delivered',
  };
}

export async function reportClaim(runtime, runId, nonce) {
  return runtime.runs.claim({ runId, claim: claimFor(runId, nonce) });
}

/** Pass every required item of one acceptance round. */
export function passAll(runtime, acceptance) {
  const itemStates = {};
  for (const item of acceptance.items) itemStates[item.key] = 'pass';
  return runtime.acceptances.decide({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates,
  });
}

/** A throwaway workspace for the stop-verification rules. */
export function createWorkspace(t, { name = 'article.md', content = '# sealed draft\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-conformance-'));
  if (name !== null) writeFileSync(join(root, name), content, 'utf8');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export async function startApi(t, runtime) {
  const url = await runtime.api.start();
  t.after(() => runtime.api.close());
  return url;
}
