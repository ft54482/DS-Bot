import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskService } from '../../service/src/index.js';
import { createDepsFromRuntime } from '../src/from-runtime.js';
import { main } from '../src/main.js';
import { runCli } from '../src/run-cli.js';
import { captureStream, jsonError, jsonOutput } from './helpers.js';

/**
 * A runtime facade assembled from the real L2 service and its in-memory store.
 * This is a test fixture for the CLI boundary: state decisions still come from
 * `packages/service`, and no database or network is opened.
 */
function createInMemoryRuntime() {
  const service = createTaskService();
  const costs = new Map();
  const runtime = {
    tasks: {
      create: (input) => service.createTask(input),
      list: (filter) => service.store.listTasks(filter),
      get: (taskId) => service.getTask(taskId),
      dispatch: ({ taskId, ...options } = {}) => service.dispatchTask({ taskId, ...options }),
    },
    runs: {
      get: (runId) => service.getRun(runId),
      list: (filter) => service.listRuns(filter),
    },
    acceptances: {
      get: (acceptanceId) => service.getAcceptance(acceptanceId),
      list: (filter) => service.listAcceptances(filter),
      decide: (options = {}) => service.decideAcceptance(options),
    },
    stop: { request: (options = {}) => service.requestStop(options) },
    cost: {
      total: (taskId) => ({
        taskId,
        entries: 0,
        ...(costs.get(taskId) ?? {}),
      }),
    },
  };
  return { runtime, service, costs };
}

test('main wires argv through the runtime adapter and writes the result', async () => {
  const { runtime } = createInMemoryRuntime();
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await main(['task', 'create', '--level', 'goal', '--title', 'smoke', '--json'], {
    loadRuntime: async () => runtime,
    stdout,
    stderr,
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), '');
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.ok, true);
  assert.equal(payload.data.task.level, 'goal');
  assert.equal(payload.data.task.state, 'planned');
});

test('main reports a missing runtime as a clear error', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await main(['task', 'list', '--json'], {
    loadRuntime: async () => {
      throw Object.assign(new Error('packages/runtime is not available'), {
        code: 'runtime_unavailable',
        status: 503,
      });
    },
    stdout,
    stderr,
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  const payload = JSON.parse(stderr.text());
  assert.equal(payload.error.code, 'runtime_unavailable');
  assert.equal(payload.error.status, 503);
});

test('main does not load the runtime for help or version', async () => {
  let loaded = 0;
  const stdout = captureStream();
  const stderr = captureStream();
  const helpCode = await main(['--help'], {
    loadRuntime: async () => {
      loaded += 1;
      return {};
    },
    stdout,
    stderr,
  });
  assert.equal(helpCode, 0);
  assert.match(stdout.text(), /Usage: superagent/);
  const versionCode = await main(['--version'], {
    loadRuntime: async () => {
      loaded += 1;
      return {};
    },
    stdout,
    stderr,
  });
  assert.equal(versionCode, 0);
  assert.equal(loaded, 0);
});

test('CLI drives the real service state machine end to end in memory', async () => {
  const { runtime, service, costs } = createInMemoryRuntime();
  const deps = createDepsFromRuntime(runtime);

  const goal = jsonOutput(
    await runCli(['task', 'create', '--level', 'goal', '--title', 'goal', '--json'], deps),
  ).data.task;
  const business = jsonOutput(
    await runCli(
      ['task', 'create', '--level', 'business', '--title', 'business', '--parent', goal.id, '--json'],
      deps,
    ),
  ).data.task;
  const execution = jsonOutput(
    await runCli(
      ['task', 'create', '--level', 'execution', '--title', 'execution', '--parent', business.id, '--json'],
      deps,
    ),
  ).data.task;

  const list = jsonOutput(await runCli(['task', 'list', '--json'], deps));
  assert.equal(list.data.count, 3);

  const dispatchGoal = await runCli(['dispatch', goal.id, '--json'], deps);
  assert.equal(dispatchGoal.exitCode, 422);
  assert.equal(jsonError(dispatchGoal).error.code, 'validation_error');

  const dispatched = jsonOutput(await runCli(['dispatch', execution.id, '--json'], deps));
  const runId = dispatched.data.run.id;
  service.ackRun({ runId });
  service.claimRun({
    runId,
    claim: {
      commit: 'a'.repeat(40),
      dirty: false,
      manifest: [{ path: 'article.md', sha256: 'b'.repeat(64) }],
      nonce: 'nonce-1',
      summary: 'draft delivered',
    },
  });

  const accepting = jsonOutput(await runCli(['task', 'get', execution.id, '--json'], deps));
  assert.equal(accepting.data.task.state, 'accepting');
  assert.equal(accepting.data.open_acceptance.state, 'open');

  const accepted = await runCli(
    [
      'accept',
      runId,
      '--verdict',
      'pass',
      '--items',
      '{"auto.checks":"pass"}',
      '--json',
    ],
    deps,
  );
  assert.equal(accepted.exitCode, 0);
  const acceptedData = jsonOutput(accepted).data;
  assert.equal(acceptedData.verdict, 'pass');
  assert.equal(acceptedData.acceptance.state, 'passed');
  assert.equal(acceptedData.task.state, 'completed');

  costs.set(execution.id, {
    tokensIn: 100,
    tokensOut: 200,
    tokensCached: 50,
    costCny: 0.75,
  });
  const cost = jsonOutput(await runCli(['cost', execution.id, '--json'], deps));
  assert.deepEqual(cost.data, {
    task_id: execution.id,
    tokens_in: 100,
    tokens_out: 200,
    tokens_cached: 50,
    cost_cny: 0.75,
    entry_count: 0,
    entries: [],
  });

  const stopped = await runCli(['stop', goal.id, '--json'], deps);
  assert.equal(stopped.exitCode, 0);
  const stopData = jsonOutput(stopped).data;
  assert.equal(stopData.task.state, 'stopping');
  assert.equal(stopData.stop_state, 'requested');
  assert.equal(stopData.verified, false);
});
