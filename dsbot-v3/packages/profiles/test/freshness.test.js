import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makeFact, makePack, makeProfile, makeSource, NOW } from './fixtures.js';

function evaluateWithFacts(facts, profile = selfMediaProfileV1) {
  return evaluateArticlePack(makePack({ facts }), profile, { now: NOW });
}

test('a key fact without source time needs a timestamp or a replacement source', () => {
  // Snapshots stay complete, so only the source timestamp is missing.
  const undated = (host) => ({ ...makeSource(host), published_at: null, fetched_at: null, updated_at: null });
  const evaluation = evaluateWithFacts([
    makeFact('F1', { sources: [undated('alpha.example'), undated('beta.example')] }),
  ]);
  const freshness = itemById(evaluation, 'independent.freshness');

  assert.equal(freshness.result, RESULT.needsRework);
  assert.match(freshness.detail, /F1: no source timestamp/);
  assert.equal(evaluation.result, RESULT.needsRework);
});

test('expired key-fact sources block by default', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      sources: [
        makeSource('alpha.example', { published_at: '2025-01-01T00:00:00.000Z' }),
        makeSource('beta.example', { published_at: '2025-01-02T00:00:00.000Z' }),
      ],
    }),
  ]);
  const freshness = itemById(evaluation, 'independent.freshness');

  assert.equal(freshness.result, RESULT.blocked);
  assert.match(freshness.detail, /newest source is \d+\.\d days old \(> 180\) -> blocked/);
  assert.equal(evaluation.result, RESULT.blocked);
});

test('a profile may ask for a replacement source instead of blocking', () => {
  const profile = makeProfile({ freshness: { expiredResult: 'needs_rework' } });
  const evaluation = evaluateWithFacts(
    [
      makeFact('F1', {
        sources: [
          makeSource('alpha.example', { published_at: '2025-01-01T00:00:00.000Z' }),
          makeSource('beta.example', { published_at: '2025-01-02T00:00:00.000Z' }),
        ],
      }),
    ],
    profile,
  );
  assert.equal(itemById(evaluation, 'independent.freshness').result, RESULT.needsRework);
  assert.equal(evaluation.result, RESULT.needsRework);
});

test('freshness uses the freshest source, so one recent source keeps the fact current', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      sources: [
        makeSource('alpha.example', { published_at: '2025-01-01T00:00:00.000Z' }),
        makeSource('beta.example', { published_at: '2026-11-01T00:00:00.000Z' }),
      ],
    }),
  ]);
  assert.equal(itemById(evaluation, 'independent.freshness').result, RESULT.pass);
});

test('explicitly non-time-sensitive facts do not expire', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      time_sensitive: false,
      sources: [
        makeSource('alpha.example', { published_at: '2020-01-01T00:00:00.000Z' }),
        makeSource('beta.example', { published_at: '2020-01-02T00:00:00.000Z' }),
      ],
    }),
  ]);
  const freshness = itemById(evaluation, 'independent.freshness');
  assert.equal(freshness.result, RESULT.pass);
  assert.match(freshness.detail, /explicitly not time-sensitive/);
});

test('a future source timestamp needs rework instead of being trusted', () => {
  const evaluation = evaluateWithFacts([
    makeFact('F1', {
      sources: [
        makeSource('alpha.example', { published_at: '2027-02-01T00:00:00.000Z' }),
        makeSource('beta.example', { published_at: '2027-02-02T00:00:00.000Z' }),
      ],
    }),
  ]);
  const freshness = itemById(evaluation, 'independent.freshness');
  assert.equal(freshness.result, RESULT.needsRework);
  assert.match(freshness.detail, /is in the future/);
});
