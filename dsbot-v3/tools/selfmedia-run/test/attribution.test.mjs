import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  enrichArticleBody,
  renderSourceLines,
  selectKeyFacts,
} from '../src/attribution.mjs';
import { createFakeWriter } from '../src/model.mjs';
import {
  createFixtureRetrieval,
  deriveFactsFromSources,
  loadSourcePack,
  sha256Hex,
} from '../src/retrieval.mjs';
import { reviewArticle } from '../src/review.mjs';
import { readJson, runCli, tempDir, writeJson } from './support.mjs';

const TOPIC = '测试选题';
const NOW = () => 1700000000000;
const LICENSE = { status: 'unauthorized', published: false };

function fixtureSources() {
  const retrieval = createFixtureRetrieval(TOPIC);
  const sources = retrieval.sources.map((source) => {
    const text = retrieval.documents.get(source.url) ?? '';
    return {
      ...source,
      fetched_at: '2026-11-20T10:00:00.000Z',
      sha256: sha256Hex(text),
      excerpt: text.slice(0, 280),
    };
  });
  return { retrieval, sources };
}

function dualSourcePack({ samePublisher = false } = {}) {
  const claim = '两家媒体都记录，双人复核把事实错误率从 18% 降到 7%。';
  const publishers = samePublisher ? ['同一家媒体', '同一家媒体'] : ['媒体甲', '媒体乙'];
  return {
    topic: '双源选题',
    sources: [
      {
        url: 'https://aihot.news/item/1',
        title: '材料一',
        publisher: publishers[0],
        via: 'AIHOT',
        text: `材料一记录了一个编辑团队的流程。${claim}`,
        claims: [{ text: claim, key: true }],
      },
      {
        url: 'https://aihot.news/item/2',
        title: '材料二',
        publisher: publishers[1],
        via: 'AIHOT',
        text: `材料二访谈了另一个团队。${claim}`,
        claims: [{ text: claim, key: true }],
      },
    ],
    facts: [
      {
        claim,
        key: true,
        source_refs: ['https://aihot.news/item/1', 'https://aihot.news/item/2'],
      },
    ],
  };
}

test('fake run marks key facts and embeds snapshot sha256 in article and pack', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out]);
  assert.equal(result.code, 0);

  const pack = readJson(out, 'article-pack.json');
  const article = readFileSync(join(out, 'article.md'), 'utf8');
  assert.match(article, /## 关键事实/);
  assert.equal(pack.key_facts.length, 3);
  const urls = new Set(pack.source_list.map((source) => source.url));
  for (const fact of pack.key_facts) {
    assert.ok(fact.claim.length > 0);
    assert.ok(fact.source_refs.length > 0);
    for (const ref of fact.source_refs) assert.ok(urls.has(ref), `unknown key-fact ref: ${ref}`);
  }
  for (const source of pack.source_list) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.excerpt.length > 0 && source.excerpt.length <= 300);
    assert.ok(article.includes(`｜快照 sha256:${source.sha256}｜`), 'article.md lost a snapshot hash');
  }
  assert.equal(pack.sources.length, pack.source_list.length);
  for (const source of pack.sources) {
    assert.ok(source.title.length > 0);
    assert.ok(source.publisher.length > 0);
    assert.ok('via' in source);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.excerpt.length > 0 && source.excerpt.length <= 300);
    assert.equal('text' in source, false);
    assert.equal('body' in source, false);
  }
  assert.equal(pack.review.verdict, 'passed');
});

