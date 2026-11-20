import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
);

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

test('source performs no ambient time, process or network I/O', () => {
  const sourceDir = join(packageRoot, 'src');
  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(join(sourceDir, file), 'utf8');
    for (const forbidden of [
      /\bDate\.now\b/,
      /\bnew Date\b/,
      /\bchild_process\b/,
      /\bnode:fs\b/,
      /\bnode:http\b/,
      /\bfetch\s*\(/,
      /\bprocess\.env\b/,
    ]) {
      assert.doesNotMatch(
        text,
        forbidden,
        `${file} must not read ambient time, environment, files or the network`,
      );
    }
  }
});
