import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makePack, makeProfile, NOW } from './fixtures.js';

function evaluateWithQuality(quality, profile = selfMediaProfileV1) {
  return evaluateArticlePack(makePack({ quality }), profile, { now: NOW });
}

test('a rubric score below its threshold needs rework and reports the issue', () => {
  const evaluation = evaluateWithQuality({
    rubric: {
      structure: { score: 40, issues: ['opening lacks a hook', 'argument jumps between topics'] },
    },
  });
  const structure = itemById(evaluation, 'independent.quality.structure');

  assert.equal(structure.result, RESULT.needsRework);
  assert.match(structure.detail, /structure score 40 < threshold 70/);
  assert.match(structure.detail, /opening lacks a hook/);
  assert.equal(evaluation.result, RESULT.needsRework);
});

test('missing rubric dimensions need rework instead of being assumed good', () => {
  const evaluation = evaluateWithQuality({ rubric: { readability: { score: undefined } } });
  const readability = itemById(evaluation, 'independent.quality.readability');
  assert.equal(readability.result, RESULT.needsRework);
  assert.match(readability.detail, /missing readability score/);
});

test('scores outside the profile scale need rework', () => {
  const evaluation = evaluateWithQuality({ rubric: { style: { score: 140 } } });
  const style = itemById(evaluation, 'independent.quality.style');
  assert.equal(style.result, RESULT.needsRework);
  assert.match(style.detail, /outside the profile scale \[0, 100\]/);
});

test('a missing independent reviewer record needs rework', () => {
  const evaluation = evaluateWithQuality({ reviewer: undefined });
  const reviewer = itemById(evaluation, 'independent.quality.reviewer');
  assert.equal(reviewer.result, RESULT.needsRework);
  assert.match(reviewer.detail, /independent reviewer record missing/);
});

test('scores from a non-independent context block acceptance', () => {
  const evaluation = evaluateWithQuality({ reviewer: { id: 'author', independent: false } });
  const reviewer = itemById(evaluation, 'independent.quality.reviewer');
  assert.equal(reviewer.result, RESULT.blocked);
  assert.match(reviewer.detail, /self-review scores are not acceptance evidence/);
  assert.equal(evaluation.result, RESULT.blocked);
});

test('a reviewer without a review context needs rework', () => {
  const evaluation = evaluateWithQuality({ reviewer: { id: 'reviewer-1', context_id: undefined, independent: true } });
  const reviewer = itemById(evaluation, 'independent.quality.reviewer');
  assert.equal(reviewer.result, RESULT.needsRework);
  assert.match(reviewer.detail, /has no context_id/);
});

test('a reviewer reusing the author context blocks acceptance', () => {
  const evaluation = evaluateWithQuality({
    reviewer: { id: 'same-context', context_id: 'ctx-writer-1', independent: true },
  });
  const reviewer = itemById(evaluation, 'independent.quality.reviewer');
  assert.equal(reviewer.result, RESULT.blocked);
  assert.match(reviewer.detail, /ran in the author's context/);
});

test('custom profile thresholds are applied', () => {
  const profile = makeProfile({ quality: { thresholds: { structure: 90 } } });
  const evaluation = evaluateWithQuality({}, profile);
  assert.equal(itemById(evaluation, 'independent.quality.structure').result, RESULT.needsRework);
  assert.equal(itemById(evaluation, 'independent.quality.readability').result, RESULT.pass);
});
