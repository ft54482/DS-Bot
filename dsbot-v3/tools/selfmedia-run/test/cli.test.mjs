import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { readJson, runCli, tempDir, writeJson } from './support.mjs';

const TOPIC = '测试选题';

test('fake run exits 0 and writes article-pack, review and report', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /status: ready_for_review/);
  assert.ok(existsSync(join(out, 'article-pack.json')));
  assert.ok(existsSync(join(out, 'review.json')));
  assert.ok(existsSync(join(out, 'report.json')));
  assert.ok(existsSync(join(out, 'article.md')));
  assert.ok(existsSync(join(out, 'sources.json')));

  const pack = readJson(out, 'article-pack.json');
  assert.equal(pack.status, 'ready_for_review');
  assert.equal(pack.needs_rework, false);
  assert.ok(pack.title_candidates.length >= 3);
  assert.ok(pack.body.length > 0);
  assert.ok(pack.tags.length >= 3);
  assert.ok(pack.word_count >= 200);
  assert.ok(pack.source_list.length >= 2);
  for (const source of pack.source_list) {
    assert.equal(typeof source.url, 'string');
    assert.match(source.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.excerpt.length > 0);
    assert.ok(source.excerpt.length <= 300);
    assert.equal('text' in source, false);
    assert.equal('body' in source, false);
  }
  assert.equal(pack.license_status, 'unauthorized');
  assert.equal(pack.license_status_label, '未授权');
  assert.equal(pack.license.status, 'unauthorized');
  assert.equal(pack.publish.executed, false);
  assert.equal(pack.review.verdict, 'passed');
});

test('review artifact has rubric items, verdict and evidence', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out]);
  assert.equal(result.code, 0);

  const review = readJson(out, 'review.json');
  assert.equal(review.review_version, 1);
  assert.equal(review.verdict, 'passed');
  assert.equal(review.needs_rework, false);
  assert.ok(review.score > 0);
  assert.ok(Array.isArray(review.rubric));
  assert.ok(review.rubric.length >= 5);
  for (const item of review.rubric) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.score, 'number');
    assert.equal(typeof item.threshold, 'number');
    assert.equal(typeof item.passed, 'boolean');
    assert.ok(item.evidence && typeof item.evidence === 'object');
  }
  assert.equal(review.reviewer.independent, true);
  assert.notEqual(review.reviewer.context_id, 'ctx-selfmedia-writer');
  assert.ok(Array.isArray(review.evidence.source_hosts));
  assert.equal(review.evidence.source_count, 3);
});

test('report has per-step timings, call counts and cost fields', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out]);
  assert.equal(result.code, 0);

  const report = readJson(out, 'report.json');
  const names = report.steps.map((step) => step.name);
  for (const name of ['retrieve', 'snapshot', 'fact_check', 'write', 'review', 'typeset', 'write_artifacts']) {
    assert.ok(names.includes(name), `missing step ${name}`);
  }
  for (const step of report.steps) {
    assert.equal(typeof step.duration_ms, 'number');
    assert.ok(step.duration_ms >= 0);
    assert.ok(step.calls && typeof step.calls === 'object');
  }
  assert.equal(report.model_calls.total, 0);
  assert.equal(report.fake_model_calls.total, 2);
  assert.equal(report.calls.search, 1);
  assert.equal(report.calls.fetch, 3);
  assert.equal(report.calls.network_fetch, 0);
  assert.equal(report.usage.source, 'fake_no_usage');
  assert.equal(report.cost.currency, 'CNY');
  assert.equal(report.cost.estimated_cny, 0);
  assert.equal(report.cost.pricing_source, 'not_applicable_fake');
  assert.equal(report.env.api_key_logged, false);
});

test('fake run prose is deterministic across runs', async (t) => {
  const first = tempDir(t);
  const second = tempDir(t);
  const a = await runCli(['--topic', TOPIC, '--out', first]);
  const b = await runCli(['--topic', TOPIC, '--out', second]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);

  const packA = readJson(first, 'article-pack.json');
  const packB = readJson(second, 'article-pack.json');
  assert.deepEqual(packA.title_candidates, packB.title_candidates);
  assert.equal(packA.body, packB.body);
  assert.deepEqual(packA.tags, packB.tags);
  assert.deepEqual(
    packA.source_list.map((source) => source.url),
    packB.source_list.map((source) => source.url),
  );
});

test('inject-fact-error produces rework and names the unsupported claim', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out, '--inject-fact-error']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /status: needs_rework/);

  const pack = readJson(out, 'article-pack.json');
  const review = readJson(out, 'review.json');
  assert.equal(pack.status, 'needs_rework');
  assert.equal(pack.needs_rework, true);
  assert.equal(review.verdict, 'rework');
  assert.equal(review.needs_rework, true);
  assert.equal(pack.injection.enabled, true);
  assert.equal(pack.injection.caught, true);
  assert.match(pack.injection.detected_claim, /37\.5/);

  const issue = review.issues.find((entry) => entry.code === 'unsupported_claim');
  assert.ok(issue, 'expected an unsupported_claim issue');
  assert.match(issue.message, /37\.5/);
  assert.match(issue.evidence.claim, /37\.5/);
  const factuality = review.rubric.find((item) => item.id === 'factuality');
  assert.equal(factuality.passed, false);
  assert.ok(factuality.evidence.unsupported_claims.length >= 1);
});

test('offline without a snapshot blocks with exit 3 and no sources', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out, '--offline']);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /no source was fabricated/);

  const pack = readJson(out, 'article-pack.json');
  const review = readJson(out, 'review.json');
  assert.equal(pack.status, 'blocked');
  assert.equal(pack.body, '');
  assert.equal(pack.source_list.length, 0);
  assert.equal(pack.facts.length, 0);
  assert.ok(pack.blocks.some((block) => block.code === 'snapshot_missing'));
  assert.equal(review.verdict, 'blocked');
  assert.ok(review.issues.some((issue) => issue.code === 'snapshot_missing'));
});

