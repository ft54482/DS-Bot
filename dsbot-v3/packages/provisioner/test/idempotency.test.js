import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { provision } from '../src/provision.js';
import {
  baseOptions,
  createProbe,
  createTestFs,
  dshHomeFor,
  pathsFor,
  readRegistryFile,
} from './support/fixtures.js';

test('a repeated provision returns the existing instance without rewriting it', async () => {
  const fs = createTestFs();
  const probe = createProbe();
  const options = baseOptions(fs, { probe });

  const first = await provision(options);
  const second = await provision({ ...options, port: 3099, model: 'another-model', probe });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.existing, true);
  assert.equal(second.port, first.port);
  assert.equal(second.profileDir, first.profileDir);
  assert.equal(second.settings.executor.model, first.settings.executor.model);
  assert.equal(probe.calls.length, 1, 'the existing instance is not probed again');

  const registry = readRegistryFile(fs, dshHomeFor(fs));
  assert.equal(registry.instances.length, 1);
  assert.equal(registry.instances[0].port, first.port);
});

test('repeating provision keeps the original manifest timestamp', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  const options = baseOptions(fs, { now: '2026-11-21T00:00:00.000Z' });
  await provision(options);
  const original = JSON.parse(fs.readFile(paths.manifestPath));

  await provision({ ...options, now: '2026-11-22T00:00:00.000Z' });

  const after = JSON.parse(fs.readFile(paths.manifestPath));
  assert.equal(after.createdAt, original.createdAt);
  assert.equal(after.createdAt, '2026-11-21T00:00:00.000Z');
});

test('a foreign profile directory is never overwritten', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  const cordisPatch = path.join(paths.profileDir, 'cordis.patch.yml');
  fs.mkdir(paths.profileDir);
  fs.writeFile(cordisPatch, 'webserver:\n  port: 3999\n');

  await assert.rejects(provision(baseOptions(fs)), (error) => {
    assert.equal(error.code, 'profile_exists');
    assert.equal(error.details.path, paths.profileDir);
    return true;
  });
  assert.equal(fs.readFile(cordisPatch), 'webserver:\n  port: 3999\n');
});

test('a corrupt provisioner manifest fails closed instead of re-provisioning', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  fs.mkdir(paths.profileDir);
  fs.writeFile(paths.manifestPath, '{ not valid json');

  await assert.rejects(provision(baseOptions(fs)), (error) => {
    assert.equal(error.code, 'profile_corrupt');
    return true;
  });
});

test('a manifest for another name is treated as corrupt', async () => {
  const fs = createTestFs();
  const paths = pathsFor(fs, 'lab-one');
  fs.mkdir(paths.profileDir);
  fs.writeFile(
    paths.manifestPath,
    JSON.stringify({ name: 'other', port: 3091, repo: 'o/r', settings: {} }),
  );

  await assert.rejects(provision(baseOptions(fs)), (error) => {
    assert.equal(error.code, 'profile_corrupt');
    return true;
  });
});
