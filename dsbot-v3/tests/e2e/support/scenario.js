/**
 * Independent state builders for the step-wise L5 e2e acceptance.
 *
 * Every test builds a fresh journaled store, clock and id factory, so no state
 * leaks between step cases. The helpers only drive the shipped service and mock
 * adapter; the assertions stay in the test files so a failure names the step
 * under test instead of disappearing inside shared setup.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXECUTION_ITEMS,
  claimFromExecutor,
  createBusiness,
  createClock,
  createExecution,
  createExecutor,
  createGoal,
  createIds,
  createService,
  dispatchToMock,
  passedItemStates,
} from './harness.js';
import { createJournaledStore } from './journal-store.js';

export const GOAL_TITLE = '写一篇关于 AI 的文章';
export const INITIAL_USAGE = Object.freeze({
  tokens_in: 1200,
  tokens_out: 800,
  tokens_cached: 200,
  cost_cny: 0.12,
});
export const REWORK_USAGE = Object.freeze({
  tokens_in: 900,
  tokens_out: 700,
  tokens_cached: 100,
  cost_cny: 0.18,
});

/** Fresh temp journal, deterministic clock/ids and a service over it. */
export function createLoop(t) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsbot-e2e-loop-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const journalPath = join(tempRoot, 'service-store.json');
  const clock = createClock();
  const ids = createIds();
  const store = createJournaledStore(journalPath);
  const service = createService(store, clock, ids);

  return { tempRoot, journalPath, clock, ids, store, service };
}

/** Step 1: create the goal only. */
export function setupGoal(loop) {
  loop.goal = createGoal(loop.service);
  return loop.goal;
}

/** Step 2: queue the goal, delegate the business task and queue it too. */
export function setupDelegation(loop) {
  loop.service.transitionTask({
    taskId: loop.goal.id,
    to: 'queued',
    actor: 'chief',
    idempotencyKey: 'loop-goal-queued',
  });
  loop.business = createBusiness(loop.service, loop.goal);
  loop.service.transitionTask({
    taskId: loop.business.id,
    to: 'queued',
    actor: 'bot',
    idempotencyKey: 'loop-business-queued',
  });
  return loop.business;
}

/** Step 3: execution task, service dispatch, mock dispatch, ack, parent start. */
export async function setupDispatch(
  loop,
  {
    usage = INITIAL_USAGE,
    artifact = '# draft v1',
    summary = 'initial draft',
    completeAt = 100,
  } = {},
) {
  const execution = createExecution(loop.service, loop.business);
  const dispatched = loop.service.dispatchTask({
    taskId: execution.id,
    idempotencyKey: 'loop-dispatch-initial-1',
    executorKind: 'mock',
  });
  const run = dispatched.run;

  const executor = createExecutor({ usage, artifact, summary, completeAt });
  const accepted = await dispatchToMock({ adapter: executor.adapter, run, goal: GOAL_TITLE });
  const statusWhileRunning = await executor.adapter.status({ run_id: run.id });
  const acked = loop.service.ackRun({ runId: run.id });

  loop.service.transitionTask({
    taskId: loop.business.id,
    to: 'running',
    actor: 'system',
    idempotencyKey: 'loop-business-running',
  });
  loop.service.transitionTask({
    taskId: loop.goal.id,
    to: 'running',
    actor: 'system',
    idempotencyKey: 'loop-goal-running',
  });

  Object.assign(loop, { execution, run1: run, executor1: executor });
  return { execution, dispatched, run, executor, accepted, statusWhileRunning, acked };
}

/** Step 5: rebuild the service from the journal, keeping the same clock/ids. */
export function setupRestart(loop) {
  const store = createJournaledStore(loop.journalPath);
  loop.service = createService(store, loop.clock, loop.ids);
  loop.store = store;
  return store;
}

/** Step 6: the executor completes and its first claim opens acceptance round 1. */
export async function setupSubmission(loop, initial) {
  initial.executor.clock.advance(200);
  const completed = await initial.executor.adapter.status({ run_id: initial.run.id });
  const claim = await claimFromExecutor(initial.executor.adapter, initial.run, {
    nonce: 'claim-initial-1',
    summary: 'draft v1 ready',
  });
  const claimed = loop.service.claimRun({
    runId: initial.run.id,
    claim,
    acceptanceItems: [...EXECUTION_ITEMS],
    idempotencyKey: 'loop-claim-initial-1',
  });
  return { completed, claim, claimed };
}

/** Step 7: reject the first acceptance, deriving the rework run. */
export function setupRevision(loop, claimed) {
  return loop.service.decideAcceptance({
    acceptanceId: claimed.acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'fail' },
    reason: 'factual_error',
    reviewer: { role: 'independent_reviewer', id: 'reviewer-1', context_id: 'ctx-reviewer-1' },
    idempotencyKey: 'loop-decision-initial-revise',
  });
}

/** Step 8: dispatch/claim the derived run and record its completed status. */
export async function setupRework(loop, revised) {
  const run2 = revised.reworkRun;
  const dispatched = loop.service.dispatchTask({
    taskId: loop.execution.id,
    idempotencyKey: 'loop-dispatch-rework-1',
    executorKind: 'mock',
  });

  const executor = createExecutor({
    usage: REWORK_USAGE,
    artifact: '# final v2',
    summary: 'revised draft',
    completeAt: 300,
  });
  const accepted = await dispatchToMock({ adapter: executor.adapter, run: run2, goal: GOAL_TITLE });
  const acked = loop.service.ackRun({ runId: run2.id });

  executor.clock.advance(400);
  const completed = await executor.adapter.status({ run_id: run2.id });
  const claim = await claimFromExecutor(executor.adapter, run2, {
    nonce: 'claim-rework-1',
    summary: 'final v2 ready',
  });
  const claimed = loop.service.claimRun({
    runId: run2.id,
    claim,
    acceptanceItems: [...EXECUTION_ITEMS],
    idempotencyKey: 'loop-claim-rework-1',
  });
  return { run2, dispatched, executor, accepted, acked, completed, claim, claimed };
}

/** Step 8: pass the rework acceptance. */
export function setupPass(loop, claimed) {
  return loop.service.decideAcceptance({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(claimed.acceptance),
    idempotencyKey: 'loop-decision-rework-pass',
  });
}
