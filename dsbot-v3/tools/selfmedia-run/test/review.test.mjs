import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureRetrieval, sha256Hex } from '../src/retrieval.mjs';
import { createFakeWriter } from '../src/model.mjs';
import {
  extractSentences,
  isOpinionOrAdviceSentence,
  reviewArticle,
} from '../src/review.mjs';

const TOPIC = '测试选题';
const NOW = () => 1700000000000;

function fixtureContext(topic = TOPIC) {
  const retrieval = createFixtureRetrieval(topic);
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

function fixtureDraft({ injectFactError = false } = {}) {
  const { retrieval, sources } = fixtureContext();
  const writer = createFakeWriter({ injectFactError });
  const draft = {
    title_candidates: [
      '测试选题：三条可核查的事实',
      '把「测试选题」写清楚：证据、做法与待确认',
      '测试选题 的实践复盘：先核对再动笔',
    ],
    body: '',
  };
  return writer({
    topic: TOPIC,
    facts: retrieval.facts,
    sources,
  }).then((result) => ({ ...result, retrieval, sources }));
}

const LICENSE = { status: 'unauthorized', published: false };

test('review passes a fully sourced deterministic article and weights sum to one', async () => {
  const { retrieval, sources } = fixtureContext();
  const draft = await fixtureDraft();
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources,
    sourceTexts: retrieval.documents,
    license: LICENSE,
    now: NOW,
  });

  assert.equal(result.verdict, 'passed');
  assert.equal(result.needs_rework, false);
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
  assert.equal(result.rubric.length, 6);
  const weightSum = result.rubric.reduce((sum, item) => sum + item.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9);
  assert.ok(result.rubric.every((item) => item.passed));
  assert.deepEqual(result.evidence.unsupported_claims, []);
});

test('review catches an injected unsupported number and names the exact claim', async () => {
  const { retrieval, sources } = fixtureContext();
  const draft = await fixtureDraft({ injectFactError: true });
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources,
    sourceTexts: retrieval.documents,
    license: LICENSE,
    now: NOW,
  });

  assert.equal(result.verdict, 'rework');
  assert.equal(result.needs_rework, true);
  const factuality = result.rubric.find((item) => item.id === 'factuality');
  assert.equal(factuality.passed, false);
  assert.ok(factuality.score < factuality.threshold);
  assert.ok(factuality.evidence.unsupported_claims.length >= 1);
  assert.match(factuality.evidence.unsupported_claims[0].claim, /37\.5/);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === 'unsupported_claim' && /37\.5/.test(issue.evidence.claim),
    ),
  );
});

test('review refuses a publish-authorized license even when prose is clean', async () => {
  const { retrieval, sources } = fixtureContext();
  const draft = await fixtureDraft();
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources,
    sourceTexts: retrieval.documents,
    license: { status: 'authorized', published: true },
    now: NOW,
  });

  const compliance = result.rubric.find((item) => item.id === 'compliance');
  assert.equal(compliance.score, 0);
  assert.equal(compliance.passed, false);
  assert.equal(result.verdict, 'rework');
  assert.ok(result.issues.some((issue) => issue.code === 'license_not_unauthorized'));
});

test('review merges an independent model rubric and cannot be raised above local checks', async () => {
  const { retrieval, sources } = fixtureContext();
  const draft = await fixtureDraft();
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources,
    sourceTexts: retrieval.documents,
    license: LICENSE,
    modelReview: {
      rubric: {
        style: { score: 60, evidence: ['marketing tone'] },
        factuality: { score: 100, evidence: ['looks fine to the model'] },
      },
      issues: [
        { code: 'style_issue', severity: 'warning', message: '文风需要收敛。', rubric_item: 'style' },
      ],
      verdict: 'rework',
    },
    now: NOW,
  });

  assert.equal(result.verdict, 'rework');
  const style = result.rubric.find((item) => item.id === 'style');
  assert.ok(style.score <= 60);
  assert.equal(style.evidence.independent_model.score, 60);
  assert.ok(result.issues.some((issue) => issue.code === 'style_issue'));
});

test('review treats an invalid model review as rework instead of passing', async () => {
  const { retrieval, sources } = fixtureContext();
  const draft = await fixtureDraft();
  const result = reviewArticle({
    topic: TOPIC,
    article: draft,
    facts: retrieval.facts,
    sources,
    sourceTexts: retrieval.documents,
    license: LICENSE,
    modelReview: { __parse_error: true, raw: 'not json' },
    now: NOW,
  });

  assert.equal(result.verdict, 'rework');
  assert.ok(result.issues.some((issue) => issue.code === 'review_invalid_json'));
});

