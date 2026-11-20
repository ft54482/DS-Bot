import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runHarness } from '../src/harness.mjs';
import { readJson, runCli, tempDir, writeJson } from './support.mjs';

const CLAIM = '采用双人复核后，错误率从 18% 降到 7%。';

function sourcePack() {
  return {
    topic: '真实集成',
    sources: [
      {
        url: 'https://one.real.invalid/a',
        title: '材料一',
        text:
          `材料一记录了一个编辑团队的流程变化。${CLAIM} ` +
          '团队把结论、证据和待确认事项分开记录，并在发布前由第二位编辑逐条核对来源。' +
          '这套流程并不保证内容一定正确，但能让错误更早暴露。',
        claims: [{ text: CLAIM, key: true }],
      },
      {
        url: 'https://two.real.invalid/b',
        title: '材料二',
        text:
          `材料二访谈了另一个团队，得到同样的结论。${CLAIM} ` +
          '受访者强调，复核要留下记录，否则下一次仍会重复同样的错误。',
        claims: [{ text: CLAIM, key: true }],
      },
    ],
    facts: [
      {
        claim: CLAIM,
        key: true,
        source_refs: ['https://one.real.invalid/a', 'https://two.real.invalid/b'],
      },
    ],
  };
}

function writerBody(claim = CLAIM) {
  return [
    '# 真实集成',
    '',
    '围绕这个选题，两组材料都记录了一次可复用的流程变化。',
    '',
    '## 事实与引用',
    '',
    `${claim} [1][2]`,
    '',
    '材料一和材料二都强调，复核记录比口头确认更重要；如果没有留下记录，下一次仍可能重复同样的错误。',
    '',
    '## 可以怎么做',
    '',
    '- 把复核步骤固定下来，并留下可追溯的记录。',
    '- 发布前逐条核对来源，对没有来源的数字保持克制。',
    '- 把结论、证据和待确认事项分开记录。',
    '',
    '## 待确认',
    '',
    '- 来源样本是否覆盖不同规模的团队。',
    '- 是否需要补充第二轮回访。',
    '',
    '## 来源',
    '',
    '[1] https://one.real.invalid/a',
    '[2] https://two.real.invalid/b',
    '',
  ].join('\n');
}

function fakeModelPayload(init, { claim = CLAIM } = {}) {
  const request = JSON.parse(init.body);
  const system = String(request.messages?.[0]?.content ?? '');
  const isReviewer = system.includes('独立审校');
  const payload = isReviewer
    ? {
        rubric: {
          factuality: { score: 95, evidence: ['numbers trace to the source pack'] },
          sourcing: { score: 95, evidence: ['two hosts'] },
          structure: { score: 95, evidence: ['complete sections'] },
          readability: { score: 95, evidence: ['short paragraphs'] },
          style: { score: 95, evidence: ['plain language'] },
          compliance: { score: 95, evidence: ['license stays unauthorized'] },
        },
        issues: [],
        verdict: 'passed',
      }
    : {
        title_candidates: [
          '真实集成：一条可核查的流程变化',
          '把复核写进流程：从证据到动作',
          '真实集成 的实践记录与待确认事项',
        ],
        body: writerBody(claim),
      };
  return {
    isReviewer,
    body: {
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: isReviewer
        ? { prompt_tokens: 100, completion_tokens: 50 }
        : { prompt_tokens: 200, completion_tokens: 100 },
    },
  };
}

function fakeModelFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const { body } = fakeModelPayload(init);
    return { ok: true, status: 200, json: async () => body };
  };
}

test('real mode composes source pack, real-style model calls and cost reporting', async (t) => {
  const out = tempDir(t);
  const packFile = join(tempDir(t), 'sources.json');
  writeJson(packFile, sourcePack());
  const calls = [];
  const env = {
    DSBOT_MODEL_BASE_URL: 'https://model.example.com/v1',
    DSBOT_MODEL_API_KEY: 'real-integration-secret',
    DSBOT_MODEL_NAME: 'test-model',
    DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K: '0.002',
    DSBOT_MODEL_PRICE_OUTPUT_CNY_PER_1K: '0.008',
  };

  const result = await runHarness({
    topic: '真实集成',
    out,
    mode: 'real',
    sources: packFile,
    env,
    fetchImpl: fakeModelFetch(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.articlePack.status, 'ready_for_review');
  assert.equal(result.articlePack.license_status, 'unauthorized');
  assert.equal(result.review.verdict, 'passed');
  assert.equal(result.report.model_calls.total, 2);
  assert.equal(result.report.fake_model_calls.total, 0);
  assert.equal(result.report.usage.total_tokens, 450);
  assert.equal(result.report.cost.estimated_cny, 0.0018);
  assert.equal(result.report.cost.pricing_source, 'env');
  assert.equal(result.report.env.api_key_logged, false);
  assert.equal(JSON.stringify(result.report).includes(env.DSBOT_MODEL_API_KEY), false);
  assert.equal(JSON.stringify(result.articlePack).includes(env.DSBOT_MODEL_API_KEY), false);

  // Two model calls: writer (needs facts) and an independent reviewer.
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].init.body), /已核查事实/);
  assert.match(String(calls[1].init.body), /正文/);

  const onDisk = readFileSync(join(out, 'report.json'), 'utf8');
  assert.equal(onDisk.includes(env.DSBOT_MODEL_API_KEY), false);

  // A local source pack is read locally; no article page is ever requested.
  assert.equal(result.report.calls.network_fetch, 0);
  for (const source of result.articlePack.source_list) {
    assert.equal(typeof source.url, 'string');
    assert.match(source.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.excerpt.length > 0);
    assert.ok(source.excerpt.length <= 300);
    assert.equal('text' in source, false);
    assert.equal('body' in source, false);
  }
});

