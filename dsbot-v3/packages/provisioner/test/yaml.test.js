import assert from 'node:assert/strict';
import test from 'node:test';
import { toYaml } from '../src/yaml.js';

test('toYaml renders nested mappings, arrays and scalars', () => {
  const text = toYaml({
    webserver: { port: 3086 },
    'dsh-superagent': { stateDir: 'C:\\Users\\a b' },
    list: ['a', 'b'],
    empty: [],
    flag: true,
    nothing: null,
  });

  assert.match(text, /^webserver:\n {2}port: 3086$/m);
  assert.match(text, /^dsh-superagent:$/m);
  assert.ok(text.includes('stateDir: "C:\\\\Users\\\\a b"'), text);
  assert.match(text, /^ {2}- "a"$/m);
  assert.match(text, /^ {2}- "b"$/m);
  assert.match(text, /^empty: \[\]$/m);
  assert.match(text, /^flag: true$/m);
  assert.match(text, /^nothing: null$/m);
});

test('toYaml handles arrays of objects as nested blocks', () => {
  const text = toYaml({ items: [{ a: 1 }, { b: 2 }] });
  assert.match(text, /^items:$/m);
  assert.match(text, /^ {2}-$/m);
  assert.match(text, /^ {4}a: 1$/m);
  assert.match(text, /^ {4}b: 2$/m);
});

test('toYaml quotes keys that are not plain YAML identifiers', () => {
  const text = toYaml({ 'weird key': 1 });
  assert.match(text, /^"weird key": 1$/m);
});

test('toYaml refuses values it cannot represent', () => {
  assert.throws(() => toYaml({ fn: () => 1 }), TypeError);
});
