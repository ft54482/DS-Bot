import test from 'node:test';

import { expectCode, expectEqual, expectNotEqual, expectTrue } from './support/conformance.js';
import {
  createExecutor,
  createTree,
  openRuntime,
  passAll,
  reportClaim,
  startRun,
} from './support/harness.js';

test('[PRD 03 §4.2 + §0.5 G30] a task cannot complete without its own passed acceptance', async (t) => {
  const { adapter } = createExecutor();
  const { runtime } = openRuntime(t, { adapter });
  const { execution } = createTree(runtime);

  const { run } = await startRun(runtime, execution.id);
  const claimed = await reportClaim(runtime, run.id, 'no-acceptance');

  // The claim opened an acceptance, but nothing has decided it.
  expectEqual('03 §4.2', 'the claim opens an acceptance round', claimed.acceptance.state, 'open');

  const viaComplete = expectCode(
    '03 §4.2',
    'the completion API refuses an open/unpassed round',
    () => runtime.service.completeTask({ taskId: execution.id }),
    'missing_acceptance',
  );
  expectEqual('03 §4.2', 'the completion guard is G30', viaComplete.details?.guard, 'G30');

  const viaTransition = expectCode(
    '03 §0.5',
    'a direct task transition cannot bypass the guard',
    () => runtime.service.transitionTask({ taskId: execution.id, to: 'completed' }),
    'missing_acceptance',
  );
  expectEqual('03 §0.5', 'the transition guard is G30 too', viaTransition.details?.guard, 'G30');

  expectEqual('03 §0.5', 'the task stays accepting', runtime.tasks.get(execution.id).state, 'accepting');
  expectEqual('03 §0.5', 'the acceptance stays open', claimed.acceptance.state, 'open');
  expectEqual(
    '03 §0.5',
    'no task.completed event was written',
    runtime.service.listEvents({ type: 'task.completed' }).length,
    0,
  );

  // Positive control: the only path is the task's own passed acceptance.
  const decided = passAll(runtime, claimed.acceptance);
  expectEqual('03 §0.5', 'the passed acceptance completes the task', decided.task.state, 'completed');
  expectEqual('03 §0.5', 'the run is accepted', runtime.runs.get(run.id).state, 'accepted');
  expectEqual(
    '03 §0.5',
    'exactly one task.completed event now exists',
    runtime.service.listEvents({ type: 'task.completed' }).length,
    1,
  );
});

test('[PRD 02 §2.2 + 03 §4.2] a claim reports work; it never sets completion or item outcomes', async (t) => {
  const { adapter } = createExecutor();
  const { runtime } = openRuntime(t, { adapter });
  const { execution } = createTree(runtime);

  const { run } = await startRun(runtime, execution.id);
  expectEqual('02 §2.2', 'the run is running before the claim', runtime.runs.get(run.id).state, 'running');

  const claimed = await reportClaim(runtime, run.id, 'claim-only');

  expectEqual('02 §2.2', 'the run becomes reported, not completed', claimed.run.state, 'reported');
  expectEqual('03 §4.2', 'the task becomes accepting', claimed.task.state, 'accepting');
  expectNotEqual('03 §4.2', 'the claim does not complete the task', claimed.task.state, 'completed');
  expectEqual('03 §4.2', 'the claim record is a valid self-report', claimed.claim.validationState, 'valid');
  expectEqual('03 §4.2', 'the acceptance round is open', claimed.acceptance.state, 'open');

  expectTrue(
    '03 §4.2',
    'every acceptance item is still pending; the claim cannot set them',
    claimed.acceptance.items.every((item) => item.state === 'pending'),
  );
  expectEqual(
    '03 §4.2',
    'no task.completed event follows a claim',
    runtime.service.listEvents({ type: 'task.completed' }).length,
    0,
  );
  expectEqual(
    '03 §4.2',
    'the claim is the only self-report record',
    runtime.service.listClaims({ taskId: execution.id }).length,
    1,
  );
});
