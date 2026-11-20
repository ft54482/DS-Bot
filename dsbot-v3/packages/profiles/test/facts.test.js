import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makeFact, makePack, makeSnapshot, makeSource, NOW } from './fixtures.js';

function evaluateWithFacts(facts) {
  return evaluateArticlePack(makePack({ facts }), selfMediaProfileV1, { now: NOW });
}

test('a key fact with a single source needs rework (two independent sources required)', () => {
  const evaluation = evaluateWithFacts([makeFact('F1', { sources: [makeSource('alpha.example')] })]);
  const facts = itemById(evaluation, 'independent.facts');

  assert.equal(facts.result, RESULT.needsRework);
  assert.match(facts.detail, /F1: 1 independent source\(s\) \[alpha\.example\]/);
  assert.match(facts.detail, /need >=2 distinct hosts/);
  assert.equal(evaluation.result, RESULT.needsRework);
});

test('two URLs on the same host count as one independent source', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      sources: [
        makeSource('alpha.example', { url: 'https://alpha.example/a' }),
        makeSource('alpha.example', { url: 'https://alpha.example/b' }),
      ],
    }),
  ]);
  const facts = itemById(evaluation, 'independent.facts');

  assert.equal(facts.result, RESULT.needsRework);
  assert.match(facts.detail, /1 independent source\(s\)/);
});

test('www is normalised, so www and apex on one site are still one source', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      sources: [makeSource('alpha.example'), makeSource('www.alpha.example', { url: 'https://www.alpha.example/x' })],
    }),
  ]);
  assert.equal(itemById(evaluation, 'independent.facts').result, RESULT.needsRework);
});

test('a missing or incomplete snapshot blocks a key fact', () => {
  for (const snapshot of [null, makeSnapshot('alpha.example', { sha256: 'not-a-hash' }), makeSnapshot('alpha.example', { excerpt: '' }), makeSnapshot('alpha.example', { captured_at: null })]) {
    const evaluation = evaluateWithFacts([
      makeFact('F1', { sources: [makeSource('alpha.example', { snapshot }), makeSource('beta.example')] }),
    ]);
    const facts = itemById(evaluation, 'independent.facts');
    assert.equal(facts.result, RESULT.blocked, JSON.stringify(snapshot));
    assert.match(facts.detail, /snapshot unavailable for alpha\.example/);
    assert.match(facts.detail, /-> blocked/);
  }
});

test('contradicting sources block a key fact', () => {
  const evaluation = evaluateWithFacts([makeFact('F1', { contradiction: true })]);
  const facts = itemById(evaluation, 'independent.facts');
  assert.equal(facts.result, RESULT.blocked);
  assert.match(facts.detail, /sources contradict each other/);
});

test('a key fact without any reachable source blocks', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', { sources: [{ url: 'not a url' }, { url: 'ftp://example.org/file' }] }),
  ]);
  assert.equal(itemById(evaluation, 'independent.facts').result, RESULT.blocked);
});

test('at least one key fact must be declared', () => {
  const evaluation = evaluateWithFacts([makeFact('N1', { key: false })]);
  const facts = itemById(evaluation, 'independent.facts');
  assert.equal(facts.result, RESULT.needsRework);
  assert.match(facts.detail, /no key facts declared/);
});

test('non-key facts are not gated even when their source is unreachable', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1'),
    { id: 'N1', key: false, statement: 'background colour', sources: [{ url: 'not a url' }] },
  ]);
  assert.equal(evaluation.result, RESULT.pass);
  assert.match(itemById(evaluation, 'independent.facts').detail, /non-key facts: 1 \(not gated\)/);
});