const SEARCH_URL = 'https://search.example.com/search';
const SEARCH_CLAIM = '两家机构都记录，复核后错误率从 18% 降到 7%。';
const FILLER = '补充摘要内容，'.repeat(40);
const UNIQUE_TAIL = 'UNIQUE_TAIL_MARKER';

function searchItem(host, label) {
  return {
    url: `https://${host}/story`,
    title: label,
    snippet: `${SEARCH_CLAIM}${FILLER}${UNIQUE_TAIL}`,
    // Body-like fields must be ignored on the metadata-only path (D-04).
    content: 'FULLTEXT_SHOULD_NOT_BE_USED',
    body: 'FULLTEXT_SHOULD_NOT_BE_USED',
  };
}

test('--real --search uses metadata only and never requests an article body URL', async (t) => {
  const out = tempDir(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const requested = String(url);
    calls.push({ url: requested, init });
    if (requested.startsWith(SEARCH_URL)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            searchItem('one.news.example', '材料一'),
            searchItem('two.news.example', '材料二'),
          ],
        }),
      };
    }
    if (requested.startsWith('https://model.example.com/')) {
      const { body } = fakeModelPayload(init, { claim: SEARCH_CLAIM });
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error(`unexpected request (D-04 body fetch?): ${requested}`);
  };

  const env = {
    DSBOT_MODEL_BASE_URL: 'https://model.example.com/v1',
    DSBOT_MODEL_API_KEY: 'search-integration-secret',
    DSBOT_MODEL_NAME: 'test-model',
    DSBOT_SEARCH_BASE_URL: SEARCH_URL,
  };
  const result = await runCli(
    ['--topic', '真实检索', '--out', out, '--real', '--search'],
    { env, fetchImpl },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /status: ready_for_review/);

  // `--real` without the explicit `--search` flag still uses the search
  // endpoint when no source pack is configured; it must not fetch bodies either.
  const outNoFlag = tempDir(t);
  const resultNoFlag = await runCli(
    ['--topic', '真实检索', '--out', outNoFlag, '--real'],
    { env, fetchImpl },
  );
  assert.equal(resultNoFlag.code, 0);
  assert.equal(
    readJson(outNoFlag, 'report.json').retrieval.fulltext_policy,
    'metadata_and_summary_only',
  );

  // Only the metadata search endpoint and the model endpoint may be contacted.
  const hosts = new Set(calls.map((call) => new URL(call.url).hostname));
  assert.deepEqual([...hosts].sort(), ['model.example.com', 'search.example.com']);
  for (const call of calls) {
    assert.equal(
      call.url.includes('/story'),
      false,
      `article body URL must never be requested: ${call.url}`,
    );
  }

  const pack = readJson(out, 'article-pack.json');
  const report = readJson(out, 'report.json');
  assert.equal(report.calls.network_fetch, 0);
  assert.equal(report.retrieval.page_fetch, false);
  assert.equal(report.retrieval.fulltext_policy, 'metadata_and_summary_only');
  assert.equal(pack.source_list.length, 2);
  for (const source of pack.source_list) {
    assert.equal(typeof source.url, 'string');
    assert.match(source.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.excerpt.length > 0);
    assert.ok(source.excerpt.length <= 300);
    assert.equal('text' in source, false);
    assert.equal('body' in source, false);
  }

  const serialized = `${JSON.stringify(pack)}\n${readFileSync(join(out, 'sources.json'), 'utf8')}`;
  assert.equal(serialized.includes(UNIQUE_TAIL), false, 'summary tail leaked into artifacts');
  assert.equal(serialized.includes('FULLTEXT_SHOULD_NOT_BE_USED'), false, 'body leaked into artifacts');
  assert.equal(JSON.stringify(result).includes('search-integration-secret'), false);
});