test('review flags an attribution sentence with no matching fact', async () => {
  const article = {
    title_candidates: ['T', 'T2', 'T3'],
    body: [
      '# T',
      '',
      '研究表明，这个领域即将发生根本变化。',
      '',
      '## 来源',
      '',
      '[1] https://example.com/a',
      '',
    ].join('\n'),
  };
  const result = reviewArticle({
    topic: 'T',
    article,
    facts: [],
    sources: [],
    sourceTexts: new Map(),
    license: LICENSE,
    now: NOW,
  });
  assert.equal(result.verdict, 'rework');
  const factuality = result.rubric.find((item) => item.id === 'factuality');
  assert.ok(
    factuality.evidence.unsupported_claims.some(
      (claim) => claim.reason === 'attribution_without_source',
    ),
  );
});

function reviewBody(body, { facts = [], sources = [], sourceTexts = new Map() } = {}) {
  return reviewArticle({
    topic: 'T',
    article: {
      title_candidates: ['T1', 'T2', 'T3'],
      body: ['# T', '', body, '', '## 来源', '', '[1] https://example.com/a', ''].join('\n'),
    },
    facts,
    sources,
    sourceTexts,
    license: LICENSE,
    now: NOW,
  });
}

test('factuality skips a numbered advice/opinion sentence instead of reporting it', () => {
  const sentence = '4. 用回滚率验收，而不是用「AI 会不会出错」争论。';
  const result = reviewBody(sentence);
  const factuality = result.rubric.find((item) => item.id === 'factuality');

  assert.deepEqual(factuality.evidence.unsupported_claims, []);
  assert.equal(factuality.evidence.skipped_opinion_count, 1);
  assert.equal(
    factuality.evidence.skipped_opinion_claims[0].claim,
    '用回滚率验收，而不是用「AI 会不会出错」争论。',
  );
  assert.equal(factuality.evidence.skipped_opinion_claims[0].reason, 'opinion_or_advice');
  assert.equal(result.evidence.skipped_opinion_claims.length, 1);
});

test('factuality skips recommendations even when they contain a number', () => {
  const result = reviewBody('建议把回滚率阈值设为 42%。');
  const factuality = result.rubric.find((item) => item.id === 'factuality');

  assert.deepEqual(factuality.evidence.unsupported_claims, []);
  assert.equal(factuality.evidence.skipped_opinion_count, 1);
});

test('factuality still blocks a declarative sentence with unsupported numbers', () => {
  const sentence = '报告显示，错误率从 18% 降到 7%。';
  const result = reviewBody(sentence);
  const factuality = result.rubric.find((item) => item.id === 'factuality');

  assert.equal(factuality.evidence.unsupported_claims.length, 1);
  assert.equal(factuality.evidence.unsupported_claims[0].reason, 'numbers_not_in_sources');
  assert.deepEqual(factuality.evidence.unsupported_claims[0].missing_numbers, ['18%', '7%']);
  assert.equal(factuality.evidence.unsupported_claims[0].claim, sentence);
  assert.equal(factuality.passed, false);
});

test('factuality strips ordered-list markers before extracting numbers', () => {
  const result = reviewBody('4. 报告显示，错误率从 18% 降到 7%。');
  const factuality = result.rubric.find((item) => item.id === 'factuality');
  const entry = factuality.evidence.unsupported_claims[0];

  assert.equal(entry.claim, '报告显示，错误率从 18% 降到 7%。');
  assert.deepEqual(entry.missing_numbers, ['18%', '7%']);
  assert.equal(entry.missing_numbers.includes('4'), false);
});

test('factuality still checks 可以看到 sentences that state a number', () => {
  const result = reviewBody('可以看到，错误率从 18% 降到 7%。');
  const factuality = result.rubric.find((item) => item.id === 'factuality');

  assert.equal(factuality.evidence.unsupported_claims.length, 1);
  assert.equal(factuality.evidence.skipped_opinion_count, 0);
});

test('extractSentences removes ordered-list markers but keeps decimal facts', () => {
  const sentences = extractSentences('# T\n\n4. 用回滚率验收。\n\n5. 错误率降到 7.5%。');
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ['用回滚率验收。', '错误率降到 7.5%。'],
  );
});

test('opinion detection covers advice leads and comparisons only', () => {
  assert.equal(isOpinionOrAdviceSentence('应该先统一术语。'), true);
  assert.equal(isOpinionOrAdviceSentence('A 方案优于 B 方案。'), true);
  assert.equal(isOpinionOrAdviceSentence('4. 用回滚率验收，而不是争论。'), true);
  assert.equal(isOpinionOrAdviceSentence('研究表明，错误率为 18%。'), false);
  assert.equal(isOpinionOrAdviceSentence('可以看到，错误率为 18%。'), false);
});
