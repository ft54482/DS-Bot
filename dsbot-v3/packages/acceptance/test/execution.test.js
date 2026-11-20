import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, RESULTS, STAGES, sha256Hex } from '../src/index.js';
import {
  COMMIT,
  TEST_OUTPUT,
  commitEvidence,
  itemById,
  testEvidence,
} from './helpers.js';

test('execution passes with a commit sha and passing test output', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { id: 'tsk-exec', level: 'execution' },
    evidence: [commitEvidence(), testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.deepEqual(
    evaluation.items.map((item) => item.id),
    ['stage.alignment', 'evidence.integrity', 'execution.commit', 'execution.tests'],
  );
  assert.equal(itemById(evaluation, 'execution.commit').detail.includes(COMMIT), true);
  assert.equal(itemById(evaluation, 'execution.commit').ok, true);
  assert.equal(itemById(evaluation, 'execution.tests').ok, true);
});

test('execution blocks when the commit evidence is missing', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { level: 'execution' },
    evidence: [testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const commit = itemById(evaluation, 'execution.commit');
  assert.equal(commit.ok, false);
  assert.match(commit.detail, /missing commit evidence/);
  assert.equal(itemById(evaluation, 'execution.tests').ok, true);
});

test('execution blocks when the test output evidence is missing', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { level: 'execution' },
    evidence: [commitEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const tests = itemById(evaluation, 'execution.tests');
  assert.equal(tests.ok, false);
  assert.match(tests.detail, /missing test output/);
});

test('execution with no evidence at all blocks and names both gates', () => {
  const evaluation = evaluate({ stage: 'execution', task: { level: 'execution' } });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.equal(itemById(evaluation, 'execution.commit').ok, false);
  assert.equal(itemById(evaluation, 'execution.tests').ok, false);
});

test('a non-zero test exit code is rework, not pass and not blocked', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { level: 'execution' },
    evidence: [commitEvidence(), testEvidence({ exitCode: 1 })],
  });

  assert.equal(evaluation.result, RESULTS.rework);
  const tests = itemById(evaluation, 'execution.tests');
  assert.equal(tests.ok, false);
  assert.match(tests.detail, /exit code 1/);
});

test('snake_case exit_code and failed verdict are honoured', () => {
  const byCode = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ exit_code: '2', exitCode: undefined })],
  });
  assert.equal(byCode.result, RESULTS.rework);

  const byVerdict = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ verdict: 'fail', exitCode: 0 })],
  });
  assert.equal(byVerdict.result, RESULTS.rework);
});

test('a malformed commit sha blocks instead of passing', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence({ content: 'not-a-sha' }), testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'execution.commit').detail, /40 hexadecimal/);
});

test('an empty test output blocks because it cannot be judged', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ content: '   ' })],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'execution.tests').detail, /content is empty/);
});

test('a stage that contradicts task.level is blocked', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { level: 'business' },
    evidence: [commitEvidence(), testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const alignment = itemById(evaluation, 'stage.alignment');
  assert.equal(alignment.ok, false);
  assert.match(alignment.detail, /cannot evaluate a "business" task/);
});

test('a missing task.level is allowed: the stage argument is authoritative', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: {},
    evidence: [commitEvidence(), testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.match(itemById(evaluation, 'stage.alignment').detail, /not declared/);
});

test('an unknown stage is a programmer error, not an acceptance verdict', () => {
  assert.throws(() => evaluate({ stage: 'deployment' }), /stage must be one of/);
  assert.throws(() => evaluate({}), /stage must be one of/);
  assert.throws(() => evaluate({ stage: STAGES.execution, evidence: 'nope' }), /evidence must be an array/);
});

test('execution test evidence can also carry a valid sha256 binding', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ sha256: sha256Hex(TEST_OUTPUT) })],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, true);
});
