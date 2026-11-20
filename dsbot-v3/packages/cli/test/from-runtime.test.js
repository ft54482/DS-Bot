import assert from 'node:assert/strict';
import test from 'node:test';

import { createDepsFromRuntime } from '../src/from-runtime.js';
import { spy } from './helpers.js';

function baseRuntime() {
  const task = {
    id: 'task-1',
    level: 'goal',
    state: 'planned',
    title: 'demo',
    openAcceptanceId: null,
  };
  return {
    tasks: {
      create: spy((input) => ({ id: 'task-1', level: input.level, state: 'planned', title: input.title })),
      list: spy(() => []),
      get: spy(() => ({ ...task })),
      dispatch: spy(({ taskId }) => ({
        task: { id: taskId, level: 'execution', state: 'queued' },
        run: { id: 'run-1', taskId, state: 'dispatched' },
      })),
    },
    runs: {
      get: spy(() => ({ id: 'run-1', taskId: 'task-1', state: 'reported' })),
      list: spy(() => [{ id: 'run-1', taskId: 'task-1', state: 'reported' }]),
    },
    acceptances: {
      get: spy((acceptanceId) => ({ id: acceptanceId, state: 'open' })),
      list: spy(() => [{ id: 'acc-1', state: 'open' }]),
      decide: spy(({ acceptanceId }) => ({
        task: { id: 'task-1', state: 'completed' },
        acceptance: { id: acceptanceId, state: 'passed' },
      })),
    },
    stop: {
      request: spy(({ taskId }) => ({
        task: { id: taskId, state: 'stopping', stopState: 'requested' },
        tasks: [],
        stopState: 'requested',
      })),
    },
    cost: {
      total: spy((taskId) => ({
        taskId,
        entries: 2,
        tokensIn: 10,
        tokensOut: 20,
        tokensCached: 0,
        costCny: 0.5,
      })),
    },
  };
}

test('forwards task operations to the runtime facade', async () => {
  const runtime = baseRuntime();
  const deps = createDepsFromRuntime(runtime);

  assert.deepEqual(await deps.createTask({ level: 'goal', title: 'x' }), {
    id: 'task-1',
    level: 'goal',
    state: 'planned',
    title: 'x',
  });
  assert.deepEqual(await deps.listTasks({ level: 'goal' }), []);
  assert.deepEqual(await deps.dispatchTask('task-1', { executorKind: 'tool_chain' }), {
    task: { id: 'task-1', level: 'execution', state: 'queued' },
    run: { id: 'run-1', taskId: 'task-1', state: 'dispatched' },
  });
  assert.deepEqual(await deps.stopTask('task-1', { reason: 'user_stop' }), {
    task: { id: 'task-1', state: 'stopping', stopState: 'requested' },
    tasks: [],
    stopState: 'requested',
  });
  assert.deepEqual(await deps.getCost('task-1'), {
    taskId: 'task-1',
    entries: 2,
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 0,
    costCny: 0.5,
  });

  assert.deepEqual(runtime.tasks.create.calls, [[{ level: 'goal', title: 'x' }]]);
  assert.deepEqual(runtime.tasks.list.calls, [[{ level: 'goal' }]]);
  assert.deepEqual(runtime.tasks.dispatch.calls, [[{ taskId: 'task-1', executorKind: 'tool_chain' }]]);
  assert.deepEqual(runtime.stop.request.calls, [[{ taskId: 'task-1', reason: 'user_stop' }]]);
  assert.deepEqual(runtime.cost.total.calls, [['task-1']]);
});

test('task detail composes the task, run list, acceptance list and open acceptance', async () => {
  const runtime = baseRuntime();
  runtime.tasks.get = spy(() => ({
    id: 'task-1',
    level: 'execution',
    state: 'accepting',
    openAcceptanceId: 'acc-1',
  }));
  const deps = createDepsFromRuntime(runtime);
  const detail = await deps.getTask('task-1');

  assert.equal(detail.task.state, 'accepting');
  assert.deepEqual(detail.runs, [{ id: 'run-1', taskId: 'task-1', state: 'reported' }]);
  assert.deepEqual(detail.acceptances, [{ id: 'acc-1', state: 'open' }]);
  assert.deepEqual(detail.open_acceptance, { id: 'acc-1', state: 'open' });
  assert.deepEqual(runtime.tasks.get.calls, [['task-1']]);
  assert.deepEqual(runtime.runs.list.calls, [[{ taskId: 'task-1' }]]);
  assert.deepEqual(runtime.acceptances.list.calls, [[{ taskId: 'task-1' }]]);
  assert.deepEqual(runtime.acceptances.get.calls, [['acc-1']]);
});

test('accept resolves the open acceptance of a run and decides it with an options object', async () => {
  const runtime = baseRuntime();
  const deps = createDepsFromRuntime(runtime);
  const result = await deps.acceptRun('run-1', { verdict: 'pass' });

  assert.deepEqual(runtime.runs.get.calls, [['run-1']]);
  assert.deepEqual(runtime.acceptances.decide.calls, [
    [{ acceptanceId: 'acc-1', verdict: 'pass' }],
  ]);
  assert.equal(result.acceptance.id, 'acc-1');
  assert.equal(result.run.id, 'run-1');
  assert.equal(result.task.state, 'completed');
});

