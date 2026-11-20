import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SOURCE_ITEM_KEYS,
  SourceError,
  createSourceClient,
  sha256Hex,
} from '../src/index.js';
import {
  SUMMARIES,
  createClock,
  createHttp,
  createTestClient,
  expectedItem,
  rawItem,
} from './helpers.js';

function sourceErrorWith(code) {
  return (error) => {
    assert.ok(error instanceof SourceError, `expected SourceError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('createSourceClient: requires an injected http function and validates options', () => {
  assert.throws(
    () => createSourceClient({}),
    /requires an injected http function/,
  );
  assert.throws(
    () => createSourceClient({ http: async () => ({ status: 200, body: {} }), retries: -1 }),
    /retries must be an integer/,
  );
  // A clock without sleep is harmless: only retry backoff needs it, and the
  // real timer is a safe fallback.
  assert.doesNotThrow(() =>
    createSourceClient({ http: async () => ({ status: 200, body: { items: [] } }), clock: {} }),
  );
});

test('listHot: normalizes entries, computes sha256(summary) and applies the limit', async () => {
  const { http, calls } = createHttp(() => ({
    status: 200,
    body: { items: [rawItem(1), rawItem(2), rawItem(3)] },
  }));
  const client = createTestClient(http);

  const items = await client.listHot({ limit: 2 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://selfmedia.invalid/hot');
  assert.equal(items.length, 2);
  assert.deepEqual(items, [expectedItem(1), expectedItem(2)]);
  assert.deepEqual(Object.keys(items[0]).sort(), [...SOURCE_ITEM_KEYS].sort());
  assert.equal(items[0].contentHash, sha256Hex(SUMMARIES[1]));
});

test('listHot: the default limit is 10 and the hard maximum is 50', async () => {
  const seen = [];
  const { http } = createHttp(({ url, options }) => {
    seen.push(new URL(url).searchParams.get('limit'));
    return { status: 200, body: { items: [] } };
  });
  const client = createTestClient(http, {
    endpoints: { hot: ({ limit }) => `https://feed.example/hot?limit=${limit}` },
  });

  assert.deepEqual(await client.listHot(), []);
  assert.deepEqual(await client.listHot({ limit: 999 }), []);
  assert.deepEqual(seen, [String(DEFAULT_LIMIT), String(MAX_LIMIT)]);
});

test('listHot: accepts a JSON string body, camelCase fields and a data envelope', async () => {
  const raw = {
    id: 'hot-9',
    title: 'Camel story',
    summary: 'A summary served in camelCase.',
    sourceName: 'Camel source',
    sourceUrl: 'https://camel.example/story/9',
    publishedAt: '2026-11-20T09:30:00.000Z',
  };
  const { http } = createHttp(() => ({
    status: 200,
    body: JSON.stringify({ data: { items: [raw] } }),
  }));
  const client = createTestClient(http);

  const [item] = await client.listHot();

  assert.deepEqual(item, {
    ...raw,
    contentHash: sha256Hex(raw.summary),
  });
});

test('listHot: response-like json() and text() transports are accepted', async () => {
  const viaJson = createTestClient(async () => ({
    status: 200,
    json: async () => ({ items: [rawItem(1)] }),
  }));
  const viaText = createTestClient(async () => ({
    status: 200,
    text: async () => JSON.stringify({ item: rawItem(2) }),
  }));

  assert.deepEqual(await viaJson.listHot(), [expectedItem(1)]);
  assert.equal((await viaText.fetchItem({ id: 'hot-2' })).id, 'hot-2');
});

test('fetchItem: a malformed publication time is invalid_item', async () => {
  const { http } = createHttp(() => ({
    status: 200,
    body: { item: rawItem(1, { published_at: 'yesterday-ish' }) },
  }));
  const client = createTestClient(http);

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'invalid_item');
    assert.deepEqual(error.invalid, ['publishedAt:format']);
    return true;
  });
});

test('listHot: a missing field is invalid_item and is not retried', async () => {
  const { http, calls } = createHttp(() => ({
    status: 200,
    body: { items: [rawItem(1, { source_url: undefined })] },
  }));
  const client = createTestClient(http, { retries: 3, clock: createClock() });

  await assert.rejects(client.listHot(), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'invalid_item');
    assert.deepEqual(error.missing, ['sourceUrl']);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('fetchItem: returns exactly seven keys, never the body or a source-supplied hash', async () => {
  const raw = rawItem(1, {
    content_hash: 'f'.repeat(64),
    body: 'The full article text that must not be fetched or returned.',
  });
  const { http } = createHttp(() => ({ status: 200, body: { item: raw } }));
  const client = createTestClient(http);

  const item = await client.fetchItem({ id: 'hot-1' });

  assert.deepEqual(Object.keys(item).sort(), [...SOURCE_ITEM_KEYS].sort());
  assert.equal(item.summary, SUMMARIES[1]);
  assert.equal(item.contentHash, sha256Hex(SUMMARIES[1]));
  assert.notEqual(item.contentHash, 'f'.repeat(64));
  assert.equal('body' in item, false);
});

test('fetchItem: the same id twice yields the same content hash', async () => {
  const { http, calls } = createHttp(() => ({ status: 200, body: { item: rawItem(2) } }));
  const client = createTestClient(http);

  const first = await client.fetchItem({ id: 'hot-2' });
  const second = await client.fetchItem({ id: 'hot-2' });

  assert.equal(calls.length, 2);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first, second);
});

test('fetchItem: the id is encoded in the default endpoint template', async () => {
  const { http, calls } = createHttp(() => ({
    status: 200,
    body: {
      item: rawItem(1, {
        id: 'a b/c',
        source_url: 'https://feed.example/items/a-b-c',
      }),
    },
  }));
  const client = createTestClient(http);

  const item = await client.fetchItem({ id: 'a b/c' });

  assert.equal(item.id, 'a b/c');
  assert.equal(calls[0].url, 'https://selfmedia.invalid/items/a%20b%2Fc');
});

test('fetchItem: an id mismatch from the source is invalid_item', async () => {
  const { http } = createHttp(() => ({
    status: 200,
    body: { item: rawItem(1, { id: 'hot-other' }) },
  }));
  const client = createTestClient(http);

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'invalid_item');
    assert.deepEqual(error.invalid, ['id:mismatch']);
    return true;
  });
});

