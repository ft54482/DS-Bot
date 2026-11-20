/**
 * Test support for the agent tool surface.
 *
 * One independent runtime per test: in-memory SQLite store, deterministic clock
 * and ids, and the `mock` executor adapter. The task chain mirrors the PRD
 * hierarchy goal → business → execution.
 */

import { createMockAdapter } from '../../../adapters/src/mock.js';
import { createRuntime } from '../../../runtime/src/index.js';
import { createChiefTools, createBusinessTools } from '../../src/index.js';

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.auto_v1',
  version: 1,
  items: [
    { key: 'auto.contract', class: 'auto', required: true },
    { key: 'independent.review', class: 'independent', required: true },
  ],
});

export const BUSINESS_PROFILE = Object.freeze({
  id: 'business.delivery_v1',
  version: 1,
  items: [{ key: 'independent.business_review', class: 'independent', required: true }],
});

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.objective_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

export const TEST_USAGE = Object.freeze({
  tokens_in: 1200,
  tokens_out: 800,
  tokens_cached: 200,
  cost_cny: 0.12,
});

export const CHIEF_SCOPE = Object.freeze({
  projects: ['self-media'],
  spend_cny_cap: 100,
  max_delegate_level: 'goal',
});

export const BUSINESS_SCOPE = Object.freeze({
  projects: ['self-media'],
  executors: ['mock'],
  spend_cny_cap: 20,
  max_delegate_level: 'business',
});

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

export function openRuntime(t, { script, usage = TEST_USAGE } = {}) {
  const clock = createClock();
  const ids = createIds();
  const adapter = createMockAdapter({
    now: clock.now,
    usage,
    script:
      script ??
      [
        { at: 0, type: 'progress', message: 'started' },
        {
          at: 100,
          type: 'complete',
          summary: 'delivered',
          artifacts: [{ path: 'article.md', content: '# draft' }],
        },
      ],
  });
  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: { mock: adapter },
    clock: clock.now,
    idFactory: ids.next,
  });
  t.after(() => runtime.close());
  return { runtime, clock, ids, adapter };
}

export function createTree(
  runtime,
  {
    project = 'self-media',
    goalBudget = 100,
    businessBudget = 50,
    executionBudget = 20,
    goalProfile = GOAL_PROFILE,
  } = {},
) {
  const goal = runtime.tasks.create({
    level: 'goal',
    title: 'goal: produce one deliverable',
    subject: { project },
    budget: { capCny: goalBudget },
    acceptanceProfile: goalProfile,
    authScope: { projects: [project], max_delegate_level: 'goal' },
  });
  const business = runtime.tasks.delegate({
    parentTaskId: goal.id,
    title: 'business: own the deliverable',
    subject: { project },
    budget: { capCny: businessBudget },
    acceptanceProfile: BUSINESS_PROFILE,
    authScope: { projects: [project], max_delegate_level: 'business' },
  });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: 'execution: produce the draft',
    subject: { project, goal: 'write the draft' },
    budget: { capCny: executionBudget },
    acceptanceProfile: EXECUTION_PROFILE,
    authScope: { projects: [project], max_delegate_level: 'execution' },
  });
  return { goal, business, execution };
}

export function startTask(runtime, taskId) {
  let task = runtime.tasks.get(taskId);
  if (task.state === 'planned') {
    runtime.tasks.queue({ taskId, actor: 'bot' });
    task = runtime.tasks.get(taskId);
  }
  if (task.state === 'queued') {
    runtime.service.transitionTask({ taskId, to: 'running', actor: 'bot' });
  }
  return runtime.tasks.get(taskId);
}

/** Drive the execution task to an open acceptance round. */
export async function driveToAcceptance({ runtime, clock, adapter }, execution, { nonce = 'claim-1' } = {}) {
  const dispatched = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });
  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  runtime.runs.ack({ runId: dispatched.run.id });
  clock.advance(200);

  const artifacts = await adapter.collectArtifacts({ run_id: dispatched.run.id });
  const claimed = await runtime.runs.claim({
    runId: dispatched.run.id,
    claim: {
      commit: 'a'.repeat(40),
      dirty: false,
      manifest: artifacts.items.map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
      })),
      nonce,
      summary: 'delivered',
    },
    acceptanceItems: EXECUTION_PROFILE.items,
  });

  return { run: dispatched.run, acceptance: claimed.acceptance, claimed };
}

export function claimReadiness(runtime, taskId, items, nonce) {
  return runtime.service.claimReadiness({
    taskId,
    claim: { nonce },
    acceptanceItems: items,
    actor: 'bot',
    idempotencyKey: `readiness:${taskId}:${nonce}`,
  });
}

/**
 * Complete the execution round through the business tools, then walk the
 * business and goal aggregates to an open goal acceptance round.
 */
export async function openGoalAcceptance(t, options = {}) {
  const context = openRuntime(t, options);
  const tree = createTree(context.runtime, options);
  const chiefTools = createChiefTools({ runtime: context.runtime, scope: options.chiefScope ?? CHIEF_SCOPE });
  const businessTools = createBusinessTools({
    runtime: context.runtime,
    scope: options.businessScope ?? BUSINESS_SCOPE,
  });

  const execution = await driveToAcceptance(context, tree.execution);
  const executionDecision = businessTools.accept({
    acceptanceId: execution.acceptance.id,
    verdict: 'pass',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'pass' },
  });
  if (!executionDecision.ok) throw new Error(`execution acceptance failed: ${executionDecision.message}`);

  startTask(context.runtime, tree.business.id);
  const businessReady = claimReadiness(context.runtime, tree.business.id, BUSINESS_PROFILE.items, 'business-1');
  const businessDecision = businessTools.accept({
    acceptanceId: businessReady.acceptance.id,
    verdict: 'pass',
    itemStates: { 'independent.business_review': 'pass' },
  });
  if (!businessDecision.ok) throw new Error(`business acceptance failed: ${businessDecision.message}`);

  startTask(context.runtime, tree.goal.id);
  const goalReady = claimReadiness(context.runtime, tree.goal.id, GOAL_PROFILE.items, 'goal-1');

  return {
    ...context,
    tree,
    chiefTools,
    businessTools,
    executionAcceptance: execution.acceptance,
    goalAcceptance: goalReady.acceptance,
  };
}
