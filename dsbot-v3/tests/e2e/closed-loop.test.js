import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchEnvelope, sumUsage } from './support/harness.js';
import { createCostLedger } from './support/cost-ledger.js';
import {
  GOAL_TITLE,
  INITIAL_USAGE,
  REWORK_USAGE,
  createLoop,
  setupDelegation,
  setupDispatch,
  setupGoal,
  setupPass,
  setupRestart,
  setupRework,
  setupRevision,
  setupSubmission,
} from './support/scenario.js';

test('step01 create goal', async (t) => {
  const loop = createLoop(t);
  const goal = setupGoal(loop);

  assert.equal(goal.level, 'goal');
  assert.equal(goal.state, 'planned');
  assert.equal(goal.parentTaskId, null);
  assert.equal(goal.currentRunId, null);
  assert.equal(loop.service.listEvents({ type: 'task.created' }).length, 1);
});

test('step02 delegate business', async (t) => {
  const loop = createLoop(t);
  const goal = setupGoal(loop);
  const business = setupDelegation(loop);

  assert.equal(loop.service.getTask(goal.id).state, 'queued');
  assert.equal(business.parentTaskId, goal.id);
  assert.equal(business.level, 'business');
  assert.ok(
    loop.service
      .listEvents({ type: 'delegation.created' })
      .some((event) => event.taskId === business.id && event.payload.parent_task_id === goal.id),
  );
  assert.throws(
    () =>
      loop.service.createTask({
        level: 'execution',
        parentTaskId: goal.id,
        title: 'illegal level skip',
      }),
    (error) => error.code === 'hierarchy_violation',
    'goal -> execution would skip the business level and must be rejected',
  );
});

test('step03 dispatch through the mock adapter', async (t) => {
  const loop = createLoop(t);
  const goal = setupGoal(loop);
  const business = setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const { execution, dispatched, run, accepted, statusWhileRunning, acked } = initial;

  assert.equal(dispatched.task.state, 'queued');
  assert.equal(run.state, 'dispatched');
  assert.equal(run.executorKind, 'mock');
  assert.equal(run.attemptNo, 1);
  assert.equal(dispatched.task.currentRunId, run.id);

  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.run_id, run.id);
  assert.deepEqual(accepted.tracking.modes, ['status', 'follow']);

  assert.equal(statusWhileRunning.state, 'running');
  assert.equal(statusWhileRunning.progress.health, 'progress');

  assert.equal(acked.run.state, 'running');
  assert.equal(acked.task.state, 'running');

  // Parent aggregation: a started child moves the parents from queued to running.
  assert.equal(loop.service.getTask(business.id).state, 'running');
  assert.equal(loop.service.getTask(goal.id).state, 'running');
});

