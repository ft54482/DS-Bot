import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { decompose } from '../src/index.js';
import { goal, input, lane } from './helpers.js';

const SOURCE_DIR = new URL('../src/', import.meta.url);
const SOURCE_FILES = readdirSync(SOURCE_DIR).filter((file) => file.endsWith('.js'));
const SOURCE = SOURCE_FILES
  .map((file) => readFileSync(new URL(file, SOURCE_DIR), 'utf8'))
  .join('\n');

test('the source has no IO, network, clock, randomness or environment access', () => {
  const forbidden = [
    { pattern: /from\s+['"]node:(fs|http|https|net|tls|dgram|child_process)['"]/, label: 'an IO/network module' },
    { pattern: /\bfetch\s*\(/, label: 'fetch()' },
    { pattern: /\bMath\.random\b/, label: 'Math.random' },
    { pattern: /\bDate\.now\b/, label: 'Date.now' },
    { pattern: /\bnew\s+Date\b/, label: 'new Date' },
    { pattern: /process\.env/, label: 'process.env' },
    { pattern: /\brequire\s*\(/, label: 'require()' },
  ];

  assert.ok(SOURCE_FILES.length >= 5);
  for (const { pattern, label } of forbidden) {
    assert.equal(pattern.test(SOURCE), false, `source must not use ${label}`);
  }
});

test('results are deterministic across interleaved calls', () => {
  const first = decompose(input());
  const other = decompose({
    goal: goal({ title: '另一个目标' }),
    lanes: [lane({ lane: 'other', dir: 'packages/other', cost: 1, prd: [] })],
    budget: 5,
  });
  const again = decompose(input());

  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
});

test('each call returns fresh state, not a shared mutable result', () => {
  const first = decompose(input());
  const baseline = first.milestones[0].lanes[0].taskBook.background;
  first.milestones[0].lanes[0].taskBook.background = 'mutated';
  first.milestones[0].lanes[0].taskBook.forbidden.push('mutated');

  const second = decompose(input());

  assert.equal(second.milestones[0].lanes[0].taskBook.background, baseline);
  assert.ok(!second.milestones[0].lanes[0].taskBook.forbidden.includes('mutated'));
});
