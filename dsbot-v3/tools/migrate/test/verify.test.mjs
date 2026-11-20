/**
 * Verification-side tests for tools/migrate/bundle.mjs:
 * happy path, tamper detection (content / extra / missing / manifest edits),
 * direct `dsbot-v3` targeting and the real CLI exit codes.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { BUNDLE_DIR_NAME, MANIFEST_FILE_NAME, bundle, verify } from '../bundle.mjs';
import { cleanup, makeFixtureSource, makeTempDir, runCli } from './support/fixtures.mjs';

const FIXED_TIME = '2026-01-02T03:04:05.000Z';

async function prepare(t) {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  await makeFixtureSource(source);
  const out = path.join(workspace, 'out');
  const result = await bundle({ root: source, out, generatedAt: FIXED_TIME });
  return { workspace, source, out, bundleDir: result.bundleDir };
}

test('校验通过：fileCount、逐文件哈希、逐包哈希、分区哈希全部匹配', async (t) => {
  const { bundleDir } = await prepare(t);
  const result = await verify({ dir: path.dirname(bundleDir) });

  assert.equal(result.ok, true, `应通过，实际错误: ${result.errors.join('; ')}`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.fileCount, 14);
  assert.equal(result.manifest.fileCount, 14);
  assert.equal(result.manifest.packages.length, 3);
});

test('内容被篡改后校验失败（逐文件哈希 + 逐包哈希都报错）', async (t) => {
  const { bundleDir } = await prepare(t);
  const target = path.join(bundleDir, 'packages/alpha/src/index.js');
  await appendFile(target, '// tampered\n');

  const result = await verify({ dir: path.dirname(bundleDir) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('内容被改动') && error.includes('packages/alpha/src/index.js')));
  assert.ok(result.errors.some((error) => error.includes('包 packages/alpha sha256 不匹配')));
});

test('文件被删除后校验失败（数量 + 缺失文件）', async (t) => {
  const { bundleDir } = await prepare(t);
  await rm(path.join(bundleDir, 'tests/unit/beta.test.js'));

  const result = await verify({ dir: bundleDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('文件数不匹配')));
  assert.ok(result.errors.some((error) => error.includes('缺少文件: tests/unit/beta.test.js')));
});

test('多出未登记文件后校验失败', async (t) => {
  const { bundleDir } = await prepare(t);
  await writeFile(path.join(bundleDir, 'packages/alpha/src/extra.js'), 'export const extra = 1;\n');

  const result = await verify({ dir: bundleDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('多出未登记文件: packages/alpha/src/extra.js')));
});

test('清单自身被改写后校验失败（fileCount / 包 sha256）', async (t) => {
  const { bundleDir } = await prepare(t);
  const manifestPath = path.join(bundleDir, MANIFEST_FILE_NAME);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.fileCount += 1;
  manifest.packages[0].sha256 = '0'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await verify({ dir: bundleDir });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('files.length=') || error.includes('文件数不匹配')));
  assert.ok(result.errors.some((error) => error.includes('sha256 不匹配')));
});

test('清单缺失 / 目录不存在时校验失败并给出可操作提示', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));

  const empty = await verify({ dir: workspace });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((error) => error.includes('找不到清单')));

  const missing = await verify({ dir: path.join(workspace, 'does-not-exist') });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes('目录不存在')));
});

test('verify 可直接指向 dsbot-v3 目录本身', async (t) => {
  const { bundleDir } = await prepare(t);
  const result = await verify({ dir: bundleDir });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.bundleDir, bundleDir);
});

test('真实 CLI 退出码：生成 0 → 校验 0 → 篡改后校验 1', async (t) => {
  const workspace = await makeTempDir('dsh-migrate-cli-');
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  await makeFixtureSource(source);
  const out = path.join(workspace, 'out');

  const build = runCli(['--out', out, '--root', source, '--generated-at', FIXED_TIME]);
  assert.equal(build.status, 0, `生成失败: ${build.stderr}`);
  assert.match(build.stdout, /已生成/);
  assert.ok(existsSync(path.join(out, BUNDLE_DIR_NAME, MANIFEST_FILE_NAME)));

  const okVerify = runCli(['--verify', out]);
  assert.equal(okVerify.status, 0, `校验应通过: ${okVerify.stdout}${okVerify.stderr}`);
  assert.match(okVerify.stdout, /\[verify\] OK/);

  await appendFile(path.join(out, BUNDLE_DIR_NAME, 'tools/thing/run.mjs'), '// tampered\n');
  const badVerify = runCli(['--verify', out]);
  assert.equal(badVerify.status, 1, '篡改后校验必须退出 1');
  assert.match(badVerify.stderr, /FAILED/);
});

test('CLI 参数错误返回 2，--help 返回 0', async (t) => {
  const noArgs = runCli([]);
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /需要 --out <dir> 或 --verify <dir>/);

  const unknown = runCli(['--out', 'x', '--bogus']);
  assert.equal(unknown.status, 2);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法:/);
});
