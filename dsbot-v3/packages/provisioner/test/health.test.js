import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { provision } from '../src/provision.js';
import { baseOptions, createProbe, createTestFs, pathsFor } from './support/fixtures.js';

test('a failed probe raises not_ready with the probe reason and rolls back', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  const probe = createProbe({ ok: false, reason: 'overview returned HTTP 503' });

  await assert.rejects(provision(baseOptions(fs, { probe })), (error) => {
    assert.equal(error.code, 'not_ready');
    assert.equal(error.reason, 'overview returned HTTP 503');
    assert.match(error.message, /health check failed/);
    assert.equal(error.details.port, 3091);
    return true;
  });

  assert.equal(fs.exists(paths.profileDir), false, 'profileDir rolled back');
  assert.equal(fs.exists(paths.stateDir), false, 'stateDir rolled back');
  assert.equal(fs.exists(paths.registryPath), false, 'registry not created');
});

test('a probe that throws is a failed health check, not a pass', async () => {
  const fs = createTestFs();
  const probe = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1');
  };

  await assert.rejects(provision(baseOptions(fs, { probe })), (error) => {
    assert.equal(error.code, 'not_ready');
    assert.match(error.reason, /ECONNREFUSED/);
    return true;
  });
});

test('a probe that returns false or no result is not ready', async () => {
  for (const probe of [() => false, async () => undefined, () => ({ ok: false, message: 'booting' })]) {
    const fs = createTestFs();
    await assert.rejects(provision(baseOptions(fs, { probe })), (error) => {
      assert.equal(error.code, 'not_ready');
      assert.equal(typeof error.reason, 'string');
      assert.ok(error.reason.length > 0);
      return true;
    });
  }
});

test('a probe returning true means ready', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs, { probe: () => true }));
  assert.equal(result.health.ok, true);
  assert.equal(result.health.checked, true);
  assert.equal(result.created, true);
});

test('omitting the probe records an explicit skipped health check', async () => {
  const fs = createTestFs();
  const options = baseOptions(fs);
  delete options.probe;
  const result = await provision(options);

  assert.equal(result.health.ok, true);
  assert.equal(result.health.checked, false);
  assert.equal(result.health.skipped, true);
  assert.equal(result.created, true);
});

test('a failed probe keeps a pre-existing registry untouched', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  fs.mkdir(path.dirname(paths.registryPath));
  fs.writeFile(paths.registryPath, JSON.stringify({ version: 1, instances: [{ name: 'keep', port: 3079 }] }));

  const probe = createProbe({ ok: false, reason: 'nope' });
  await assert.rejects(provision(baseOptions(fs, { probe })), (error) => {
    assert.equal(error.code, 'not_ready');
    return true;
  });

  const registry = JSON.parse(fs.readFile(paths.registryPath));
  assert.deepEqual(registry.instances, [{ name: 'keep', port: 3079 }]);
});
