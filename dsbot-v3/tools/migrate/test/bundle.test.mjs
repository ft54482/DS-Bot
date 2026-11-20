/**
 * Generation-side tests for tools/migrate/bundle.mjs:
 * target layout, exclusion rules, MIGRATION.json completeness, idempotent reruns
 * and a full-repository smoke run.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  BUNDLE_DIR_NAME,
  EXCLUDED_DIR_NAMES,
  MANIFEST_FILE_NAME,
  SECTIONS,
  SCHEMA_VERSION,
  VERIFY_SCHEMA_ASSET,
  bundle,
  digestFiles,
} from '../bundle.mjs';
import { REPO_ROOT, cleanup, listPackageDirs, makeFixtureSource, makeTempDir, writeFiles } from './support/fixtures.mjs';

async function readManifest(bundleDir) {
  return JSON.parse(await readFile(path.join(bundleDir, MANIFEST_FILE_NAME), 'utf8'));
}

test('生成目标布局：packages/tests/tools + README.md + MIGRATION.json', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  const out = path.join(workspace, 'out');
  await makeFixtureSource(source);

  const result = await bundle({ root: source, out, generatedAt: '2026-01-02T03:04:05.000Z' });
  const bundleDir = path.join(out, BUNDLE_DIR_NAME);

  assert.equal(result.bundleDir, bundleDir);
  assert.ok(existsSync(path.join(bundleDir, 'packages')));
  assert.ok(existsSync(path.join(bundleDir, 'tests')));
  assert.ok(existsSync(path.join(bundleDir, 'tools')));
  assert.ok(existsSync(path.join(bundleDir, 'README.md')));
  assert.ok(existsSync(path.join(bundleDir, MANIFEST_FILE_NAME)));

  // regular sources are copied byte-for-byte
  assert.equal(await readFile(path.join(bundleDir, 'packages/alpha/src/index.js'), 'utf8'), 'export const alpha = 1;\n');
  assert.ok(existsSync(path.join(bundleDir, 'tests/unit/beta.test.js')));
  assert.ok(existsSync(path.join(bundleDir, 'tools/thing/run.mjs')));
  // nested package keeps its directory depth
  assert.ok(existsSync(path.join(bundleDir, 'packages/nested/group/gamma/src/index.js')));

  // generated README is the bundle's own, not the source root README
  const readme = await readFile(path.join(bundleDir, 'README.md'), 'utf8');
  assert.match(readme, /DS Bot V3/);
  assert.doesNotMatch(readme, /fixture source root readme/);
});

test('排除规则：任意深度的 .agent / node_modules / tmp / .git 都不进入迁移包', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  const out = path.join(workspace, 'out');
  await makeFixtureSource(source);

  const result = await bundle({ root: source, out, generatedAt: '2026-01-02T03:04:05.000Z' });
  const bundleDir = path.join(out, BUNDLE_DIR_NAME);
  const allPaths = result.manifest.files.map((file) => file.path);

  for (const excluded of ['packages/alpha/node_modules', 'packages/alpha/tmp', 'packages/alpha/.agent', 'packages/beta/.git']) {
    assert.ok(
      allPaths.every((filePath) => !filePath.startsWith(`${excluded}/`)),
      `${excluded}/ 不应出现在迁移包中`,
    );
    assert.equal(existsSync(path.join(bundleDir, excluded)), false, `${excluded}/ 不应被创建`);
  }
  // root-level decoys are never copied (only the three sections are walked)
  assert.equal(existsSync(path.join(bundleDir, '.agent')), false);
  assert.equal(existsSync(path.join(bundleDir, 'node_modules')), false);
  assert.equal(existsSync(path.join(bundleDir, 'tmp')), false);
  // ...but the report records what was pruned
  assert.ok(result.skipped.some((entry) => entry.reason === 'excluded-dir'));
  assert.deepEqual(EXCLUDED_DIR_NAMES, ['.agent', 'node_modules', 'tmp', '.git']);
});

test('MIGRATION.json 字段齐全且与磁盘一致', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  const out = path.join(workspace, 'out');
  await makeFixtureSource(source);

  const result = await bundle({ root: source, out, generatedAt: '2026-01-02T03:04:05.000Z' });
  const bundleDir = path.join(out, BUNDLE_DIR_NAME);
  const manifest = await readManifest(bundleDir);

  // required top-level fields
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.sourceRepo, 'ft54482/superagent-lab-smoke');
  assert.equal(typeof manifest.sourceCommit, 'string');
  assert.ok(manifest.sourceCommit.length > 0);
  assert.equal(manifest.generatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(manifest.generatedAtSource, 'cli');
  assert.equal(manifest.bundleRoot, BUNDLE_DIR_NAME);
  assert.deepEqual(manifest.excludedDirNames, EXCLUDED_DIR_NAMES);
  assert.equal(manifest.fileCount, manifest.files.length);
  assert.ok(manifest.fileCount > 0);
  assert.equal(manifest.totalBytes, manifest.files.reduce((total, file) => total + file.bytes, 0));

  // file count agrees with what is actually on disk (MIGRATION.json itself excluded)
  const onDisk = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else onDisk.push(rel);
    }
  }
  await walk(bundleDir);
  assert.equal(onDisk.length, manifest.fileCount + 1, '磁盘文件数 = 清单文件数 + MIGRATION.json');

  // every file has a well-formed hash and the digest recomputes
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(file.bytes) && file.bytes >= 0);
  }
  assert.equal(digestFiles(manifest.files.filter((file) => file.path.startsWith('packages/'))), manifest.sections.packages.sha256);

  // package table: top-level + nested packages, each with a real sha256 and file count
  const dirs = manifest.packages.map((pkg) => pkg.dir);
  assert.deepEqual(dirs, ['packages/alpha', 'packages/beta', 'packages/nested/group/gamma']);
  assert.deepEqual(manifest.packages.map((pkg) => pkg.name), ['@fixture/alpha', '@fixture/beta', '@fixture/gamma']);
  assert.deepEqual(manifest.packageNames, ['@fixture/alpha', '@fixture/beta', '@fixture/gamma']);
  assert.equal(manifest.packages.find((pkg) => pkg.dir === 'packages/alpha').fileCount, 4);
  for (const pkg of manifest.packages) {
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pkg.fileCount > 0);
  }
  // the fixture source has no docs/, so no schema asset is expected
  assert.deepEqual(manifest.assets, []);
  // files that belong to no package are reported, not silently dropped
  assert.deepEqual(manifest.unpackagedFiles, ['packages/stray.txt']);
  // section table covers exactly the three migrated trees
  assert.deepEqual(Object.keys(manifest.sections).sort(), [...SECTIONS].sort());
  assert.equal(manifest.sections.packages.fileCount, 9);
  assert.equal(manifest.sections.tests.fileCount, 2);
  assert.equal(manifest.sections.tools.fileCount, 2);
});

test('幂等重跑：固定生成时间时 MIGRATION.json 与整个包逐字节一致，并清掉旧文件', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  const out = path.join(workspace, 'out');
  await makeFixtureSource(source);
  const options = { root: source, out, generatedAt: '2026-01-02T03:04:05.000Z' };

  const first = await bundle(options);
  const firstManifest = await readFile(first.manifestPath, 'utf8');
  const firstFiles = await readdir(first.bundleDir, { recursive: true });

  // plant a stale file, then rerun: it must disappear and the manifest must match the first run
  await writeFile(path.join(first.bundleDir, 'stale-file.txt'), 'left over from a previous run\n');
  const second = await bundle(options);
  const secondManifest = await readFile(second.manifestPath, 'utf8');
  const secondFiles = await readdir(second.bundleDir, { recursive: true });

  assert.equal(secondManifest, firstManifest, '两次打包的 MIGRATION.json 必须逐字节相同');
  assert.equal(existsSync(path.join(second.bundleDir, 'stale-file.txt')), false, '旧文件必须被清理');
  assert.deepEqual(secondFiles, firstFiles);
  assert.equal(second.manifest.fileCount, first.manifest.fileCount);
});

test('SOURCE_DATE_EPOCH 可固定生成时间（可复现打包）', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  const out = path.join(workspace, 'out');
  await makeFixtureSource(source);

  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1700000000';
  try {
    const result = await bundle({ root: source, out });
    assert.equal(result.manifest.generatedAt, new Date(1700000000 * 1000).toISOString());
    assert.equal(result.manifest.generatedAtSource, 'SOURCE_DATE_EPOCH');
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  }
});

test('--out 位于源目录内时不会把输出目录当成源码复制进去', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  await makeFixtureSource(source);

  const outInsideSource = path.join(source, 'bundle-output');
  const result = await bundle({ root: source, out: outInsideSource, generatedAt: '2026-01-02T03:04:05.000Z' });

  assert.ok(result.warnings.some((warning) => warning.includes('已从复制范围排除')));
  assert.ok(result.manifest.files.every((file) => !file.path.includes('bundle-output')));
  // same content as a clean run outside the source tree
  const clean = await bundle({ root: source, out: path.join(workspace, 'out-clean'), generatedAt: '2026-01-02T03:04:05.000Z' });
  assert.equal(result.manifest.fileCount, clean.manifest.fileCount);
  assert.deepEqual(
    result.manifest.files.map((file) => file.path),
    clean.manifest.files.map((file) => file.path),
  );
});

test('--out 指向源目录本身时拒绝执行（防覆盖）', async (t) => {
  const workspace = await makeTempDir();
  t.after(() => cleanup(workspace));
  const source = path.join(workspace, 'source');
  await makeFixtureSource(source);

  await assert.rejects(() => bundle({ root: source, out: source }), /不能是源目录本身或其上级/);
  await assert.rejects(() => bundle({ root: source }), /缺少 --out/);
});

test('真实仓库冒烟：动态发现包、schema 资产与三个分区，verify 通过', async (t) => {
  const out = await makeTempDir('dsh-migrate-repo-');
  t.after(() => cleanup(out));

  const result = await bundle({ root: REPO_ROOT, out, generatedAt: '2026-01-02T03:04:05.000Z' });
  const bundleDir = result.bundleDir;

  assert.ok(result.manifest.fileCount > 300, `真实仓库应有 300+ 文件，实际 ${result.manifest.fileCount}`);

  // The package inventory is discovered from the source tree, never hard-coded,
  // and the actual list is recorded verbatim in the manifest.
  const expectedDirs = (await listPackageDirs(path.join(REPO_ROOT, 'packages'))).map((dir) => `packages/${dir}`);
  assert.ok(expectedDirs.length >= 23, `试验仓应至少有 23 个包，实际 ${expectedDirs.length}`);
  assert.deepEqual(
    result.manifest.packages.map((pkg) => pkg.dir),
    expectedDirs,
    `清单应记录实际发现的 ${expectedDirs.length} 个包`,
  );
  assert.deepEqual(
    result.manifest.packageNames.slice().sort(),
    result.manifest.packages.map((pkg) => pkg.name).sort(),
    'packageNames 应与 packages[].name 一致',
  );
  assert.ok(result.manifest.packages.some((pkg) => pkg.dir === 'packages/pipelines/content'));
  assert.ok(result.manifest.packages.some((pkg) => pkg.dir === 'packages/pipelines/selfmedia'));

  // The schema copy required by tools/verify must be in the bundle byte-for-byte.
  assert.deepEqual(result.manifest.assets.map((asset) => asset.path), [VERIFY_SCHEMA_ASSET]);
  assert.equal(
    await readFile(path.join(bundleDir, ...VERIFY_SCHEMA_ASSET.split('/')), 'utf8'),
    await readFile(path.join(REPO_ROOT, ...VERIFY_SCHEMA_ASSET.split('/')), 'utf8'),
    'schema 资产必须逐字节复制',
  );

  assert.ok(result.manifest.sections.tests.fileCount > 10);
  assert.ok(result.manifest.sections.tools.fileCount > 8);
  if (existsSync(path.join(REPO_ROOT, '.git'))) {
    assert.match(result.manifest.sourceCommit, /^[0-9a-f]{40}$/, '从 git 检出打包时应记录 40 位 commit');
  } else {
    assert.equal(result.manifest.sourceCommit, 'unknown', '迁移树没有 .git，应记录 unknown 而不是猜测');
  }
  assert.deepEqual(result.manifest.unpackagedFiles, []);
  for (const section of SECTIONS) {
    assert.ok(result.manifest.sections[section].fileCount > 0);
  }
});
