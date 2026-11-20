import assert from 'node:assert/strict';
import test from 'node:test';

import { countCases } from '../src/index.js';

test('cases: the node TAP summary is authoritative', () => {
  const output = [
    'TAP version 13',
    'ok 1 - first',
    'not ok 2 - second',
    '1..5',
    '# tests 5',
    '# pass 4',
    '# fail 1',
    '',
  ].join('\n');
  assert.equal(countCases(output), 5);
});

test('cases: pass + fail is used when tests summary is absent', () => {
  assert.equal(countCases('# pass 7\n# fail 2\n'), 9);
});

test('cases: indented subtest results are not double counted', () => {
  const output = [
    'ok 1 - parent',
    '    ok 1 - child a',
    '    ok 2 - child b',
    'not ok 2 - parent failure',
    '  ok 1 - nested',
    '',
  ].join('\n');
  assert.equal(countCases(output), 2);
});

test('cases: ANSI codes, noise and an empty output', () => {
  assert.equal(countCases(''), 0);
  assert.equal(countCases('component: building...\nno tests here\n'), 0);
  assert.equal(countCases('\x1b[32m# tests 12\x1b[0m\n'), 12);
});

test('cases: the node spec reporter summary is understood', () => {
  const output = [
    '✔ first case (1.2ms)',
    '✔ second case (0.4ms)',
    'ℹ tests 2',
    'ℹ pass 2',
    'ℹ fail 0',
    '',
  ].join('\n');
  assert.equal(countCases(output), 2);
});

test('cases: the TAP plan is a last-resort fallback', () => {
  assert.equal(countCases('TAP version 13\n1..4\n'), 4);
});
