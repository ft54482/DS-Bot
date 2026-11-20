import test from 'node:test';
import assert from 'node:assert/strict';

import { createGateway, ERROR_CODES, fetchTransport, redact, sanitize } from '../src/index.js';
import { chatResponse, fakeTransport, sequenceClock } from './helpers/fake_transport.js';

const ENV = {
  DSBOT_MODEL_BASE_URL: 'https://api.example.test/v1',
  DSBOT_MODEL_API_KEY: 'sk-test-gateway-0123456789',
  DSBOT_MODEL_NAME: 'dsbot-test-model',
};

test('gateway: unknown kind and a missing transport are rejected at construction', () => {
  assert.throws(
    () => createGateway({ kind: 'grpc', transport: () => {} }),
    (error) => error.code === ERROR_CODES.invalid_kind,
  );
  assert.throws(
    () => createGateway({ kind: 'direct_http' }),
    (error) => error.code === ERROR_CODES.invalid_request && /transport/.test(error.message),
  );
  assert.throws(
    () => createGateway({ kind: 'dsh_bridge', transport: () => {}, clock: 'later' }),
    (error) => error.code === ERROR_CODES.invalid_request && /clock/.test(error.message),
  );
  assert.throws(
    () => createGateway({ kind: 'direct_http', transport: () => {}, env: [] }),
    (error) => error.code === ERROR_CODES.invalid_request && /env/.test(error.message),
  );
});

test('gateway: complete() validates the request before touching the transport', async () => {
  const transport = fakeTransport(() => chatResponse({ text: 'never' }));
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV });

  for (const request of [undefined, {}, { prompt: '' }, { prompt: '   ' }, { prompt: 'x', system: 5 }]) {
    await assert.rejects(gateway.complete(request), (error) => error.code === ERROR_CODES.invalid_request);
  }
  await assert.rejects(gateway.complete({ prompt: 'x', maxTokens: 0 }), (error) => error.code === ERROR_CODES.invalid_request);
  await assert.rejects(gateway.complete({ prompt: 'x', maxTokens: 1.5 }), (error) => error.code === ERROR_CODES.invalid_request);
  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 0 }), (error) => error.code === ERROR_CODES.invalid_request);
  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 'soon' }), (error) => error.code === ERROR_CODES.invalid_request);
  assert.equal(transport.calls.length, 0);
});

test('gateway: invalid retry/backoff configuration is rejected', () => {
  for (const options of [{ maxRetries: -1 }, { maxRetries: 2.5 }, { maxRetries: 6 }, { backoffMs: -1 }, { backoffMs: 'x' }]) {
    assert.throws(
      () => createGateway({ kind: 'direct_http', transport: () => {}, env: ENV, ...options }),
      (error) => error.code === ERROR_CODES.invalid_request,
    );
  }
});

test('gateway: the gateway-level timeout applies when the call does not override it', async () => {
  const transport = fakeTransport(() => chatResponse({ text: 'ok' }));
  const gateway = createGateway({
    kind: 'direct_http',
    transport,
    env: ENV,
    timeoutMs: 1234,
    clock: sequenceClock([0, 1]),
  });

  await gateway.complete({ prompt: 'x' });
  await gateway.complete({ prompt: 'x', timeoutMs: 777 });
  await gateway.complete({ prompt: 'x', timeoutMs: 999_999 });

  assert.equal(transport.calls[0].timeoutMs, 1234);
  assert.equal(transport.calls[1].timeoutMs, 777);
  assert.equal(transport.calls[2].timeoutMs, 300_000);
});

test('gateway: a Response-like transport (fetch) is accepted', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ choices: [{ message: { content: 'via fetch' } }], usage: { prompt_tokens: 1 } }),
    };
  };
  const gateway = createGateway({
    kind: 'direct_http',
    transport: fetchTransport(fakeFetch),
    env: ENV,
    clock: sequenceClock([0, 3]),
  });

  const result = await gateway.complete({ prompt: 'hi' });

  assert.equal(result.text, 'via fetch');
  assert.equal(result.usage.inputTokens, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(seen[0].init.method, 'POST');
});

test('gateway: sanitize and redact work on nested values and never mutate input', () => {
  const input = { text: 'secret-123 and more', list: ['secret-123', 2], nested: { key: 'secret-123' }, keep: null };
  assert.deepEqual(sanitize(input, ['secret-123']), {
    text: '[redacted] and more',
    list: ['[redacted]', 2],
    nested: { key: '[redacted]' },
    keep: null,
  });
  assert.equal(input.text, 'secret-123 and more');
  assert.equal(input.nested.key, 'secret-123');

  assert.equal(redact('no change', ['absent']), 'no change');
  assert.equal(redact('a secret-123 b', ['secret-123']), 'a [redacted] b');
});
