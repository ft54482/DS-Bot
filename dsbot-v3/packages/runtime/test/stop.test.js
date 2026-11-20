import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntime } from '../src/index.js';
import { createClock, createExecutor, createIds, createTree } from './support/harness.js';

async function runningTree(runtime, { executorKind = 'mock' } = {}) {
  const tree = createTree(runtime);
  const dispatched = runtime.tasks.dispatch({
    taskId: tree.execution.id,
    executorKind,
  });
  const accepted = await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  assert.equal(accepted.accepted, true);
  runtime.runs.ack({ runId: dispatched.run.id });
  return { ...tree, run: dispatched.run };
}

test('stop: verified quiescence cancels the subtree only after the write proof', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsbot-runtime-stop-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'article.md'), '# sealed draft\n', 'utf8');

  const clock = createClock();
  const ids = createIds();
  // A long-running script: the run is still running when the stop is requested.
  const { adapter } = createExecutor({
    clock: createClock(0),
    completeAt: 60_000,
  });
  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: { mock: adapter },
    clock: clock.now,
    idFactory: ids.next,
    workspacePath: workspace,
    quiescenceMs: 5000,
  });
  t.after(() => runtime.close());

  const { goal, business, execution, run } = await runningTree(runtime);
  assert.equal(runtime.runs.get(run.id).state, 'running');

  const stopped = await runtime.stop.stop({
    taskId: goal.id,
    requestedBy: 'human',
    reason: 'user_stop',
  });

  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.stopState, 'verified');
  assert.deepEqual(stopped.blockers, []);
  assert.equal(stopped.executor.length, 1);
  assert.equal(stopped.executor[0].runId, run.id);
  assert.equal(stopped.executor[0].cancel.requested, true);
  assert.equal(stopped.executor[0].cancel.remote_may_still_run, false);
  assert.equal(stopped.workspace.writesStable, true);
  assert.equal(stopped.workspace.hashBefore, stopped.workspace.hashAfter);

  for (const task of [goal, business, execution]) {
    const current = runtime.tasks.get(task.id);
    assert.equal(current.state, 'cancelled');
    assert.equal(current.stopState, 'verified');
    assert.equal(current.stopUnknown, false);
    assert.notEqual(current.terminalAt, null);
  }
  assert.equal(runtime.runs.get(run.id).state, 'cancelled');

  // Proofs are recorded through the service, not by the runtime pretending.
  const proofs = runtime.service.listStopVerifications({ runId: run.id });
  assert.equal(proofs.at(-1).verdict, 'verified');

  // No new dispatch after a verified stop.
  assert.throws(
    () => runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' }),
    (error) => error.status === 409,
  );
  assert.equal(runtime.runs.list({ taskId: execution.id }).length, 1);
});

test('stop: an unverified executor cancel stays stop_unknown, never cancelled', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsbot-runtime-stop-unknown-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const clock = createClock();
  const ids = createIds(100);
  const { adapter } = createExecutor({
    clock: createClock(0),
    completeAt: 60_000,
    cancelVerification: 'unverified',
  });
  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: { mock: adapter },
    clock: clock.now,
    idFactory: ids.next,
    workspacePath: workspace,
    quiescenceMs: 5000,
  });
  t.after(() => runtime.close());

  const { goal, execution, run } = await runningTree(runtime);
  const stopped = await runtime.stop.stop({
    taskId: goal.id,
    requestedBy: 'human',
    reason: 'user_stop',
  });

  assert.equal(stopped.cancelled, false);
  assert.equal(stopped.stopState, 'stop_unknown');
  assert.equal(stopped.executor[0].cancel.state, 'stop_unknown');
  assert.ok(
    stopped.blockers.some(
      (blocker) => blocker.runId === run.id && blocker.reasons.includes('process_still_alive'),
    ),
  );
  assert.equal(runtime.tasks.get(goal.id).state, 'stopping');
  assert.equal(runtime.tasks.get(execution.id).state, 'stopping');
  assert.equal(runtime.tasks.get(goal.id).stopUnknown, true);
  assert.equal(runtime.runs.get(run.id).state, 'running');

  // The caller can retry verification with real evidence through the same service.
  const retried = runtime.stop.verify({
    taskId: goal.id,
    verifications: [
      {
        runId: run.id,
        processGone: true,
        cancelAck: true,
        quiescenceWindowMs: 5000,
        windowStartedAt: clock.now(),
        lastWriteAt: clock.now() - 1,
        namespaceHashBefore: 'hash-a',
        namespaceHashAfter: 'hash-a',
        openFileHandles: 0,
      },
    ],
    minQuiescenceMs: 5000,
  });
  assert.equal(retried.cancelled, true);
  assert.equal(retried.stopState, 'verified');
  assert.equal(runtime.tasks.get(goal.id).state, 'cancelled');
  assert.equal(runtime.runs.get(run.id).state, 'cancelled');
});
