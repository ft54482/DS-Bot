import test from 'node:test';

import {
  expectDeepEqual,
  expectEqual,
  expectFalse,
  expectTrue,
} from './support/conformance.js';
import {
  createExecutor,
  createTree,
  createWorkspace,
  openRuntime,
  startRun,
} from './support/harness.js';

test('[PRD 03 §5.2.1 step 7 + §5.2.2] an unverified stop is stop_unknown, never cancelled', async (t) => {
  const workspace = createWorkspace(t);
  const { adapter } = createExecutor({
    completeAt: 60_000,
    cancelVerification: 'unverified',
  });
  const { runtime } = openRuntime(t, {
    adapter,
    workspacePath: workspace,
    quiescenceMs: 5000,
  });
  const { goal, business, execution } = createTree(runtime);
  const { run } = await startRun(runtime, execution.id);

  const stopped = await runtime.stop.stop({
    taskId: goal.id,
    requestedBy: 'human',
    reason: 'user_stop',
  });

  expectFalse('03 §5.2.1', 'the stop is not reported as cancelled', stopped.cancelled);
  expectEqual('03 §5.2.1', 'the stop state is stop_unknown', stopped.stopState, 'stop_unknown');
  expectTrue(
    '03 §5.2.1',
    'the blocker is the live executor, not a bookkeeping flag',
    stopped.blockers.some(
      (blocker) => blocker.runId === run.id && blocker.reasons.includes('process_still_alive'),
    ),
  );

  for (const task of [goal, business, execution]) {
    const current = runtime.tasks.get(task.id);
    expectEqual('03 §5.2.1', `${task.level} stays stopping`, current.state, 'stopping');
    expectEqual('03 §5.2.1', `${task.level} is marked stop_unknown`, current.stopUnknown, true);
  }
  expectEqual('03 §5.2.2', 'the executor run is still active', runtime.runs.get(run.id).state, 'running');
  expectEqual(
    '03 §5.2.2',
    'no task.cancelled event is written without proof',
    runtime.service.listEvents({ type: 'task.cancelled' }).length,
    0,
  );

  const proofs = runtime.service.listStopVerifications({ runId: run.id });
  expectEqual('03 §5.2.2', 'a stop_verification record exists', proofs.length, 1);
  expectEqual('03 §5.2.2', 'the verdict is stop_unknown', proofs[0].verdict, 'stop_unknown');

  // A timeout must not silently become a cancellation either: the PRD allows
  // stopping or blocked(stop_unverified), and this implementation blocks.
  const timedOut = runtime.stop.verify({ taskId: goal.id, deadlinePassed: true });
  expectFalse('03 §5.2.1', 'a timeout still does not cancel', timedOut.cancelled);
  expectEqual('03 §5.2.1', 'the timed-out stop state is failed', timedOut.stopState, 'failed');
  expectEqual('03 §5.2.1', 'the root becomes blocked', runtime.tasks.get(goal.id).state, 'blocked');
  expectEqual(
    '03 §5.2.1',
    'the block reason locates the unverified stop',
    runtime.tasks.get(goal.id).blockedReason,
    'stop_unverified',
  );
});

test('[PRD 03 §5.2.1 step 5-6 + §5.2.2] only a verified quiescence proof cancels the subtree', async (t) => {
  const workspace = createWorkspace(t, { content: '# sealed draft\n' });
  const { adapter } = createExecutor({
    completeAt: 60_000,
    cancelVerification: 'verified',
  });
  const { runtime } = openRuntime(t, {
    adapter,
    workspacePath: workspace,
    quiescenceMs: 5000,
  });
  const { goal, business, execution } = createTree(runtime);
  const { run } = await startRun(runtime, execution.id);

  const stopped = await runtime.stop.stop({
    taskId: goal.id,
    requestedBy: 'human',
    reason: 'user_stop',
  });

  expectTrue('03 §5.2.1', 'the verified stop cancels', stopped.cancelled);
  expectEqual('03 §5.2.1', 'the stop state is verified', stopped.stopState, 'verified');
  expectDeepEqual('03 §5.2.1', 'there are no blockers', stopped.blockers, []);
  expectTrue('03 §5.2.2', 'the workspace hash was stable', stopped.workspace.writesStable);
  expectEqual(
    '03 §5.2.2',
    'the namespace hash did not change',
    stopped.workspace.hashBefore,
    stopped.workspace.hashAfter,
  );

  for (const task of [goal, business, execution]) {
    const current = runtime.tasks.get(task.id);
    expectEqual('03 §5.2.1', `${task.level} is cancelled`, current.state, 'cancelled');
    expectEqual('03 §5.2.1', `${task.level} keeps the verified proof`, current.stopState, 'verified');
    expectFalse('03 §5.2.1', `${task.level} is not stop_unknown`, current.stopUnknown);
  }
  expectEqual('03 §5.2.2', 'the executor run is cancelled', runtime.runs.get(run.id).state, 'cancelled');
  expectEqual(
    '03 §5.2.2',
    'the verified proof is persisted',
    runtime.service.listStopVerifications({ runId: run.id }).at(-1).verdict,
    'verified',
  );
});
