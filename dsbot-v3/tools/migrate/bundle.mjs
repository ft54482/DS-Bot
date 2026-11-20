#!/usr/bin/env node
/**
 * DS Bot V3 migration bundler.
 *
 * Reads the lab repository's `packages/`, `tests/` and `tools/` trees and writes a
 * ready-to-land bundle with the target layout:
 *
 *   <out>/dsbot-v3/
 *     packages/       (every discovered package, unchanged relative layout)
 *     tests/
 *     tools/
 *     docs/prd/       (read-only schema assets required by tools/verify)
 *     README.md       (generated provenance / verification notes)
 *     MIGRATION.json  (source commit, generation time, file count, per-package sha256)
 *
 * Usage:
 *   node tools/migrate/bundle.mjs --out <dir>       # build bundle
 *   node tools/migrate/bundle.mjs --verify <dir>    # verify bundle (exit 0/1)
 *
 * Options:
 *   --out <dir>              output directory (bundle is written to <dir>/dsbot-v3)
 *   --verify <dir>           verify <dir>/dsbot-v3 (or <dir> itself if it holds MIGRATION.json)
 *   --root <dir>             source root to read from (default: this repository)
 *   --source-commit <sha>    override the recorded git commit
 *   --source-repo <owner/name> override the recorded source repository
 *   --generated-at <iso>     override the recorded generation time
 *   --help                   print usage
 *
 * Exit codes: 0 success, 1 verification/operation failure, 2 usage error.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const BUNDLE_DIR_NAME = 'dsbot-v3';
export const MANIFEST_FILE_NAME = 'MIGRATION.json';
export const SECTIONS = ['packages', 'tests', 'tools'];
/** Schema consumed by tools/verify/verify.mjs; a bundle that ships verify must carry it. */
export const VERIFY_SCHEMA_ASSET = 'docs/prd/01-data-model.sql';
/** Read-only files the migrated tree needs at runtime, copied verbatim. */
export const ASSET_FILES = [VERIFY_SCHEMA_ASSET];
/** Excluded directory names, matched at any depth. */
export const EXCLUDED_DIR_NAMES = ['.agent', 'node_modules', 'tmp', '.git'];
export const GENERATOR = {
  name: 'dsbot-v3-migrate',
  version: '1.0.0',
  entry: 'tools/migrate/bundle.mjs',
};
export const DEFAULT_SOURCE_REPO = 'ft54482/superagent-lab-smoke';
const README_FILE_NAME = 'README.md';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

const USAGE = [
  '用法:',
  '  node tools/migrate/bundle.mjs --out <dir>      生成迁移包到 <dir>/dsbot-v3',
  '  node tools/migrate/bundle.mjs --verify <dir>   校验 <dir>/dsbot-v3（退出码 0/1）',
  '',
  '选项:',
  '  --root <dir>               源仓库根目录（默认：本脚本所在仓库）',
  '  --source-commit <sha>      覆盖记录的源 commit',
  '  --source-repo <owner/name> 覆盖记录的源仓库',
  '  --generated-at <iso>       覆盖记录的生成时间',
].join('\n');

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

