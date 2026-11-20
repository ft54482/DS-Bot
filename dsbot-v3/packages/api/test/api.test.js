import test from 'node:test';
import assert from 'node:assert/strict';

import { createExecutionTask, startTestApi, validClaim } from './helpers.js';

test('POST /v1/tasks replays the first result for the same Idempotency-Key', async (t) => {
  const api = await startTestApi(t);

  const first = await api.post(
    '/v1/tasks',
    { level: 'execution', title: 'idempotent create' },
    'create-key-1',
  );
  assert.equal(first.status, 201);
  assert.equal(first.body.level, 'execution');
  assert.equal(first.body.task.level, 'execution');
  const taskId = first.body.task.id;

  const second = await api.post(
    '/v1/tasks',
    { level: 'execution', title: 'idempotent create' },
    'create-key-1',
  );
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.task.id, taskId);
  assert.equal(second.headers.get('idempotency-replayed'), 'true');

  const conflict = await api.post(
    '/v1/tasks',
    { level: 'execution', title: 'different payload' },
    'create-key-1',
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

test('dispatch is idempotent and a second key cannot create a parallel active run', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'dispatch idempotency' }, 'task-key-1');
  const taskId = created.body.task.id;

  const first = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-1');
  assert.equal(first.status, 200);
  assert.equal(first.body.run.state, 'dispatched');
  assert.equal(first.body.run_id, first.body.run.id);

  const second = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-1');
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.run.id, first.body.run.id);

  const parallel = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-2');
  assert.equal(parallel.status, 409);
  assert.equal(parallel.body.code, 'invalid_state_transition');
});

test('claim is illegal on a dispatched run (409) and never completes the task', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'claim semantics' }, 'task-key-2');
  const taskId = created.body.task.id;
  const dispatched = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-3');
  const runId = dispatched.body.run.id;

  const early = await api.post('/v1/runs/' + runId + '/claim', { claim: validClaim() }, 'claim-early');
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'invalid_state_transition');
  assert.equal(early.body.details.from, 'dispatched');
  assert.equal(early.body.details.to, 'reported');

  const acked = await api.post('/v1/runs/' + runId + '/ack', { instance_id: 'test' }, 'ack-1');
  assert.equal(acked.status, 200);
  assert.equal(acked.body.run.state, 'running');
  assert.equal(acked.body.task.state, 'running');

  const claimed = await api.post('/v1/runs/' + runId + '/claim', { claim: validClaim() }, 'claim-1');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.task.state, 'accepting');
  assert.notEqual(claimed.body.task.state, 'completed');
  assert.equal(claimed.body.run.state, 'reported');
  assert.notEqual(claimed.body.run.state, 'accepted');
  assert.equal(claimed.body.acceptance.state, 'open');
  assert.equal(claimed.body.acceptance_id, claimed.body.acceptance.id);

  const current = await api.get('/v1/tasks/' + taskId);
  assert.equal(current.body.task.state, 'accepting');
  assert.equal(current.body.open_acceptance.state, 'open');
  assert.equal(current.body.current_run.state, 'reported');
});

test('verdict pass requires every required item, then completes through the acceptance', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'completion path' }, 'task-key-3');
  const taskId = created.body.task.id;
  const dispatched = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-4');
  const runId = dispatched.body.run.id;
  await api.post('/v1/runs/' + runId + '/ack', {}, 'ack-2');
  const claimed = await api.post('/v1/runs/' + runId + '/claim', { claim: validClaim() }, 'claim-2');
  const acceptanceId = claimed.body.acceptance.id;

  const incomplete = await api.post(
    '/v1/acceptances/' + acceptanceId + '/verdict',
    { verdict: 'pass' },
    'verdict-incomplete',
  );
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.code, 'acceptance_incomplete');
  assert.equal((await api.get('/v1/tasks/' + taskId)).body.task.state, 'accepting');

  const passed = await api.post(
    '/v1/acceptances/' + acceptanceId + '/verdict',
    { verdict: 'pass', item_states: { 'auto.checks': 'pass' } },
    'verdict-pass',
  );
  assert.equal(passed.status, 200);
  assert.equal(passed.body.acceptance.state, 'passed');
  assert.equal(passed.body.task.state, 'completed');

  const completed = await api.get('/v1/tasks/' + taskId);
  assert.equal(completed.body.task.state, 'completed');
  assert.equal(completed.body.current_run.state, 'accepted');
  assert.equal(completed.body.task.terminalAt !== null, true);
  assert.equal(completed.body.acceptances.length, 1);
  assert.equal(completed.body.acceptances[0].state, 'passed');
});

