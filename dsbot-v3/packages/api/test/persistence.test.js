import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startTestApi } from './helpers.js';

test('SQLite-backed API persists tasks and idempotency records across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsbot-api-'));
  const databasePath = join(directory, 'tasks.sqlite');
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const first = await startTestApi(t, { databasePath });
  const created = await first.post(
    '/v1/tasks',
    { level: 'execution', title: 'persisted task', project: 'api-test' },
    'persist-key-1',
  );
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  await first.close();

  const second = await startTestApi(t, { databasePath });
  const loaded = await second.get('/v1/tasks/' + taskId);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.task.id, taskId);
  assert.equal(loaded.body.task.title, 'persisted task');
  assert.equal(loaded.body.task.project, 'api-test');

  const replay = await second.post(
    '/v1/tasks',
    { level: 'execution', title: 'persisted task', project: 'api-test' },
    'persist-key-1',
  );
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.task.id, taskId);
  await second.close();
});
