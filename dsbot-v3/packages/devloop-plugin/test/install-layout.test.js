import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.join(HERE, '..', '..');
const PACKAGES = ['devloop-plugin', 'autoloop', 'goal-engine', 'provisioner', 'verifier-agent'];

// `fs.cpSync` is deliberately not used here. On Node v25 a recursive cpSync
// crashes natively (exit 3221226505 / 0xC0000409) when the source lives under
// a non-ASCII path, such as the lab checkout at D:\AI全自动视频流\...; the
// whole test process dies without any test output. Copy by hand instead so
// the suite stays green in both ASCII and non-ASCII workspaces.

/** Recursively copies a directory tree with readdirSync/mkdirSync/copyFileSync. */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/**
 * Runs inside the temporary install root: imports the plugin by package name,
 * the way a DSH profile does, then builds a manager from its exported API.
 */
const PROBE = `
const plugin = await import('@dsbot/devloop-plugin');
const manager = plugin.createDevloopManager({
  scheduler: {
    freeSlots: () => 0,
    async dispatch() { throw new Error('no dispatch expected'); },
    async collect() { return []; },
    async rework() { return { workOrderId: 'rework-1' }; },
  },
  merger: { async merge() { return { merged: true }; } },
});
process.stdout.write(JSON.stringify({
  name: plugin.name,
  tools: plugin.createDevloopTools({ manager }).length,
  loops: manager.list().length,
}));
`;

test('imports from an installed node_modules/@dsbot layout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devloop-install-'));

  try {
    // A profile install copies each package out of its tarball: package.json
    // plus the `files` entries. Only the import graph is needed here.
    for (const name of PACKAGES) {
      const installed = path.join(root, 'node_modules', '@dsbot', name);
      mkdirSync(installed, { recursive: true });
      copyTree(path.join(PACKAGES_DIR, name, 'src'), path.join(installed, 'src'));
      copyFileSync(
        path.join(PACKAGES_DIR, name, 'package.json'),
        path.join(installed, 'package.json'),
      );
    }
    writeFileSync(path.join(root, 'probe.mjs'), PROBE);

    const result = spawnSync(process.execPath, ['probe.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.name, 'devloop-plugin');
    assert.equal(payload.tools, 3);
    assert.equal(payload.loops, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
