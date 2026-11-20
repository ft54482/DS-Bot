import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChatClient,
  createRealReviewer,
  createRealWriter,
  extractJsonObject,
  fakeWrite,
} from '../src/model.mjs';
import { buildCost, buildModelEnvSummary } from '../src/report.mjs';

test('extractJsonObject handles plain JSON and fenced JSON', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonObject('prefix {"a":3} suffix'), { a: 3 });
  assert.equal(extractJsonObject('not json'), null);
});

test('chat client posts an OpenAI-compatible request and records usage', async () => {
  const calls = [];
  const client = createChatClient({
    baseUrl: 'https://model.example.com/v1',
    apiKey: 'secret-model-key',
    model: 'test-model',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
        }),
      };
    },
  });
  const result = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(result.content, 'hello');
  assert.equal(client.calls, 1);
  assert.equal(calls[0].url, 'https://model.example.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-model-key');
  assert.deepEqual(client.getUsage(), { tokens_in: 12, tokens_out: 5, tokens_cached: 2 });
});

test('chat client redacts the API key from HTTP error messages', async () => {
  const secret = 'sk-super-secret-value';
  const client = createChatClient({
    baseUrl: 'https://model.example.com/v1',
    apiKey: secret,
    model: 'test-model',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => `invalid key ${secret}`,
    }),
  });
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }]),
    (error) => {
      assert.equal(error.code, 'model_http_error');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test('real writer falls back to prose with a warning when JSON is absent', async () => {
  const writer = createRealWriter({
    chat: async () => ({ content: '这是一段没有 JSON 的正文。', usage: { prompt_tokens: 1 } }),
  });
  const draft = await writer({
    topic: '测试选题',
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });
  assert.equal(draft.body, '这是一段没有 JSON 的正文。');
  assert.ok(draft.title_candidates.length >= 3);
  assert.equal(draft.warnings[0].code, 'writer_non_json');
});

test('real reviewer flags unparseable output instead of inventing a pass', async () => {
  const reviewer = createRealReviewer({
    chat: async () => ({ content: 'I think it is fine.', usage: null }),
  });
  const result = await reviewer({
    topic: 'T',
    article: { title_candidates: [], body: '' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });
  assert.equal(result.__parse_error, true);
});

test('fake writer injects exactly one unsupported fact when asked', () => {
  const plain = fakeWrite({
    topic: '测试选题',
    facts: [],
    sources: [],
  });
  assert.equal(plain.injected_fact, null);

  const injected = fakeWrite(
    { topic: '测试选题', facts: [], sources: [] },
    { injectFactError: true },
  );
  assert.match(injected.injected_fact, /37\.5/);
  assert.match(injected.body, /37\.5/);
});

test('cost estimate uses env unit prices and stays zero when unconfigured', () => {
  const usage = { tokens_in: 1000, tokens_out: 500, tokens_cached: 0 };
  const configured = buildCost({
    usage,
    mode: 'real',
    env: {
      DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K: '0.002',
      DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K: '0.008',
    },
  });
  assert.equal(configured.pricing_source, 'env');
  assert.equal(configured.estimated_cny, 0.006);

  const unconfigured = buildCost({ usage, mode: 'real', env: {} });
  assert.equal(unconfigured.pricing_source, 'unconfigured');
  assert.equal(unconfigured.estimated_cny, 0);
  assert.match(unconfigured.formula, /DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K/);
});

test('model environment summary never includes the key', () => {
  const summary = buildModelEnvSummary({
    mode: 'real',
    env: {
      DSBOT_MODEL_NAME: 'test-model',
      DSBOT_MODEL_API_KEY: 'must-not-appear',
      DSBOT_MODEL_BASE_URL: 'https://model.example.com/v1',
    },
    client: { endpointHost: 'model.example.com' },
  });
  assert.equal(JSON.stringify(summary).includes('must-not-appear'), false);
  assert.equal(summary.api_key_logged, false);
  assert.equal(summary.api_key_present, true);
});
