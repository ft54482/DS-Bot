import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

/**
 * L43 discipline: the source client is offline by construction and never
 * persists anything. These tests inspect the shipped modules, not a mock, so a
 * future import of node:fs / node:http or a direct global fetch call fails.
 */
const SRC_DIR = new URL('../src/', import.meta.url);

test('src: only node:crypto and relative imports, no fs/http/network APIs', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 2);

  for (const file of files) {
    const text = readFileSync(new URL(file, SRC_DIR), 'utf8');
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier === 'node:crypto' || specifier.startsWith('./'),
        `${file} imports unexpected module: ${specifier}`,
      );
    }

    assert.doesNotMatch(text, /node:fs|node:http|node:https|node:net/, `${file} uses a forbidden module`);
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${file} calls global fetch`);
    assert.doesNotMatch(
      text,
      /writeFile|appendFile|createWriteStream|mkdir|rmSync|unlink/,
      `${file} writes to disk`,
    );
  }
});
