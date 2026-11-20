import assert from 'node:assert/strict';
import test from 'node:test';

import { openAcceptingRun } from './support/harness.js';

test('api: the mounted /v1 server reads the same service and store', async (t) => {
  const { runtime, tree, claimed } = await openAcceptingRun(t);
  runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'pass' },
  });

  const url = await runtime.api.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const health = await fetch(`${url}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const taskResponse = await fetch(`${url}/v1/tasks/${tree.execution.id}`);
  assert.equal(taskResponse.status, 200);
  const taskBody = await taskResponse.json();
  assert.equal(taskBody.id, tree.execution.id);
  assert.equal(taskBody.state, 'completed');
  assert.equal(taskBody.task.state, 'completed');
  assert.equal(taskBody.runs.length, 1);
  assert.equal(taskBody.runs[0].state, 'accepted');
  assert.equal(taskBody.acceptances.length, 1);
  assert.equal(taskBody.acceptances[0].state, 'passed');

  const missing = await fetch(`${url}/v1/tasks/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not_found');
});
