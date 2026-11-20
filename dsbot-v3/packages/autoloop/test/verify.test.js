import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf } from './helpers.js';
import { parseVerdict } from '../src/verdict.js';

test('PASS JSON from the verifier advances to merge', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', commit: 'c1', costCny: 1 }],
    verdicts: { T1: '{"verdict":"PASS"}' },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  const verified = await harness.loop.step();

  assert.equal(actionOf(verified, 'verify').verdict, 'PASS');
  assert.equal(verified.next, 'merge');
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'passed');
});

test('FAIL feedback is handed to the rework dispatch', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: { verdict: 'FAIL', feedback: 'add regression tests' } },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  const verified = await harness.loop.step();
  assert.equal(actionOf(verified, 'verify').verdict, 'FAIL');
  assert.equal(verified.next, 'merge');

  const merged = await harness.loop.step();
  assert.equal(actionOf(merged, 'rework').feedback, 'add regression tests');
  assert.equal(harness.ports.mergeCalls.length, 0);
  assert.equal(harness.ports.reworkCalls[0].feedback, 'add regression tests');
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'dispatched');
});

test('malformed verifier output fails closed and never merges', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: 'looks good to me' },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  const verified = await harness.loop.step();

  assert.equal(actionOf(verified, 'verify').verdict, 'FAIL');
  assert.equal(actionOf(verified, 'verify').reason, 'invalid_verifier_output');

  const merged = await harness.loop.step();
  assert.equal(actionOf(merged, 'rework').taskId, 'T1');
  assert.equal(harness.ports.mergeCalls.length, 0);
});

test('a thrown verifier error fails closed with verifier_error', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: {
      T1: () => {
        throw new Error('verifier crashed');
      },
    },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  const verified = await harness.loop.step();

  assert.equal(actionOf(verified, 'verify').verdict, 'FAIL');
  assert.equal(actionOf(verified, 'verify').reason, 'verifier_error');
  assert.match(actionOf(verified, 'verify').feedback, /verifier crashed/);
});

test('verdict parser accepts JSON strings, objects, envelopes and fences', () => {
  assert.equal(parseVerdict('{"verdict":"PASS"}').verdict, 'PASS');
  assert.equal(parseVerdict({ verdict: 'fail' }).verdict, 'FAIL');
  assert.equal(
    parseVerdict({ output: '{"verdict":"PASS","feedback":"ok"}' }).verdict,
    'PASS',
  );
  assert.equal(parseVerdict({ result: { verdict: 'FAIL' } }).verdict, 'FAIL');
  assert.equal(
    parseVerdict('```json\n{"verdict":"PASS"}\n```').verdict,
    'PASS',
  );
});

test('verdict parser fails closed on everything else', () => {
  for (const raw of [
    undefined,
    null,
    '',
    'PASS',
    '{"result":"PASS"}',
    '{"verdict":"MAYBE"}',
    '["PASS"]',
    '"PASS"',
    'not json',
  ]) {
    const parsed = parseVerdict(raw);
    assert.equal(parsed.verdict, 'FAIL', `raw=${JSON.stringify(raw)}`);
    assert.equal(parsed.reason, 'invalid_verifier_output');
    assert.equal(parsed.ok, false);
  }
});
