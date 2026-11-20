/**
 * End-to-end self-media pilot (docs/prd/09-wbs.md §1.1, docs/prd/14-business-model.md §2.1).
 *
 * The content chain (`packages/pipelines/content`) produces an article draft and
 * the pinned acceptance profile (`packages/profiles`) decides whether that draft
 * may be handed to a person as a publish package. This module only orchestrates
 * those two existing implementations:
 *
 *   retrieve -> snapshot -> fact_check -> write -> review -> typeset
 *        -> profile acceptance -> (bounded rework) -> publish package
 *
 * It never publishes. The publish package always records
 * `license_status: "unauthorized"` and a rejected `evaluatePublish` decision with
 * no authorization record; a person must supply the separate publish
 * authorization (docs/prd/14-business-model.md §3.2, D-V3-23).
 *
 * Search, fetch and model are injected. The content chain's defaults already
 * refuse the network, so this pilot stays offline by construction:
 *   - `deps.search(query)`  -> search results/claims;
 *   - `deps.fetch(url)`     -> `{ ok, text, fetched_at }` or a failure;
 *   - `deps.model.write`    -> draft `{ title_candidates, body }`;
 *   - `deps.model.review`   -> review `{ score, issues, rubric?, reviewer?,
 *                              citations?, risks?, cover_copy? }`.
 *
 * A review may return one aggregate `score`; the acceptance profile requires a
 * per-dimension rubric, so an aggregate score is projected onto every dimension
 * and the projection is recorded as `rubric_source`. A review that supplies
 * neither a rubric nor a score cannot pass quality: the pilot does not invent
 * quality evidence, and the bounded rework loop ends `blocked`.
 */

import { excerptOf, runContentPipeline } from '../../content/src/index.js';
import {
  evaluateArticlePack,
  evaluatePublish,
  selfMediaProfileV1,
} from '../../../profiles/src/index.js';

export const PILOT_VERSION = 1;

/** Two rework attempts after the first draft: at most three content runs. */
export const DEFAULT_MAX_REWORK_ROUNDS = 2;

export const LICENSE_STATUS_UNAUTHORIZED = 'unauthorized';

export const DEFAULT_PLATFORM = 'wechat';

export const DEFAULT_AUTHOR = Object.freeze({
  id: 'selfmedia-pilot-writer',
  context_id: 'ctx-selfmedia-writer',
});

/**
 * The pilot runs the review stage in its own context/model call, so the default
 * reviewer record is independent of the default writer context. Callers can
 * override it with `deps.reviewer`; the profile still validates independence.
 */
export const DEFAULT_REVIEWER = Object.freeze({
  id: 'selfmedia-pilot-review',
  context_id: 'ctx-selfmedia-review',
  independent: true,
});

export const QUALITY_DIMENSIONS = Object.freeze(['structure', 'readability', 'style']);

const TAG_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'why', 'how', 'what', 'when', 'that',
  'this', 'make', 'makes', 'more', 'less', 'about', 'from', 'into', 'you', 'your',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    if (!isNonEmptyString(value)) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function normalizeMaxReworkRounds(value) {
  if (!Number.isInteger(value) || value < 0) return DEFAULT_MAX_REWORK_ROUNDS;
  return value;
}

function normalizeCall(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('runSelfMediaPilot input must be an object: { topic, deps }');
  }
  if (!isNonEmptyString(input.topic)) {
    throw new TypeError('runSelfMediaPilot requires a non-empty input.topic');
  }
  return {
    topic: input.topic.trim(),
    deps: isPlainObject(input.deps) ? input.deps : {},
  };
}

function clockOf(deps) {
  return typeof deps.now === 'function' ? deps.now : () => Date.now();
}

function stampOf(now) {
  const value = now();
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  return { ms };
}

function platformOf(deps) {
  return isNonEmptyString(deps.platform) ? deps.platform.trim() : DEFAULT_PLATFORM;
}

function accountOf(deps) {
  return isNonEmptyString(deps.account) ? deps.account.trim() : null;
}

function profileOf(deps) {
  return isPlainObject(deps.profile) ? deps.profile : selfMediaProfileV1;
}

