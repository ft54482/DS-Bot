import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { runStopUnknownScenario } from '../src/drill.js';
import {
  EXECUTION_ITEMS,
  EXECUTION_PROFILE,
  GOAL_PROFILE,
  INITIAL_USAGE,
  claimFromExecutor,
  createClock,
  createIds,
  openRuntime,
} from '../src/support.js';

function buildTree(runtime) {
  const goal = runtime.tasks.create({
    level: 'goal',
    title: '失败路径演练',
    owner: 'chief:test',
    acceptanceProfile: GOAL_PROFILE,
  });
  const business = runtime.tasks.delegate({ parentTaskId: goal.id, title: '业务侧' });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: '执行侧',
    acceptanceProfile: EXECUTION_PROFILE,
  });
  return { goal, business, execution };
}

function openMini(t, { cancelVerification = 'verified', completeAt = 100 } = {}) {
  const clock = createClock();
  const adapterClock = createClock(0);
  const ids = createIds(100);
  const adapter = createMockAdapter({
    now: adapterClock.now,
    cancelVerification,
    usage: { ...INITIAL_USAGE },
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: completeAt,
        type: 'complete',
        summary: 'done',
        artifacts: [{ path: 'article.md', content: '# result\n' }],
      },
    ],
  });
  const runtime = openRuntime({ dbPath: ':memory:', adapter, clock, ids, workspacePath: null });
  t.after(() => runtime.close());
  return { runtime, clock, adapterClock, ids, adapter };
}

test('failure path: a malformed claim is refused and opens no acceptance', async (t) => {
  const { runtime, adapterClock, adapter } = openMini(t);
  const { execution } = buildTree(runtime);
  const dispatched = runtime.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'failure:dispatch:1',
  });
  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  runtime.runs.ack({ runId: dispatched.run.id });

  adapterClock.advance(200);
  const valid = await claimFromExecutor(adapter, dispatched.run, { nonce: 'failure:claim:1' });
  const bad = { ...valid, commit: 'not-a-sha' };

  await assert.rejects(
    () => runtime.runs.claim({ runId: dispatched.run.id, claim: bad, acceptanceItems: EXECUTION_ITEMS }),
    (error) => error.code === 'claim_invalid' && error.status === 422,
  );
  assert.equal(runtime.runs.get(dispatched.run.id).state, 'running');
  assert.equal(runtime.tasks.get(execution.id).state, 'running');
  assert.equal(runtime.acceptances.list({ taskId: execution.id }).length, 0);
});

test('failure path: a completed task refuses a new dispatch and creates no run', async (t) => {
  const { runtime, adapterClock, adapter } = openMini(t);
  const { execution } = buildTree(runtime);
  const dispatched = runtime.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'failure:dispatch:complete',
  });
  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  runtime.runs.ack({ runId: dispatched.run.id });
  adapterClock.advance(200);
  const claim = await claimFromExecutor(adapter, dispatched.run, { nonce: 'failure:claim:complete' });
  const claimed = await runtime.runs.claim({
    runId: dispatched.run.id,
    claim,
    acceptanceItems: EXECUTION_ITEMS,
  });
  runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: {
      'auto.contract': 'pass',
      'fact.accuracy': 'pass',
      'independent.review': 'pass',
    },
  });
  assert.equal(runtime.tasks.get(execution.id).state, 'completed');
  const runCount = runtime.runs.list({ taskId: execution.id }).length;

  assert.throws(
    () => runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' }),
    (error) => error.code === 'invalid_state_transition' && error.status === 409,
  );
  assert.equal(runtime.runs.list({ taskId: execution.id }).length, runCount);
});

test('failure path: stop_unknown leaves the task stopping and the run running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm5-drill-stop-unknown-'));
  try {
    const scenario = await runStopUnknownScenario(root);
    assert.equal(scenario.ok, true);
    assert.equal(scenario.cancelled, false);
    assert.equal(scenario.stopState, 'stop_unknown');
    assert.equal(scenario.executor.cancelState, 'stop_unknown');
    assert.equal(scenario.executor.remoteMayStillRun, true);
    assert.equal(scenario.runState, 'running');
    assert.deepEqual(scenario.taskStates, {
      goal: 'stopping',
      business: 'stopping',
      execution: 'stopping',
    });
    assert.equal(scenario.noNewDispatch.rejectedCode, 'invalid_state_transition');
    assert.equal(scenario.noNewDispatch.runsAfter, scenario.noNewDispatch.runsBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure path: an unverified stop without evidence stays stop_unknown and never cancels', async (t) => {
  const { runtime } = openMini(t, { completeAt: 60_000 });
  const { goal, execution } = buildTree(runtime);
  runtime.tasks.queue({ taskId: goal.id, actor: 'chief', idempotencyKey: 'failure:stop:goal-queue' });
  const dispatched = runtime.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'failure:stop:dispatch',
  });
  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  runtime.runs.ack({ runId: dispatched.run.id });

  runtime.stop.request({ taskId: goal.id, requestedBy: 'human', reason: 'user_stop' });
  const verified = runtime.stop.verify({ taskId: goal.id, verifications: [] });

  assert.equal(verified.cancelled, false);
  assert.equal(verified.stopState, 'stop_unknown');
  assert.equal(runtime.tasks.get(goal.id).state, 'stopping');
  assert.equal(runtime.tasks.get(goal.id).stopUnknown, true);
  assert.equal(runtime.runs.get(dispatched.run.id).state, 'running');
});

test('failure path: re-capturing usage for the same run never double-bills', async (t) => {
  const { runtime, adapterClock, adapter } = openMini(t);
  const { execution } = buildTree(runtime);
  const dispatched = runtime.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'failure:cost:dispatch',
  });
  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  runtime.runs.ack({ runId: dispatched.run.id });
  adapterClock.advance(200);
  const claim = await claimFromExecutor(adapter, dispatched.run, { nonce: 'failure:cost:claim' });
  const claimed = await runtime.runs.claim({
    runId: dispatched.run.id,
    claim,
    acceptanceItems: EXECUTION_ITEMS,
  });
  assert.equal(claimed.cost.recorded, true);
  const before = runtime.cost.total(execution.id);

  const recaptured = await runtime.cost.captureRunUsage(dispatched.run.id);
  assert.equal(recaptured.recorded, false);
  assert.equal(recaptured.reason, 'already_recorded');
  assert.deepEqual(runtime.cost.total(execution.id), before);
  assert.equal(runtime.cost.list(execution.id).length, 1);
});
