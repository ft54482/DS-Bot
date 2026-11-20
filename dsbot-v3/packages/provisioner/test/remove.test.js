import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { provision } from '../src/provision.js';
import { removeProvision } from '../src/remove.js';
import {
  baseOptions,
  createTestFs,
  dshHomeFor,
  pathsFor,
  readRegistryFile,
} from './support/fixtures.js';

test('remove deletes the profile directory and registry entry but keeps state', async () => {
  const fs = createTestFs();
  const created = await provision(baseOptions(fs));
  const result = removeProvision({ name: 'lab-one', fs });

  assert.equal(result.removed, true);
  assert.equal(result.profileDir, created.profileDir);
  assert.equal(result.stateRemoved, false);
  assert.equal(fs.exists(created.profileDir), false);
  assert.equal(fs.exists(created.stateDir), true);
  assert.deepEqual(readRegistryFile(fs, dshHomeFor(fs)).instances, []);
});

test('remove --remove-state also deletes the state directory and work root', async () => {
  const fs = createTestFs();
  const created = await provision(baseOptions(fs));
  const result = removeProvision({ name: 'lab-one', fs, removeState: true });

  assert.equal(result.removed, true);
  assert.equal(result.stateRemoved, true);
  assert.equal(fs.exists(created.stateDir), false);
  assert.equal(fs.exists(created.workRoot), false);
});

test('removing an unknown instance is an idempotent no-op', () => {
  const fs = createTestFs();
  const result = removeProvision({ name: 'missing', fs });
  assert.equal(result.removed, false);
  assert.equal(fs.exists(path.join(dshHomeFor(fs), 'profiles', 'missing')), false);
});

test('remove refuses to delete an unmanaged profile directory', () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  fs.mkdir(paths.profileDir);
  const file = path.join(paths.profileDir, 'cordis.patch.yml');
  fs.writeFile(file, 'webserver:\n  port: 3999\n');

  assert.throws(() => removeProvision({ name: 'lab-one', fs }), (error) => {
    assert.equal(error.code, 'profile_exists');
    assert.equal(error.details.path, paths.profileDir);
    return true;
  });
  assert.equal(fs.readFile(file), 'webserver:\n  port: 3999\n');
});

test('removing one instance preserves the others', async () => {
  const fs = createTestFs();
  const one = await provision(baseOptions(fs, { name: 'one', port: 3091 }));
  const two = await provision(baseOptions(fs, { name: 'two', port: 3092 }));

  removeProvision({ name: 'one', fs });

  assert.equal(fs.exists(one.profileDir), false);
  assert.equal(fs.exists(two.profileDir), true);
  const registry = readRegistryFile(fs, dshHomeFor(fs));
  assert.deepEqual(registry.instances.map((item) => item.name), ['two']);
});
