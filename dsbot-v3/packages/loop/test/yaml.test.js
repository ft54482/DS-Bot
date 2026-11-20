import assert from 'node:assert/strict';
import test from 'node:test';

import { parseYaml, YamlError } from '../src/index.js';

test('parses nested mappings, scalars and comments', () => {
  const document = parseYaml(`
# loop lane
lane: content
maxWorkers: 4
ratio: 0.5
scientific: 1e3
enabled: true
disabled: false
empty: null
tilde: ~
url: http://example.test/a#frag
quoted: "a # b"
escaped: "say \\"hi\\""
single: 'it''s fine'
trailing: value # comment
`);

  assert.deepEqual(document, {
    lane: 'content',
    maxWorkers: 4,
    ratio: 0.5,
    scientific: 1000,
    enabled: true,
    disabled: false,
    empty: null,
    tilde: null,
    url: 'http://example.test/a#frag',
    quoted: 'a # b',
    escaped: 'say "hi"',
    single: "it's fine",
    trailing: 'value',
  });
});

test('parses nested mappings by indentation', () => {
  const document = parseYaml(`
verifier:
  command: node --test packages/loop/test
  independent: false
stopLoss:
  maxRounds: 2
  maxBudget: 30
  noProgressMinutes: 15
`);

  assert.deepEqual(document, {
    verifier: {
      command: 'node --test packages/loop/test',
      independent: false,
    },
    stopLoss: {
      maxRounds: 2,
      maxBudget: 30,
      noProgressMinutes: 15,
    },
  });
});

test('parses sequences of scalars, including negative numbers', () => {
  const document = parseYaml(`
paths:
  - packages/loop
  - docs/prd
numbers:
  - 1
  - -2
  - true
`);

  assert.deepEqual(document, {
    paths: ['packages/loop', 'docs/prd'],
    numbers: [1, -2, true],
  });
});

test('parses sequences of mappings', () => {
  const document = parseYaml(`
checks:
  - command: node --check src/index.js
    required: true
  - command: node --test test
    required: false
`);

  assert.deepEqual(document, {
    checks: [
      { command: 'node --check src/index.js', required: true },
      { command: 'node --test test', required: false },
    ],
  });
});

test('parses a sequence mapping with a nested mapping', () => {
  const document = parseYaml(`
verifiers:
  - name: local
    run:
      command: node --test
`);

  assert.deepEqual(document, {
    verifiers: [{ name: 'local', run: { command: 'node --test' } }],
  });
});

test('an empty or comment-only document is null', () => {
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('\n  \n# nothing here\n'), null);
});

test('a leading UTF-8 BOM is ignored', () => {
  assert.deepEqual(parseYaml('\uFEFFlane: main\n'), { lane: 'main' });
});

test('rejects tabs used for indentation', () => {
  assert.throws(() => parseYaml('lane:\n\tverifier: x\n'), YamlError);
  assert.throws(() => parseYaml('lane:\n\tverifier: x\n'), /tabs/);
});

test('rejects duplicate keys', () => {
  assert.throws(() => parseYaml('lane: a\nlane: b\n'), /duplicate key/);
});

test('rejects a mapping entry without a colon', () => {
  assert.throws(() => parseYaml('lane main\n'), /expected "key: value"/);
});

test('rejects inconsistent indentation', () => {
  assert.throws(() => parseYaml('a:\n  b: 1\n c: 2\n'), /unexpected indentation/);
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /unexpected indentation/);
  assert.throws(() => parseYaml('  lane: main\n'), /indentation 0/);
});

test('rejects unterminated and malformed quoted scalars', () => {
  assert.throws(() => parseYaml("lane: 'main\n"), /unterminated single-quoted/);
  assert.throws(() => parseYaml('lane: "main\n'), /invalid double-quoted/);
  assert.throws(() => parseYaml("lane: 'main' trailing\n"), /unexpected text/);
});

test('rejects YAML features outside the supported subset', () => {
  assert.throws(() => parseYaml('paths: [a, b]\n'), /flow collections/);
  assert.throws(() => parseYaml('paths: {a: b}\n'), /flow collections/);
  assert.throws(() => parseYaml('script: |\n  echo hi\n'), /block scalars/);
});