test('source lines carry title, publisher, via and citation indexes', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out]);
  assert.equal(result.code, 0);
  const pack = readJson(out, 'article-pack.json');
  const article = readFileSync(join(out, 'article.md'), 'utf8');

  pack.source_list.forEach((source, index) => {
    const line = article.split(/\r?\n/).find((entry) => entry.startsWith(`[${index + 1}] `));
    assert.ok(line, `missing source line ${index + 1}`);
    assert.ok(line.includes(source.title), 'source line lost its title');
    assert.ok(line.includes(source.publisher), 'source line lost its publisher');
    assert.ok(line.includes(source.url), 'source line lost its URL');
    assert.match(line, /｜摘要：.+｜https?:\/\//);
  });

  for (const fact of pack.key_facts) {
    const expected = fact.source_refs
      .map((ref) => `[${pack.source_list.findIndex((source) => source.url === ref) + 1}]`)
      .join('');
    const bullet = article
      .split(/\r?\n/)
      .find((line) => line.startsWith('- ') && line.includes(fact.claim));
    assert.ok(bullet, 'missing key-fact bullet');
    assert.ok(bullet.includes(expected), `key fact is missing citation ${expected}`);
  }
});

test('dual attribution passes when two publishers sit behind one aggregator host', async (t) => {
  const dir = tempDir(t);
  const out = tempDir(t);
  writeJson(join(dir, 'sources.json'), dualSourcePack());
  const result = await runCli([
    '--topic',
    '双源选题',
    '--out',
    out,
    '--offline',
    '--snapshots',
    dir,
  ]);
  assert.equal(result.code, 0);

  const pack = readJson(out, 'article-pack.json');
  const review = readJson(out, 'review.json');
  assert.equal(pack.status, 'ready_for_review');
  assert.equal(review.verdict, 'passed');
  assert.deepEqual(
    pack.source_list.map((source) => source.publisher),
    ['媒体甲', '媒体乙'],
  );
  assert.deepEqual(pack.source_list.map((source) => source.via), ['AIHOT', 'AIHOT']);
  const article = readFileSync(join(out, 'article.md'), 'utf8');
  assert.match(article, /媒体甲（via AIHOT）/);
  const sourcing = review.rubric.find((item) => item.id === 'sourcing');
  assert.equal(sourcing.passed, true);
  assert.equal(sourcing.evidence.key_facts[0].distinct_hosts.length, 2);
});

test('a single publisher behind two URLs still warns and needs rework', async (t) => {
  const dir = tempDir(t);
  const out = tempDir(t);
  writeJson(join(dir, 'sources.json'), dualSourcePack({ samePublisher: true }));
  const result = await runCli([
    '--topic',
    '双源选题',
    '--out',
    out,
    '--offline',
    '--snapshots',
    dir,
  ]);
  assert.equal(result.code, 0);

  const pack = readJson(out, 'article-pack.json');
  const review = readJson(out, 'review.json');
  assert.equal(pack.status, 'needs_rework');
  assert.equal(review.verdict, 'rework');
  assert.equal(pack.key_facts.length, 1);
  const issue = review.issues.find((entry) => entry.code === 'single_host_sourcing');
  assert.ok(issue, 'expected single_host_sourcing');
  assert.equal(issue.severity, 'warning');
  const sourcing = review.rubric.find((item) => item.id === 'sourcing');
  assert.equal(sourcing.passed, false);
  assert.ok(sourcing.score < sourcing.threshold);
});

test('a source without a snapshot is reworked instead of passing', async () => {
  const { retrieval, sources } = fixtureSources();
  const writer = createFakeWriter();
  const draft = await writer({ topic: TOPIC, facts: retrieval.facts, sources });
  const broken = sources.map((source, index) =>
    index === 0 ? { ...source, sha256: undefined, excerpt: '' } : source,
  );
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources: broken,
    sourceTexts: retrieval.documents,
    license: LICENSE,
    now: NOW,
  });
  assert.equal(result.verdict, 'rework');
  const issue = result.issues.find((entry) => entry.code === 'missing_source_snapshot');
  assert.ok(issue, 'expected missing_source_snapshot');
  assert.equal(issue.severity, 'warning');
  const sourcing = result.rubric.find((item) => item.id === 'sourcing');
  assert.equal(sourcing.passed, false);
});

