import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);
const PACKAGE = new URL('../package.json', import.meta.url);

function sourceFiles() {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: readFileSync(new URL(name, SRC), 'utf8') }));
}

test('purity: the gateway logs nothing and imports no IO, network or process internals', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 5);
  for (const { name, text } of files) {
    assert.ok(!/console\./.test(text), `${name} must not log`);
    assert.ok(!/from ['"]node:(fs|http|https|net|tls)['"]/.test(text), `${name} must not import IO/net modules`);
    assert.ok(!/\bprocess\.env\b/.test(text), `${name} must not read process.env`);
    assert.ok(!/\b(readFile|writeFile|createServer|listen)\s*\(/.test(text), `${name} must not open files or sockets`);
    assert.ok(!/(?<![.\w])fetch\s*\(/.test(text), `${name} must not call the global fetch`);
  }
});

test('purity: the package declares no runtime dependencies and the documented test command', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.test, 'node --test test');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
});
