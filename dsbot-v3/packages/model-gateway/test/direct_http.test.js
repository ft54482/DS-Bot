import test from 'node:test';
import assert from 'node:assert/strict';

import { createGateway, ERROR_CODES, GatewayError } from '../src/index.js';
import { chatResponse, fakeTransport, jsonResponse, sequenceClock } from './helpers/fake_transport.js';

const KEY = 'sk-test-direct-0123456789abcdef';
const ENV = {
  DSBOT_MODEL_BASE_URL: 'https://api.example.test/v1',
  DSBOT_MODEL_API_KEY: KEY,
  DSBOT_MODEL_NAME: 'dsbot-test-model',
};

function makeGateway(transport, extra = {}) {
  return createGateway({ kind: 'direct_http', transport, env: ENV, ...extra });
}

test('direct_http: complete() sends an OpenAI-compatible request and maps the reply', async () => {
  const transport = fakeTransport(() =>
    chatResponse({ text: 'pong', usage: { prompt_tokens: 11, completion_tokens: 2 } }),
  );
  const gateway = makeGateway(transport, { clock: sequenceClock([1000, 1042]) });

  const result = await gateway.complete({ prompt: 'ping', system: 'be terse', maxTokens: 64 });

  assert.deepEqual(result, {
    text: 'pong',
    usage: { inputTokens: 11, outputTokens: 2 },
    backend: 'direct_http',
    latencyMs: 42,
  });
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.body, {
    model: 'dsbot-test-model',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'ping' },
    ],
    max_tokens: 64,
  });
});

test('direct_http: a base URL that already names the endpoint is used verbatim (and usage may be absent)', async () => {
  const transport = fakeTransport(() => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
  const gateway = createGateway({
    kind: 'direct_http',
    transport,
    env: { ...ENV, DSBOT_MODEL_BASE_URL: 'https://api.example.test/v1/chat/completions/' },
    clock: sequenceClock([0, 5]),
  });

  const result = await gateway.complete({ prompt: 'hello' });

  assert.equal(result.text, 'ok');
  assert.deepEqual(result.usage, {});
  assert.equal(transport.calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.deepEqual(transport.calls[0].body, {
    model: 'dsbot-test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });
});

test('direct_http: missing credentials fail before any request', async () => {
  const transport = fakeTransport(() => chatResponse({ text: 'never' }));
  const gateway = createGateway({ kind: 'direct_http', transport, env: { DSBOT_MODEL_API_KEY: KEY } });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, ERROR_CODES.missing_credentials);
    assert.match(error.message, /DSBOT_MODEL_BASE_URL/);
    assert.match(error.message, /DSBOT_MODEL_NAME/);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    assert.deepEqual(error.missing, ['DSBOT_MODEL_BASE_URL', 'DSBOT_MODEL_NAME']);
    return true;
  });
  assert.equal(transport.calls.length, 0);
});

test('direct_http: flat options override the injected env', async () => {
  const transport = fakeTransport(() => chatResponse({ text: 'pong' }));
  const gateway = createGateway({
    kind: 'direct_http',
    transport,
    env: {},
    baseUrl: 'https://override.example.test/v2/',
    apiKey: KEY,
    model: 'override-model',
    clock: sequenceClock([0, 1]),
  });

  await gateway.complete({ prompt: 'x' });
  assert.equal(transport.calls[0].url, 'https://override.example.test/v2/chat/completions');
  assert.equal(transport.calls[0].body.model, 'override-model');
});

test('direct_http: 429 retries once, honours Retry-After and then succeeds', async () => {
  const clock = sequenceClock([0, 1]);
  let attempt = 0;
  const transport = fakeTransport(() => {
    attempt += 1;
    if (attempt === 1) return jsonResponse(429, { error: 'slow down' }, { 'retry-after': '0.5' });
    return chatResponse({ text: 'after-retry' });
  });
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV, clock, backoffMs: 10 });

  const result = await gateway.complete({ prompt: 'x' });

  assert.equal(result.text, 'after-retry');
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(clock.sleeps, [500]);
});

test('direct_http: repeated 5xx become upstream_error after one retry and use exponential backoff', async () => {
  const clock = sequenceClock([0, 1]);
  const transport = fakeTransport(() => jsonResponse(503, { error: 'unavailable' }));
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV, clock, backoffMs: 7 });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.upstream_error);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(clock.sleeps, [7]);
});

test('direct_http: authentication failures are not retried', async () => {
  const clock = sequenceClock([0, 1]);
  const transport = fakeTransport(() => jsonResponse(401, { error: 'bad key' }));
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV, clock, backoffMs: 7 });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.auth_failed);
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('direct_http: a transport timeout is reported as timeout and not retried', async () => {
  const transport = fakeTransport(() => new Promise(() => {}));
  const gateway = createGateway({
    kind: 'direct_http',
    transport,
    env: ENV,
    clock: {
      now: () => 0,
      sleep: async () => {},
      setTimeout: (fn) => setTimeout(fn, 0),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });

  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 50 }), (error) => {
    assert.equal(error.code, ERROR_CODES.timeout);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.calls.length, 1);
});

test('direct_http: an aborted fetch is classified as timeout and not retried', async () => {
  const clock = sequenceClock([0, 1]);
  const transport = fakeTransport(() => {
    const error = new Error('The operation was aborted');
    error.name = 'TimeoutError';
    throw error;
  });
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV, clock, backoffMs: 3 });

  await assert.rejects(gateway.complete({ prompt: 'x', timeoutMs: 50 }), (error) => {
    assert.equal(error.code, ERROR_CODES.timeout);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('direct_http: an empty completion is empty_completion', async () => {
  const transport = fakeTransport(() => chatResponse({ text: '   ' }));
  const gateway = makeGateway(transport, { clock: sequenceClock([0, 1]) });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.empty_completion);
    return true;
  });
  assert.equal(transport.calls.length, 1);
});

test('direct_http: the API key never appears in an error message', async () => {
  const transport = fakeTransport(() =>
    jsonResponse(401, { error: `invalid key ${KEY}`, hint: `Bearer ${KEY}` }),
  );
  const gateway = makeGateway(transport, {
    clock: sequenceClock([0, 1]),
    maxRetries: 0,
  });

  await assert.rejects(gateway.complete({ prompt: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.auth_failed);
    assert.ok(!error.message.includes(KEY));
    assert.match(error.message, /\[redacted\]/);
    assert.ok(!JSON.stringify(error.toJSON()).includes(KEY));
    return true;
  });
});

test('direct_http: completion text is sanitized before it is returned', async () => {
  const transport = fakeTransport(() => chatResponse({ text: `the key was ${KEY}` }));
  const gateway = makeGateway(transport, { clock: sequenceClock([0, 1]) });

  const result = await gateway.complete({ prompt: 'repeat the key' });

  assert.equal(result.text, 'the key was [redacted]');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('direct_http: transport failures are upstream_error and retried once', async () => {
  const clock = sequenceClock([0, 1]);
  let attempt = 0;
  const transport = fakeTransport(() => {
    attempt += 1;
    if (attempt === 1) throw new Error(`socket closed for ${KEY}`);
    return chatResponse({ text: 'second attempt' });
  });
  const gateway = createGateway({ kind: 'direct_http', transport, env: ENV, clock, backoffMs: 3 });

  const result = await gateway.complete({ prompt: 'x' });

  assert.equal(result.text, 'second attempt');
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(clock.sleeps, [3]);
});
