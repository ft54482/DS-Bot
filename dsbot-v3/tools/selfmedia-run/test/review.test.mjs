import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureRetrieval, sha256Hex } from '../src/retrieval.mjs';
import { createFakeWriter } from '../src/model.mjs';
import { reviewArticle } from '../src/review.mjs';

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
