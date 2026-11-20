import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_REWORK_ROUNDS,
  runSelfMediaPilot,
} from '../src/index.js';
import {
  BODIES,
  FETCHED_AT,
  SOURCE_A,
  SOURCE_B,
  TOPIC,
  createFetch,
  createReview,
  createSearch,
  createWriter,
  makeHarness,
  passReview,
} from './helpers.js';

test('pilot: a clean run returns draft, review and a ready publish package', async () => {
  const { deps } = makeHarness();
  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(result.topic, TOPIC);
  assert.equal(result.blocked_reason, undefined);
  assert.ok(result.draft);
  assert.equal(result.draft.body.length > 0, true);
  assert.equal(result.review.result, 'pass');
  assert.equal(result.review.needs_rework, false);
  assert.equal(result.review.acceptance_result, 'pass');
  assert.equal(result.review.rework_rounds, 0);
  assert.equal(result.review.max_rework_rounds, DEFAULT_MAX_REWORK_ROUNDS);
  assert.equal(result.publish_package.status, 'ready_for_review');
  assert.equal(result.attempts.length, 1);
});

test('pilot: the publish package carries titles, body, tags, sources and facts', async () => {
  const { deps } = makeHarness();
  const result = await runSelfMediaPilot({ topic: TOPIC, deps });
  const { publish_package: pkg } = result;

  assert.ok(pkg.title_candidates.length >= 3);
  assert.equal(pkg.chosen_title, pkg.title_candidates[0]);
  assert.ok(pkg.body.trim().length > 0);
  assert.ok(pkg.tags.length >= 3);
  assert.equal(new Set(pkg.tags).size, pkg.tags.length);
  assert.deepEqual(result.draft.tags, pkg.tags);
  assert.deepEqual(result.draft.layout.tags, pkg.tags);
  assert.equal(result.draft.cover_copy, pkg.cover_copy);
  assert.equal(pkg.sources.length, 2);
  assert.deepEqual(
    pkg.sources.map((source) => source.url).sort(),
    [SOURCE_A, SOURCE_B],
  );
  assert.equal(pkg.facts.filter((fact) => fact.key).length, 1);
  assert.equal(pkg.acceptance.result, 'pass');
});

test('pilot: the publish package is explicitly unauthorized and never published', async () => {
  const { deps } = makeHarness();
  const { publish_package: pkg } = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(pkg.license_status, 'unauthorized');
  assert.equal(pkg.license.status, 'unauthorized');
  assert.equal(pkg.license.allowed, false);
  assert.equal(pkg.license.authorization, null);
  assert.equal(pkg.license.decision.result, 'rejected');
  assert.ok(
    pkg.license.decision.reasons.some((reason) => reason.code === 'publish_authorization_required'),
  );
  assert.deepEqual(pkg.publish, { executed: false, authorization: null });
});

