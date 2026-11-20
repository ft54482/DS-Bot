/**
 * Self-media content chain (docs/prd/17-minimal-implementation-package.md §S3):
 *
 *   retrieve -> snapshot -> fact_check -> write -> review -> typeset
 *
 * Every external capability is injected (`search`, `fetch`, `model`) and the
 * defaults never touch the network: the default search returns no sources and
 * the default fetch reports `network_disabled`. Tests and callers provide
 * deterministic doubles.
 *
 * Source degradation follows docs/prd/14-business-model.md §2.1 and D-V3-28:
 *   - a source that cannot be fetched but has a verifiable snapshot is used,
 *     and the chain continues with a warning;
 *   - a key fact that cannot be verified from snapshots blocks the chain;
 *   - an unreachable non-key source is warned about and does not block.
 */

import {
  PACK_VERSION,
  excerptOf,
  isPlainObject,
  sha256Hex,
  validateArticlePack,
} from './article-pack.js';

export const STAGES = Object.freeze(['retrieve', 'snapshot', 'fact_check', 'write', 'review', 'typeset']);

export const CANCELLED_CODE = 'content_chain_cancelled';

export const DEFAULT_MIN_TITLE_CANDIDATES = 3;
export const DEFAULT_MIN_INDEPENDENT_SOURCES_FOR_KEY_FACT = 2;
export const DEFAULT_EXCERPT_CHARS = 280;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function emptyUsage() {
  return { tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_cny: 0 };
}

function addUsage(total, usage) {
  if (!isPlainObject(usage)) return false;
  let seen = false;
  for (const key of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost_cny']) {
    const value = Number(usage[key] ?? 0);
    if (Number.isFinite(value)) total[key] += value;
    if (Number.isFinite(value) && value !== 0) seen = true;
  }
  return seen;
}

function isoNow(now) {
  const value = now();
  return new Date(typeof value === 'number' ? value : Date.now()).toISOString();
}

