import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT, '..');
const SIBLINGS = ['autoloop', 'goal-engine', 'provisioner', 'verifier-agent'];

test('package.json declares the cordis bundle patch and entry point', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.manifestVersion, 1);
  assert.deepEqual(manifest.dsh.bundle, { patch: './cordis.patch.yml' });
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(path.join(ROOT, manifest.dsh.bundle.patch)));
  assert.ok(existsSync(path.join(ROOT, manifest.main)));
  assert.ok(manifest.files.includes('src'));
});

test('package.json depends on the four sibling packages at 0.1.0', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  for (const name of SIBLINGS) {
    const specifier = `@dsbot/${name}`;
    assert.equal(manifest.dependencies[specifier], '0.1.0', `dependencies.${specifier}`);
    assert.equal(manifest.peerDependencies[specifier], '0.1.0', `peerDependencies.${specifier}`);
  }
});

test('sibling packages export ./src/* and ship their src directory', () => {
  for (const name of SIBLINGS) {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGES_DIR, name, 'package.json'), 'utf8'),
    );

    assert.equal(manifest.exports['./src/*'], './src/*', `${name} exports ./src/*`);
    assert.ok(manifest.files.includes('src'), `${name} files includes src`);
  }
});

test('cordis.patch.yml inserts the devloop plugin row', () => {
  const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');

  assert.match(patch, /^- insert:/m);
  assert.match(patch, /^\s+- id: devloop-plugin$/m);
  assert.match(patch, /^\s+name: '@dsbot\/devloop-plugin'$/m);
});