test('step04 duplicate dispatch creates no second run', async (t) => {
  const loop = createLoop(t);
  setupGoal(loop);
  setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const { execution, run, executor } = initial;
  const service = loop.service;

  // The same retry key replays the first result and creates no second run.
  const replayed = service.dispatchTask({
    taskId: execution.id,
    idempotencyKey: 'loop-dispatch-initial-1',
    executorKind: 'mock',
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.run.id, run.id);
  assert.equal(service.listRuns({ taskId: execution.id }).length, 1);

  // A different key is rejected while the run is active.
  assert.throws(
    () =>
      service.dispatchTask({
        taskId: execution.id,
        idempotencyKey: 'loop-dispatch-initial-2',
        executorKind: 'mock',
      }),
    (error) => error.code === 'invalid_state_transition' && error.status === 409,
  );
  assert.equal(service.listRuns({ taskId: execution.id }).length, 1);

  // The adapter also refuses to execute the same run twice.
  const adapterEventsBefore = (await executor.adapter.follow({ run_id: run.id }, 0)).events.length;
  const duplicateAdapterDispatch = await executor.adapter.dispatch(
    dispatchEnvelope(run, { goal: GOAL_TITLE }),
  );
  assert.equal(duplicateAdapterDispatch.ok, false);
  assert.equal(duplicateAdapterDispatch.accepted, false);
  assert.equal(duplicateAdapterDispatch.code, 'duplicate_dispatch');
  assert.equal(duplicateAdapterDispatch.fallback, 'none');
  const adapterEventsAfter = (await executor.adapter.follow({ run_id: run.id }, 0)).events.length;
  assert.equal(adapterEventsAfter, adapterEventsBefore);
});

test('step05 restart recovery', async (t) => {
  const loop = createLoop(t);
  setupGoal(loop);
  setupDelegation(loop);
  const initial = await setupDispatch(loop);

  const eventsBeforeRestart = loop.service.listEvents();
  const journalEntriesBeforeRestart = loop.store.journalEntries();
  assert.ok(journalEntriesBeforeRestart > 0);

  const storeAfterRestart = setupRestart(loop);
  assert.equal(storeAfterRestart.journalEntries(), journalEntriesBeforeRestart);
  const service = loop.service;

  assert.equal(service.getTask(loop.goal.id).state, 'running');
  assert.equal(service.getTask(loop.business.id).state, 'running');
  assert.equal(service.getTask(initial.execution.id).state, 'running');
  assert.equal(service.getRun(initial.run.id).state, 'running');
  assert.equal(service.listRuns({ taskId: initial.execution.id }).length, 1);
  assert.deepEqual(
    service.listEvents().map((event) => event.seq),
    eventsBeforeRestart.map((event) => event.seq),
  );
  assert.deepEqual(
    service.listEvents().map((event) => event.hash),
    eventsBeforeRestart.map((event) => event.hash),
  );

  const replayedAfterRestart = service.dispatchTask({
    taskId: initial.execution.id,
    idempotencyKey: 'loop-dispatch-initial-1',
    executorKind: 'mock',
  });
  assert.equal(replayedAfterRestart.replayed, true);
  assert.equal(replayedAfterRestart.run.id, initial.run.id);
  assert.equal(service.listRuns({ taskId: initial.execution.id }).length, 1);
});

test('step06 submission enters accepting', async (t) => {
  const loop = createLoop(t);
  setupGoal(loop);
  setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const submission = await setupSubmission(loop, initial);
  const { completed, claim, claimed } = submission;

  assert.equal(completed.state, 'completed');
  assert.equal(completed.progress.timed_out, false);

  assert.equal(claim.manifest.length, 1);
  assert.equal(claim.manifest[0].path, 'article.md');

  assert.equal(claimed.claim.validationState, 'valid');
  assert.equal(claimed.run.state, 'reported');
  assert.equal(claimed.task.state, 'accepting');
  assert.equal(claimed.acceptance.state, 'open');
  assert.equal(claimed.acceptance.roundNo, 1);
  assert.notEqual(claimed.task.state, 'completed');
  assert.equal(claimed.task.openAcceptanceId, claimed.acceptance.id);
  assert.throws(
    () => loop.service.completeTask({ taskId: initial.execution.id }),
    (error) => error.code === 'missing_acceptance',
    'an author claim must not be able to complete the task',
  );
  assert.equal(loop.service.getTask(initial.execution.id).state, 'accepting');
});

test('step07 acceptance rejected, rework run derived', async (t) => {
  const loop = createLoop(t);
  setupGoal(loop);
  setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const submission = await setupSubmission(loop, initial);
  const revised = setupRevision(loop, submission.claimed);

  assert.equal(revised.acceptance.state, 'revise');
  assert.equal(loop.service.getAcceptance(submission.claimed.acceptance.id).state, 'revise');
  assert.equal(revised.task.state, 'reworking');
  assert.equal(revised.task.revision, 1);
  assert.equal(revised.task.openAcceptanceId, null);
  assert.equal(loop.service.getRun(initial.run.id).state, 'rejected');
  assert.equal(revised.reworkRun.state, 'queued');
  assert.equal(revised.reworkRun.kind, 'rework');
  assert.equal(revised.reworkRun.attemptNo, 2);
  assert.equal(revised.task.currentRunId, revised.reworkRun.id);
  assert.equal(loop.service.listRuns({ taskId: initial.execution.id }).length, 2);
  assert.equal(loop.service.listEvents({ type: 'acceptance.revise' }).length, 1);
  assert.equal(loop.service.listEvents({ type: 'run.rejected' }).length, 1);
});

test('step08 rework run passes acceptance', async (t) => {
  const loop = createLoop(t);
  const goal = setupGoal(loop);
  const business = setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const submission = await setupSubmission(loop, initial);
  const revised = setupRevision(loop, submission.claimed);
  const rework = await setupRework(loop, revised);
  const { run2, dispatched, accepted, acked, completed, claimed } = rework;

  assert.notEqual(run2.id, initial.run.id);
  assert.equal(dispatched.run.id, run2.id);
  assert.equal(dispatched.run.state, 'dispatched');
  assert.equal(dispatched.task.state, 'queued');
  assert.equal(loop.service.listRuns({ taskId: initial.execution.id }).length, 2);

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.run_id, run2.id);
  assert.equal(acked.run.state, 'running');
  assert.equal(acked.task.state, 'running');

  assert.equal(completed.state, 'completed');

  assert.equal(claimed.task.state, 'accepting');
  assert.equal(claimed.acceptance.roundNo, 2);
  assert.equal(claimed.acceptance.revision, 1);

  const passed = setupPass(loop, claimed);
  assert.equal(passed.verdict, 'pass');
  assert.equal(passed.acceptance.state, 'passed');
  assert.equal(passed.task.state, 'completed');
  assert.equal(passed.task.terminalAt !== null, true);
  assert.equal(loop.service.getRun(run2.id).state, 'accepted');
  assert.equal(loop.service.listAcceptances({ taskId: initial.execution.id, state: 'passed' }).length, 1);
  assert.equal(loop.service.listAcceptances({ taskId: initial.execution.id, state: 'revise' }).length, 1);
  assert.equal(loop.service.listEvents({ type: 'task.completed' }).length, 1);
  assert.equal(loop.service.listEvents({ type: 'child.completed' }).length, 1);

  // PRD invariant: a child pass never completes its parents.
  assert.equal(loop.service.getTask(business.id).state, 'running');
  assert.equal(loop.service.getTask(goal.id).state, 'running');
});

