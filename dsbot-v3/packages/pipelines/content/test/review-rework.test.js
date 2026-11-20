import assert from 'node:assert/strict';
import test from 'node:test';

import { validateArticlePack } from '../src/article-pack.js';
import { runContentPipeline } from '../src/pipeline.js';
import {
  TOPIC,
  createClock,
  createFetch,
  createReviewModel,
  createSearch,
  createWriterModel,
} from './helpers/fixtures.js';

function baseDeps(clock, extra = {}) {
  return {
    now: clock.now,
    search: createSearch().search,
    fetch: createFetch().fetch,
    ...extra,
  };
}

test('review: reported issues produce needs_rework=true and are listed', async () => {
  const clock = createClock();
  const writer = createWriterModel();
  const reviewer = createReviewModel({
    score: 62,
    issues: [
      { code: 'weak_structure', message: 'Opening lacks a hook.', severity: 'critical' },
      { code: 'tone_drift', message: 'The middle section changes voice.', severity: 'warning' },
    ],
  });

  const result = await runContentPipeline(
    { topic: TOPIC },
    baseDeps(clock, { model: { write: writer.write, review: reviewer.review } }),
  );

  assert.equal(result.status, 'needs_rework');
  const pack = result.article_pack;
  assert.equal(pack.status, 'needs_rework');
  assert.equal(pack.needs_rework, true);
  assert.equal(pack.review.needs_rework, true);
  assert.equal(pack.review.score, 62);
  assert.deepEqual(pack.review.issues.map((issue) => issue.code), ['weak_structure', 'tone_drift']);
  assert.ok(pack.body.length > 0, 'a rework verdict still delivers the draft for revision');
  assert.ok(pack.layout.word_count > 0);
  assert.deepEqual(validateArticlePack(pack).issues, []);

  assert.deepEqual(result.steps.map((step) => step.name), [
    'retrieve',
    'snapshot',
    'fact_check',
    'write',
    'review',
    'typeset',
  ]);
  assert.equal(reviewer.calls.length, 1);
});

test('review: the deterministic checks flag a thin title set without a model reviewer', async () => {
  const clock = createClock();
  const model = {
    write: async ({ topic }) => ({
      title_candidates: [topic],
      body: 'A body long enough to pass the empty-body check.',
    }),
  };

  const result = await runContentPipeline({ topic: TOPIC }, baseDeps(clock, { model }));

  assert.equal(result.status, 'needs_rework');
  assert.equal(result.article_pack.review.needs_rework, true);
  assert.equal(result.article_pack.review.score, 90);
  const issue = result.article_pack.review.issues.find((item) => item.code === 'too_few_title_candidates');
  assert.ok(issue);
  assert.equal(issue.severity, 'warning');
});

test('review: an empty body is a critical deterministic issue', async () => {
  const clock = createClock();
  const model = {
    write: async () => ({ title_candidates: ['One', 'Two', 'Three'], body: '   ' }),
  };

  const result = await runContentPipeline({ topic: TOPIC }, baseDeps(clock, { model }));

  assert.equal(result.status, 'needs_rework');
  const issue = result.article_pack.review.issues.find((item) => item.code === 'empty_body');
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.equal(result.article_pack.review.score, 75);
});

test('review: a failing reviewer becomes a listed rework issue, not a lost run', async () => {
  const clock = createClock();
  const writer = createWriterModel();
  const model = {
    write: writer.write,
    review: async () => {
      throw new Error('model gateway unavailable');
    },
  };

  const result = await runContentPipeline({ topic: TOPIC }, baseDeps(clock, { model }));

  assert.equal(result.status, 'needs_rework');
  const issue = result.article_pack.review.issues.find((item) => item.code === 'review_failed');
  assert.ok(issue);
  assert.match(issue.message, /model gateway unavailable/);
  assert.equal(result.article_pack.review.score, 0);
});

test('review: a blocked chain lists the blockers as critical issues', async () => {
  const clock = createClock();
  const fetcher = createFetch({ failing: { 'https://example.test/source-a': 'ECONNREFUSED' } });

  const result = await runContentPipeline(
    { topic: TOPIC },
    { now: clock.now, search: createSearch().search, fetch: fetcher.fetch },
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.article_pack.review.needs_rework, false);
  assert.ok(result.article_pack.review.issues.some((item) => item.code === 'key_fact_unverified'));
  assert.ok(result.article_pack.review.issues.every((item) => item.severity === 'critical'));
});