test('enrichArticleBody cites key-fact sentences and is idempotent', () => {
  const claim = '复核后错误率从 18% 降到 7%。';
  const url = 'https://media.example.com/a';
  const sources = [
    {
      url,
      title: '材料一',
      publisher: '媒体甲',
      via: 'AIHOT',
      sha256: 'a'.repeat(64),
      excerpt: '材料一记录了复核流程。',
    },
  ];
  const body = ['# T', '', claim, '', '## 来源', '', `[1] ${url}`, ''].join('\n');
  const once = enrichArticleBody({
    body,
    keyFacts: [{ claim, source_refs: [url] }],
    sources,
  });
  assert.ok(once.includes(`${claim}[1]`));
  assert.ok(once.includes('媒体甲（via AIHOT）'));
  assert.ok(once.includes(`快照 sha256:${'a'.repeat(64)}`));
  const twice = enrichArticleBody({
    body: once,
    keyFacts: [{ claim, source_refs: [url] }],
    sources,
  });
  assert.equal(once, twice, 'enrichment must not duplicate the key-facts or source section');
  assert.equal((once.match(new RegExp('\\[1\\]', 'g')) ?? []).length >= 2, true);
});

test('selectKeyFacts caps the list at six and keeps only real source refs', () => {
  const sources = Array.from({ length: 3 }, (_, index) => ({
    url: `https://publisher${index + 1}.example.com/a`,
    publisher: `媒体${index + 1}`,
  }));
  const facts = Array.from({ length: 9 }, (_, index) => ({
    claim: `第 ${index + 1} 条可核查结论，错误率下降 ${index + 1}%。`,
    key: index < 2,
    status: index < 8 ? 'verified' : 'unverified',
    source_refs: [`https://publisher${(index % 3) + 1}.example.com/a`],
  }));
  const selected = selectKeyFacts(facts, sources);
  assert.ok(selected.length >= 3 && selected.length <= 6);
  const urls = new Set(sources.map((source) => source.url));
  for (const fact of selected) {
    assert.ok(fact.source_refs.length > 0);
    for (const ref of fact.source_refs) assert.ok(urls.has(ref));
  }
  const filtered = selectKeyFacts(
    [{ claim: '伪造来源的结论。', source_refs: ['https://not-in-snapshot.example.com/x'] }],
    sources,
  );
  assert.equal(filtered[0].source_refs.length, 0);
});

test('source pack reads publisher/via and derives key facts from publishers', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'sources.json');
  const claim = '两处材料都记录，复核后错误率从 18% 降到 7%。';
  writeJson(file, {
    sources: [
      {
        url: 'https://aihot.news/a',
        title: '材料一',
        sourceName: '媒体甲',
        via_name: 'AIHOT',
        text: `材料甲。${claim}`,
      },
      {
        url: 'https://aihot.news/b',
        title: '材料二',
        sourceName: '媒体乙',
        via_name: 'AIHOT',
        text: `材料乙。${claim}`,
      },
    ],
  });
  const pack = await loadSourcePack({ file, topic: '双源' });
  assert.equal(pack.sources[0].publisher, '媒体甲');
  assert.equal(pack.sources[0].via, 'AIHOT');
  assert.equal(pack.facts.length, 1);
  assert.equal(pack.facts[0].key, true);
  assert.equal(pack.facts[0].source_refs.length, 2);

  const derived = deriveFactsFromSources([
    { url: 'https://aihot.news/a', publisher: '媒体甲', text: `材料甲。${claim}` },
    { url: 'https://aihot.news/b', publisher: '媒体乙', text: `材料乙。${claim}` },
  ]);
  assert.equal(derived[0].key, true);
});

test('renderSourceLines keeps summaries bounded and never drops the hash', () => {
  const longExcerpt = '摘要内容'.repeat(100);
  const lines = renderSourceLines([
    {
      url: 'https://media.example.com/a',
      title: '标题',
      publisher: '媒体甲',
      via: 'AIHOT',
      sha256: 'b'.repeat(64),
      excerpt: longExcerpt,
    },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[1\] 标题 — 媒体甲（via AIHOT）｜快照 sha256:b{64}｜摘要：/);
  const summary = lines[0].split('｜摘要：')[1].split('｜')[0];
  assert.ok(summary.length <= 300, `summary too long: ${summary.length}`);
});
