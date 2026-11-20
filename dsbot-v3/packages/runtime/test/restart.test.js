import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRuntime } from '../src/index.js';
import { createClock, createExecutor, createIds, createTree } from './support/harness.js';

test('dispatch: duplicate dispatch survives a restart without a second run', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsbot-runtime-restart-'));
  const dbPath = join(tempRoot, 'runtime.sqlite');
  const clock = createClock();
  const ids = createIds();
  let second = null;

  const first = createRuntime({
    dbPath,
    adapters: { mock: createExecutor({ clock }).adapter },
    clock: clock.now,
    idFactory: ids.next,
  });
  t.after(async () => {
    await first.close();
    await second?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });
  const { goal, business, execution } = createTree(first);
  const dispatched = first.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'restart-dispatch-1',
  });
  const runId = dispatched.run.id;
  const eventsBefore = first.service.listEvents().map((event) => event.hash);
  const costsBefore = first.cost.list(execution.id).length;
  await first.close();

  // Reopen the same database file: state, runs and idempotency records survive.
  second = createRuntime({
    dbPath,
    adapters: { mock: createExecutor({ clock }).adapter },
    clock: clock.now,
    idFactory: ids.next,
  });

  assert.equal(second.tasks.get(goal.id).state, 'planned');
  assert.equal(second.tasks.get(business.id).state, 'planned');
  assert.equal(second.tasks.get(execution.id).state, 'queued');
  assert.equal(second.runs.get(runId).state, 'dispatched');
  assert.equal(second.runs.get(runId).executorKind, 'mock');
  assert.equal(second.runs.list({ taskId: execution.id }).length, 1);
  assert.deepEqual(
    second.service.listEvents().map((event) => event.hash),
    eventsBefore,
    'the append-only ledger is intact after reopen',
  );

  const replayed = second.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'restart-dispatch-1',
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.run.id, runId);
  assert.equal(second.runs.list({ taskId: execution.id }).length, 1);
  assert.equal(second.cost.list(execution.id).length, costsBefore);
});
