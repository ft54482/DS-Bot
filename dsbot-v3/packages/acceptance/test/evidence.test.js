import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, RESULTS, sha256Hex } from '../src/index.js';
import {
  TEST_OUTPUT,
  commitEvidence,
  domainRubric,
  itemById,
  passItem,
  signedTestOutput,
  testEvidence,
} from './helpers.js';

test('a matching declared sha256 keeps execution evidence valid', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), signedTestOutput()],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, true);
  assert.equal(itemById(evaluation, 'execution.tests').ok, true);
});

test('evidence whose sha256 does not match its content is invalid and blocks', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [
      commitEvidence(),
      testEvidence({ content: TEST_OUTPUT, sha256: sha256Hex('some other output') }),
    ],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const integrity = itemById(evaluation, 'evidence.integrity');
  assert.equal(integrity.ok, false);
  assert.match(integrity.detail, /invalid evidence/);
  assert.match(integrity.detail, /does not match content hash/);

  const tests = itemById(evaluation, 'execution.tests');
  assert.equal(tests.ok, false);
  assert.match(tests.detail, /invalid sha256/);
});

test('a malformed sha256 is invalid evidence', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ sha256: 'abc123' })],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'evidence.integrity').detail, /64-character hex/);
});

test('a declared sha256 without content cannot be verified', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ content: undefined, sha256: sha256Hex(TEST_OUTPUT) })],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'evidence.integrity').detail, /content is not a UTF-8 string/);
});

test('the sha256: prefix and hash/type aliases are accepted', () => {
  const content = '{"stage":"execution"}';
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [
      { id: 'c', type: 'commit', content: commitEvidence().content },
      {
        id: 't',
        type: 'test-output',
        content,
        exitCode: 0,
        hash: `sha256:${sha256Hex(content)}`,
      },
    ],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, true);
});

test('invalid evidence blocks even when the domain rubric itself passes', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    evidence: [
      {
        id: 'review',
        kind: 'independent_review',
        content: 'review body',
        sha256: sha256Hex('a different review body'),
      },
    ],
    rubric: domainRubric([passItem('independent.visual')]),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.equal(itemById(evaluation, 'independent.visual').ok, true);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, false);
});

test('evidence without a declared hash is accepted', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence()],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, true);
  assert.match(itemById(evaluation, 'evidence.integrity').detail, /2 evidence record\(s\) verified/);
});

test('evidence records reported as blocked/invalid cannot be a pass', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [commitEvidence(), testEvidence({ verdict: 'invalid' })],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.equal(itemById(evaluation, 'execution.tests').ok, false);
});

test('a sha256 mismatch is invalid even when the record is not the gated one', () => {
  const evaluation = evaluate({
    stage: 'execution',
    evidence: [
      commitEvidence(),
      testEvidence(),
      { id: 'note', kind: 'note', content: 'hello', sha256: sha256Hex('goodbye') },
    ],
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.equal(itemById(evaluation, 'execution.commit').ok, true);
  assert.equal(itemById(evaluation, 'execution.tests').ok, true);
  assert.equal(itemById(evaluation, 'evidence.integrity').ok, false);
});
