import test from 'node:test';

import {
  expectCode,
  expectEqual,
  expectNotEqual,
  expectStatus,
  expectTrue,
} from './support/conformance.js';
import {
  createExecutor,
  createTree,
  openRuntime,
  passAll,
  reportClaim,
  startApi,
  startRun,
} from './support/harness.js';

test('[PRD 03 §1.2 + 02 §2.1] the delegation hierarchy is adjacent and skips are refused', (t) => {
  const { runtime } = openRuntime(t);
  const goal = runtime.tasks.create({ level: 'goal', title: '目标' });

  const business = runtime.tasks.delegate({ parentTaskId: goal.id, title: '业务' });
  expectEqual('03 §1.2', 'goal→business parent link', business.parentTaskId, goal.id);
  expectEqual('03 §1.2', 'goal→business child level', business.level, 'business');

  const skippedByFacade = expectCode(
    '03 §1.2',
    'goal cannot own an execution child',
    () => runtime.tasks.delegate({ parentTaskId: goal.id, level: 'execution', title: 'skip' }),
    'hierarchy_violation',
  );
  expectEqual('03 §1.2', 'G26 guard on the facade', skippedByFacade.details?.guard, 'G26');

  // The raw service path is the same guard, so an API/CLI caller cannot skip it.
  const skippedByService = expectCode(
    '03 §1.2',
    'the service guard also refuses goal→execution',
    () => runtime.service.createTask({ level: 'execution', parentTaskId: goal.id, title: 'skip' }),
    'hierarchy_violation',
  );
  expectEqual('03 §1.2', 'G26 guard on the service', skippedByService.details?.guard, 'G26');
  expectEqual('03 §1.2', 'a refused child is not persisted', runtime.tasks.list().length, 2);

  const execution = runtime.tasks.delegate({ parentTaskId: business.id, title: '执行' });
  expectEqual('03 §1.2', 'business→execution parent link', execution.parentTaskId, business.id);
  expectEqual('03 §1.2', 'business→execution child level', execution.level, 'execution');

  const childless = expectCode(
    '03 §1.2',
    'an execution task cannot delegate a child',
    () => runtime.tasks.delegate({ parentTaskId: execution.id, title: 'child' }),
    'hierarchy_violation',
  );
  expectTrue('03 §1.2', 'the refusal names the guard', Boolean(childless.details?.guard));
});

test('[PRD 03 §1.3 + §3.9 G2] a completed child never completes its parent', async (t) => {
  const { adapter } = createExecutor();
  const { runtime } = openRuntime(t, { adapter });
  const { goal, business, execution } = createTree(runtime);

  const { run } = await startRun(runtime, execution.id);
  const claimed = await reportClaim(runtime, run.id, 'child-only');
  const passed = passAll(runtime, claimed.acceptance);

  expectEqual('03 §1.3', 'the execution task itself completes', passed.task.state, 'completed');
  expectEqual('03 §1.3', 'the execution run is accepted', runtime.runs.get(run.id).state, 'accepted');
  expectNotEqual('03 §1.3', 'the business parent is not completed', runtime.tasks.get(business.id).state, 'completed');
  expectNotEqual('03 §1.3', 'the goal parent is not completed', runtime.tasks.get(goal.id).state, 'completed');

  expectEqual(
    '03 §3.9',
    'no business acceptance was passed by the child completion',
    runtime.service.listAcceptances({ taskId: business.id, state: 'passed' }).length,
    0,
  );
  expectEqual(
    '03 §3.9',
    'no goal acceptance was passed by the child completion',
    runtime.service.listAcceptances({ taskId: goal.id, state: 'passed' }).length,
    0,
  );

  const childCompleted = runtime.service.listEvents({ type: 'child.completed' });
  expectEqual('03 §3.9', 'exactly one child.completed event', childCompleted.length, 1);
  expectEqual('03 §3.9', 'the event belongs to the completed execution', childCompleted[0].taskId, execution.id);

  const url = await startApi(t, runtime);
  const businessBody = await expectStatus(
    '03 §1.3',
    'the parent projection over HTTP',
    await fetch(`${url}/v1/tasks/${business.id}`),
    200,
  );
  expectNotEqual('03 §1.3', 'the API does not report the parent as completed', businessBody.state, 'completed');
});

test('[PRD 03 §3.9 + §4.1 G28] a parent acceptance opens only after the children pass', async (t) => {
  const { adapter } = createExecutor();
  const { runtime } = openRuntime(t, { adapter });
  const { business, execution } = createTree(runtime);

  // The parent is running while its child is still active.
  runtime.service.queueTask({ taskId: business.id });
  runtime.service.transitionTask({ taskId: business.id, to: 'running' });
  const blocked = expectCode(
    '03 §3.9',
    'business acceptance with an incomplete child',
    () => runtime.service.claimReadiness({ taskId: business.id, claim: { nonce: 'ready-too-early' } }),
    'invalid_state_transition',
  );
  expectTrue(
    '03 §3.9',
    'the refusal is the children gate (G28/G35)',
    ['G28', 'G35'].includes(blocked.details?.guard),
  );
  expectEqual(
    '03 §3.9',
    'no business acceptance was opened',
    runtime.service.listAcceptances({ taskId: business.id }).length,
    0,
  );

  // Complete and pass the child, then the same readiness claim is legal.
  const { run } = await startRun(runtime, execution.id);
  const claimed = await reportClaim(runtime, run.id, 'gate-child');
  passAll(runtime, claimed.acceptance);

  const ready = runtime.service.claimReadiness({ taskId: business.id, claim: { nonce: 'ready-after' } });
  expectEqual('03 §3.9', 'the business task becomes reviewable', ready.task.state, 'accepting');
  expectEqual('03 §3.9', 'the business acceptance is open', ready.acceptance.state, 'open');
  expectEqual('03 §3.9', 'the acceptance stage is business', ready.acceptance.stage, 'business');

  // Its own level still has to pass before it can complete.
  expectCode(
    '03 §4.1',
    'parent completion needs its own passed acceptance',
    () => runtime.service.completeTask({ taskId: business.id }),
    'missing_acceptance',
  );
  const businessDecision = passAll(runtime, ready.acceptance);
  expectEqual('03 §4.1', 'the parent completes on its own pass', businessDecision.task.state, 'completed');
});
