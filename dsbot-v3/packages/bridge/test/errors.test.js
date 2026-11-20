import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRD_ERROR_NAMES,
  PRD_ERRORS,
  classifyHttpStatus,
  isPrdErrorCode,
  mapError,
} from '../src/index.js';

test('errors: every PRD name round-trips with its contract status', () => {
  assert.equal(PRD_ERROR_NAMES.length, 10);
  for (const name of PRD_ERROR_NAMES) {
    const mapped = mapError(name);
    assert.equal(mapped.prd, name, name);
    assert.equal(mapped.prd_status, PRD_ERRORS[name].status, name);
    assert.equal(mapped.extension, false, name);
  }
});

test('errors: bridge-native codes convert to PRD names', () => {
  const cases = {
    BAD_REQUEST: 'invalid_state_transition',
    NOT_FOUND: 'invalid_state_transition',
    FORBIDDEN_WORKSPACE: 'scope_denied',
    RATE_LIMITED: 'rate_limited',
    HOST_ERROR: 'executor_unavailable',
    TIMEOUT: 'executor_unavailable',
    NETWORK_ERROR: 'executor_unavailable',
    UNAUTHORIZED: 'authorization_exceeded',
    BUDGET_EXCEEDED: 'budget_exceeded',
    DUPLICATE_DISPATCH: 'duplicate_dispatch',
  };
  for (const [code, prd] of Object.entries(cases)) {
    const mapped = mapError(code);
    assert.equal(mapped.prd, prd, code);
  }
});

test('errors: 5xx is retryable but may have side effects, so a key is required', () => {
  for (const status of [500, 502, 503, 504]) {
    const mapped = mapError(status);
    assert.equal(mapped.prd, 'executor_unavailable', String(status));
    assert.equal(mapped.status_class, '5xx', String(status));
    assert.equal(mapped.retryable, true, String(status));
    assert.equal(mapped.side_effects_possible, true, String(status));
    assert.equal(mapped.requires_idempotency_key, true, String(status));
  }
});

test('errors: 4xx classification separates client, auth, budget, conflict and validation', () => {
  const fourHundred = mapError(400);
  assert.equal(fourHundred.prd, 'invalid_state_transition');
  assert.equal(fourHundred.category, 'client');
  assert.equal(fourHundred.retryable, false);

  assert.equal(mapError(401).prd, 'authorization_exceeded');
  assert.equal(mapError(402).prd, 'budget_exceeded');
  assert.equal(mapError(403).prd, 'scope_denied');

  const notFound = mapError(404);
  assert.equal(notFound.category, 'not_found');
  assert.equal(notFound.retryable, false);

  assert.equal(mapError(409).prd, 'invalid_state_transition');
  assert.equal(mapError(422).prd, 'missing_acceptance');

  const limited = mapError(429);
  assert.equal(limited.prd, 'rate_limited');
  assert.equal(limited.retryable, true);
  assert.equal(limited.extension, true);

  const teapot = mapError(418);
  assert.equal(teapot.prd, null);
  assert.equal(teapot.category, 'client');
  assert.equal(teapot.side_effects_possible, false);
});

test('errors: object input prefers a known code and keeps the observed status', () => {
  const mapped = mapError({ code: 'FORBIDDEN_WORKSPACE', status: 403, message: 'workspace outside allowlist' });
  assert.equal(mapped.prd, 'scope_denied');
  assert.equal(mapped.code, 'FORBIDDEN_WORKSPACE');
  assert.equal(mapped.prd_status, 403);
  assert.equal(mapped.http_status, 403);
  assert.equal(mapped.message, 'workspace outside allowlist');
});

test('errors: an unknown code is not guessed, but a known HTTP status still classifies it', () => {
  const unknown = mapError('SOMETHING_NEW');
  assert.equal(unknown.prd, null);
  assert.equal(unknown.category, 'unknown');
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.side_effects_possible, true);

  const withStatus = mapError({ code: 'SOMETHING_NEW', status: 503 });
  assert.equal(withStatus.code, 'SOMETHING_NEW');
  assert.equal(withStatus.prd, 'executor_unavailable');
  assert.equal(withStatus.http_status, 503);
});

test('errors: classifyHttpStatus never invents a PRD name for 2xx/3xx', () => {
  assert.equal(classifyHttpStatus(200).category, 'ok');
  assert.equal(classifyHttpStatus(200).prd, null);
  assert.equal(classifyHttpStatus(302).category, 'redirect');
  assert.equal(classifyHttpStatus(302).prd, null);
});

test('errors: isPrdErrorCode accepts the PRD names and rejects bridge aliases', () => {
  assert.equal(isPrdErrorCode('missing_acceptance'), true);
  assert.equal(isPrdErrorCode('MISSING_ACCEPTANCE'), true);
  assert.equal(isPrdErrorCode('BAD_REQUEST'), false);
  assert.equal(isPrdErrorCode('executor_unavailable'), true);
});
