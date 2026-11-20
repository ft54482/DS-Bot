import assert from 'node:assert/strict';
import test from 'node:test';

import { openRuntime } from './support/harness.js';

test('composition: createRuntime assembles store, service, api and adapters', (t) => {
  const { runtime, adapter } = openRuntime(t);

  // The facade the CLI and the monitor consume.
  for (const name of ['tasks', 'runs', 'acceptances', 'cost', 'stop']) {
    assert.equal(typeof runtime[name], 'object', `facade must expose ${name}`);
  }

  // L1 store: a migrated SQLite database behind the same runtime.
  assert.equal(typeof runtime.store.getTask, 'function');
  assert.ok(runtime.store.schemaVersion() >= 1, 'the store is migrated before use');

  // L2 service: the state machine, not a runtime re-implementation.
  assert.equal(typeof runtime.service.createTask, 'function');
  assert.equal(typeof runtime.service.dispatchTask, 'function');

  // L6 api: a server object mounted on the same service/store.
  assert.equal(typeof runtime.api.start, 'function');
  assert.equal(runtime.api.url(), null, 'the API is not listening until start()');

  // L3 adapters: the registered executor is frozen into the router.
  assert.equal(runtime.adapters.mock, adapter);
  assert.equal(runtime.router.adapters.mock, adapter);
  assert.deepEqual(runtime.config.adapters, ['mock']);
  assert.equal(runtime.config.dbPath, ':memory:');

  // One store behind every layer: a task written through the facade is visible
  // to the service object.
  const goal = runtime.tasks.create({ level: 'goal', title: 'one store' });
  assert.equal(runtime.service.getTask(goal.id).id, goal.id);
});
