import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceError } from '../../service/src/errors.js';
import { runCli } from '../src/run-cli.js';
import { createDeps, jsonError, jsonOutput, spy } from './helpers.js';

function taskView(overrides = {}) {
  return {
    id: 'task-1',
    level: 'goal',
    state: 'planned',
    title: 'demo',
    parent_task_id: null,
    current_run_id: null,
    blocked_reason: null,
    stop_state: null,
    stop_unknown: false,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function runView(overrides = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    state: 'dispatched',
    executor_kind: null,
    attempt_no: null,
    created_at: null,
    ...overrides,
  };
}

function acceptanceView(overrides = {}) {
  return {
    id: 'acc-1',
    task_id: 'task-1',
    run_id: 'run-1',
    state: 'passed',
    stage: null,
    round_no: null,
    decided_at: null,
    ...overrides,
  };
}

test('task create --json emits the projected task and forwards the input', async () => {
  const deps = createDeps();
  const result = await runCli(
    ['task', 'create', '--level', 'goal', '--title', 'hello', '--parent', 'task-0', '--actor', 'chief', '--json'],
    deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const payload = jsonOutput(result);
  assert.deepEqual(payload, {
    ok: true,
    command: 'task.create',
    data: {
      task: taskView({
        level: 'goal',
        title: 'hello',
        parent_task_id: 'task-0',
      }),
    },
  });
  assert.deepEqual(deps.createTask.calls, [
    [{ level: 'goal', title: 'hello', parentTaskId: 'task-0', actor: 'chief' }],
  ]);
});

test('task list --json projects tasks and forwards filters', async () => {
  const listTasks = spy(() => [
    { id: 'task-1', level: 'goal', state: 'planned', title: 'one' },
    { id: 'task-2', level: 'execution', state: 'running', title: 'two' },
  ]);
  const deps = createDeps({ listTasks });
  const result = await runCli(
    ['task', 'list', '--level', 'execution', '--state', 'running', '--limit', '10', '--json'],
    deps,
  );
  assert.equal(result.exitCode, 0);
  const payload = jsonOutput(result);
  assert.equal(payload.command, 'task.list');
  assert.equal(payload.data.count, 2);
  assert.deepEqual(payload.data.tasks[0], taskView({ title: 'one' }));
  assert.deepEqual(payload.data.tasks[1], taskView({ id: 'task-2', level: 'execution', state: 'running', title: 'two' }));
  assert.deepEqual(deps.listTasks.calls, [[{ level: 'execution', state: 'running', limit: 10 }]]);
});

test('task get --json includes runs, acceptances and the open acceptance', async () => {
  const getTask = spy((taskId) => ({
    task: { id: taskId, level: 'execution', state: 'accepting', title: 'deliverable' },
    runs: [{ id: 'run-1', taskId, state: 'reported', executorKind: 'dsh_session', attemptNo: 1 }],
    acceptances: [{ id: 'acc-1', taskId, runId: 'run-1', state: 'open', stage: 'execution', roundNo: 1 }],
    open_acceptance: { id: 'acc-1', taskId, runId: 'run-1', state: 'open', stage: 'execution', roundNo: 1 },
  }));
  const deps = createDeps({ getTask });
  const result = await runCli(['task', 'get', 'task-1', '--json'], deps);
  assert.equal(result.exitCode, 0);
  const payload = jsonOutput(result);
  assert.deepEqual(payload.data.task, taskView({ level: 'execution', state: 'accepting', title: 'deliverable' }));
  assert.deepEqual(payload.data.runs, [
    runView({ state: 'reported', executor_kind: 'dsh_session', attempt_no: 1 }),
  ]);
  assert.deepEqual(payload.data.acceptances, [
    acceptanceView({ state: 'open', stage: 'execution', round_no: 1 }),
  ]);
  assert.deepEqual(payload.data.open_acceptance, acceptanceView({ state: 'open', stage: 'execution', round_no: 1 }));
  assert.deepEqual(deps.getTask.calls, [['task-1']]);
});

test('dispatch --json returns the task and run', async () => {
  const deps = createDeps();
  const result = await runCli(
    ['dispatch', 'task-1', '--executor-kind', 'tool_chain', '--idempotency-key', 'key-1', '--json'],
    deps,
  );
  assert.equal(result.exitCode, 0);
  const payload = jsonOutput(result);
  assert.equal(payload.command, 'dispatch');
  assert.deepEqual(payload.data.task, taskView({ level: 'execution', state: 'queued' }));
  assert.deepEqual(payload.data.run, runView({ executor_kind: 'dsh_session' }));
  assert.deepEqual(deps.dispatchTask.calls, [
    ['task-1', { executorKind: 'tool_chain', idempotencyKey: 'key-1' }],
  ]);
});

test('accept pass/reject maps to the service verdict vocabulary', async () => {
  const deps = createDeps();
  const pass = await runCli(['accept', 'run-1', '--verdict', 'pass', '--json'], deps);
  assert.equal(pass.exitCode, 0);
  assert.deepEqual(jsonOutput(pass).data, {
    task: taskView({ level: 'execution', state: 'completed' }),
    acceptance: acceptanceView({ round_no: 1 }),
    run: null,
    verdict: 'pass',
  });
  assert.deepEqual(deps.acceptRun.calls[0], ['run-1', { verdict: 'pass' }]);

  const reject = await runCli(
    ['accept', 'run-1', '--verdict', 'reject', '--reason', 'missing source', '--items', '{"auto.checks":"fail"}', '--json'],
    deps,
  );
  assert.equal(reject.exitCode, 0);
  assert.equal(jsonOutput(reject).data.verdict, 'reject');
  assert.deepEqual(deps.acceptRun.calls[1], [
    'run-1',
    { verdict: 'fail', reason: 'missing source', itemStates: { 'auto.checks': 'fail' } },
  ]);
});

test('stop --json reports the stop state and verification', async () => {
  const deps = createDeps();
  const result = await runCli(['stop', 'task-1', '--reason', 'user_stop', '--json'], deps);
  assert.equal(result.exitCode, 0);
  const payload = jsonOutput(result);
  assert.equal(payload.data.stop_state, 'verified');
  assert.equal(payload.data.verified, true);
  assert.deepEqual(payload.data.tasks, [taskView({ state: 'cancelled', stop_state: 'verified' })]);
  assert.deepEqual(deps.stopTask.calls, [['task-1', { reason: 'user_stop' }]]);
});

test('cost --json reports totals and entries', async () => {
  const deps = createDeps({
    getCost: async (taskId) => ({
      taskId,
      total: { tokens_in: 10, tokens_out: 20, tokens_cached: 5, cost_cny: 0.25 },
      entries: [
        { kind: 'llm', runId: 'run-1', tokensIn: 10, tokensOut: 20, tokensCached: 5, costCny: 0.25 },
      ],
    }),
  });
  const result = await runCli(['cost', 'task-1', '--json'], deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(jsonOutput(result).data, {
    task_id: 'task-1',
    tokens_in: 10,
    tokens_out: 20,
    tokens_cached: 5,
    cost_cny: 0.25,
    entry_count: 1,
    entries: [
      {
        kind: 'llm',
        run_id: 'run-1',
        tokens_in: 10,
        tokens_out: 20,
        tokens_cached: 5,
        cost_cny: 0.25,
        created_at: null,
      },
    ],
  });
});

test('human output is stable for each command', async () => {
  const deps = createDeps();
  assert.equal(
    (await runCli(['task', 'create', '--level', 'goal', '--title', 'hello'], deps)).stdout,
    'created task task-1 level=goal state=planned title="hello"\n',
  );
  assert.equal(
    (await runCli(['task', 'list'], deps)).stdout,
    'no tasks\n',
  );
  assert.equal(
    (await runCli(['task', 'get', 'task-1'], deps)).stdout,
    'task task-1 level=goal state=planned title="demo"\nruns=0 acceptances=0\n',
  );
  assert.equal(
    (await runCli(['dispatch', 'task-1'], deps)).stdout,
    'dispatched task=task-1 run=run-1 state=dispatched\n',
  );
  assert.equal(
    (await runCli(['accept', 'run-1', '--verdict', 'pass'], deps)).stdout,
    'acceptance=acc-1 verdict=pass state=passed task=task-1\n',
  );
  assert.equal(
    (await runCli(['stop', 'task-1'], deps)).stdout,
    'stop task=task-1 state=cancelled stop_state=verified verified=true\n',
  );
  assert.equal(
    (await runCli(['cost', 'task-1'], deps)).stdout,
    'cost task=task-1 cny=0.25 tokens_in=10 tokens_out=20 tokens_cached=5 entries=0\n',
  );
});

test('repeated invocations produce byte-identical output', async () => {
  const deps = createDeps();
  const first = await runCli(['task', 'list', '--json'], deps);
  const second = await runCli(['task', 'list', '--json'], deps);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.exitCode, second.exitCode);
});

test('PRD error codes become exit codes and a stable JSON error payload', async () => {
  const cases = [
    ['invalid_state_transition', 409],
    ['forbidden_transition', 403],
    ['validation_error', 422],
    ['missing_acceptance', 422],
    ['duplicate_dispatch', 409],
  ];
  for (const [code, status] of cases) {
    const deps = createDeps({
      dispatchTask: async () => {
        throw new ServiceError(code, `failure from ${code}`, { taskId: 'task-1' });
      },
    });
    const result = await runCli(['dispatch', 'task-1', '--json'], deps);
    assert.equal(result.exitCode, status, code);
    assert.equal(result.stdout, '');
    const payload = jsonError(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.command, 'dispatch');
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.status, status);
    assert.deepEqual(payload.error.details, { taskId: 'task-1' });
  }
});

test('unknown runtime errors are internal errors and do not leak a stack', async () => {
  const deps = createDeps({
    listTasks: async () => {
      throw new Error('boom');
    },
  });
  const result = await runCli(['task', 'list', '--json'], deps);
  assert.equal(result.exitCode, 1);
  const payload = jsonError(result);
  assert.equal(payload.error.code, 'internal_error');
  assert.equal(payload.error.status, 500);
  assert.equal(payload.error.message, 'boom');
  assert.equal(JSON.stringify(payload).includes('stack'), false);
});

test('text-mode errors are one line on stderr', async () => {
  const deps = createDeps({
    stopTask: async () => {
      throw new ServiceError('forbidden_transition', 'not allowed');
    },
  });
  const result = await runCli(['stop', 'task-1'], deps);
  assert.equal(result.exitCode, 403);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error 403 forbidden_transition: not allowed\n');
});

test('missing deps fail as internal errors', async () => {
  const result = await runCli(['task', 'list', '--json'], {});
  assert.equal(result.exitCode, 1);
  assert.equal(jsonError(result).error.code, 'internal_error');
});

test('parse errors are reported in JSON when --json is requested', async () => {
  const result = await runCli(['accept', 'run-1', '--verdict', 'maybe', '--json'], createDeps());
  assert.equal(result.exitCode, 422);
  assert.equal(result.stdout, '');
  const payload = jsonError(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, null);
  assert.equal(payload.error.code, 'validation_error');
  assert.equal(payload.error.status, 422);
});

test('help and version do not require deps', async () => {
  const help = await runCli(['--help'], null);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Usage: superagent/);
  const commandHelp = await runCli(['task', 'create', '--help'], null);
  assert.equal(commandHelp.exitCode, 0);
  assert.match(commandHelp.stdout, /task create --level/);
  const version = await runCli(['--version'], null);
  assert.equal(version.exitCode, 0);
  assert.equal(version.stdout, 'superagent 0.1.0\n');
});