test('pilot: an unreachable source with a cached snapshot continues to a package', async () => {
  const fetch = createFetch({ failing: { [SOURCE_A]: 'connection refused' } });
  const { deps } = makeHarness({
    fetch: fetch.fetch,
    snapshotStore: new Map([
      [SOURCE_A, { text: BODIES[SOURCE_A], fetched_at: '2026-11-19T10:00:00.000Z' }],
    ]),
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(result.review.result, 'pass');
  assert.ok(result.publish_package);
  assert.ok(result.publish_package.sources.some((source) => source.url === SOURCE_A));
  assert.ok(
    result.review.warnings.some(
      (warning) => warning.code === 'source_unreachable_using_cached_snapshot',
    ),
  );
  assert.deepEqual(fetch.calls, [SOURCE_A, SOURCE_B]);
});

test('pilot: an unreachable source without a snapshot blocks without a package', async () => {
  const fetch = createFetch({
    failing: { [SOURCE_A]: 'connection refused', [SOURCE_B]: 'timeout' },
  });
  const { deps } = makeHarness({ fetch: fetch.fetch });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(result.draft, null);
  assert.equal(result.publish_package, null);
  assert.equal(result.review.result, 'blocked');
  assert.equal(result.review.stage, 'content');
  assert.match(result.blocked_reason, /content_blocked/);
  assert.match(result.blocked_reason, /no_usable_sources|key_fact_unverified/);
  assert.equal(result.attempts.length, 1);
});

test('pilot: two review rework rounds are allowed before a clean third attempt', async () => {
  const writeCalls = [];
  const reviewCalls = [];
  let reviewCount = 0;
  const { deps } = makeHarness({
    model: {
      write: createWriter({ calls: writeCalls }),
      review: async (context) => {
        reviewCalls.push(context);
        reviewCount += 1;
        return reviewCount < 3
          ? passReview({
            score: 60,
            issues: [{ code: 'weak_argument', message: 'tighten the argument', severity: 'warning' }],
          })
          : passReview();
      },
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(reviewCalls.length, 3);
  assert.equal(writeCalls.length, 3);
  assert.equal(result.review.rework_rounds, 2);
  assert.equal(result.review.result, 'pass');
  assert.ok(result.publish_package);
  assert.ok(
    writeCalls[1].rework_feedback.some((line) => line.includes('weak_argument')),
  );
  assert.ok(
    reviewCalls[1].rework_feedback.some((line) => line.includes('weak_argument')),
  );
});

test('pilot: persistent review needs_rework blocks after exactly two rework rounds', async () => {
  let reviewCount = 0;
  const { deps } = makeHarness({
    model: {
      write: createWriter(),
      review: async () => {
        reviewCount += 1;
        return passReview({
          score: 55,
          issues: [{ code: 'weak_argument', message: 'still weak', severity: 'warning' }],
        });
      },
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(reviewCount, 3);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.review.result, 'blocked');
  assert.equal(result.review.exhausted, true);
  assert.equal(result.review.needs_rework, false);
  assert.equal(result.review.rework_rounds, 2);
  assert.equal(result.publish_package, null);
  assert.ok(result.draft);
  assert.match(result.blocked_reason, /rework_exhausted/);
  assert.match(result.blocked_reason, /weak_argument/);
  assert.match(result.blocked_reason, /after 2 rework round\(s\)/);
});

test('pilot: an acceptance needs_rework triggers a rework round and can recover', async () => {
  let reviewCount = 0;
  const writeCalls = [];
  const { deps } = makeHarness({
    model: {
      write: createWriter({ calls: writeCalls }),
      review: async () => {
        reviewCount += 1;
        return passReview({
          rubric: reviewCount === 1
            ? {
              structure: { score: 50, issues: ['weak structure'] },
              readability: { score: 82, issues: [] },
              style: { score: 84, issues: [] },
            }
            : {
              structure: { score: 80, issues: [] },
              readability: { score: 82, issues: [] },
              style: { score: 84, issues: [] },
            },
        });
      },
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(reviewCount, 2);
  assert.equal(writeCalls.length, 2);
  assert.equal(result.review.rework_rounds, 1);
  assert.equal(result.review.result, 'pass');
  assert.ok(result.publish_package);
  assert.ok(
    writeCalls[1].rework_feedback.some((line) => line.includes('independent.quality.structure')),
  );
  assert.equal(result.publish_package.acceptance.result, 'pass');
});

test('pilot: an acceptance blocked result stops immediately with the finding', async () => {
  const { deps } = makeHarness({
    model: {
      write: createWriter(),
      review: async () => passReview({
        reviewer: { id: 'author-echo', context_id: 'ctx-selfmedia-writer', independent: false },
      }),
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(result.attempts.length, 1);
  assert.equal(result.review.result, 'blocked');
  assert.equal(result.review.rework_rounds, 0);
  assert.equal(result.publish_package, null);
  assert.ok(result.draft);
  assert.match(result.blocked_reason, /acceptance_blocked/);
  assert.match(result.blocked_reason, /independent\.quality\.reviewer/);
});

test('pilot: no injected dependencies blocks on no_sources without touching the network', async () => {
  const result = await runSelfMediaPilot({ topic: TOPIC });

  assert.equal(result.draft, null);
  assert.equal(result.publish_package, null);
  assert.equal(result.review.result, 'blocked');
  assert.equal(result.review.stage, 'content');
  assert.match(result.blocked_reason, /no_sources/);
  assert.equal(result.attempts.length, 1);
});

test('pilot: the writer title candidates and body are preserved verbatim', async () => {
  const titles = ['Candidate one', 'Candidate two', 'Candidate three', 'Candidate four'];
  const body = '# Custom\n\nA distinct body marker.\n';
  const { deps } = makeHarness({
    model: {
      write: createWriter({ titles, body }),
      review: async () => passReview(),
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.deepEqual(result.draft.title_candidates, titles);
  assert.deepEqual(result.publish_package.title_candidates, titles);
  assert.equal(result.publish_package.chosen_title, 'Candidate one');
  assert.equal(result.publish_package.body, body);
});

test('pilot: a missing or blank topic is rejected as a caller error', async () => {
  await assert.rejects(() => runSelfMediaPilot(), /input must be an object/);
  await assert.rejects(() => runSelfMediaPilot({ topic: '   ' }), /non-empty input\.topic/);
});

test('pilot: maxReworkRounds=0 blocks after the first needs_rework result', async () => {
  let reviewCount = 0;
  const { deps } = makeHarness({
    maxReworkRounds: 0,
    model: {
      write: createWriter(),
      review: async () => {
        reviewCount += 1;
        return passReview({
          score: 60,
          issues: [{ code: 'weak_argument', message: 'needs another pass', severity: 'warning' }],
        });
      },
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(reviewCount, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.review.rework_rounds, 0);
  assert.equal(result.review.result, 'blocked');
  assert.match(result.blocked_reason, /after 0 rework round\(s\)/);
});

test('pilot: explicit tags are kept first in the publish package', async () => {
  const { deps } = makeHarness({ tags: ['alpha', 'beta', 'gamma'] });
  const { publish_package: pkg } = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.deepEqual(pkg.tags.slice(0, 3), ['alpha', 'beta', 'gamma']);
});

test('pilot: missing tags fall back to at least three unique topic/platform tags', async () => {
  const { deps } = makeHarness({ tags: [] });
  const { publish_package: pkg } = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.ok(pkg.tags.length >= 3);
  assert.equal(new Set(pkg.tags).size, pkg.tags.length);
  assert.ok(pkg.tags.includes('wechat'));
});

test('pilot: every source entry has a URL, fetch time, sha256 and excerpt', async () => {
  const { deps } = makeHarness();
  const { publish_package: pkg } = await runSelfMediaPilot({ topic: TOPIC, deps });

  for (const source of pkg.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.equal(Number.isNaN(Date.parse(source.fetched_at)), false);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(source.excerpt.length > 0);
    assert.equal(source.fetched_at, FETCHED_AT);
  }
  assert.equal(new Set(pkg.sources.map((source) => new URL(source.url).hostname)).size, 2);
});

test('pilot: an aggregate reviewer score is projected and the projection is recorded', async () => {
  const { deps } = makeHarness({
    model: {
      write: createWriter(),
      review: async () => ({
        score: 88,
        issues: [],
        reviewer: { id: 'reviewer-1', context_id: 'ctx-review-1', independent: true },
        citations: { total_chars: 2000, quoted_chars: 120 },
        risks: [],
      }),
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(result.review.result, 'pass');
  assert.equal(result.publish_package.review.rubric_source, 'aggregate_score_projection');
  for (const dimension of ['structure', 'readability', 'style']) {
    assert.equal(result.publish_package.review.rubric[dimension].score, 88);
  }
});

test('pilot: a reviewer with no score or rubric cannot pass quality', async () => {
  let reviewCount = 0;
  const { deps } = makeHarness({
    model: {
      write: createWriter(),
      review: async () => {
        reviewCount += 1;
        return {
          issues: [],
          reviewer: { id: 'reviewer-1', context_id: 'ctx-review-1', independent: true },
          citations: { total_chars: 2000, quoted_chars: 120 },
          risks: [],
        };
      },
    },
  });

  const result = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.equal(reviewCount, 3);
  assert.equal(result.review.result, 'blocked');
  assert.equal(result.publish_package, null);
  assert.match(result.blocked_reason, /rework_exhausted/);
  assert.match(result.blocked_reason, /independent\.quality/);
});

test('pilot: the source claim and search doubles stay deterministic', async () => {
  const search = createSearch();
  const fetch = createFetch();
  const review = createReview();
  const { deps } = makeHarness({
    search: search.search,
    fetch: fetch.fetch,
    model: { write: createWriter(), review: review.review },
  });

  const first = await runSelfMediaPilot({ topic: TOPIC, deps });
  const second = await runSelfMediaPilot({ topic: TOPIC, deps });

  assert.deepEqual(first.publish_package.title_candidates, second.publish_package.title_candidates);
  assert.deepEqual(first.publish_package.sources, second.publish_package.sources);
  assert.equal(search.calls.length, 2);
  assert.equal(fetch.calls.length, 4);
  assert.equal(review.calls.length, 2);
});