/**
 * Wrap the injected model so the pilot can see the raw review evidence (the
 * content chain intentionally normalizes review output down to score/issues)
 * and hand bounded rework feedback to later attempts.
 */
function wrapModel(model, capture, feedback) {
  const source = typeof model === 'function'
    ? { write: model }
    : isPlainObject(model)
      ? { ...model }
      : {};
  const wrapped = { ...source };

  if (typeof source.write === 'function') {
    wrapped.write = async (context) =>
      source.write({ ...context, rework_feedback: [...feedback] });
  }
  if (typeof source.review === 'function') {
    wrapped.review = async (context) => {
      const raw = await source.review({ ...context, rework_feedback: [...feedback] });
      capture.review = raw;
      return raw;
    };
  }
  return wrapped;
}

function contentInputFor({ topic, deps, feedback }) {
  const constraints = [
    ...asArray(deps.constraints).filter(isNonEmptyString),
    ...feedback.map((line) => `rework: ${line}`),
  ];
  return {
    topic,
    goal: isNonEmptyString(deps.goal) ? deps.goal.trim() : topic,
    platform: platformOf(deps),
    audience: deps.audience,
    tone: deps.tone,
    tags: asArray(deps.tags).filter(isNonEmptyString),
    facts: asArray(deps.facts),
    constraints,
    acceptance: asArray(deps.acceptance),
    ...(Number.isInteger(deps.minTitleCandidates)
      ? { min_title_candidates: deps.minTitleCandidates }
      : {}),
    ...(Number.isInteger(deps.minIndependentSourcesForKeyFact)
      ? { min_independent_sources_for_key_fact: deps.minIndependentSourcesForKeyFact }
      : {}),
  };
}

function contentDepsFor({ deps, model }) {
  return {
    now: deps.now,
    search: deps.search,
    fetch: deps.fetch,
    model,
    snapshotStore: deps.snapshotStore,
    minTitleCandidates: deps.minTitleCandidates,
    minIndependentSourcesForKeyFact: deps.minIndependentSourcesForKeyFact,
    excerptChars: deps.excerptChars,
  };
}

/* ------------------------------------------------------------- review bridge */

function issueLine(issue) {
  const code = isNonEmptyString(issue?.code) ? issue.code : 'review_issue';
  const message = isNonEmptyString(issue?.message) ? issue.message : code;
  return `[${code}] ${message}`;
}

function failureLine(item) {
  return `[${item.id}] ${item.detail}`;
}

function feedbackFrom({ contentReview, acceptance }) {
  return [
    ...asArray(contentReview?.issues).map(issueLine),
    ...asArray(acceptance?.items)
      .filter((item) => item.result !== 'pass')
      .map(failureLine),
  ];
}

function dimensionEntry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { score: value };
  if (!isPlainObject(value)) return null;
  if (!Number.isFinite(value.score)) return null;
  return { ...value };
}

function buildRubric({ rawReview }) {
  if (!isPlainObject(rawReview)) return { rubric: {}, source: 'missing' };

  if (isPlainObject(rawReview.rubric)) {
    const rubric = {};
    for (const dimension of QUALITY_DIMENSIONS) {
      const entry = dimensionEntry(rawReview.rubric[dimension]);
      if (entry) rubric[dimension] = entry;
    }
    return { rubric, source: 'reviewer_rubric' };
  }

  // Only a reviewer-supplied aggregate score is projected. The deterministic
  // fallback reviewer's score is not independent quality evidence.
  if (!Number.isFinite(rawReview.score)) return { rubric: {}, source: 'missing' };
  return {
    rubric: Object.fromEntries(
      QUALITY_DIMENSIONS.map((dimension) => [dimension, { score: rawReview.score }]),
    ),
    source: 'aggregate_score_projection',
  };
}

function pickAuthor(deps) {
  const candidate = isPlainObject(deps.author) ? deps.author : DEFAULT_AUTHOR;
  return {
    id: isNonEmptyString(candidate.id) ? candidate.id.trim() : DEFAULT_AUTHOR.id,
    context_id: isNonEmptyString(candidate.context_id)
      ? candidate.context_id.trim()
      : DEFAULT_AUTHOR.context_id,
  };
}

