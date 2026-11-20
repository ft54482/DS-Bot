import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { provision } from '../src/provision.js';
import {
  FIXED_NOW,
  baseOptions,
  createProbe,
  createTestFs,
  dshHomeFor,
  readRegistryFile,
} from './support/fixtures.js';

test('provision returns the documented shape and creates profile files', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs));

  for (const key of ['profileDir', 'cordisPatch', 'prepareScript', 'settings']) {
    assert.ok(key in result, `missing ${key}`);
  }
  assert.equal(result.created, true);
  assert.equal(result.existing, false);
  assert.equal(result.port, 3091);
  assert.equal(path.basename(result.profileDir), 'lab-one');
  assert.ok(fs.exists(result.profileDir), 'profileDir exists');
  assert.ok(fs.exists(path.join(result.profileDir, 'cordis.patch.yml')), 'cordis patch exists');
  assert.ok(fs.exists(path.join(result.profileDir, 'instance.json')), 'manifest exists');
  assert.ok(fs.exists(result.stateDir), 'stateDir exists');
  assert.ok(fs.exists(result.workRoot), 'workRoot exists');
});

test('cordis patch binds the allocated port and the state directory', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs));
  const yaml = fs.readFile(path.join(result.profileDir, 'cordis.patch.yml'));

  assert.equal(result.cordisPatch.webserver.port, 3091);
  assert.equal(result.cordisPatch['dsh-superagent'].stateDir, result.stateDir);
  assert.match(yaml, /^webserver:\n {2}port: 3091$/m);
  assert.match(yaml, /^dsh-superagent:$/m);
  assert.ok(yaml.includes(JSON.stringify(result.stateDir)), 'stateDir is written');
});

test('executor settings carry model, maxWorkers, directory, prepare and blockedCommands', async () => {
  const fs = createTestFs();
  const options = baseOptions(fs, { maxWorkers: 2, blockedCommands: ['git push --force', 'rm -rf /'] });
  const result = await provision(options);
  const executor = result.settings.executor;

  assert.equal(executor.model, options.model);
  assert.equal(executor.maxWorkers, 2);
  assert.equal(executor.directory, result.workRoot);
  assert.equal(executor.prepare, result.prepareScript);
  assert.deepEqual(executor.blockedCommands, ['git push --force', 'rm -rf /']);
});

test('settings.default maxWorkers is 4 and blocked commands default to empty', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs));

  assert.equal(result.settings.executor.maxWorkers, 4);
  assert.deepEqual(result.settings.executor.blockedCommands, []);
});

test('prepare script uses DSH_SUPERAGENT variables and the ticket worktree', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs));

  assert.match(result.prepareScript, /\$DSH_SUPERAGENT_NAME/);
  assert.match(result.prepareScript, /\$DSH_SUPERAGENT_DIR/);
  assert.match(result.prepareScript, /git worktree add/);
  assert.equal(result.settings.executor.prepare, result.prepareScript);
});

test('policy whitelists exactly the specified account and repository', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs, { account: 'yuxianghan-droid' }));
  const github = result.settings.policy.sources.github;

  assert.deepEqual(github.allowed, ['yuxianghan-droid']);
  assert.equal(github.repository, 'ft54482/superagent-lab-smoke');
  assert.equal(github.owner, 'ft54482');
  assert.equal(github.account, 'yuxianghan-droid');
});

test('the documented call without account uses the lab agent whitelist', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs, { account: undefined }));
  const github = result.settings.policy.sources.github;

  assert.deepEqual(github.allowed, ['yuxianghan-droid']);
  assert.equal(github.account, 'yuxianghan-droid');
});

test('workRoot override is honoured and written into executor.directory', async () => {
  const fs = createTestFs();
  const workRoot = path.join(fs.homedir(), 'custom-work');
  const result = await provision(baseOptions(fs, { workRoot }));

  assert.equal(result.workRoot, path.resolve(workRoot));
  assert.equal(result.settings.executor.directory, path.resolve(workRoot));
  assert.ok(fs.exists(path.resolve(workRoot)));
});

test('manifest and registry record the instance for later runs', async () => {
  const fs = createTestFs();
  const result = await provision(baseOptions(fs));
  const manifest = JSON.parse(fs.readFile(path.join(result.profileDir, 'instance.json')));
  const registry = readRegistryFile(fs, dshHomeFor(fs));

  assert.equal(manifest.version, 1);
  assert.equal(manifest.name, 'lab-one');
  assert.equal(manifest.port, 3091);
  assert.equal(manifest.createdAt, FIXED_NOW);
  assert.equal(manifest.settings.executor.model, result.settings.executor.model);
  assert.equal(registry.instances.length, 1);
  assert.equal(registry.instances[0].name, 'lab-one');
  assert.equal(registry.instances[0].port, 3091);
});

test('invalid name, repo, model and port fail closed before writing anything', async () => {
  const fs = createTestFs();
  const cases = [
    [{ name: '../escape' }, 'name'],
    [{ repo: 'not a repo' }, 'repo'],
    [{ model: '   ' }, 'model'],
    [{ port: 70000 }, 'port'],
  ];

  for (const [override, field] of cases) {
    await assert.rejects(provision(baseOptions(fs, override)), (error) => {
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.details.field, field);
      return true;
    });
    assert.equal(fs.exists(path.join(dshHomeFor(fs), 'profiles', 'lab-one')), false);
  }
});

test('a missing fs adapter is rejected instead of falling back to node:fs', async () => {
  await assert.rejects(provision({ name: 'lab-one', repo: 'o/r', model: 'm', probe: createProbe() }), (error) => {
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.details.field, 'fs');
    return true;
  });
});

test('probe receives the resolved instance context', async () => {
  const fs = createTestFs();
  const probe = createProbe({ health: { status: 200 } });
  const result = await provision(baseOptions(fs, { probe }));

  assert.equal(probe.calls.length, 1);
  const context = probe.calls[0];
  assert.equal(context.name, 'lab-one');
  assert.equal(context.port, 3091);
  assert.equal(context.url, 'http://127.0.0.1:3091');
  assert.equal(context.profileDir, result.profileDir);
  assert.equal(context.settings.executor.model, result.settings.executor.model);
  assert.equal(result.health.ok, true);
  assert.equal(result.health.checked, true);
  assert.equal(result.health.status, 200);
});
