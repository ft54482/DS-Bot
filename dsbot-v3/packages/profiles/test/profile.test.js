import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWN_ITEM_IDS,
  ProfileError,
  assertProfile,
  evaluateArticlePack,
  RESULT,
  selfMediaProfileV1,
} from '../src/index.js';
import { itemById, makePack, makeProfile, NOW } from './fixtures.js';

test('the default profile is pinned, versioned and declares every item', () => {
  assert.equal(selfMediaProfileV1.id, 'business.self_media_v1');
  assert.equal(selfMediaProfileV1.version, 1);
  assert.equal(selfMediaProfileV1.stage, 'business');
  assert.deepEqual(selfMediaProfileV1.requiredItems, [...KNOWN_ITEM_IDS]);
  assert.ok(selfMediaProfileV1.requiredItems.some((item) => item.startsWith('independent.')));
  assert.equal(assertProfile(selfMediaProfileV1), true);
});

test('the default profile is deeply frozen so a caller cannot weaken a gate', () => {
  assert.ok(Object.isFrozen(selfMediaProfileV1));
  assert.ok(Object.isFrozen(selfMediaProfileV1.quality.thresholds));
  assert.ok(Object.isFrozen(selfMediaProfileV1.requiredItems));
  assert.throws(() => {
    selfMediaProfileV1.facts.minIndependentSources = 1;
  }, TypeError);
});

test('structurally invalid profiles are rejected before evaluation', () => {
  const cases = [
    null,
    {},
    { ...selfMediaProfileV1, version: 0 },
    { ...selfMediaProfileV1, stage: 'execution' },
    { ...selfMediaProfileV1, requiredItems: [] },
    { ...selfMediaProfileV1, requiredItems: ['auto.layout.titles'] },
    makeProfile({ facts: { minIndependentSources: 1 } }),
    makeProfile({ facts: { requireSnapshot: false } }),
    makeProfile({ freshness: { expiredResult: 'ignore' } }),
    makeProfile({ quality: { thresholds: { structure: 120 } } }),
    makeProfile({ quality: { requireIndependentReviewer: false } }),
    makeProfile({ compliance: { maxQuoteRatio: 0.5, hardQuoteRatio: 0.3 } }),
    makeProfile({ compliance: { requireRiskList: false } }),
  ];

  for (const profile of cases) {
    assert.throws(() => assertProfile(profile), ProfileError, JSON.stringify(profile));
  }
});

test('evaluation refuses to run with an invalid profile', () => {
  assert.throws(
    () => evaluateArticlePack(makePack(), makeProfile({ version: 0 }), { now: NOW }),
    ProfileError,
  );
});

test('a custom profile keeps every item evaluated (no silent waiver)', () => {
  const profile = makeProfile({ quality: { thresholds: { style: 95 } } });
  const evaluation = evaluateArticlePack(makePack(), profile, { now: NOW });
  assert.equal(itemById(evaluation, 'independent.quality.style').result, RESULT.needsRework);
  assert.equal(itemById(evaluation, 'independent.quality.structure').result, RESULT.pass);
});

test('a missing profile falls back to the pinned v1 profile', () => {
  const evaluation = evaluateArticlePack(makePack(), undefined, { now: NOW });
  assert.equal(evaluation.result, RESULT.pass);
});