function pickReviewer({ rawReview, deps }) {
  const candidate = isPlainObject(rawReview?.reviewer)
    ? rawReview.reviewer
    : isPlainObject(deps.reviewer)
      ? deps.reviewer
      : DEFAULT_REVIEWER;
  return {
    id: isNonEmptyString(candidate.id) ? candidate.id.trim() : DEFAULT_REVIEWER.id,
    context_id: isNonEmptyString(candidate.context_id)
      ? candidate.context_id.trim()
      : DEFAULT_REVIEWER.context_id,
    independent: candidate.independent === undefined ? true : candidate.independent === true,
    ...(isNonEmptyString(candidate.model) ? { model: candidate.model.trim() } : {}),
  };
}

function buildCitations(rawReview, body) {
  const provided = isPlainObject(rawReview?.citations) ? rawReview.citations : {};
  return {
    total_chars: Number.isFinite(provided.total_chars) ? provided.total_chars : body.length,
    quoted_chars: Number.isFinite(provided.quoted_chars) ? provided.quoted_chars : 0,
  };
}

function buildCoverCopy(rawReview, pack, topic) {
  if (isNonEmptyString(rawReview?.cover_copy)) return rawReview.cover_copy.trim();
  if (isNonEmptyString(pack?.layout?.cover_copy)) return pack.layout.cover_copy.trim();
  return excerptOf(pack?.title_candidates?.[0] ?? topic, 40);
}

function buildTags({ deps, pack, topic }) {
  const platform = platformOf(deps);
  const explicit = asArray(deps.tags).filter(isNonEmptyString).map((tag) => tag.trim());
  const contentTags = asArray(pack?.layout?.tags);
  const topicWords = topic
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !TAG_STOPWORDS.has(word.toLowerCase()));
  return uniqueStrings([
    ...explicit,
    ...contentTags,
    ...topicWords,
    platform,
    'self-media',
    '待发布',
  ]).slice(0, 8);
}

function profileSource(source) {
  return {
    url: source.url,
    fetched_at: source.fetched_at,
    snapshot: {
      sha256: source.sha256,
      captured_at: source.fetched_at,
      excerpt: source.excerpt,
    },
  };
}

function profileFacts(pack) {
  const byUrl = new Map(asArray(pack.sources).map((source) => [source.url, source]));
  return asArray(pack.facts).map((fact, index) => {
    const sources = asArray(fact.source_refs)
      .map((ref) => byUrl.get(ref))
      .filter(Boolean)
      .map(profileSource);
    return {
      id: isNonEmptyString(fact.id) ? fact.id.trim() : `F${index + 1}`,
      key: fact.key === true,
      statement: fact.claim,
      time_sensitive: fact.time_sensitive !== false,
      sources,
    };
  });
}

function buildProfilePack({ topic, deps, pack, capture, tags }) {
  const rawReview = isPlainObject(capture.review) ? capture.review : {};
  const { rubric, source: rubricSource } = buildRubric({ rawReview });
  const titles = asArray(pack.title_candidates).filter(isNonEmptyString);
  const account = accountOf(deps);
  const platform = platformOf(deps);

  const profilePack = {
    schema_version: 1,
    article: {
      title: titles[0] ?? '',
      body: pack.body,
      author: pickAuthor(deps),
    },
    facts: profileFacts(pack),
    quality: {
      reviewer: pickReviewer({ rawReview, deps }),
      rubric,
    },
    layout: {
      titles,
      tags,
      cover_copy: buildCoverCopy(rawReview, pack, topic),
      platform,
      ...(account === null ? {} : { account }),
    },
    citations: buildCitations(rawReview, pack.body),
    compliance: { risks: Array.isArray(rawReview.risks) ? rawReview.risks : [] },
  };

  return { profile_pack: profilePack, rubric_source: rubricSource };
}

/* -------------------------------------------------------------------- outputs */

function buildDraft({ topic, deps, pack, tags, coverCopy }) {
  return {
    topic,
    platform: platformOf(deps),
    title_candidates: [...asArray(pack.title_candidates)],
    body: pack.body,
    tags: [...tags],
    cover_copy: coverCopy,
    layout: { ...pack.layout, tags: [...tags], cover_copy: coverCopy },
    sources: asArray(pack.sources).map((source) => ({ ...source })),
    facts: asArray(pack.facts).map((fact) => ({ ...fact })),
  };
}

