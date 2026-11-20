import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import * as cost from '../src/index.js';

const SRC_DIR = new URL('../src/', import.meta.url);

test('exports the documented pure API', () => {
  assert.equal(typeof cost.createLedger, 'function');
  assert.equal(typeof cost.guard, 'function');
  assert.equal(typeof cost.CostError, 'function');
  assert.equal(cost.COST_CURRENCY, 'CNY');
  assert.ok(Object.isFrozen(cost.COST_CODES));
  assert.equal(cost.COST_CODES.BUDGET_EXCEEDED, 'budget_exceeded');
});

test('source performs no IO, reads no clock and imports nothing external', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 3);

  const specifiers = [];
  for (const name of files) {
    const source = readFileSync(new URL(name, SRC_DIR), 'utf8');

    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      specifiers.push(match[1]);
    }

    assert.doesNotMatch(
      source,
      /\b(fetch|readFile|readFileSync|writeFile|openSync|createServer|connect)\s*\(/,
      `${name} must not perform I/O`,
    );
    assert.doesNotMatch(
      source,
      /\b(Date|process|performance|setTimeout|setInterval|XMLHttpRequest)\b/,
      `${name} must not read ambient time or process state`,
    );
  }

  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('./') || specifier.startsWith('../'),
      `unexpected external import ${specifier}`,
    );
  }
});

test('the package declares no runtime dependencies', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
  assert.equal(packageJson.optionalDependencies, undefined);
});
