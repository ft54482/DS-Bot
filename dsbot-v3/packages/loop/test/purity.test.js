import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

test('the package declares no runtime dependencies', () => {
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
});

test('source files import only relative modules', () => {
  const sourceDir = join(packageRoot, 'src');
  const files = readdirSync(sourceDir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);

  for (const file of files) {
    const text = readFileSync(join(sourceDir, file), 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.match(
        match[1],
        /^\.\.?\//,
        `${file} imports "${match[1]}"; only relative imports are allowed`,
      );
    }
  }
});
