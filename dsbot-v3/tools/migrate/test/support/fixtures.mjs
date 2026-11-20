/**
 * Shared helpers for the migration bundler tests.
 *
 * Every fixture lives in the OS temp directory, never inside the repository, so
 * the tests do not touch `packages/`, `tests/` or `tools/` under version control.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives at <repo>/tools/migrate/test/support/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const CLI_PATH = path.join(REPO_ROOT, 'tools', 'migrate', 'bundle.mjs');

export async function makeTempDir(prefix = 'dsh-migrate-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Write `{ relative/path: content }` under `root`, creating directories. */
export async function writeFiles(root, entries) {
  for (const [relativePath, content] of Object.entries(entries)) {
    const absolute = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

/**
 * Minimal but structurally faithful source tree:
 *  - two top-level packages (`alpha`, `beta`), one nested package (`nested/group/gamma`)
 *  - excluded directories at different depths (`.agent`, `node_modules`, `tmp`, `.git`)
 *  - one file under packages/ that belongs to no package (`stray.txt`)
 *  - tests/ and tools/ sections, plus decoys at the source root (must not be copied)
 */
export async function makeFixtureSource(root) {
  const packageJson = (name) => `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module' }, null, 2)}\n`;
  await writeFiles(root, {
    'packages/alpha/package.json': packageJson('@fixture/alpha'),
    'packages/alpha/src/index.js': 'export const alpha = 1;\n',
    'packages/alpha/src/helper.js': 'export const helper = () => alpha;\n',
    'packages/alpha/test/index.js': "import test from 'node:test';\ntest('alpha', () => {});\n",
    'packages/alpha/node_modules/dep/index.js': 'module.exports = {};\n',
    'packages/alpha/node_modules/dep/package.json': packageJson('dep'),
    'packages/alpha/tmp/cache.bin': 'cache-should-not-be-copied',
    'packages/alpha/.agent/log.txt': 'should-not-be-copied',
    'packages/beta/package.json': packageJson('@fixture/beta'),
    'packages/beta/src/index.js': 'export const beta = 2;\n',
    'packages/beta/.git/config': '[core]\n',
    'packages/nested/group/gamma/package.json': packageJson('@fixture/gamma'),
    'packages/nested/group/gamma/src/index.js': 'export const gamma = 3;\n',
    'packages/stray.txt': 'not part of any package\n',
    'tests/unit/beta.test.js': "import test from 'node:test';\ntest('beta', () => {});\n",
    'tests/conformance/index.js': 'export {};\n',
    'tools/thing/run.mjs': 'console.log("tool");\n',
    'tools/thing/README.md': '# tool\n',
    '.agent/state.md': 'root-level excluded dir\n',
    'node_modules/root-dep/index.js': 'should-not-be-copied\n',
    'tmp/scratch.txt': 'should-not-be-copied\n',
    'README.md': '# fixture source root readme (must not be copied)\n',
  });
}

/** Remove a temp tree, ignoring failures (used from `t.after`). */
export async function cleanup(directory) {
  if (!directory) return;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Discover package directories under `base`: every directory holding a
 * `package.json`, recursively. Returns posix paths relative to `base`, sorted.
 * Used so tests assert against the source tree instead of a hard-coded count.
 */
export async function listPackageDirs(base, options = {}) {
  const excluded = new Set(options.excludedDirNames ?? ['.agent', 'node_modules', 'tmp', '.git']);
  const found = [];

  async function visit(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        await visit(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && entry.name === 'package.json' && rel) {
        found.push(rel);
      }
    }
  }

  await visit(base, '');
  return found.sort();
}

/** Run the real CLI (spawn) and return { status, stdout, stderr }. */
export function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
}
