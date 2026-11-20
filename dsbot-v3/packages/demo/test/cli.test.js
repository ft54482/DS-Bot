import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, runCli, UsageError } from '../src/index.js';

const RUN_ENTRY = fileURLToPath(new URL('../run.mjs', import.meta.url));

function capture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    read: () => text,
  };
}

test('cli: parses --out <dir> and --out=<dir>', () => {
  assert.deepEqual(parseArgs(['--out', 'tmp/demo']), { outDir: 'tmp/demo', help: false });
  assert.deepEqual(parseArgs(['--out=tmp/demo']), { outDir: 'tmp/demo', help: false });
  assert.deepEqual(parseArgs(['--help']), { outDir: null, help: true });
  assert.throws(() => parseArgs(['--out']), UsageError);
  assert.throws(() => parseArgs(['--out=']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
});

test('cli: missing --out exits 2 with usage and writes nothing', async () => {
  const stdout = capture();
  const stderr = capture();
  const result = await runCli([], { stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(result.exitCode, 2);
  assert.equal(stdout.read(), '');
  assert.match(stderr.read(), /missing required --out/);
  assert.match(stderr.read(), /Usage: node packages\/demo\/run\.mjs/);
});

test('cli: --help exits 0 and prints usage', async () => {
  const stdout = capture();
  const stderr = capture();
  const result = await runCli(['--help'], { stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(result.exitCode, 0);
  assert.match(stdout.read(), /Usage: node packages\/demo\/run\.mjs/);
  assert.equal(stderr.read(), '');
});

test('cli: node run.mjs --out <tmpdir> exits 0 and writes demo-report.json', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'dsbot-demo-cli-'));
  t.after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const child = spawnSync(process.execPath, [RUN_ENTRY, '--out', outDir], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /L29 self-media demo: PASSED/);
  assert.match(child.stdout, /verify: 10\/10 checks passed/);
  await access(join(outDir, 'demo-report.json'));
  await access(join(outDir, 'publish-package.json'));
  await access(join(outDir, 'article.md'));
});
