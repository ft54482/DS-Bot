/**
 * Self-containment tests for the migration bundle.
 *
 * Regression for the subdirectory layout: the generated `dsbot-v3/` tree must
 * run its checks from any working directory, and `tools/verify` must fail with
 * a clear diagnostic (never a TypeError) when the schema copy is missing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VERIFY_SCHEMA_ASSET, bundle } from '../bundle.mjs';
import { REPO_ROOT, cleanup, makeTempDir, writeFiles } from './support/fixtures.mjs';

const FIXED_TIME = '2026-01-02T03:04:05.000Z';

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
}

test('迁移树自带 schema，verify 从任意 cwd 运行通过', async (t) => {
  const out = await makeTempDir('dsh-migrate-selfcontained-');
  t.after(() => cleanup(out));
  const result = await bundle({ root: REPO_ROOT, out, generatedAt: FIXED_TIME });
  const bundleDir = result.bundleDir;

  const assetPath = path.join(bundleDir, ...VERIFY_SCHEMA_ASSET.split('/'));
  assert.equal(existsSync(assetPath), true, `迁移树缺少 schema 副本: ${assetPath}`);

  // Deliberately unrelated cwd: the bundle must resolve everything from its own
  // location (import.meta.url), not from the process working directory.
  const unrelated = await makeTempDir('dsh-migrate-cwd-');
  t.after(() => cleanup(unrelated));

  const run = runNode([path.join(bundleDir, 'tools', 'verify', 'verify.mjs')], unrelated);
  assert.equal(
    run.status,
    0,
    `verify 应在任意 cwd 下通过\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.match(run.stdout, /Summary: \d+ passed, 0 failed/);
  assert.match(run.stdout, /Result: OK/);
});

test('verify.mjs 用 import.meta.url 解析路径，不依赖 process.cwd()', async () => {
  const source = await readFile(path.join(REPO_ROOT, 'tools', 'verify', 'verify.mjs'), 'utf8');
  // Comments may mention process.cwd(); the executable code must not use it.
  const codeLines = source.split(/\r?\n/).filter((line) => !line.trim().startsWith('//'));
  assert.equal(
    codeLines.some((line) => /process\.cwd\s*\(/.test(line)),
    false,
    'verify.mjs 的可执行代码不应调用 process.cwd()',
  );
  assert.match(source, /import\.meta\.url/);
});

test('schema 缺失时 verify 给出明确错误而不是 TypeError', async (t) => {
  const workspace = await makeTempDir('dsh-verify-missing-');
  t.after(() => cleanup(workspace));
  await writeFiles(workspace, {
    'tools/verify/verify.mjs': await readFile(path.join(REPO_ROOT, 'tools', 'verify', 'verify.mjs'), 'utf8'),
  });

  const run = runNode([path.join(workspace, 'tools', 'verify', 'verify.mjs')], os.tmpdir());
  assert.equal(run.status, 1, 'schema 缺失时 verify 必须退出 1');
  assert.match(run.stdout, /\[FAIL\] execute/);
  assert.match(run.stdout, /schema not found/);
  assert.match(run.stdout, /Summary: 0 passed, \d+ failed/);
  assert.doesNotMatch(run.stdout, /Cannot read properties of undefined/);
  assert.doesNotMatch(run.stderr, /Cannot read properties of undefined/);
});
