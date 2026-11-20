import { createHash } from 'node:crypto';

import { createMockAdapter } from '../../../adapters/src/mock.js';
import { createRuntime } from '../../src/index.js';

export const EXECUTION_ITEMS = Object.freeze([
  { key: 'auto.contract', class: 'auto', required: true },
  { key: 'independent.review', class: 'independent', required: true },
]);

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.objective_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.auto_v1',
  version: 1,
  items: [...EXECUTION_ITEMS],
});

export const TEST_USAGE = Object.freeze({
  tokens_in: 1200,
  tokens_out: 800,
  tokens_cached: 200,
  cost_cny: 0.12,
});

/** Deterministic manually advanced clock (no timers, no sleeps). */
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

/** Deterministic ids. */
export function createIds(start = 0) {
  let counter = start;
  return {
    next: (prefix) => `${prefix}-${++counter}`,
    count: () => counter,
  };
}

/**
 * A mock executor with one scripted completion and an explicit usage record.
 * `completeAt` is executor-clock milliseconds; callers advance the clock.
 */
export function createExecutor({
  clock,
  usage = TEST_USAGE,
  artifact = '# draft v1',
  summary = 'draft ready',
  completeAt = 100,
  cancelVerification = 'verified',
  script = null,
} = {}) {
  const adapterClock = clock ?? createClock(0);
  const adapter = createMockAdapter({
    now: adapterClock.now,
    cancelVerification,
    usage,
    script:
      script ??
      [
        { at: 0, type: 'progress', message: 'started' },
        {
          at: completeAt,
          type: 'complete',
          summary,
          artifacts: [{ path: 'article.md', content: artifact }],
        },
      ],
  });
  return { adapter, clock: adapterClock };
}

/** Build a claim from what the executor actually produced. */
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
  });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: '写稿 + 自检',
    acceptanceProfile: EXECUTION_PROFILE,
  });
  return { goal, business, execution };
}

/**
 * One independent runtime for one test: in-memory store, deterministic clock and
 * ids, and one mock executor registered as `mock`.
 */
export function openRuntime(
  t,
  {
    adapterOptions = {},
    runtime: overrides = {},
    adapters = null,
    adapter = null,
    clock = createClock(),
    ids = createIds(),
  } = {},
) {
  const executor = adapter ?? createExecutor({ clock, ...adapterOptions }).adapter;
  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: adapters ?? { mock: executor },
    clock: clock.now,
    idFactory: ids.next,
    ...overrides,
  });
  t.after(() => runtime.close());
  return { runtime, clock, ids, adapter: executor };
}

/**
 * Build the task tree, dispatch its execution task, let the mock executor
 * accept it and ack it, so the run is `running`.
 */
export async function openRun(t, options = {}) {
  const context = openRuntime(t, options);
  const tree = options.tree ?? createTree(context.runtime);
  const dispatched = context.runtime.tasks.dispatch({
    taskId: tree.execution.id,
    executorKind: options.executorKind ?? 'mock',
  });
  const accepted = await context.runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  const acked = context.runtime.runs.ack({ runId: dispatched.run.id });
  return { ...context, tree, dispatched, run: dispatched.run, accepted, acked };
}

/**
 * Drive one execution task to the acceptance boundary: dispatched, running,
 * reported claim and an open acceptance. This is the shared precondition for
 * claim, completion, rework and cost tests.
 */
export async function openAcceptingRun(t, options = {}) {
  const context = await openRun(t, options);
  context.clock.advance(options.advanceMs ?? 200);
  const claim = await claimFromExecutor(context.adapter, context.run, {
    nonce: options.nonce ?? 'claim-1',
  });
  const claimed = await context.runtime.runs.claim({
    runId: context.run.id,
    claim,
    acceptanceItems: [...EXECUTION_ITEMS],
  });
  return { ...context, claim, claimed };
}
