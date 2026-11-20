/**
 * Shared helpers for the L5 e2e acceptance.
 *
 * Everything here is glue, not a second implementation:
 *  - the task/run/acceptance state machine comes from
 *    `packages/service/src/index.js`;
 *  - the executor comes from `packages/adapters/src/mock.js`;
 *  - persistence for the restart step is the journaled store fixture.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { createTaskService } from '../../../packages/service/src/index.js';

export const EXECUTION_ITEMS = Object.freeze([
  { key: 'auto.contract', class: 'auto', required: true },
  { key: 'independent.review', class: 'independent', required: true },
]);

export const DEFAULT_GOAL_TITLE = '写一篇关于 AI 的文章';

export function createGoal(service, { title = DEFAULT_GOAL_TITLE } = {}) {
  return service.createTask({
    level: 'goal',
    title,
    owner: { role: 'chief', id: 'chief-1' },
    acceptanceProfile: {
      id: 'goal.objective_v1',
      version: 1,
      items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
    },
  });
}

export function createBusiness(service, goal, { title = '内容 BOT：拆解并交付稿件' } = {}) {
  return service.createTask({
    level: 'business',
    parentTaskId: goal.id,
    title,
    owner: { role: 'bot', id: 'content-bot' },
  });
}

export function createExecution(service, business, { title = '写稿 + 自检' } = {}) {
  return service.createTask({
    level: 'execution',
    parentTaskId: business.id,
    title,
    acceptanceProfile: { id: 'execution.auto_v1', version: 1, items: [...EXECUTION_ITEMS] },
  });
}

/** Deterministic, manually advanced clock (no sleeps anywhere in the suite). */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
      return current;
    },
  };
}

/** Deterministic ids; the same factory survives the simulated restart. */
export function createIds(start = 0) {
  let counter = start;
  return {
    next: (prefix) => `${prefix}-${++counter}`,
    count: () => counter,
  };
}

export function createService(store, clock, ids) {
  return createTaskService({
    store,
    clock: clock.now,
    idFactory: ids.next,
  });
}

/**
 * A mock executor with one scripted completion and an explicit usage record.
 * `completeAt` is in executor-clock milliseconds; tests advance the executor
 * clock instead of sleeping.
 */
export function createExecutor({
  usage,
  artifact = '# draft',
  summary = 'mock completed',
  completeAt = 100,
  cancelVerification = 'verified',
} = {}) {
  const clock = createClock(0);
  const adapter = createMockAdapter({
    now: clock.now,
    cancelVerification,
    usage,
    script: [
      { at: 0, type: 'progress', message: 'started' },
      { at: completeAt, type: 'complete', summary, artifacts: [{ path: 'article.md', content: artifact }] },
    ],
  });
  return { adapter, clock };
}

export function dispatchEnvelope(run, { goal = '写一篇关于 AI 的文章', workspace = '/tmp/closed-loop' } = {}) {
  return {
    run: { id: run.id, executor_kind: 'mock' },
    taskPack: {
      goal,
      constraints: ['本地执行', '不发布'],
      acceptance: ['auto.contract', 'independent.review'],
      context_refs: [],
    },
    workspace: { path: workspace, repo: 'ft54482/superagent-lab-smoke' },
    budget: { cny_cap: 5 },
    tracking: { status: true, follow: true },
  };
}

export async function dispatchToMock({ adapter, run, goal, workspace } = {}) {
  return adapter.dispatch(dispatchEnvelope(run, { goal, workspace }));
}

/**
 * Build a claim from what the executor actually produced: the manifest hashes
 * come from `collectArtifacts`, not from a hard-coded list.
 */
export async function claimFromExecutor(adapter, run, { nonce, summary = 'delivered' } = {}) {
  if (!nonce) throw new TypeError('claimFromExecutor requires a nonce');
  const artifacts = await adapter.collectArtifacts({ run_id: run.id });
  const manifest = artifacts.items.map((artifact) => ({
    path: artifact.path,
    sha256: artifact.sha256,
  }));
  return {
    commit: createHash('sha256').update(`${run.id}:${nonce}`).digest('hex').slice(0, 40),
    dirty: false,
    manifest,
    nonce,
    summary,
  };
}

export function passedItemStates(acceptance) {
  return Object.fromEntries(acceptance.items.map((item) => [item.key, 'pass']));
}

export function sumUsage(usages) {
  const total = usages.reduce(
    (accumulator, usage) => ({
      tokens_in: accumulator.tokens_in + usage.tokens_in,
      tokens_out: accumulator.tokens_out + usage.tokens_out,
      tokens_cached: accumulator.tokens_cached + usage.tokens_cached,
      cost_cny: accumulator.cost_cny + usage.cost_cny,
    }),
    { tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_cny: 0 },
  );
  return { ...total, cost_cny: Number(total.cost_cny.toFixed(6)) };
}

/** One consistently computed hash for a small workspace tree. */
export function hashTree(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const path = relative(root, full).replaceAll('\\', '/');
        entries.push(`${path}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
