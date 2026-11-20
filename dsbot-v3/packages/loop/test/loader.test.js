import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_REF,
  DEFAULT_LANE,
  DEFAULT_STOP_LOSS,
  MAX_WORKERS,
  MIN_WORKERS,
  loadLoop,
} from '../src/index.js';

function expectInvalid(yaml, path) {
  const result = loadLoop(yaml);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_config');
  assert.equal(result.path, path);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  return result;
}

test('loads and normalizes a complete loop config', () => {
  const result = loadLoop(`
lane: content
base: origin/main
maxWorkers: 4
verifier:
  command: node --test packages/loop/test
  independent: true
stopLoss:
  maxRounds: 3
  maxBudget: 50
  noProgressMinutes: 45
`);

  assert.deepEqual(result, {
    ok: true,
    config: {
      lane: 'content',
      base: 'origin/main',
      maxWorkers: 4,
      verifier: {
        command: 'node --test packages/loop/test',
        independent: true,
      },
      stopLoss: {
        maxRounds: 3,
        maxBudget: 50,
        noProgressMinutes: 45,
      },
    },
  });
});

test('a minimal config gets the lane and stop-loss defaults', () => {
  const result = loadLoop(`
verifier: node --test packages/loop/test
base: origin/main
maxWorkers: 2
`);

  assert.deepEqual(result, {
    ok: true,
    config: {
      lane: DEFAULT_LANE,
      base: BASE_REF,
      maxWorkers: 2,
      verifier: {
        command: 'node --test packages/loop/test',
        independent: true,
      },
      stopLoss: { ...DEFAULT_STOP_LOSS },
    },
  });
});

test('missing or invalid verifier reports the verifier field path', () => {
  expectInvalid('base: origin/main\nmaxWorkers: 4\n', 'verifier');
  expectInvalid('verifier: ""\nbase: origin/main\nmaxWorkers: 4\n', 'verifier');
  expectInvalid('verifier: 42\nbase: origin/main\nmaxWorkers: 4\n', 'verifier');
  expectInvalid('verifier:\n  independent: true\nbase: origin/main\nmaxWorkers: 4\n', 'verifier.command');
  expectInvalid('verifier:\n  command: node --test\n  independent: yes\nbase: origin/main\nmaxWorkers: 4\n', 'verifier.independent');
});

test('base must be exactly origin/main', () => {
  expectInvalid('verifier: node --test\nbase: main\nmaxWorkers: 4\n', 'base');
  expectInvalid('verifier: node --test\nbase: refs/remotes/origin/main\nmaxWorkers: 4\n', 'base');
  expectInvalid('verifier: node --test\nmaxWorkers: 4\n', 'base');
});

test('maxWorkers must be an integer in range', () => {
  for (const value of ['0', '-1', '5', '9', '1.5', '"4"']) {
    expectInvalid(`verifier: node --test\nbase: origin/main\nmaxWorkers: ${value}\n`, 'maxWorkers');
  }
  expectInvalid('verifier: node --test\nbase: origin/main\n', 'maxWorkers');

  for (const value of [MIN_WORKERS, 2, MAX_WORKERS]) {
    const result = loadLoop(`verifier: node --test\nbase: origin/main\nmaxWorkers: ${value}\n`);
    assert.equal(result.ok, true);
    assert.equal(result.config.maxWorkers, value);
  }
});

test('invalid YAML is invalid_config with the document path and line number', () => {
  const result = expectInvalid('verifier: [a, b]\nbase: origin/main\nmaxWorkers: 4\n', '$');
  assert.match(result.message, /line 1/);

  expectInvalid('verifier: node --test\nbase: origin/main\nmaxWorkers: 4\n\tlane: main\n', '$');
});

test('an empty document, a sequence root and non-string input are invalid', () => {
  expectInvalid('', '$');
  expectInvalid('# only a comment\n', '$');
  expectInvalid('- zero\n- one\n', '$');
  expectInvalid(null, '$');
  expectInvalid(42, '$');
});

test('lane is optional but must be a non-empty string', () => {
  expectInvalid('verifier: node --test\nbase: origin/main\nmaxWorkers: 4\nlane: 7\n', 'lane');
  expectInvalid('verifier: node --test\nbase: origin/main\nmaxWorkers: 4\nlane: ""\n', 'lane');
});

test('stopLoss overrides are validated field by field', () => {
  const prefix = 'verifier: node --test\nbase: origin/main\nmaxWorkers: 4\nstopLoss:\n';
  expectInvalid(`${prefix}  maxRounds: 0\n`, 'stopLoss.maxRounds');
  expectInvalid(`${prefix}  maxRounds: 1.5\n`, 'stopLoss.maxRounds');
  expectInvalid(`${prefix}  maxBudget: 0\n`, 'stopLoss.maxBudget');
  expectInvalid(`${prefix}  maxBudget: cheap\n`, 'stopLoss.maxBudget');
  expectInvalid(`${prefix}  noProgressMinutes: 0\n`, 'stopLoss.noProgressMinutes');
  expectInvalid(`${prefix}  noProgressMinutes: -5\n`, 'stopLoss.noProgressMinutes');
  expectInvalid('verifier: node --test\nbase: origin/main\nmaxWorkers: 4\nstopLoss: nope\n', 'stopLoss');
});

test('unknown keys are ignored so later revisions stay forward compatible', () => {
  const result = loadLoop(`
verifier: node --test
base: origin/main
maxWorkers: 1
futureField: yes
`);

  assert.equal(result.ok, true);
  assert.equal(result.config.maxWorkers, 1);
  assert.equal(Object.hasOwn(result.config, 'futureField'), false);
});

test('comments and quoted values load without changing the command', () => {
  const result = loadLoop(`
verifier:
  command: "node --test packages/loop/test" # run the unit suite
base: origin/main # integration branch
maxWorkers: 3
`);

  assert.equal(result.ok, true);
  assert.equal(result.config.verifier.command, 'node --test packages/loop/test');
  assert.equal(result.config.base, 'origin/main');
});