export class MigrationError extends Error {
  constructor(message, code = 'E_MIGRATION') {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toPosix = (value) => value.split(path.sep).join('/');
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sumBytes = (files) => files.reduce((total, file) => total + file.bytes, 0);

/** True when `child` is strictly inside `parent`. */
export function isInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (parentResolved === childResolved) return false;
  const rel = path.relative(parentResolved, childResolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Stable aggregate digest for a set of files: sha256 over the sorted
 * `path\0fileSha256\n` records. Equivalent to hashing the sorted manifest of
 * file contents, but cheap to recompute on verify.
 */
export function digestFiles(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => byCodepoint(a.path, b.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function defaultRoot() {
  // this file lives at <repo>/tools/migrate/bundle.mjs
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Fallback for sandboxes where spawning `git` is not allowed: read `.git` by hand. */
function readGitHeadFromFiles(root) {
  try {
    const head = readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (HEX40.test(head)) return head;
    const match = /^ref:\s*(.+)$/.exec(head);
    if (!match) return null;
    const ref = match[1].trim();
    const refPath = path.join(root, '.git', ref);
    if (existsSync(refPath)) {
      const value = readFileSync(refPath, 'utf8').trim();
      return HEX40.test(value) ? value : null;
    }
    const packedPath = path.join(root, '.git', 'packed-refs');
    if (!existsSync(packedPath)) return null;
    for (const line of readFileSync(packedPath, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && HEX40.test(sha)) return sha;
    }
  } catch {
    /* not a git checkout */
  }
  return null;
}

/** Return { commit, branch } for `root`, using git when available. */
export function detectGit(root) {
  const commit = gitOutput(root, ['rev-parse', 'HEAD']) ?? readGitHeadFromFiles(root);
  const branch = gitOutput(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const cleanCommit = commit && HEX40.test(commit) ? commit : null;
  const cleanBranch = branch && branch !== 'HEAD' ? branch : null;
  return { commit: cleanCommit, branch: cleanBranch };
}

function resolveGeneratedAt(explicit) {
  if (explicit) {
    const date = new Date(explicit);
    if (Number.isNaN(date.getTime())) {
      throw new MigrationError(`--generated-at 不是合法时间: ${explicit}`, 'E_USAGE');
    }
    return { iso: date.toISOString(), source: 'cli' };
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch.trim())) {
    return { iso: new Date(Number(epoch.trim()) * 1000).toISOString(), source: 'SOURCE_DATE_EPOCH' };
  }
  return { iso: new Date().toISOString(), source: 'clock' };
}

/* ------------------------------------------------------------------ */
/* source walking                                                     */
/* ------------------------------------------------------------------ */

/**
 * Walk `base` recursively and return regular files as
 * `{ abs, rel }` (rel is posix, relative to `base`).
 * Excluded directory names are pruned at any depth; `skipDirs` prunes absolute
 * subtrees (used to keep the output directory out of its own bundle).
 */
export async function walkFiles(base, options = {}) {
  const excluded = options.excludedDirNames ?? EXCLUDED_DIR_NAMES;
  const skipDirs = (options.skipDirs ?? []).map((dir) => path.resolve(dir));
  const skipped = options.skipped ?? [];
  const files = [];
  const state = { excluded, skipDirs, skipped };

  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => byCodepoint(a.name, b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (skipDirs.some((skip) => abs === skip || isInside(skip, abs))) continue;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: toPosix(path.relative(base, abs)), reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        if (excluded.includes(entry.name)) {
          skipped.push({ path: `${toPosix(path.relative(base, abs))}/`, reason: 'excluded-dir' });
          continue;
        }
        await visit(abs);
        continue;
      }
      if (entry.isFile()) {
        files.push({ abs, rel: toPosix(path.relative(base, abs)) });
      }
    }
  }

  await visit(base);
  return { files, skipped };
}

/* ------------------------------------------------------------------ */
/* bundle                                                             */
/* ------------------------------------------------------------------ */

function renderBundleReadme({ sourceRepo, sourceCommit, packages, assets }) {
  const lines = [];
  lines.push('# DS Bot V3 任务运行层（dsbot-v3）');
  lines.push('');
  lines.push('本目录由试验仓 `tools/migrate/bundle.mjs` 打包生成：');
  lines.push('');
  lines.push(`- 源仓库：\`${sourceRepo}\``);
  lines.push(`- 源 commit：\`${sourceCommit}\``);
  lines.push('- 目标：作为 DS Bot fork 的**新增顶层目录**整体落地；DS Bot 既有文件保持不变');
  lines.push('');
  lines.push('## 目录');
  lines.push('');
  lines.push('| 路径 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| \`packages/\` | ${packages.length} 个任务运行层包（源码 + 各自 test） |`);
  lines.push('| `tests/` | 跨包验收测试：conformance / contract / e2e / dod / regression |');
  lines.push('| `tools/` | 校验与运维脚本：verify / seed / perf / migrate |');
  for (const asset of assets) {
    lines.push(`| \`${asset.path}\` | verify 所需的只读 schema 副本（自包含） |`);
  }
  lines.push('| `MIGRATION.json` | 打包清单：源 commit、生成时间、文件数、逐包 sha256 |');
  lines.push('');
  lines.push('## 结构约束');
  lines.push('');
  lines.push('包之间用相对路径互相引用（例如 `packages/demo` → `../../runtime/src/index.js`），');
  lines.push('因此 `packages/`、`tests/`、`tools/` 必须保持为同级目录整体搬运，不能只拷单个包。');
  lines.push('');
  lines.push('## 包清单');
  lines.push('');
  for (const pkg of packages) {
    lines.push(`- \`${pkg.dir}/\` — \`${pkg.name}\``);
  }
  lines.push('');
  lines.push('## 自包含与 cwd 无关');
  lines.push('');
  lines.push('`tools/verify/verify.mjs` 与 `tools/migrate/bundle.mjs` 都用 `import.meta.url` 解析路径，');
  lines.push('不依赖 `process.cwd()`；verify 需要的 schema 已作为只读副本写进本包的 `docs/prd/`。');
  lines.push('因此从任意工作目录都可以运行：');
  lines.push('');
  lines.push('```');
  lines.push('node <本目录>/tools/verify/verify.mjs');
  lines.push('node --test <本目录>/tools/migrate/test');
  lines.push('node --test <本目录>/tests/e2e');
  lines.push('```');
  lines.push('');
  lines.push('## 校验');
  lines.push('');
  lines.push('```');
  lines.push('# 在本目录内（含 MIGRATION.json 时可直接指向自身）');
  lines.push('node tools/migrate/bundle.mjs --verify .');
  lines.push('# 或指向包含 dsbot-v3/ 的父目录');
  lines.push('node tools/migrate/bundle.mjs --verify <父目录>');
  lines.push('```');
  lines.push('');
  lines.push('退出码 0 表示文件数与逐包/逐分区 sha256 全部匹配，且清单里的包名列表与树内 `package.json` 一致；非 0 时按输出逐条排查。');
  lines.push('');
  lines.push('## 回滚');
  lines.push('');
  lines.push('本目录是纯新增内容：删除 `dsbot-v3/` 或 revert 对应 PR 即可完全回滚，不涉及数据迁移。');
  lines.push('');
  return lines.join('\n');
}

async function readPackageJson(root, dir) {
  try {
    const raw = await readFile(path.join(root, dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build the migration bundle.
 * @returns {Promise<{ok: true, bundleDir: string, manifestPath: string, manifest: object, skipped: object[]}>}
 */
export async function bundle(options = {}) {
  const root = path.resolve(options.root ?? defaultRoot());
  if (!options.out) throw new MigrationError('缺少 --out <dir>', 'E_USAGE');
  const out = path.resolve(options.out);
  const bundleDir = path.join(out, BUNDLE_DIR_NAME);

  if (!existsSync(root)) throw new MigrationError(`源目录不存在: ${root}`, 'E_SOURCE');
  const present = SECTIONS.filter((section) => existsSync(path.join(root, section)));
  if (present.length === 0) {
    throw new MigrationError(`源目录 ${root} 下没有 packages/ tests/ tools/ 任何一个`, 'E_SOURCE');
  }
  if (out === root || isInside(out, root)) {
    throw new MigrationError(`--out 不能是源目录本身或其上级: ${out}`, 'E_OUT');
  }
  if (bundleDir === root) {
    throw new MigrationError(`--out 会把源目录覆盖掉: ${out}`, 'E_OUT');
  }

  const warnings = [];
  const skipDirs = [bundleDir];
  if (isInside(root, out)) {
    skipDirs.push(out);
    warnings.push(`--out 位于源目录内（${out}），已从复制范围排除，避免自我复制`);
  }

  // start from a clean target so reruns are idempotent and no stale file survives
  if (existsSync(bundleDir)) await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });

  const generatedAt = resolveGeneratedAt(options.generatedAt);
  const git = detectGit(root);
  const sourceCommit = options.sourceCommit ?? git.commit ?? 'unknown';
  const sourceRepo = options.sourceRepo ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_SOURCE_REPO;
  const sourceBranch = options.sourceBranch ?? git.branch ?? null;

  const files = [];
  const skipped = [];

  for (const section of SECTIONS) {
    const sectionRoot = path.join(root, section);
    if (!existsSync(sectionRoot)) {
      warnings.push(`源目录缺少 ${section}/，已跳过`);
      continue;
    }
    const walked = await walkFiles(sectionRoot, { skipDirs, excludedDirNames: options.excludedDirNames ?? EXCLUDED_DIR_NAMES });
    skipped.push(...walked.skipped);
    for (const entry of walked.files) {
      const bundlePath = `${section}/${entry.rel}`;
      const destination = path.join(bundleDir, ...bundlePath.split('/'));
      const buffer = await readFile(entry.abs);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
      files.push({ path: bundlePath, bytes: buffer.length, sha256: sha256(buffer) });
    }
  }

  // Read-only assets that make the bundle self-contained. A bundle that ships
  // tools/verify must carry the schema; without it verify only works inside the
  // lab repository, where docs/prd/ happens to exist.
  const shipVerify = existsSync(path.join(root, 'tools', 'verify', 'verify.mjs'));
  const assets = [];
  for (const assetRel of ASSET_FILES) {
    const sourcePath = path.join(root, ...assetRel.split('/'));
    if (!existsSync(sourcePath)) {
      const message = `源目录缺少 verify 所需的 schema 资产 ${assetRel}`;
      if (shipVerify) throw new MigrationError(message, 'E_ASSET');
      warnings.push(`${message}，迁移树中的 verify 将无法运行`);
      continue;
    }
    const buffer = await readFile(sourcePath);
    const destination = path.join(bundleDir, ...assetRel.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, buffer);
    const record = { path: assetRel, bytes: buffer.length, sha256: sha256(buffer) };
    files.push(record);
    assets.push(record);
  }

  // generated README (kept deterministic: no timestamps, only source commit)
  const packageDirs = [...new Set(
    files
      .map((file) => file.path)
      .filter((filePath) => filePath.endsWith('/package.json') || filePath === `packages/package.json`)
      .filter((filePath) => filePath.startsWith('packages/'))
      .map((filePath) => filePath.slice(0, -'/package.json'.length)),
  )].sort(byCodepoint);

  const packageDescriptors = [];
  for (const dir of packageDirs) {
    const pkg = await readPackageJson(root, dir);
    const pkgFiles = files.filter((file) => file.path.startsWith(`${dir}/`));
    packageDescriptors.push({
      dir,
      name: pkg?.name ?? null,
      fileCount: pkgFiles.length,
      bytes: sumBytes(pkgFiles),
      sha256: digestFiles(pkgFiles),
    });
  }

  const packageNames = packageDescriptors
    .map((descriptor) => descriptor.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort(byCodepoint);

  const covered = new Set();
  for (const descriptor of packageDescriptors) {
    for (const file of files) {
      if (file.path.startsWith(`${descriptor.dir}/`)) covered.add(file.path);
    }
  }
  const unpackagedFiles = files
    .filter((file) => file.path.startsWith('packages/') && !covered.has(file.path))
    .map((file) => file.path)
    .sort(byCodepoint);

  const readme = renderBundleReadme({
    sourceRepo,
    sourceCommit,
    packages: packageDescriptors,
    assets,
  });
  const readmeBuffer = Buffer.from(readme, 'utf8');
  await writeFile(path.join(bundleDir, README_FILE_NAME), readmeBuffer);
  files.push({ path: README_FILE_NAME, bytes: readmeBuffer.length, sha256: sha256(readmeBuffer) });

  files.sort((a, b) => byCodepoint(a.path, b.path));

  const sections = {};
  for (const section of SECTIONS) {
    const sectionFiles = files.filter((file) => file.path.startsWith(`${section}/`));
    sections[section] = {
      fileCount: sectionFiles.length,
      bytes: sumBytes(sectionFiles),
      sha256: digestFiles(sectionFiles),
    };
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    sourceRepo,
    sourceCommit,
    sourceBranch,
    generatedAt: generatedAt.iso,
    generatedAtSource: generatedAt.source,
    bundleRoot: BUNDLE_DIR_NAME,
    excludedDirNames: options.excludedDirNames ?? EXCLUDED_DIR_NAMES,
    fileCount: files.length,
    totalBytes: sumBytes(files),
    sections,
    packages: packageDescriptors,
    packageNames,
    assets,
    unpackagedFiles,
    files,
  };
  const manifestPath = path.join(bundleDir, MANIFEST_FILE_NAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { ok: true, bundleDir, manifestPath, manifest, skipped, warnings };
}

/* ------------------------------------------------------------------ */
/* verify                                                             */
/* ------------------------------------------------------------------ */

function checkManifestShape(manifest, errors) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('MIGRATION.json 顶层不是对象');
    return false;
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 期望 ${SCHEMA_VERSION}，实际 ${JSON.stringify(manifest.schemaVersion)}`);
  }
  if (typeof manifest.sourceRepo !== 'string' || manifest.sourceRepo.length === 0) {
    errors.push('sourceRepo 缺失或不是字符串');
  }
  if (typeof manifest.sourceCommit !== 'string' || manifest.sourceCommit.length === 0) {
    errors.push('sourceCommit 缺失或不是字符串');
  }
  if (typeof manifest.generatedAt !== 'string' || Number.isNaN(new Date(manifest.generatedAt).getTime())) {
    errors.push(`generatedAt 不是合法 ISO 时间: ${JSON.stringify(manifest.generatedAt)}`);
  }
  if (!Number.isInteger(manifest.fileCount) || manifest.fileCount < 0) {
    errors.push(`fileCount 不是非负整数: ${JSON.stringify(manifest.fileCount)}`);
  }
  if (!Array.isArray(manifest.files)) {
    errors.push('files 不是数组');
    return false;
  }
  if (!Array.isArray(manifest.packages)) {
    errors.push('packages 不是数组');
    return false;
  }
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)) {
      errors.push(`files[${index}] 形状非法（需要 path 与非空 sha256）`);
      break;
    }
  }
  for (const descriptor of manifest.packages) {
    if (!descriptor || typeof descriptor.dir !== 'string' || !descriptor.dir.startsWith('packages/')) {
      errors.push('packages[] 存在 dir 非法的条目');
      continue;
    }
    if (typeof descriptor.sha256 !== 'string' || !HEX64.test(descriptor.sha256)) {
      errors.push(`包 ${descriptor.dir} 的 sha256 非法`);
    }
    if (!Number.isInteger(descriptor.fileCount) || descriptor.fileCount < 0) {
      errors.push(`包 ${descriptor.dir} 的 fileCount 非法`);
    }
  }
  if (!Array.isArray(manifest.packageNames)) {
    errors.push('packageNames 不是数组');
    return false;
  }
  if (manifest.packageNames.some((name) => typeof name !== 'string' || name.length === 0)) {
    errors.push('packageNames 含非法条目');
  }
  if (!Array.isArray(manifest.assets)) {
    errors.push('assets 不是数组');
    return false;
  }
  for (const [index, asset] of manifest.assets.entries()) {
    if (!asset || typeof asset.path !== 'string' || typeof asset.sha256 !== 'string' || !HEX64.test(asset.sha256)) {
      errors.push(`assets[${index}] 形状非法（需要 path 与 sha256）`);
      break;
    }
  }
  for (const section of SECTIONS) {
    const value = manifest.sections?.[section];
    if (!value || typeof value.sha256 !== 'string' || !HEX64.test(value.sha256) || !Number.isInteger(value.fileCount)) {
      errors.push(`sections.${section} 缺失或形状非法`);
    }
  }
  return true;
}

/**
 * Verify a generated bundle against its MIGRATION.json.
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], bundleDir: string|null, fileCount: number, manifest: object|null}>}
 */
export async function verify(options = {}) {
  const errors = [];
  const warnings = [];
  const fail = (message) => ({ ok: false, errors: [...errors, message], warnings, bundleDir: null, fileCount: 0, manifest: null });

  if (!options.dir) throw new MigrationError('缺少 --verify <dir>', 'E_USAGE');
  const target = path.resolve(options.dir);
  if (!existsSync(target)) return fail(`目录不存在: ${target}`);

  const bundleDir = existsSync(path.join(target, MANIFEST_FILE_NAME)) ? target : path.join(target, BUNDLE_DIR_NAME);
  const manifestPath = path.join(bundleDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) {
    return fail(`找不到清单: ${manifestPath}（--verify 需要指向包含 ${BUNDLE_DIR_NAME}/ 的目录，或 ${BUNDLE_DIR_NAME} 目录本身）`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return fail(`MIGRATION.json 解析失败: ${error.message}`);
  }
  if (!checkManifestShape(manifest, errors)) {
    return { ok: false, errors, warnings, bundleDir, fileCount: 0, manifest };
  }

  const walked = await walkFiles(bundleDir, { excludedDirNames: [] });
  const actual = [];
  for (const entry of walked.files) {
    if (entry.rel === MANIFEST_FILE_NAME) continue;
    const buffer = await readFile(entry.abs);
    actual.push({ path: entry.rel, bytes: buffer.length, sha256: sha256(buffer) });
  }
  for (const entry of walked.skipped) {
    errors.push(`包内出现不允许的符号链接: ${entry.path}`);
  }

  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));

  if (manifest.fileCount !== actual.length) {
    errors.push(`文件数不匹配: 清单 ${manifest.fileCount}，实际 ${actual.length}`);
  }
  if (manifest.files.length !== manifest.fileCount) {
    errors.push(`清单自身不一致: files.length=${manifest.files.length}，fileCount=${manifest.fileCount}`);
  }

  for (const [filePath, expected] of manifestByPath) {
    const found = actualByPath.get(filePath);
    if (!found) {
      errors.push(`缺少文件: ${filePath}`);
      continue;
    }
    if (found.sha256 !== expected.sha256) {
      errors.push(`内容被改动: ${filePath}（清单 ${expected.sha256.slice(0, 12)}…，实际 ${found.sha256.slice(0, 12)}…）`);
    }
    if (Number.isInteger(expected.bytes) && found.bytes !== expected.bytes) {
      errors.push(`文件大小不符: ${filePath}（清单 ${expected.bytes}，实际 ${found.bytes}）`);
    }
  }
  for (const filePath of actualByPath.keys()) {
    if (!manifestByPath.has(filePath)) errors.push(`多出未登记文件: ${filePath}`);
  }

  // per-package digests
  for (const descriptor of manifest.packages) {
    const actualPkg = actual.filter((file) => file.path.startsWith(`${descriptor.dir}/`));
    const actualDigest = digestFiles(actualPkg);
    if (descriptor.fileCount !== actualPkg.length) {
      errors.push(`包 ${descriptor.dir} 文件数不匹配: 清单 ${descriptor.fileCount}，实际 ${actualPkg.length}`);
    }
    if (descriptor.sha256 !== actualDigest) {
      errors.push(`包 ${descriptor.dir} sha256 不匹配: 清单 ${descriptor.sha256.slice(0, 12)}…，实际 ${actualDigest.slice(0, 12)}…`);
    }
  }

  // The manifest's package inventory must match the package.json files on disk,
  // so a package can neither disappear from nor appear in the tree unnoticed.
  const actualPackageDirs = actual
    .filter((file) => /^packages\/(?:.+\/)?package\.json$/.test(file.path))
    .map((file) => file.path.slice(0, -'/package.json'.length))
    .sort(byCodepoint);
  const manifestPackageDirs = manifest.packages.map((descriptor) => descriptor.dir).slice().sort(byCodepoint);
  if (actualPackageDirs.join('\n') !== manifestPackageDirs.join('\n')) {
    errors.push(`包清单与树内 package.json 不一致: 清单 ${manifestPackageDirs.length} 个，实际 ${actualPackageDirs.length} 个`);
  }
  const expectedPackageNames = manifest.packages
    .map((descriptor) => descriptor.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort(byCodepoint);
  if (manifest.packageNames.slice().sort(byCodepoint).join('\n') !== expectedPackageNames.join('\n')) {
    errors.push('packageNames 与 packages[].name 不一致');
  }
  for (const descriptor of manifest.packages) {
    const pkgPath = path.join(bundleDir, ...descriptor.dir.split('/'), 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      const actualName = typeof pkg.name === 'string' ? pkg.name : null;
      if (actualName !== descriptor.name) {
        errors.push(`包 ${descriptor.dir} 的 package.json name 不匹配: 清单 ${JSON.stringify(descriptor.name)}，实际 ${JSON.stringify(actualName)}`);
      }
    } catch (error) {
      errors.push(`包 ${descriptor.dir} 的 package.json 读取失败: ${error.message}`);
    }
  }

  // read-only schema assets: recorded by the manifest and present on disk
  for (const asset of manifest.assets) {
    if (!existsSync(path.join(bundleDir, ...asset.path.split('/')))) {
      errors.push(`缺少迁移资产: ${asset.path}`);
    }
  }

  // every packaged file must be covered by exactly one package descriptor
  const covered = new Set();
  for (const descriptor of manifest.packages) {
    for (const file of manifest.files) {
      if (file.path.startsWith(`${descriptor.dir}/`)) covered.add(file.path);
    }
  }
  const expectedUnpackaged = (manifest.unpackagedFiles ?? []).slice().sort(byCodepoint);
  const actualUnpackaged = manifest.files
    .filter((file) => file.path.startsWith('packages/') && !covered.has(file.path))
    .map((file) => file.path)
    .sort(byCodepoint);
  if (expectedUnpackaged.join('\n') !== actualUnpackaged.join('\n')) {
    errors.push(`packages/ 下未归属任何包的文件与清单不一致: 清单 ${expectedUnpackaged.length}，实际 ${actualUnpackaged.length}`);
  }

  // section digests
  for (const section of SECTIONS) {
    const expected = manifest.sections[section];
    const actualSection = actual.filter((file) => file.path.startsWith(`${section}/`));
    const actualDigest = digestFiles(actualSection);
    if (expected.fileCount !== actualSection.length) {
      errors.push(`分区 ${section}/ 文件数不匹配: 清单 ${expected.fileCount}，实际 ${actualSection.length}`);
    }
    if (expected.sha256 !== actualDigest) {
      errors.push(`分区 ${section}/ sha256 不匹配: 清单 ${expected.sha256.slice(0, 12)}…，实际 ${actualDigest.slice(0, 12)}…`);
    }
  }

  const totalActualBytes = sumBytes(actual);
  if (Number.isInteger(manifest.totalBytes) && manifest.totalBytes !== totalActualBytes) {
    errors.push(`总字节数不匹配: 清单 ${manifest.totalBytes}，实际 ${totalActualBytes}`);
  }

  // expected layout sanity
  for (const required of ['packages', 'tests', 'tools', README_FILE_NAME]) {
    if (!existsSync(path.join(bundleDir, required))) errors.push(`缺少目标布局条目: ${required}`);
  }
  if (existsSync(path.join(bundleDir, 'tools', 'verify', 'verify.mjs'))
    && !manifest.assets.some((asset) => asset.path === VERIFY_SCHEMA_ASSET)) {
    errors.push(`缺少 verify 所需的 schema 资产: ${VERIFY_SCHEMA_ASSET}（迁移树必须自包含）`);
  }
  if (manifest.sourceCommit === 'unknown') {
    warnings.push('清单中的 sourceCommit 为 unknown（打包时源目录不是 git 检出）');
  }
  if (manifest.packages.length === 0) {
    warnings.push('清单中没有任何包');
  }
  if (actual.length === 0) {
    errors.push('目标目录为空');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    bundleDir,
    fileCount: actual.length,
    manifest,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

export function parseArgs(argv = []) {
  const options = {
    mode: null,
    out: null,
    verify: null,
    root: null,
    sourceCommit: null,
    sourceRepo: null,
    generatedAt: null,
    help: false,
  };
  const requireValue = (flag, inline, argvList, index) => {
    const value = inline ?? argvList[index + 1];
    if (value === undefined || value === null || value === '' || value.startsWith('--')) {
      throw new MigrationError(`参数 ${flag} 缺少取值`, 'E_USAGE');
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) throw new MigrationError(`无法识别的参数: ${raw}`, 'E_USAGE');
    const equals = raw.indexOf('=');
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? null : raw.slice(equals + 1);
    switch (flag) {
      case '--out':
        options.out = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        options.mode = options.mode === 'verify' ? 'both' : 'out';
        break;
      case '--verify':
        options.verify = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        options.mode = options.mode === 'out' ? 'both' : 'verify';
        break;
      case '--root':
        options.root = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        break;
      case '--source-commit':
        options.sourceCommit = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        break;
      case '--source-repo':
        options.sourceRepo = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        break;
      case '--generated-at':
        options.generatedAt = requireValue(flag, inline, argv, index);
        if (inline === null) index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new MigrationError(`未知选项: ${flag}`, 'E_USAGE');
    }
  }
  return options;
}

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

/**
 * CLI entry point. Returns the process exit code so tests can call it directly.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((message) => process.stdout.write(`${message}\n`));
  const logError = io.error ?? ((message) => process.stderr.write(`${message}\n`));

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    logError(`[migrate] ${error.message}`);
    logError(USAGE);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (!options.mode) {
    logError('[migrate] 需要 --out <dir> 或 --verify <dir>');
    logError(USAGE);
    return 2;
  }

  let exitCode = 0;

  if (options.mode === 'out' || options.mode === 'both') {
    try {
      const result = await bundle({
        root: options.root ?? defaultRoot(),
        out: options.out,
        sourceCommit: options.sourceCommit,
        sourceRepo: options.sourceRepo,
        generatedAt: options.generatedAt,
      });
      log(`[bundle] 源目录: ${path.resolve(options.root ?? defaultRoot())}`);
      log(`[bundle] 源 commit: ${result.manifest.sourceCommit}${result.manifest.sourceBranch ? `（分支 ${result.manifest.sourceBranch}）` : ''}`);
      log(`[bundle] 目标: ${result.bundleDir}`);
      log(`[bundle] 已生成: ${result.manifest.fileCount} 个文件, ${formatBytes(result.manifest.totalBytes)}, ${result.manifest.packages.length} 个包, ${result.manifest.assets.length} 个 schema 资产`);
      for (const warning of result.warnings) log(`[bundle] 警告: ${warning}`);
      log(`[bundle] 清单: ${result.manifestPath}`);
    } catch (error) {
      logError(`[bundle] 失败: ${error.message}`);
      return 1;
    }
  }

  if (options.mode === 'verify' || options.mode === 'both') {
    const verifyDir = options.verify ?? options.out;
    try {
      const result = await verify({ dir: verifyDir });
      if (result.bundleDir) log(`[verify] 目标: ${result.bundleDir}`);
      if (result.manifest) {
        log(`[verify] 清单: sourceCommit=${result.manifest.sourceCommit} fileCount=${result.manifest.fileCount} packages=${result.manifest.packages.length} assets=${result.manifest.assets.length} generatedAt=${result.manifest.generatedAt}`);
      }
      if (result.ok) {
        log(`[verify] OK: ${result.fileCount} 个文件、${result.manifest.packages.length} 个包、${SECTIONS.length} 个分区 sha256 全部匹配`);
      } else {
        logError(`[verify] FAILED: ${result.errors.length} 个问题`);
        for (const error of result.errors.slice(0, 50)) logError(`  - ${error}`);
        if (result.errors.length > 50) logError(`  ... 其余 ${result.errors.length - 50} 个问题省略`);
        exitCode = 1;
      }
      for (const warning of result.warnings) logError(`[verify] 警告: ${warning}`);
    } catch (error) {
      logError(`[verify] 失败: ${error.message}`);
      exitCode = 1;
    }
  }

  return exitCode;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`[migrate] 未处理错误: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