test('offline with a local source pack uses only that pack', async (t) => {
  const snapDir = tempDir(t);
  const out = tempDir(t);
  const claim = '离线材料显示，采用双人复核后，事实错误率从 18% 降到 7%。';
  const pack = {
    topic: '离线选题',
    sources: [
      {
        url: 'https://one.snapshot.invalid/a',
        title: '材料一',
        text: `材料一记录了内容团队的复核流程。${claim}`,
        claims: [{ text: claim, key: true }],
      },
      {
        url: 'https://two.snapshot.invalid/b',
        title: '材料二',
        text: `材料二访谈了编辑团队。${claim}`,
        claims: [{ text: claim, key: true }],
      },
    ],
    facts: [
      {
        claim,
        key: true,
        source_refs: ['https://one.snapshot.invalid/a', 'https://two.snapshot.invalid/b'],
      },
    ],
  };
  writeJson(join(snapDir, 'sources.json'), pack);

  const result = await runCli(['--topic', '离线选题', '--out', out, '--offline', '--snapshots', snapDir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /status: ready_for_review/);

  const article = readJson(out, 'article-pack.json');
  const report = readJson(out, 'report.json');
  assert.equal(article.status, 'ready_for_review');
  assert.deepEqual(
    article.source_list.map((source) => source.url),
    ['https://one.snapshot.invalid/a', 'https://two.snapshot.invalid/b'],
  );
  assert.equal(article.license_status, 'unauthorized');
  assert.equal(report.calls.network_fetch, 0);
  assert.equal(report.retrieval.provider, 'snapshot');
});

test('offline with a missing source pack blocks and names the file', async (t) => {
  const out = tempDir(t);
  const missing = join(out, 'does-not-exist.json');
  const result = await runCli(['--topic', TOPIC, '--out', out, '--offline', '--sources', missing]);
  assert.equal(result.code, 3);
  const article = readJson(out, 'article-pack.json');
  assert.equal(article.status, 'blocked');
  assert.ok(article.blocks.some((block) => block.code === 'source_pack_missing'));
});

test('real mode without DSBOT_MODEL_* exits 2 and names every missing variable', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out, '--real']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /DSBOT_MODEL_BASE_URL/);
  assert.match(result.stderr, /DSBOT_MODEL_API_KEY/);
  assert.match(result.stderr, /DSBOT_MODEL_NAME/);
  assert.match(result.stderr, /never printed/);
});

test('real mode never prints a configured model key', async (t) => {
  const out = tempDir(t);
  const secret = 'sk-test-secret-value-123456';
  const result = await runCli(['--topic', TOPIC, '--out', out, '--real'], {
    env: {
      DSBOT_MODEL_BASE_URL: 'https://model.example.com/v1',
      DSBOT_MODEL_API_KEY: secret,
      DSBOT_MODEL_NAME: 'test-model',
    },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /retrieval input/);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  for (const name of readdirSync(out)) {
    assert.equal(readFileSync(join(out, name), 'utf8').includes(secret), false);
  }
});

test('invalid usage exits 2 with an actionable message', async (t) => {
  const out = tempDir(t);
  const cases = [
    ['--topic', TOPIC],
    ['--out', out],
    ['--topic', TOPIC, '--out', out, '--nope'],
    ['--topic', TOPIC, '--out', out, '--fake', '--real'],
    ['--topic', TOPIC, '--out', out, '--snapshots', out, '--sources', join(out, 's.json')],
  ];
  for (const argv of cases) {
    const result = await runCli(argv);
    assert.equal(result.code, 2, `expected exit 2 for ${argv.join(' ')}`);
    assert.ok(result.stderr.length > 0);
  }
});

test('--search is only accepted with --real and selects the metadata provider', async (t) => {
  const out = tempDir(t);
  const fake = await runCli(['--topic', TOPIC, '--out', out, '--search']);
  assert.equal(fake.code, 2);
  assert.match(fake.stderr, /--search is only valid with --real/);

  const both = await runCli([
    '--topic',
    TOPIC,
    '--out',
    out,
    '--real',
    '--search',
    '--sources',
    join(out, 'sources.json'),
  ]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /do not pass --snapshots or --sources/);
});

test('--allow-fulltext is rejected unless --real --search opts in', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out, '--real', '--allow-fulltext']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--allow-fulltext is only valid with --real --search/);
  assert.match(result.stderr, /D-04/);
});

test('--real --search without DSBOT_SEARCH_BASE_URL exits 2 without fetching', async (t) => {
  const out = tempDir(t);
  const result = await runCli(['--topic', TOPIC, '--out', out, '--real', '--search'], {
    env: {
      DSBOT_MODEL_BASE_URL: 'https://model.example.com/v1',
      DSBOT_MODEL_API_KEY: 'search-key',
      DSBOT_MODEL_NAME: 'test-model',
    },
    fetchImpl: async () => {
      throw new Error('no network request is allowed without a search endpoint');
    },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /retrieval input/);
  assert.match(result.stderr, /DSBOT_SEARCH_BASE_URL/);
});

test('--help exits 0 and documents the environment variables', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /DSBOT_MODEL_BASE_URL/);
  assert.match(result.stdout, /DSBOT_MODEL_API_KEY/);
  assert.match(result.stdout, /DSBOT_MODEL_NAME/);
  assert.match(result.stdout, /--allow-fulltext/);
  assert.match(result.stdout, /D-04/);
  assert.match(result.stdout, /Exit codes/);
});