test('step09 cost records are queryable', async (t) => {
  const loop = createLoop(t);
  setupGoal(loop);
  setupDelegation(loop);
  const initial = await setupDispatch(loop);
  const submission = await setupSubmission(loop, initial);
  const revised = setupRevision(loop, submission.claimed);
  const rework = await setupRework(loop, revised);
  setupPass(loop, rework.claimed);

  const usage1 = await initial.executor.adapter.usage({ run_id: initial.run.id });
  const usage2 = await rework.executor.adapter.usage({ run_id: rework.run2.id });

  assert.equal(usage1.run_id, initial.run.id);
  assert.equal(usage2.run_id, rework.run2.id);
  assert.equal(usage1.source, 'mock');
  assert.equal(usage2.source, 'mock');
  assert.deepEqual(
    { tokens_in: usage1.tokens_in, tokens_out: usage1.tokens_out, tokens_cached: usage1.tokens_cached, cost_cny: usage1.cost_cny },
    INITIAL_USAGE,
  );
  assert.deepEqual(
    { tokens_in: usage2.tokens_in, tokens_out: usage2.tokens_out, tokens_cached: usage2.tokens_cached, cost_cny: usage2.cost_cny },
    REWORK_USAGE,
  );
  assert.equal(submission.completed.usage.cost_cny, INITIAL_USAGE.cost_cny);
  assert.equal(rework.completed.usage.cost_cny, REWORK_USAGE.cost_cny);

  const byRun = new Map([
    [initial.run.id, usage1],
    [rework.run2.id, usage2],
  ]);
  const taskRuns = loop.service.listRuns({ taskId: initial.execution.id });
  assert.equal(taskRuns.length, 2);
  const taskCost = sumUsage(taskRuns.map((run) => byRun.get(run.id)));
  assert.deepEqual(taskCost, {
    tokens_in: 2100,
    tokens_out: 1500,
    tokens_cached: 300,
    cost_cny: 0.3,
  });

  // The durable cost records live in the L1 store's cost_ledger. The L6 API
  // that will project service state into the DAO is not part of this ticket,
  // so the e2e records the executor usage against the same task/run ids and
  // then queries the ledger.
  const ledger = createCostLedger();
  t.after(() => ledger.close());
  ledger.projectTree({ goal: loop.goal, business: loop.business, execution: initial.execution });
  ledger.projectRun(initial.run);
  ledger.projectRun(rework.run2);
  ledger.recordUsage({ taskId: initial.execution.id, runId: initial.run.id, usage: usage1 });
  ledger.recordUsage({ taskId: initial.execution.id, runId: rework.run2.id, usage: usage2 });

  const costRows = ledger.listForTask(initial.execution.id);
  assert.equal(costRows.length, 2);
  assert.deepEqual(
    costRows.map((row) => row.run_id).sort(),
    [initial.run.id, rework.run2.id].sort(),
  );
  assert.ok(costRows.every((row) => row.kind === 'llm'));
  assert.deepEqual(ledger.totalForTask(initial.execution.id), taskCost);
  t.diagnostic(
    `cost ledger: ${costRows.length} rows, task total ${ledger.totalForTask(initial.execution.id).cost_cny} CNY`,
  );
  t.diagnostic(
    `cost: run ${initial.run.id}=${usage1.cost_cny} CNY, rework ${rework.run2.id}=${usage2.cost_cny} CNY, task total=${taskCost.cost_cny} CNY`,
  );
});
