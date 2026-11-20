import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublishAllowed,
  contentFingerprint,
  evaluateArticlePack,
  evaluatePublish,
  PUBLISH_DENIALS,
  PublishNotAuthorizedError,
  RESULT,
  selfMediaProfileV1,
} from '../src/index.js';
import { DAY_MS, itemById, makePack, NOW } from './fixtures.js';

function grantedAuthorization(pack, overrides = {}) {
  return {
    id: 'pub_01JTEST',
    action: 'publish',
    target: 'wechat:翔解',
    content_fingerprint: contentFingerprint(pack),
    state: 'granted',
    granted_by: 'ft54482',
    granted_at: NOW - DAY_MS,
    expires_at: NOW + DAY_MS,
    ...overrides,
  };
}

function codes(decision) {
  return decision.reasons.map((reason) => reason.code);
}

test('acceptance passing does not authorize publishing', () => {
  const pack = makePack();
  const acceptance = evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW });
  assert.equal(acceptance.result, RESULT.pass);

  const decision = evaluatePublish(pack, null, { now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.result, 'rejected');
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.authorizationRequired));
  assert.equal(decision.acceptance, RESULT.pass);
});

test('unauthorized publish is rejected through the throwing gate', () => {
  const pack = makePack();
  assert.throws(
    () => assertPublishAllowed(pack, null, { now: NOW }),
    (error) => {
      assert.ok(error instanceof PublishNotAuthorizedError);
      assert.equal(error.code, 'publish_not_authorized');
      assert.ok(error.decision.reasons.some((reason) => reason.code === PUBLISH_DENIALS.authorizationRequired));
      return true;
    },
  );
});

test('a valid granted authorization allows publishing the identical content', () => {
  const pack = makePack();
  const decision = evaluatePublish(pack, grantedAuthorization(pack), { now: NOW });
  assert.equal(decision.allowed, true);
  assert.equal(decision.result, 'authorized');
  assert.deepEqual(decision.reasons, []);
  assert.match(decision.content_fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('an expired authorization is rejected', () => {
  const pack = makePack();
  const decision = evaluatePublish(pack, grantedAuthorization(pack, { expires_at: NOW - 1 }), { now: NOW });
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.expired));
});

test('a revoked authorization is rejected', () => {
  const pack = makePack();
  const decision = evaluatePublish(pack, grantedAuthorization(pack, { state: 'revoked' }), { now: NOW });
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.notGranted));
});

test('editing the content after the authorization invalidates it', () => {
  const original = makePack();
  const authorization = grantedAuthorization(original);
  const edited = makePack({ article: { body: 'A completely different body after the license was granted.' } });
  const decision = evaluatePublish(edited, authorization, { now: NOW });

  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.fingerprintMismatch));
  assert.notEqual(contentFingerprint(edited), authorization.content_fingerprint);
});

test('an authorization for another platform account is rejected', () => {
  const pack = makePack();
  const decision = evaluatePublish(pack, grantedAuthorization(pack, { target: 'wechat:另一个账号' }), { now: NOW });
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.targetMismatch));
});

test('publishing without any declared target is rejected', () => {
  const pack = makePack({ layout: { platform: undefined, account: undefined } });
  assert.equal(evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW }).result, RESULT.pass);

  const decision = evaluatePublish(pack, grantedAuthorization(pack), { now: NOW });
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.targetMismatch));
});

test('non-publish actions and missing expiry are rejected as invalid authorizations', () => {
  const pack = makePack();
  for (const overrides of [{ action: 'deploy' }, { expires_at: null }, { granted_by: '' }, { id: '' }]) {
    const decision = evaluatePublish(pack, grantedAuthorization(pack, overrides), { now: NOW });
    assert.equal(decision.allowed, false, JSON.stringify(overrides));
    assert.ok(codes(decision).includes(PUBLISH_DENIALS.invalid), JSON.stringify(overrides));
  }
});

test('an authorization cannot rescue a failing acceptance result', () => {
  const pack = makePack({
    facts: [
      {
        ...makePack().facts[0],
        sources: [makePack().facts[0].sources[0]],
      },
      makePack().facts[1],
    ],
  });
  const acceptance = evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW });
  assert.equal(acceptance.result, RESULT.needsRework);

  const decision = evaluatePublish(pack, grantedAuthorization(pack), { now: NOW });
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision).includes(PUBLISH_DENIALS.acceptanceNotPassed));
  assert.equal(itemById(acceptance, 'independent.facts').result, RESULT.needsRework);
});