test('fetchItem: a numeric publication timestamp is normalized to ISO', async () => {
  const ms = Date.UTC(2026, 10, 20, 4, 30, 0);
  const { http } = createHttp(() => ({
    status: 200,
    body: { item: rawItem(1, { published_at: ms }) },
  }));
  const client = createTestClient(http);

  const item = await client.fetchItem({ id: 'hot-1' });

  assert.equal(item.publishedAt, '2026-11-20T04:30:00.000Z');
});

test('retry: HTTP 5xx is retried and a later success wins', async () => {
  const clock = createClock();
  const { http, calls } = createHttp(({ call }) =>
    call === 1
      ? { status: 503, body: { error: 'unavailable' } }
      : { status: 200, body: { item: rawItem(1) } },
  );
  const client = createTestClient(http, { retries: 2, backoffMs: 25, clock });

  const item = await client.fetchItem({ id: 'hot-1' });

  assert.equal(item.id, 'hot-1');
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.sleeps, [25]);
});

test('retry: an exhausted 4xx keeps the status and the attempt count', async () => {
  const { http, calls } = createHttp(() => ({ status: 404, body: { error: 'missing' } }));
  const clock = createClock();
  const client = createTestClient(http, { retries: 2, backoffMs: 25, clock });

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'http_error');
    assert.equal(error.status, 404);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [25, 50]);
});

test('retry: a transport failure is retried', async () => {
  const { http, calls } = createHttp(({ call }) => {
    if (call === 1) throw new Error('ECONNRESET');
    return { status: 200, body: { item: rawItem(1) } };
  });
  const client = createTestClient(http, { retries: 1, backoffMs: 0 });

  const item = await client.fetchItem({ id: 'hot-1' });

  assert.equal(item.id, 'hot-1');
  assert.equal(calls.length, 2);
});

test('retry: a transport failure that never recovers is network_error', async () => {
  const { http, calls } = createHttp(() => {
    throw new Error('ENOTFOUND');
  });
  const client = createTestClient(http, { retries: 2, backoffMs: 0 });

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'network_error');
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('timeout: one slow attempt is retried and a later success wins', async () => {
  const { http, calls } = createHttp(({ call }) => {
    if (call === 1) return new Promise(() => {});
    return { status: 200, body: { item: rawItem(1) } };
  });
  const client = createTestClient(http, {
    retries: 1,
    timeoutMs: 15,
    backoffMs: 0,
  });

  const item = await client.fetchItem({ id: 'hot-1' });

  assert.equal(item.id, 'hot-1');
  assert.equal(calls.length, 2);
});

test('timeout: persistent slowness surfaces a timeout error with attempts', async () => {
  const { http, calls } = createHttp(() => new Promise(() => {}));
  const client = createTestClient(http, {
    retries: 2,
    timeoutMs: 10,
    backoffMs: 0,
  });

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'timeout');
    assert.equal(error.retryable, true);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('invalid JSON is invalid_response and is not retried', async () => {
  const { http, calls } = createHttp(() => ({ status: 200, body: '{oops' }));
  const client = createTestClient(http, { retries: 3 });

  await assert.rejects(client.fetchItem({ id: 'hot-1' }), sourceErrorWith('invalid_response'));
  assert.equal(calls.length, 1);
});

test('listHot: a payload without an items array is invalid_response', async () => {
  const { http } = createHttp(() => ({ status: 200, body: { ok: true } }));
  const client = createTestClient(http);

  await assert.rejects(client.listHot(), sourceErrorWith('invalid_response'));
});

test('caller errors are TypeErrors, not source errors', async () => {
  const { http, calls } = createHttp(() => ({ status: 200, body: { item: rawItem(1) } }));
  const client = createTestClient(http);

  await assert.rejects(client.fetchItem({}), TypeError);
  await assert.rejects(client.fetchItem(null), TypeError);
  await assert.rejects(client.listHot({ limit: 0 }), TypeError);
  await assert.rejects(client.listHot({ limit: '2' }), TypeError);
  await assert.rejects(client.listHot('hot'), TypeError);
  assert.equal(calls.length, 0);
});