test('POST /v1/acceptances opens a round from the PRD payload and is idempotent', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'acceptance endpoint' }, 'task-key-4');
  const taskId = created.body.task.id;
  const dispatched = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-5');
  const runId = dispatched.body.run.id;
  await api.post('/v1/runs/' + runId + '/ack', {}, 'ack-3');

  const body = {
    stage: 'execution',
    target_task_id: taskId,
    run_id: runId,
    target_commit: 'c'.repeat(40),
    artifact_hashes: [{ path: 'out/result.json', sha256: 'd'.repeat(64) }],
    nonce: 'acceptance-nonce-1',
  };
  const opened = await api.post('/v1/acceptances', body, 'acceptance-key-1');
  assert.equal(opened.status, 201);
  assert.equal(opened.body.created, true);
  assert.equal(opened.body.acceptance.state, 'open');
  assert.equal(opened.body.task.state, 'accepting');
  assert.equal(opened.body.acceptance.taskId, taskId);

  const replay = await api.post('/v1/acceptances', body, 'acceptance-key-1');
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.acceptance.id, opened.body.acceptance.id);

  const accepted = await api.post(
    '/v1/acceptances/' + opened.body.acceptance.id + '/verdict',
    { verdict: 'passed', items: { 'auto.checks': 'pass' } },
    'acceptance-verdict-1',
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.task.state, 'completed');
});

test('POST /v1/acceptances rejects a stage that does not match the task level', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'stage mismatch' }, 'task-key-5');
  const taskId = created.body.task.id;
  const dispatched = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-6');
  const runId = dispatched.body.run.id;
  await api.post('/v1/runs/' + runId + '/ack', {}, 'ack-4');

  const mismatch = await api.post(
    '/v1/acceptances',
    {
      stage: 'business',
      target_task_id: taskId,
      run_id: runId,
      target_commit: 'e'.repeat(40),
      artifact_hashes: [{ path: 'out/result.json', sha256: 'f'.repeat(64) }],
      nonce: 'stage-mismatch',
    },
    'acceptance-key-2',
  );
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.code, 'validation_error');
});

test('POST /v1/tasks/:id/stop freezes the subtree and stays 202 until verification', async (t) => {
  const api = await startTestApi(t);
  const created = await createExecutionTask(api, { title: 'stop semantics' }, 'task-key-6');
  const taskId = created.body.task.id;
  const dispatched = await api.post('/v1/tasks/' + taskId + '/dispatch', {}, 'dispatch-key-7');
  const runId = dispatched.body.run.id;

  const stopped = await api.post('/v1/tasks/' + taskId + '/stop', { scope: 'subtree' }, 'stop-key-1');
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.task.state, 'stopping');
  assert.equal(stopped.body.task.stopState, 'requested');
  assert.equal(stopped.body.stop_state, 'requested');
  assert.equal(stopped.body.verified, false);
  assert.notEqual(stopped.body.task.state, 'cancelled');

  const after = await api.get('/v1/tasks/' + taskId);
  assert.equal(after.body.task.state, 'stopping');
  assert.equal(after.body.current_run.cancelRequestedAt !== null, true);

  const verified = await api.post(
    '/v1/tasks/' + taskId + '/stop',
    {
      verification: {
        runId,
        cancelAck: true,
        processGone: true,
        quiescenceWindowMs: 5000,
        windowStartedAt: 10_000,
        lastWriteAt: 9_000,
        namespaceHashBefore: 'namespace-a',
        namespaceHashAfter: 'namespace-a',
        openFileHandles: 0,
      },
    },
    'stop-key-2',
  );
  assert.equal(verified.status, 200);
  assert.equal(verified.body.verified, true);
  assert.equal(verified.body.task.state, 'cancelled');
});

test('GET /v1/tasks/:id returns the task package and 404 for an unknown task', async (t) => {
  const api = await startTestApi(t);
  const missing = await api.get('/v1/tasks/task-does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');

  const created = await createExecutionTask(api, { title: 'read package' }, 'task-key-7');
  const taskId = created.body.task.id;
  const packageResponse = await api.get('/v1/tasks/' + taskId);
  assert.equal(packageResponse.status, 200);
  assert.equal(packageResponse.body.task.id, taskId);
  assert.ok(Array.isArray(packageResponse.body.runs));
  assert.ok(Array.isArray(packageResponse.body.acceptances));
  assert.ok(Array.isArray(packageResponse.body.claims));
  assert.equal(packageResponse.body.open_acceptance, null);
});

test('hierarchy violations surface as 409 hierarchy_violation', async (t) => {
  const api = await startTestApi(t);
  const goal = await api.post('/v1/tasks', { level: 'goal', title: 'goal' }, 'goal-key');
  assert.equal(goal.status, 201);

  const child = await api.post(
    '/v1/tasks',
    { level: 'execution', parent_task_id: goal.body.task.id, title: 'skipped level' },
    'child-key',
  );
  assert.equal(child.status, 409);
  assert.equal(child.body.code, 'hierarchy_violation');
});

test('the optional local token gates the API', async (t) => {
  const api = await startTestApi(t, { token: 'secret-token' });
  const unauthorized = await api.get('/v1/health');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, 'unauthorized');

  const health = await api.get('/v1/health', { authorization: 'Bearer secret-token' });
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
});