function buildReview({ run, acceptance, round, maxRounds, rubricSource }) {
  const contentReview = isPlainObject(run.article_pack?.review) ? run.article_pack.review : {};
  const needsRework = run.status === 'needs_rework' || acceptance.result === 'needs_rework';
  const result = acceptance.result === 'blocked'
    ? 'blocked'
    : needsRework
      ? 'needs_rework'
      : 'pass';
  return {
    result,
    needs_rework: needsRework && result !== 'blocked',
    score: Number.isFinite(contentReview.score) ? contentReview.score : null,
    issues: asArray(contentReview.issues),
    warnings: asArray(run.article_pack?.warnings),
    acceptance_result: acceptance.result,
    rework_rounds: round,
    max_rework_rounds: maxRounds,
    rubric_source: rubricSource,
    acceptance,
  };
}

function contentBlockedReview(run, round, maxRounds) {
  return {
    result: 'blocked',
    needs_rework: false,
    score: null,
    issues: asArray(run.blockers).map((blocker) => ({
      code: isNonEmptyString(blocker?.code) ? blocker.code : 'content_blocked',
      message: isNonEmptyString(blocker?.message)
        ? blocker.message
        : isNonEmptyString(blocker?.claim)
          ? blocker.claim
          : 'content chain blocked',
      severity: 'critical',
    })),
    warnings: asArray(run.warnings),
    acceptance_result: null,
    rework_rounds: round,
    max_rework_rounds: maxRounds,
    stage: 'content',
    acceptance: null,
  };
}

function contentBlockedReason(run) {
  const parts = asArray(run.blockers).map((blocker) => {
    const code = isNonEmptyString(blocker?.code) ? blocker.code : 'blocked';
    const detail = isNonEmptyString(blocker?.message)
      ? blocker.message
      : isNonEmptyString(blocker?.claim)
        ? blocker.claim
        : 'no detail';
    return `${code}: ${detail}`;
  });
  return parts.length > 0
    ? `content_blocked: ${parts.join('; ')}`
    : 'content_blocked: the content chain blocked without a listed reason';
}

function acceptanceBlockedReason(acceptance) {
  const details = asArray(acceptance?.items)
    .filter((item) => item.result === 'blocked')
    .map((item) => `[${item.id}] ${item.detail}`);
  return details.length > 0
    ? `acceptance_blocked: ${details.join('; ')}`
    : 'acceptance_blocked: the acceptance profile blocked the pack';
}

function buildPublishPackage({
  topic,
  deps,
  run,
  acceptance,
  tags,
  nowMs,
  profilePack,
  rubricSource,
}) {
  const pack = run.article_pack;
  const platform = platformOf(deps);
  const account = accountOf(deps);
  const decision = evaluatePublish(profilePack, null, {
    now: nowMs,
    profile: profileOf(deps),
  });

  return {
    package_version: PILOT_VERSION,
    status: 'ready_for_review',
    topic,
    platform,
    account,
    title_candidates: [...asArray(pack.title_candidates)],
    chosen_title: pack.title_candidates?.[0] ?? '',
    body: pack.body,
    tags: [...tags],
    cover_copy: profilePack.layout.cover_copy,
    sources: asArray(pack.sources).map((source) => ({
      url: source.url,
      fetched_at: source.fetched_at,
      sha256: source.sha256,
      excerpt: source.excerpt,
    })),
    facts: profilePack.facts.map((fact) => ({
      id: fact.id,
      statement: fact.statement,
      key: fact.key,
      sources: fact.sources.map((source) => source.url),
    })),
    review: {
      result: 'pass',
      score: Number.isFinite(pack.review?.score) ? pack.review.score : null,
      issues: asArray(pack.review?.issues),
      reviewer: profilePack.quality.reviewer,
      rubric: profilePack.quality.rubric,
      rubric_source: rubricSource,
    },
    acceptance: { result: acceptance.result, items: acceptance.items },
    warnings: asArray(pack.warnings),
    license_status: LICENSE_STATUS_UNAUTHORIZED,
    license: {
      status: LICENSE_STATUS_UNAUTHORIZED,
      allowed: decision.allowed,
      authorization: null,
      decision: {
        result: decision.result,
        allowed: decision.allowed,
        content_fingerprint: decision.content_fingerprint,
        acceptance: decision.acceptance,
        reasons: decision.reasons,
      },
    },
    publish: { executed: false, authorization: null },
    generated_at: new Date(nowMs).toISOString(),
  };
}

