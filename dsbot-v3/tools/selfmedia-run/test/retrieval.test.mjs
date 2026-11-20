import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertSafeHttpUrl,
  createFixtureRetrieval,
  createHttpRetrieval,
  createSnapshotRetrieval,
  deriveFactsFromSources,
  htmlToText,
  loadSourcePack,
  sha256Hex,
} from '../src/retrieval.mjs';

test('fixture retrieval searches and fetches only local text', async () => {
  const retrieval = createFixtureRetrieval('测试选题');
  const results = await retrieval.search({ topic: '测试选题' });
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((source) => source.url),
    [
      'https://alpha.fixtures.selfmedia.invalid/report',
      'https://beta.fixtures.selfmedia.invalid/brief',
      'https://gamma.fixtures.selfmedia.invalid/review',
    ],
  );

  const fetched = await retrieval.fetch(results[0].url);
  assert.equal(fetched.ok, true);
  assert.ok(fetched.text.includes('3.2'));
  assert.equal(retrieval.stats.network_fetch_calls, 0);
  assert.ok(retrieval.documents.get(results[0].url));
  assert.equal(retrieval.facts.length, 3);
});

test('source pack loader normalizes sources and derives checkable facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfmedia-pack-'));
  try {
    const file = join(dir, 'sources.json');
    const claim = '两处材料都提到，复核后错误率从 18% 降到 7%。';
    writeFileSync(
      file,
      JSON.stringify({
        sources: [
          { url: 'https://a.pack.invalid/a', title: 'A', text: `材料 A。${claim}` },
          { url: 'https://b.pack.invalid/b', title: 'B', text: `材料 B。${claim}` },
        ],
      }),
      'utf8',
    );
    const pack = await loadSourcePack({ file, topic: 'P' });
    assert.equal(pack.sources.length, 2);
    assert.equal(pack.facts.length, 1);
    assert.equal(pack.facts[0].claim, claim);
    assert.equal(pack.facts[0].key, true);
    assert.equal(pack.facts[0].source_refs.length, 2);
    assert.equal(sha256Hex(pack.sources[0].text).length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source pack claims become facts when an explicit fact list is omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfmedia-pack-claims-'));
  try {
    const file = join(dir, 'sources.json');
    const claim = '两处材料都提到，复核后错误率从 18% 降到 7%。';
    writeFileSync(
      file,
      JSON.stringify({
        sources: [
          { url: 'https://a.claims.invalid/a', title: 'A', text: `材料 A。${claim}`, claims: [{ text: claim, key: true }] },
          { url: 'https://b.claims.invalid/b', title: 'B', text: `材料 B。${claim}`, claims: [{ text: claim, key: true }] },
        ],
      }),
      'utf8',
    );
    const pack = await loadSourcePack({ file, topic: 'C' });
    assert.equal(pack.facts.length, 1);
    assert.equal(pack.facts[0].claim, claim);
    assert.equal(pack.facts[0].key, true);
    assert.equal(pack.facts[0].source_refs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source pack accepts L43 topic-pack field names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfmedia-l43-pack-'));
  try {
    const file = join(dir, 'sources.json');
    const claim = '主题包摘要显示，复核后错误率从 18% 降到 7%。';
    writeFileSync(
      file,
      JSON.stringify({
        items: [
          {
            id: 'hot-1',
            title: '主题包一',
            summary: `材料甲。${claim}`,
            sourceName: '来源甲',
            sourceUrl: 'https://one.topic.invalid/a',
            publishedAt: '2026-11-01T08:00:00.000Z',
            contentHash: 'a'.repeat(64),
          },
          {
            id: 'hot-2',
            title: '主题包二',
            summary: `材料乙。${claim}`,
            sourceName: '来源乙',
            sourceUrl: 'https://two.topic.invalid/b',
            publishedAt: '2026-11-02T08:00:00.000Z',
            contentHash: 'b'.repeat(64),
          },
        ],
      }),
      'utf8',
    );
    const pack = await loadSourcePack({ file, topic: 'L43' });
    assert.deepEqual(
      pack.sources.map((source) => source.url),
      ['https://one.topic.invalid/a', 'https://two.topic.invalid/b'],
    );
    assert.equal(pack.sources[0].publisher, '来源甲');
    assert.equal(pack.facts.length, 1);
    assert.equal(pack.facts[0].key, true);
    assert.equal(pack.facts[0].source_refs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot retrieval reports a load error instead of inventing sources', async () => {
  const retrieval = await createSnapshotRetrieval({
    file: join(tmpdir(), 'definitely-missing-selfmedia-pack.json'),
    topic: 'X',
    mode: 'offline',
  });
  assert.ok(retrieval.loadError);
  assert.equal(retrieval.loadError.code, 'source_pack_missing');
  assert.equal(retrieval.sources.length, 0);
  assert.equal((await retrieval.search({ topic: 'X' })).length, 0);
});

test('derived facts mark cross-host claims as key', () => {
  const claim = '两个独立来源都记录，留存提升了 9%。';
  const facts = deriveFactsFromSources([
    { url: 'https://a.example.com/a', text: `材料甲。${claim}` },
    { url: 'https://b.example.com/b', text: `材料乙。${claim}` },
    { url: 'https://c.example.com/c', text: '这一句没有数字，也没有归属词。' },
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].key, true);
  assert.equal(facts[0].source_refs.length, 2);
});

test('http retrieval defaults to metadata only and never requests an article body', async () => {
  const calls = [];
  const articleUrl = 'https://news.example.com/story';
  const snippet = '摘要记录，复核后错误率从 18% 降到 7%。';
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (!String(url).startsWith('https://search.example.com/search')) {
      throw new Error(`unexpected article body request: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ url: articleUrl, title: 'Story', snippet }] }),
    };
  };
  const retrieval = createHttpRetrieval({
    baseUrl: 'https://search.example.com/search',
    apiKey: 'search-secret',
    fetchImpl,
    now: () => 1700000000000,
  });
  const results = await retrieval.search({ topic: '测试选题' });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, articleUrl);
  assert.equal(calls.length, 1, 'only the metadata endpoint may be requested');
  assert.equal(retrieval.stats.network_fetch_calls, 0);
  assert.equal(retrieval.description.page_fetch, false);
  assert.equal(retrieval.description.fulltext_policy, 'metadata_and_summary_only');
  assert.equal(retrieval.documents.get(articleUrl), snippet);

  const cached = await retrieval.fetch(articleUrl);
  assert.equal(cached.ok, true);
  assert.equal(cached.text, snippet);
  assert.equal(calls.length, 1, 'fetch() must reuse the cached summary, not the page');
});

test('allowFulltext opt-in is the only path that requests an article body', async () => {
  const calls = [];
  const articleUrl = 'https://news.example.com/story';
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('search.example.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ url: articleUrl, title: 'Story', snippet: 'short snippet' }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      url: articleUrl,
      text: async () =>
        '<html><head><script>bad()</script></head><body><article><h1>Story</h1><p>Body text with 42% more detail.</p></article></body></html>',
    };
  };
  const retrieval = createHttpRetrieval({
    baseUrl: 'https://search.example.com/search',
    fetchImpl,
    fetchPages: true,
    now: () => 1700000000000,
  });
  const results = await retrieval.search({ topic: '测试选题' });
  assert.equal(results.length, 1);
  assert.ok(retrieval.documents.get(articleUrl).includes('42%'));
  assert.equal(retrieval.stats.network_fetch_calls, 1);
  assert.equal(retrieval.description.page_fetch, true);
  assert.equal(retrieval.description.fulltext_policy, 'explicit_allow_fulltext_debug');
  assert.deepEqual(calls, [
    'https://search.example.com/search?q=%E6%B5%8B%E8%AF%95%E9%80%89%E9%A2%98&limit=6',
    articleUrl,
  ]);
});

test('metadata-only search ignores body-like payload fields and caps the summary', async () => {
  const articleUrl = 'https://news.example.com/long';
  const snippet = '摘要内容'.repeat(100);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        {
          url: articleUrl,
          title: 'Long',
          snippet,
          text: 'FULLTEXT_MARKER not a summary',
          content: 'FULLTEXT_MARKER not a summary',
          body: 'FULLTEXT_MARKER not a summary',
        },
      ],
    }),
  });
  const retrieval = createHttpRetrieval({
    baseUrl: 'https://search.example.com/search',
    fetchImpl,
    now: () => 1700000000000,
  });
  await retrieval.search({ topic: '测试选题' });
  const stored = retrieval.documents.get(articleUrl);
  assert.ok(stored.length > 0);
  assert.ok(stored.length <= 300, `summary must stay bounded, got ${stored.length}`);
  assert.equal(stored.includes('FULLTEXT_MARKER'), false);
});

test('safe URL guard rejects private and non-http sources', () => {
  assert.throws(() => assertSafeHttpUrl('http://127.0.0.1:3000/x'), /private or reserved/);
  assert.throws(() => assertSafeHttpUrl('http://localhost/x'), /private or reserved/);
  assert.throws(() => assertSafeHttpUrl('file:///etc/passwd'), /unsupported/);
  assert.throws(() => assertSafeHttpUrl('https://user:pass@example.com/x'), /credentials/);
  assert.equal(assertSafeHttpUrl('https://example.com/x').hostname, 'example.com');
});

test('htmlToText removes scripts and keeps article prose', () => {
  const text = htmlToText(
    '<html><body><script>alert(1)</script><article><h1>标题</h1><p>正文 &amp; 细节</p></article></body></html>',
  );
  assert.match(text, /标题/);
  assert.match(text, /正文 & 细节/);
  assert.doesNotMatch(text, /alert/);
  assert.doesNotMatch(text, /<script/);
});