function normalizeFetchedAt(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (isNonEmptyString(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

/* ------------------------------------------------------------------ defaults */

/** Default search: no network, no results. The chain reports `no_sources`. */
export async function defaultSearch() {
  return [];
}

/** Default fetch: no network. Callers must inject a fetcher. */
export async function defaultFetch(url) {
  return { ok: false, error: `network_disabled: refusing to fetch ${url}` };
}

function absoluteSourceNumber(index) {
  return index + 1;
}

/**
 * Deterministic local writer used when no model is injected. It never calls a
 * network; titles and body are derived only from the topic and checked facts.
 */
export function defaultWrite({ topic, facts, sources }) {
  const subject = topic;
  const titleCandidates = [
    subject,
    `${subject}: three facts worth checking`,
    `What we should rethink about ${subject}`,
  ];
  const paragraphs = facts.map((fact, index) => {
    const refs = fact.source_refs.map((url) => {
      const sourceIndex = sources.findIndex((source) => source.url === url);
      return sourceIndex >= 0 ? `[${absoluteSourceNumber(sourceIndex)}]` : '';
    });
    const suffix = refs.filter(Boolean).join('');
    return suffix ? `${fact.claim} ${suffix}` : fact.claim;
  });
  const referenceLines = sources.map(
    (source, index) => `[${absoluteSourceNumber(index)}] ${source.url}`,
  );
  const body = [
    `# ${subject}`,
    '',
    ...(paragraphs.length > 0
      ? paragraphs.flatMap((paragraph) => [paragraph, ''])
      : ['No checkable claim was supplied with the retrieved sources.', '']),
    '## Sources',
    '',
    ...referenceLines,
    '',
  ].join('\n');
  return { title_candidates: titleCandidates, body };
}

/** Deterministic review used when no model is injected. */
export function defaultReview({ title_candidates: titles, body }, minTitleCandidates) {
  const issues = [];
  if (titles.length < minTitleCandidates) {
    issues.push({
      code: 'too_few_title_candidates',
      message: `expected at least ${minTitleCandidates} title candidates, got ${titles.length}`,
      severity: 'warning',
    });
  }
  if (!isNonEmptyString(body)) {
    issues.push({ code: 'empty_body', message: 'the body is empty', severity: 'critical' });
  }
  return { issues };
}

export function defaultModel() {
  return { write: defaultWrite };
}

/* ---------------------------------------------------------------- retrieval */

function normalizeCandidate(raw) {
  if (typeof raw === 'string' && isNonEmptyString(raw)) {
    return { url: raw.trim(), title: '', claims: [] };
  }
  if (!isPlainObject(raw)) return null;
  const url = raw.url ?? raw.link;
  if (!isNonEmptyString(url)) return null;
  return {
    url: url.trim(),
    title: isNonEmptyString(raw.title) ? raw.title.trim() : '',
    snippet: isNonEmptyString(raw.snippet) ? raw.snippet : '',
    text: isNonEmptyString(raw.text) ? raw.text : null,
    fetched_at: raw.fetched_at ?? null,
    claims: asArray(raw.claims),
  };
}

function normalizeSearchResults(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
  const seen = new Set();
  const candidates = [];
  for (const entry of list) {
    const candidate = normalizeCandidate(entry);
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    candidates.push(candidate);
  }
  return candidates;
}

function normalizeClaimEntry(raw) {
  if (typeof raw === 'string') {
    return isNonEmptyString(raw) ? { text: raw.trim(), key: false, conflict: false } : null;
  }
  if (!isPlainObject(raw)) return null;
  const text = raw.text ?? raw.claim;
  if (!isNonEmptyString(text)) return null;
  return {
    text: text.trim(),
    key: raw.key === true,
    conflict: raw.conflict === true,
  };
}

function buildClaimMap(candidates, providedFacts) {
  const claims = new Map();
  const add = (text, { key = false, conflict = false, ref = null } = {}) => {
    if (!isNonEmptyString(text)) return;
    const claim = text.trim();
    let entry = claims.get(claim);
    if (!entry) {
      entry = { claim, key: false, conflict: false, refs: new Set() };
      claims.set(claim, entry);
    }
    entry.key = entry.key || key === true;
    entry.conflict = entry.conflict || conflict === true;
    if (isNonEmptyString(ref)) entry.refs.add(ref);
  };

  for (const raw of asArray(providedFacts)) {
    if (typeof raw === 'string') {
      add(raw);
      continue;
    }
    if (!isPlainObject(raw)) continue;
    const text = raw.claim ?? raw.text;
    if (!isNonEmptyString(text)) continue;
    const entry = normalizeClaimEntry({ ...raw, key: raw.key === true, conflict: raw.conflict === true });
    add(text, { key: entry?.key, conflict: entry?.conflict });
    for (const ref of asArray(raw.source_refs ?? raw.refs)) {
      add(text, { key: entry?.key, conflict: entry?.conflict, ref });
    }
  }

  for (const candidate of candidates) {
    for (const rawClaim of candidate.claims) {
      const entry = normalizeClaimEntry(rawClaim);
      if (!entry) continue;
      add(entry.text, { key: entry.key, conflict: entry.conflict, ref: candidate.url });
    }
  }

  return claims;
}

/* ----------------------------------------------------------------- snapshot */

function fetchedText(value) {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return null;
  for (const key of ['text', 'body', 'content']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function isFetchOk(value) {
  if (typeof value === 'string') return true;
  if (!isPlainObject(value)) return false;
  if (value.ok === false) return false;
  return typeof fetchedText(value) === 'string' && fetchedText(value).length > 0;
}

async function readCachedSnapshot(store, url) {
  if (!store) return null;
  if (typeof store === 'function') return (await store(url)) ?? null;
  if (typeof store.get === 'function') return (await store.get(url)) ?? null;
  if (isPlainObject(store) && url in store) return store[url] ?? null;
  return null;
}

async function snapshotCandidates({ candidates, config, topic }) {
  const sources = [];
  const documents = new Map();
  const unavailable = [];
  const warnings = [];

  for (const candidate of candidates) {
    let doc = null;
    let failure = null;
    let origin = 'fetch';

    if (isNonEmptyString(candidate.text)) {
      doc = { text: candidate.text, fetched_at: candidate.fetched_at };
      origin = 'search_payload';
    } else {
      let fetched = null;
      try {
        fetched = await config.fetch(candidate.url, { topic, url: candidate.url });
      } catch (error) {
        fetched = { ok: false, error: error?.message ?? String(error) };
      }

      if (isFetchOk(fetched)) {
        doc = { text: fetchedText(fetched), fetched_at: fetched.fetched_at };
      } else {
        failure = isPlainObject(fetched) ? (fetched.error ?? fetched.message ?? 'fetch_failed') : 'fetch_failed';
        const cached = await readCachedSnapshot(config.snapshotStore, candidate.url);
        const cachedText = fetchedText(cached);
        const expectedHash = isPlainObject(cached) ? cached.sha256 : null;
        if (isNonEmptyString(cachedText)) {
          if (isNonEmptyString(expectedHash) && sha256Hex(cachedText) !== expectedHash) {
            failure = 'snapshot_corrupt';
          } else {
            doc = {
              text: cachedText,
              fetched_at: isPlainObject(cached) ? cached.fetched_at : null,
            };
            origin = 'cache';
          }
        }
      }
    }

    if (!doc || !isNonEmptyString(doc.text)) {
      unavailable.push({ url: candidate.url, code: 'source_unreachable', message: String(failure ?? 'no content') });
      warnings.push({
        code: 'source_unreachable',
        url: candidate.url,
        message: `source is unreachable and no usable snapshot exists: ${candidate.url}`,
      });
      continue;
    }

    const text = doc.text;
    const sha256 = sha256Hex(text);
    sources.push({
      url: candidate.url,
      fetched_at: normalizeFetchedAt(doc.fetched_at, config.now()),
      sha256,
      excerpt: excerptOf(text, config.excerptChars),
    });
    documents.set(candidate.url, text);

    if (origin === 'cache') {
      warnings.push({
        code: 'source_unreachable_using_cached_snapshot',
        url: candidate.url,
        message: `source is unreachable; continued from a cached snapshot (${sha256})`,
      });
    }
  }

  return { sources, documents, unavailable, warnings };
}

/* ---------------------------------------------------------------- fact check */

function checkFacts({ claimMap, documents, minIndependentSourcesForKeyFact }) {
  const facts = [];
  const blockers = [];
  const warnings = [];

  for (const entry of claimMap.values()) {
    const allRefs = [...entry.refs];
    const supporting = allRefs.filter((url) => documents.has(url));
    const missing = allRefs.filter((url) => !documents.has(url));
    const required = entry.refs.size === 0
      ? 1
      : Math.min(
          entry.key ? minIndependentSourcesForKeyFact : 1,
          Math.max(1, allRefs.length),
        );

    let status;
    if (entry.conflict) status = 'conflicted';
    else if (allRefs.length === 0) status = 'unsupported';
    else if (supporting.length >= required) status = 'verified';
    else if (supporting.length > 0) status = 'partially_verified';
    else status = 'unverified';

    const fact = {
      claim: entry.claim,
      source_refs: supporting,
      key: entry.key,
      status,
      independent_sources: supporting.length,
      required_sources: required,
      missing_source_refs: missing,
    };
    facts.push(fact);

    if (entry.key && status !== 'verified') {
      const code = status === 'conflicted' ? 'key_fact_conflict' : 'key_fact_unverified';
      blockers.push({
        code,
        claim: entry.claim,
        source_refs: supporting,
        missing_source_refs: missing,
        message: status === 'conflicted'
          ? `key fact sources contradict each other: ${entry.claim}`
          : `key fact cannot be verified from snapshots (${supporting.length}/${required}): ${entry.claim}`,
      });
    } else if (!entry.key && status !== 'verified') {
      warnings.push({
        code: 'fact_not_fully_verified',
        claim: entry.claim,
        source_refs: supporting,
        message: `non-key fact is not fully verifiable (${supporting.length}/${required}): ${entry.claim}`,
      });
    }
  }

  return { facts, blockers, warnings };
}

/* -------------------------------------------------------------------- write */

function defaultTitles(topic) {
  return [
    topic,
    `${topic}: three facts worth checking`,
    `What we should rethink about ${topic}`,
  ];
}

function normalizeDraft(raw, topic) {
  if (typeof raw === 'string') {
    return { title_candidates: defaultTitles(topic), body: raw, usage: null };
  }
  const value = isPlainObject(raw) ? raw : {};
  const hasTitles = Array.isArray(value.title_candidates) || Array.isArray(value.titles);
  const titles = (hasTitles ? asArray(value.title_candidates ?? value.titles) : defaultTitles(topic))
    .map((title) => (typeof title === 'string' ? title.trim() : ''))
    .filter((title) => title.length > 0);
  const body = typeof value.body === 'string'
    ? value.body
    : typeof value.manuscript === 'string'
      ? value.manuscript
      : '';
  return { title_candidates: titles, body, usage: value.usage ?? null };
}

/* ------------------------------------------------------------------- review */

function normalizeIssue(raw) {
  if (typeof raw === 'string') {
    return { code: 'review_issue', message: raw, severity: 'warning' };
  }
  if (!isPlainObject(raw)) {
    return { code: 'review_issue', message: String(raw), severity: 'warning' };
  }
  const code = isNonEmptyString(raw.code) ? raw.code : 'review_issue';
  const message = isNonEmptyString(raw.message) ? raw.message : code;
  const severity = raw.severity === 'critical' ? 'critical' : isNonEmptyString(raw.severity) ? raw.severity : 'warning';
  return { ...raw, code, message, severity };
}

export function scoreFromIssues(issues) {
  const penalty = issues.reduce(
    (total, issue) => total + (issue.severity === 'critical' ? 25 : 10),
    0,
  );
  return Math.max(0, 100 - penalty);
}

function normalizeReviewOutcome(raw, fallbackIssues) {
  const rawIssues = Array.isArray(raw) ? raw : asArray(raw?.issues);
  const issues = rawIssues.map(normalizeIssue);
  if (issues.length === 0 && fallbackIssues.length > 0) {
    // A provider that reports no issues still has to answer the deterministic
    // checks (empty body / too few titles); those checks are never waived.
    issues.push(...fallbackIssues);
  }
  const score = typeof raw?.score === 'number' && Number.isFinite(raw.score)
    ? Math.min(100, Math.max(0, raw.score))
    : scoreFromIssues(issues);
  return {
    score,
    issues,
    needs_rework: raw?.needs_rework === true || issues.length > 0,
    usage: isPlainObject(raw) ? (raw.usage ?? null) : null,
  };
}

/* ------------------------------------------------------------------ typeset */

function typesetArticle({ platform, tags, title, body }) {
  const headings = body
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);
  const wordCount = (body.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) ?? []).length;
  const paragraphCount = body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0).length;
  const uniqueTags = [...new Set([...asArray(tags).filter(isNonEmptyString), platform].filter(Boolean))];
  return {
    platform,
    format: 'markdown',
    title: title ?? '',
    word_count: wordCount,
    paragraph_count: paragraphCount,
    headings,
    tags: uniqueTags,
    cover_copy: title ? excerptOf(title, 40) : '',
  };
}

/* ---------------------------------------------------------------- pipeline */

function normalizeDeps(deps = {}) {
  return {
    now: typeof deps.now === 'function' ? deps.now : () => Date.now(),
    search: typeof deps.search === 'function' ? deps.search : defaultSearch,
    fetch: typeof deps.fetch === 'function' ? deps.fetch : defaultFetch,
    model: typeof deps.model === 'function'
      ? { write: deps.model }
      : isPlainObject(deps.model)
        ? deps.model
        : defaultModel(),
    snapshotStore: deps.snapshotStore ?? null,
    minTitleCandidates: Number.isInteger(deps.minTitleCandidates) && deps.minTitleCandidates > 0
      ? deps.minTitleCandidates
      : DEFAULT_MIN_TITLE_CANDIDATES,
    minIndependentSourcesForKeyFact:
      Number.isInteger(deps.minIndependentSourcesForKeyFact) && deps.minIndependentSourcesForKeyFact > 0
        ? deps.minIndependentSourcesForKeyFact
        : DEFAULT_MIN_INDEPENDENT_SOURCES_FOR_KEY_FACT,
    excerptChars: Number.isInteger(deps.excerptChars) && deps.excerptChars > 0
      ? deps.excerptChars
      : DEFAULT_EXCERPT_CHARS,
  };
}

function normalizeInput(input, config) {
  if (!isPlainObject(input)) throw new TypeError('content pipeline input must be an object');
  const topic = input.topic ?? input.goal;
  if (!isNonEmptyString(topic)) {
    throw new TypeError('content pipeline requires input.topic (or input.goal)');
  }
  const minTitleCandidates = Number.isInteger(input.min_title_candidates) && input.min_title_candidates > 0
    ? input.min_title_candidates
    : config.minTitleCandidates;
  const minIndependentSourcesForKeyFact =
    Number.isInteger(input.min_independent_sources_for_key_fact) &&
    input.min_independent_sources_for_key_fact > 0
      ? input.min_independent_sources_for_key_fact
      : config.minIndependentSourcesForKeyFact;
  return {
    topic: topic.trim(),
    goal: isNonEmptyString(input.goal) ? input.goal.trim() : topic.trim(),
    platform: isNonEmptyString(input.platform) ? input.platform.trim() : 'wechat',
    audience: isNonEmptyString(input.audience) ? input.audience.trim() : null,
    tone: isNonEmptyString(input.tone) ? input.tone.trim() : null,
    tags: asArray(input.tags).filter(isNonEmptyString),
    facts: asArray(input.facts),
    constraints: asArray(input.constraints),
    acceptance: asArray(input.acceptance),
    minTitleCandidates,
    minIndependentSourcesForKeyFact,
  };
}

function notifyHook(hooks, event) {
  if (typeof hooks?.onStep === 'function') hooks.onStep(event);
}

async function runStage(name, { config, hooks, records }, run) {
  const startedAt = config.now();
  try {
    notifyHook(hooks, { name, status: 'started', at: startedAt });
    const value = await run();
    const endedAt = config.now();
    notifyHook(hooks, {
      name,
      status: 'completed',
      at: endedAt,
      duration_ms: endedAt - startedAt,
      output: summarize(name, value),
    });
    records.push({ name, status: 'completed', startedAt, endedAt, duration_ms: endedAt - startedAt });
    return value;
  } catch (error) {
    const endedAt = config.now();
    notifyHook(hooks, {
      name,
      status: error?.code === CANCELLED_CODE ? 'cancelled' : 'failed',
      at: endedAt,
      duration_ms: endedAt - startedAt,
      message: error?.message ?? String(error),
    });
    throw error;
  }
}

function summarize(name, value) {
  if (name === 'retrieve') return { candidates: value.length };
  if (name === 'snapshot') {
    return { sources: value.sources.length, unavailable: value.unavailable.length };
  }
  if (name === 'fact_check') {
    return { facts: value.facts.length, blockers: value.blockers.length };
  }
  if (name === 'write') {
    return { title_candidates: value.title_candidates.length, body_chars: value.body.length };
  }
  if (name === 'review') {
    return { score: value.score, issues: value.issues.length, needs_rework: value.needs_rework };
  }
  if (name === 'typeset') return { platform: value.platform, word_count: value.word_count };
  return null;
}

function buildBlockedPack({ input, sources, facts, blockers, warnings, config }) {
  const issues = blockers.map((blocker) => ({
    code: blocker.code,
    message: blocker.message ?? blocker.code,
    severity: 'critical',
  }));
  return {
    pack_version: PACK_VERSION,
    status: 'blocked',
    needs_rework: false,
    title_candidates: [],
    body: '',
    sources,
    facts,
    review: { score: 0, issues, needs_rework: false },
    layout: {
      platform: input.platform,
      format: 'markdown',
      title: '',
      word_count: 0,
      blocked: true,
    },
    warnings,
    generated_at: isoNow(config.now),
  };
}

/**
 * Run the full chain once. Returns:
 *   {
 *     status: 'ready_for_review' | 'needs_rework' | 'blocked',
 *     article_pack, blockers, warnings, steps, usage, generated_at
 *   }
 *
 * `hooks.onStep(event)` receives `{name,status,at,duration_ms,output|message}`
 * for every stage; the tool_chain adapter uses it to stream events.
 */
export async function runContentPipeline(input, deps = {}, hooks = {}) {
  const config = normalizeDeps(deps);
  const normalized = normalizeInput(input, config);
  const context = { config, hooks, records: [] };
  const usage = emptyUsage();
  let usageSeen = false;

  const structuralBlockers = [];
  let candidates = [];
  let searchFailure = null;
  try {
    const results = await runStage('retrieve', context, async () =>
      config.search({
        topic: normalized.topic,
        goal: normalized.goal,
        platform: normalized.platform,
        audience: normalized.audience,
        limit: 10,
      }),
    );
    candidates = normalizeSearchResults(results);
  } catch (error) {
    if (error?.code === CANCELLED_CODE) throw error;
    searchFailure = error;
    candidates = [];
  }

  if (searchFailure) {
    structuralBlockers.push({
      code: 'search_failed',
      message: `search provider failed: ${searchFailure?.message ?? String(searchFailure)}`,
    });
  } else if (candidates.length === 0) {
    structuralBlockers.push({ code: 'no_sources', message: 'search returned no sources' });
  }

  const snapshot = await runStage('snapshot', context, async () =>
    snapshotCandidates({ candidates, config, topic: normalized.topic }),
  );

  const checked = await runStage('fact_check', context, async () => {
    const claimMap = buildClaimMap(candidates, normalized.facts);
    const result = checkFacts({
      claimMap,
      documents: snapshot.documents,
      minIndependentSourcesForKeyFact: normalized.minIndependentSourcesForKeyFact,
    });
    const blockers = [...structuralBlockers, ...result.blockers];
    if (snapshot.sources.length === 0 && candidates.length > 0) {
      blockers.unshift({
        code: 'no_usable_sources',
        message: 'no source could be snapshotted and no cached snapshot is available',
      });
    }
    return { facts: result.facts, blockers, warnings: result.warnings };
  });

  const warnings = [...snapshot.warnings, ...checked.warnings];
  const generatedAt = isoNow(config.now);

  if (checked.blockers.length > 0) {
    const pack = buildBlockedPack({
      input: normalized,
      sources: snapshot.sources,
      facts: checked.facts,
      blockers: checked.blockers,
      warnings,
      config,
    });
    const validation = validateArticlePack(pack);
    if (!validation.ok) throw new Error(`invalid blocked article pack: ${validation.issues.join(', ')}`);
    return {
      status: 'blocked',
      article_pack: pack,
      blockers: checked.blockers,
      warnings,
      steps: context.records,
      usage: { ...usage, source: 'unavailable' },
      generated_at: generatedAt,
    };
  }

  const draft = await runStage('write', context, async () => {
    const writer = typeof config.model.write === 'function' ? config.model.write : defaultWrite;
    const raw = await writer({
      topic: normalized.topic,
      goal: normalized.goal,
      platform: normalized.platform,
      audience: normalized.audience,
      tone: normalized.tone,
      facts: checked.facts,
      sources: snapshot.sources,
      constraints: normalized.constraints,
      acceptance: normalized.acceptance,
    });
    return normalizeDraft(raw, normalized.topic);
  });
  usageSeen = addUsage(usage, draft.usage) || usageSeen;

  const review = await runStage('review', context, async () => {
    const fallback = defaultReview(
      { title_candidates: draft.title_candidates, body: draft.body },
      normalized.minTitleCandidates,
    );
    let raw;
    if (typeof config.model.review === 'function') {
      try {
        raw = await config.model.review({
          topic: normalized.topic,
          goal: normalized.goal,
          article: { title_candidates: draft.title_candidates, body: draft.body },
          sources: snapshot.sources,
          facts: checked.facts,
          warnings,
          constraints: normalized.constraints,
          acceptance: normalized.acceptance,
        });
      } catch (error) {
        if (error?.code === CANCELLED_CODE) throw error;
        raw = {
          score: 0,
          issues: [{ code: 'review_failed', message: `review provider failed: ${error?.message ?? String(error)}`, severity: 'critical' }],
        };
      }
    }
    return normalizeReviewOutcome(raw, fallback.issues);
  });
  usageSeen = addUsage(usage, review.usage) || usageSeen;

  const layout = await runStage('typeset', context, async () =>
    typesetArticle({
      platform: normalized.platform,
      tags: normalized.tags,
      title: draft.title_candidates[0] ?? '',
      body: draft.body,
    }),
  );

  const status = review.needs_rework ? 'needs_rework' : 'ready_for_review';
  const pack = {
    pack_version: PACK_VERSION,
    status,
    needs_rework: review.needs_rework,
    title_candidates: draft.title_candidates,
    body: draft.body,
    sources: snapshot.sources,
    facts: checked.facts,
    review: {
      score: review.score,
      issues: review.issues,
      needs_rework: review.needs_rework,
    },
    layout,
    warnings,
    generated_at: generatedAt,
  };

  const validation = validateArticlePack(pack);
  if (!validation.ok) throw new Error(`invalid article pack: ${validation.issues.join(', ')}`);

  return {
    status,
    article_pack: pack,
    blockers: [],
    warnings,
    steps: context.records,
    usage: { ...usage, source: usageSeen ? 'model_call' : 'unavailable' },
    generated_at: generatedAt,
  };
}

export function createContentPipeline(deps = {}) {
  const config = normalizeDeps(deps);
  return {
    run: (input, hooks = {}) => runContentPipeline(input, config, hooks),
  };
}