/* ---------------------------------------------------------------------- main */

/**
 * Run the end-to-end self-media pilot.
 *
 * @param {{topic: string, deps?: object}} input
 * @returns {Promise<{
 *   topic: string,
 *   draft: object|null,
 *   review: object,
 *   publish_package: object|null,
 *   blocked_reason?: string,
 *   attempts: object[]
 * }>}
 */
export async function runSelfMediaPilot(input) {
  const { topic, deps } = normalizeCall(input);
  const maxReworkRounds = normalizeMaxReworkRounds(deps.maxReworkRounds);
  const now = clockOf(deps);
  const attempts = [];
  let feedback = [];

  for (let round = 0; round <= maxReworkRounds; round += 1) {
    const roundClock = stampOf(now);
    const capture = {};
    const model = wrapModel(deps.model, capture, feedback);

    const run = await runContentPipeline(
      contentInputFor({ topic, deps, feedback }),
      contentDepsFor({ deps, model }),
    );

    if (run.status === 'blocked') {
      attempts.push({
        round,
        content_status: run.status,
        acceptance_result: null,
        issues: asArray(run.blockers).map((blocker) => blocker.code),
      });
      return {
        topic,
        draft: null,
        review: contentBlockedReview(run, round, maxReworkRounds),
        publish_package: null,
        blocked_reason: contentBlockedReason(run),
        attempts,
      };
    }

    const tags = buildTags({ deps, pack: run.article_pack, topic });
    const { profile_pack: profilePack, rubric_source: rubricSource } = buildProfilePack({
      topic,
      deps,
      pack: run.article_pack,
      capture,
      tags,
    });
    const acceptance = evaluateArticlePack(profilePack, profileOf(deps), {
      now: roundClock.ms,
    });
    const review = buildReview({
      run,
      acceptance,
      round,
      maxRounds: maxReworkRounds,
      rubricSource,
    });
    const draft = buildDraft({
      topic,
      deps,
      pack: run.article_pack,
      tags,
      coverCopy: profilePack.layout.cover_copy,
    });

    attempts.push({
      round,
      content_status: run.status,
      acceptance_result: acceptance.result,
      content_needs_rework: run.article_pack?.review?.needs_rework === true,
      issues: asArray(run.article_pack?.review?.issues).map((issue) => issue.code),
      acceptance_failures: acceptance.items
        .filter((item) => item.result !== 'pass')
        .map((item) => ({ id: item.id, result: item.result, detail: item.detail })),
      usage: run.usage,
    });

    if (review.result === 'pass') {
      const publishPackage = buildPublishPackage({
        topic,
        deps,
        run,
        acceptance,
        tags,
        nowMs: roundClock.ms,
        profilePack,
        rubricSource,
      });
      return {
        topic,
        draft,
        review,
        publish_package: publishPackage,
        attempts,
      };
    }

    if (acceptance.result === 'blocked') {
      return {
        topic,
        draft,
        review,
        publish_package: null,
        blocked_reason: acceptanceBlockedReason(acceptance),
        attempts,
      };
    }

    feedback = feedbackFrom({ contentReview: run.article_pack?.review, acceptance });

    if (round === maxReworkRounds) {
      review.result = 'blocked';
      review.needs_rework = false;
      review.exhausted = true;
      const details = feedback.length > 0 ? feedback.join('; ') : 'review still needs rework';
      return {
        topic,
        draft,
        review,
        publish_package: null,
        blocked_reason:
          `rework_exhausted: ${details} ` +
          `(after ${maxReworkRounds} rework round(s))`,
        attempts,
      };
    }
  }

  throw new Error('runSelfMediaPilot exhausted its loop without a result');
}
