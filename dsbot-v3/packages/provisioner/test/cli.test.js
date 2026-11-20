import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, parseArgs, UsageError } from '../src/cli.js';
import {
  captureStreams,
  createProbe,
  createTestFs,
  dshHomeFor,
  seedRegistry,
} from './support/fixtures.js';

const REQUIRED = [
  '--name',
  'lab-one',
  '--repo',
  'ft54482/superagent-lab-smoke',
  '--model',
  'orange-pro/DeepSeek-V4.1-flash-2.5',
];

test('parseArgs: defaults, auto port and repeatable blocked commands', () => {
  const parsed = parseArgs([
    ...REQUIRED,
    '--port',
    'auto',
    '--max-workers',
    '2',
    '--blocked-commands',
    'git push --force',
    '--blocked-commands',
    'rm -rf /',
    '--json',
  ]);

  assert.equal(parsed.port, 'auto');
  assert.equal(parsed.maxWorkers, 2);
  assert.deepEqual(parsed.blockedCommands, ['git push --force', 'rm -rf /']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.remove, false);
});

test('parseArgs: equals form, port number and remove flags', () => {
  const parsed = parseArgs([
    '--name=lab-one',
    '--repo=ft54482/superagent-lab-smoke',
    '--model=m',
    '--port=3095',
  ]);
  assert.equal(parsed.port, 3095);

  const remove = parseArgs(['--remove', '--name', 'lab-one', '--remove-state']);
  assert.equal(remove.remove, true);
  assert.equal(remove.removeState, true);
});

test('parseArgs rejects unknown flags, missing values and invalid ports', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--name']), UsageError);
  assert.throws(() => parseArgs(['--name', '--json']), UsageError);
  assert.throws(() => parseArgs([...REQUIRED, '--port', 'front']), UsageError);
  assert.throws(() => parseArgs([...REQUIRED, '--port', '70000']), UsageError);
  assert.throws(() => parseArgs([...REQUIRED, '--max-workers', '0']), UsageError);
  assert.throws(() => parseArgs(['--remove-state', '--name', 'lab-one']), UsageError);
  assert.throws(() => parseArgs(['--name', 'lab-one']), UsageError);
});

test('runCli provision --json writes the instance and exits 0', async () => {
  const fs = createTestFs();
  const probe = createProbe({ health: { status: 200 } });
  const streams = captureStreams();

  const code = await runCli([...REQUIRED, '--port', '3095', '--health-check', '--json'], {
    fs,
    probe,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 0);
  const payload = JSON.parse(streams.outText());
  assert.equal(payload.ok, true);
  assert.equal(payload.name, 'lab-one');
  assert.equal(payload.port, 3095);
  assert.equal(payload.created, true);
  assert.equal(payload.health.checked, true);
  assert.equal(streams.errText(), '');
});

test('runCli --port auto uses the injected live port check', async () => {
  const fs = createTestFs();
  const busy = new Set([3080]);
  const streams = captureStreams();

  const code = await runCli([...REQUIRED, '--port', 'auto', '--json'], {
    fs,
    isPortFree: async (port) => !busy.has(port),
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(streams.outText()).port, 3081);
});

test('runCli --remove deletes a managed profile and exits 0', async () => {
  const fs = createTestFs();
  const streams = captureStreams();
  const provisioned = await runCli([...REQUIRED, '--port', '3096', '--json'], {
    fs,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(provisioned, 0);
  const profileDir = JSON.parse(streams.outText()).profileDir;

  const removalStreams = captureStreams();
  const code = await runCli(['--remove', '--name', 'lab-one', '--json'], {
    fs,
    stdout: removalStreams.stdout,
    stderr: removalStreams.stderr,
  });

  assert.equal(code, 0);
  const payload = JSON.parse(removalStreams.outText());
  assert.equal(payload.removed, true);
  assert.equal(fs.exists(profileDir), false);
});

test('runCli reports a port_taken error as exit 1 with JSON', async () => {
  const fs = createTestFs();
  seedRegistry(fs, dshHomeFor(fs), [{ name: 'other', port: 3091 }]);
  const streams = captureStreams();

  const code = await runCli([...REQUIRED, '--port', '3091', '--json'], {
    fs,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 1);
  const payload = JSON.parse(streams.outText());
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'port_taken');
  assert.equal(payload.details.holder, 'other');
});

test('runCli usage errors exit 2 and print usage', async () => {
  const streams = captureStreams();
  const code = await runCli(['--name', 'lab-one'], {
    fs: createTestFs(),
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 2);
  assert.match(streams.errText(), /--repo is required/);
  assert.match(streams.errText(), /Usage:/);
});

test('runCli --help exits 0 and prints usage without touching fs', async () => {
  const streams = captureStreams();
  const code = await runCli(['--help'], {
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 0);
  assert.match(streams.outText(), /Usage:/);
  assert.match(streams.outText(), /--port <auto\|number>/);
});

test('runCli text output names the profile, port and paths', async () => {
  const fs = createTestFs();
  const streams = captureStreams();
  const code = await runCli([...REQUIRED, '--port', '3097'], {
    fs,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  assert.equal(code, 0);
  assert.match(streams.outText(), /provisioned lab-one on port 3097/);
  assert.match(streams.outText(), /profile:/);
  assert.match(streams.outText(), /health: {2}skipped/);
});