test('accept prefers the task open acceptance id', async () => {
  const runtime = baseRuntime();
  runtime.tasks.get = spy(() => ({
    id: 'task-1',
    state: 'accepting',
    openAcceptanceId: 'acc-open',
  }));
  runtime.acceptances.get = spy((acceptanceId) => ({ id: acceptanceId, state: 'open' }));
  const deps = createDepsFromRuntime(runtime);
  await deps.acceptRun('run-1', { verdict: 'fail', reason: 'nope' });

  assert.deepEqual(runtime.acceptances.get.calls, [['acc-open']]);
  assert.deepEqual(runtime.acceptances.list.calls, []);
  assert.deepEqual(runtime.acceptances.decide.calls, [
    [{ acceptanceId: 'acc-open', verdict: 'fail', reason: 'nope' }],
  ]);
});

test('accept can find the open acceptance through the run list', async () => {
  const runtime = baseRuntime();
  runtime.acceptances.list = spy(() => [
    { id: 'acc-closed', state: 'closed' },
    { id: 'acc-open', state: 'open' },
  ]);
  const deps = createDepsFromRuntime(runtime);
  await deps.acceptRun('run-1', { verdict: 'pass' });

  assert.deepEqual(runtime.acceptances.list.calls, [[{ runId: 'run-1', state: 'open' }]]);
  assert.deepEqual(runtime.acceptances.decide.calls, [[{ acceptanceId: 'acc-open', verdict: 'pass' }]]);
});

test('accept prefers decideByRun when the facade provides it without a runs namespace', async () => {
  const runtime = baseRuntime();
  runtime.acceptances.decideByRun = spy(() => ({ acceptance: { id: 'acc-9', state: 'passed' } }));
  delete runtime.runs;
  const deps = createDepsFromRuntime(runtime);
  const result = await deps.acceptRun('run-2', { verdict: 'fail' });

  assert.deepEqual(runtime.acceptances.decideByRun.calls, [['run-2', { verdict: 'fail' }]]);
  assert.equal(result.acceptance.id, 'acc-9');
});

test('accept reports not_found when the run has no open acceptance', async () => {
  const runtime = baseRuntime();
  runtime.acceptances.list = spy(() => []);
  const deps = createDepsFromRuntime(runtime);
  await assert.rejects(deps.acceptRun('run-1', { verdict: 'pass' }), (error) => {
    assert.equal(error.code, 'not_found');
    assert.equal(error.status, 404);
    return true;
  });
});

test('stop prefers the full verified stop path and normalizes its result', async () => {
  const runtime = baseRuntime();
  runtime.stop.stop = spy(({ taskId }) => ({
    requested: { id: taskId, state: 'stopping', stopState: 'requested' },
    tasks: [{ id: taskId, state: 'cancelled', stopState: 'verified' }],
    stopState: 'verified',
    cancelled: true,
    blockers: [],
  }));
  const deps = createDepsFromRuntime(runtime);
  const result = await deps.stopTask('task-1', { reason: 'user_stop' });

  assert.deepEqual(runtime.stop.stop.calls, [[{ taskId: 'task-1', reason: 'user_stop' }]]);
  assert.equal(runtime.stop.request.calls.length, 0);
  assert.equal(result.task.state, 'cancelled');
  assert.equal(result.stopState, 'verified');
});

test('accepts the createTask/getTask/requestStop/summary aliases', async () => {
  const runtime = {
    tasks: {
      createTask: spy(() => ({ id: 'task-1' })),
      listTasks: spy(() => []),
      getTask: spy((id) => ({ id, state: 'planned', openAcceptanceId: 'acc-1' })),
      dispatchTask: spy(({ taskId }) => ({ task: { id: taskId }, run: { id: 'run-1' } })),
    },
    runs: {
      get: spy(() => ({ id: 'run-1', taskId: 'task-1' })),
      listRuns: spy(() => []),
    },
    acceptances: {
      getAcceptance: spy((id) => ({ id, state: 'open' })),
      listAcceptances: spy(() => []),
      decideAcceptance: spy(({ acceptanceId }) => ({
        task: { id: 'task-1' },
        acceptance: { id: acceptanceId },
      })),
    },
    stop: { requestStop: spy(({ taskId }) => ({ task: { id: taskId }, stopState: 'requested' })) },
    cost: { summary: spy(() => ({ task_id: 'task-1', cost_cny: 2 })) },
  };
  const deps = createDepsFromRuntime(runtime);
  assert.equal((await deps.createTask({ level: 'goal', title: 'x' })).id, 'task-1');
  assert.equal((await deps.getTask('task-1')).task.id, 'task-1');
  assert.equal((await deps.dispatchTask('task-1', {})).run.id, 'run-1');
  assert.equal((await deps.acceptRun('run-1', { verdict: 'pass' })).acceptance.id, 'acc-1');
  assert.equal((await deps.stopTask('task-1', {})).task.id, 'task-1');
  assert.equal((await deps.getCost('task-1')).cost_cny, 2);
});

test('missing namespaces and malformed runtimes fail loudly', async () => {
  assert.throws(
    () => createDepsFromRuntime(null),
    (error) => error.code === 'internal_error' && error.status === 500,
  );
  const deps = createDepsFromRuntime({ tasks: {} });
  await assert.rejects(deps.listTasks({}), (error) => {
    assert.equal(error.code, 'internal_error');
    assert.equal(error.status, 500);
    return true;
  });
  const noAcceptances = createDepsFromRuntime({ tasks: { get: async () => ({}) }, runs: {} });
  await assert.rejects(noAcceptances.acceptRun('run-1', { verdict: 'pass' }), (error) => {
    assert.equal(error.code, 'internal_error');
    return true;
  });
});
