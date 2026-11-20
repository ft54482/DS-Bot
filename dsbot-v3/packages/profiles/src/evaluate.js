import { ITEM_CLASS, RESULT, RESULT_RANK } from './constants.js';
import { assertProfile, selfMediaProfileV1 } from './profile.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_HASH = /^[a-f0-9]{64}$/i;
const QUALITY_DIMENSIONS = Object.freeze(['structure', 'readability', 'style']);

function makeItem(id, itemClass, result, detail) {
  return { id, class: itemClass, result, detail };
}

function raise(worst, result) {
  return RESULT_RANK[result] > RESULT_RANK[worst] ? result : worst;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function resolveNow(value) {
  const time = value === undefined ? Date.now() : parseTime(value);
  if (time === null) throw new TypeError('options.now must be a Date, epoch milliseconds or a parsable timestamp');
  return time;
}

function iso(time) {
  return time === null ? 'unknown' : new Date(time).toISOString();
}

/** Independent source identity is the host, so two URLs on one site are one source. */
function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function readSources(fact) {
  const sources = Array.isArray(fact?.sources) ? fact.sources : [];
  return sources.map((source, index) => {
    const snapshot = source?.snapshot;
    const host = hostOf(normalizeText(source?.url));
    const snapshotOk =
      isPlainObject(snapshot) &&
      SNAPSHOT_HASH.test(normalizeText(snapshot.sha256)) &&
      parseTime(snapshot.captured_at) !== null &&
      normalizeText(snapshot.excerpt) !== '';
    const sourceTime =
      parseTime(source?.published_at) ?? parseTime(source?.updated_at) ?? parseTime(source?.fetched_at);
    return {
      index,
      host,
      snapshotOk,
      sourceTime,
      url: normalizeText(source?.url),
    };
  });
}

function keyFactsOf(pack) {
  const facts = Array.isArray(pack?.facts) ? pack.facts : [];
  return facts.filter((fact) => isPlainObject(fact) && fact.key === true);
}

function factLabel(fact, index) {
  return normalizeText(fact?.id) || `key#${index + 1}`;
}

function checkSchema(pack) {
  const issues = [];
  if (!isPlainObject(pack)) return { ok: false, issues: ['pack must be an object'] };
  if (pack.schema_version !== undefined && pack.schema_version !== 1) {
    issues.push('schema_version must be 1');
  }
  if (!isPlainObject(pack.article)) {
    issues.push('article object required');
  } else if (normalizeText(pack.article.body) === '') {
    issues.push('article.body must be a non-empty string');
  }
  if (pack.facts !== undefined && !Array.isArray(pack.facts)) issues.push('facts must be an array');
  for (const field of ['quality', 'layout', 'citations', 'compliance']) {
    if (pack[field] !== undefined && !isPlainObject(pack[field])) issues.push(`${field} must be an object`);
  }
  return { ok: issues.length === 0, issues };
}

function evaluateSchema(pack) {
  const schema = checkSchema(pack);
  if (schema.ok) {
    return makeItem(
      'auto.pack_schema',
      ITEM_CLASS.auto,
      RESULT.pass,
      'article pack schema v1: article.body present; facts/quality/layout/citations/compliance have no structural type errors',
    );
  }
  return makeItem(
    'auto.pack_schema',
    ITEM_CLASS.auto,
    RESULT.blocked,
    `article pack cannot be evaluated: ${schema.issues.join('; ')}`,
  );
}

/**
 * Facts: every key fact needs at least two independent hosts *and* a complete
 * snapshot per source (URL + captured_at + sha256 + excerpt), matching
 * docs/prd/14-business-model.md §2.1 and its source-failure grading table.
 */
function evaluateFacts(pack, profile) {
  const keyFacts = keyFactsOf(pack);
  if (keyFacts.length === 0) {
    return makeItem(
      'independent.facts',
      ITEM_CLASS.independent,
      RESULT.needsRework,
      'no key facts declared; mark every load-bearing claim with key=true and attach its sources',
    );
  }

  let worst = RESULT.pass;
  const lines = [];

  keyFacts.forEach((fact, index) => {
    const label = factLabel(fact, index);
    if (fact.contradiction === true || fact.sources_contradict === true) {
      worst = raise(worst, RESULT.blocked);
      lines.push(`${label}: sources contradict each other -> blocked`);
      return;
    }

    const sources = readSources(fact);
    const valid = sources.filter((source) => source.host !== null);
    const hosts = new Set(valid.map((source) => source.host));

    if (sources.length === 0 || valid.length === 0) {
      worst = raise(worst, RESULT.blocked);
      lines.push(`${label}: no reachable http(s) source -> blocked`);
      return;
    }

    const badSnapshots = valid.filter((source) => !source.snapshotOk);
    if (profile.facts.requireSnapshot && badSnapshots.length > 0) {
      worst = raise(worst, RESULT.blocked);
      const detail = badSnapshots
        .map((source) => `${source.host} (URL+captured_at+sha256+excerpt required)`)
        .join(', ');
      lines.push(`${label}: snapshot unavailable for ${detail} -> blocked`);
      return;
    }

    if (hosts.size < profile.facts.minIndependentSources) {
      worst = raise(worst, RESULT.needsRework);
      lines.push(
        `${label}: ${hosts.size} independent source(s) [${[...hosts].join(', ')}], ` +
          `need >=${profile.facts.minIndependentSources} distinct hosts -> needs_rework`,
      );
      return;
    }

    lines.push(`${label}: ${hosts.size} independent sources [${[...hosts].join(', ')}], snapshots complete`);
  });

  const nonKeyCount = (Array.isArray(pack?.facts) ? pack.facts : []).filter(
    (fact) => isPlainObject(fact) && fact.key !== true,
  ).length;
  if (nonKeyCount > 0) lines.push(`non-key facts: ${nonKeyCount} (not gated)`);

  return makeItem('independent.facts', ITEM_CLASS.independent, worst, lines.join('; '));
}

/**
 * Freshness: every key fact needs source time; the freshest source older than
 * `maxSourceAgeDays` expires. By default stale evidence blocks acceptance; a
 * profile may instead ask for a replacement source (`needs_rework`).
 */
function evaluateFreshness(pack, profile, now) {
  const keyFacts = keyFactsOf(pack);
  if (keyFacts.length === 0) {
    return makeItem(
      'independent.freshness',
      ITEM_CLASS.independent,
      RESULT.needsRework,
      'no key facts declared; source freshness cannot be checked',
    );
  }

  let worst = RESULT.pass;
  const lines = [];

  keyFacts.forEach((fact, index) => {
    const label = factLabel(fact, index);
    const sources = readSources(fact).filter((source) => source.host !== null);
    const times = sources.map((source) => source.sourceTime).filter((time) => time !== null);

    if (times.length === 0) {
      worst = raise(worst, RESULT.needsRework);
      lines.push(`${label}: no source timestamp -> add published_at/fetched_at or replace the source`);
      return;
    }

    const newest = Math.max(...times);
    const ageDays = (now - newest) / DAY_MS;

    if (ageDays < -1) {
      worst = raise(worst, RESULT.needsRework);
      lines.push(`${label}: newest source timestamp ${iso(newest)} is in the future -> needs_rework`);
      return;
    }
    if (fact.time_sensitive === false) {
      lines.push(`${label}: source dated ${iso(newest)}, explicitly not time-sensitive (expiry not enforced)`);
      return;
    }
    if (ageDays > profile.freshness.maxSourceAgeDays) {
      const expired = profile.freshness.expiredResult;
      worst = raise(worst, expired);
      lines.push(
        `${label}: newest source is ${ageDays.toFixed(1)} days old ` +
          `(> ${profile.freshness.maxSourceAgeDays}) -> ${expired}`,
      );
      return;
    }
    lines.push(`${label}: source dated ${iso(newest)}, age ${ageDays.toFixed(1)} days`);
  });

  return makeItem('independent.freshness', ITEM_CLASS.independent, worst, lines.join('; '));
}

/**
 * The rubric must come from an independent review context. Author self-scores
 * are not acceptance evidence (docs/prd/03-acceptance-spec.md §4.2).
 */
function evaluateReviewer(pack) {
  const reviewer = pack?.quality?.reviewer;
  if (!isPlainObject(reviewer)) {
    return makeItem(
      'independent.quality.reviewer',
      ITEM_CLASS.independent,
      RESULT.needsRework,
      'independent reviewer record missing; attach reviewer.context_id with independent=true',
    );
  }
  const label = normalizeText(reviewer.id) || normalizeText(reviewer.context_id) || 'unnamed reviewer';
  if (reviewer.independent !== true) {
    return makeItem(
      'independent.quality.reviewer',
      ITEM_CLASS.independent,
      RESULT.blocked,
      `reviewer ${label} is not independent from the author; self-review scores are not acceptance evidence`,
    );
  }
  const contextId = normalizeText(reviewer.context_id);
  if (contextId === '') {
    return makeItem(
      'independent.quality.reviewer',
      ITEM_CLASS.independent,
      RESULT.needsRework,
      `reviewer ${label} has no context_id; the blind review context cannot be verified`,
    );
  }
  const authorContext = normalizeText(pack?.article?.author?.context_id);
  if (authorContext !== '' && contextId === authorContext) {
    return makeItem(
      'independent.quality.reviewer',
      ITEM_CLASS.independent,
      RESULT.blocked,
      `reviewer ${label} ran in the author's context ${contextId}; self-review scores are not acceptance evidence`,
    );
  }
  return makeItem(
    'independent.quality.reviewer',
    ITEM_CLASS.independent,
    RESULT.pass,
    `independent reviewer ${label} (context ${contextId})`,
  );
}

function evaluateQualityDimension(pack, dimension, profile) {
  const id = `independent.quality.${dimension}`;
  const entry = pack?.quality?.rubric?.[dimension];
  const score = typeof entry === 'number' ? entry : entry?.score;
  const threshold = profile.quality.thresholds[dimension];

  if (!Number.isFinite(score)) {
    return makeItem(id, ITEM_CLASS.independent, RESULT.needsRework, `missing ${dimension} score; rubric is incomplete`);
  }

  const { min, max } = profile.quality.scale;
  if (score < min || score > max) {
    return makeItem(
      id,
      ITEM_CLASS.independent,
      RESULT.needsRework,
      `${dimension} score ${score} is outside the profile scale [${min}, ${max}]`,
    );
  }

  const issues = Array.isArray(entry?.issues)
    ? entry.issues.filter((issue) => typeof issue === 'string' && issue.trim() !== '')
    : [];

  if (score < threshold) {
    const suffix = issues.length > 0 ? `: ${issues.join('; ')}` : ' (no issue detail supplied)';
    return makeItem(
      id,
      ITEM_CLASS.independent,
      RESULT.needsRework,
      `${dimension} score ${score} < threshold ${threshold}${suffix}`,
    );
  }

  return makeItem(
    id,
    ITEM_CLASS.independent,
    RESULT.pass,
    `${dimension} score ${score} >= threshold ${threshold}` + (issues.length > 0 ? `; notes: ${issues.join('; ')}` : ''),
  );
}

function uniqueCandidates(value) {
  if (!Array.isArray(value)) return { unique: [], duplicates: 0, invalid: 0 };
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  let invalid = 0;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      invalid += 1;
      continue;
    }
    const candidate = entry.trim();
    if (seen.has(candidate)) {
      duplicates += 1;
      continue;
    }
    seen.add(candidate);
    unique.push(candidate);
  }
  return { unique, duplicates, invalid };
}

function evaluateTitleCandidates(pack, profile) {
  const { unique, duplicates, invalid } = uniqueCandidates(pack?.layout?.titles);
  const required = profile.layout.minTitleCandidates;
  const notes = [];
  if (duplicates > 0) notes.push(`${duplicates} duplicate(s) ignored`);
  if (invalid > 0) notes.push(`${invalid} empty/non-string entr${invalid === 1 ? 'y' : 'ies'} ignored`);
  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  if (unique.length < required) {
    return makeItem(
      'auto.layout.titles',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      `${unique.length} unique title candidate(s), need >=${required}${suffix}`,
    );
  }
  return makeItem(
    'auto.layout.titles',
    ITEM_CLASS.auto,
    RESULT.pass,
    `${unique.length} unique title candidates (>=${required})${suffix}`,
  );
}

function evaluateTags(pack, profile) {
  const { unique, duplicates, invalid } = uniqueCandidates(pack?.layout?.tags);
  const required = profile.layout.minTags;
  const notes = [];
  if (duplicates > 0) notes.push(`${duplicates} duplicate(s) ignored`);
  if (invalid > 0) notes.push(`${invalid} empty/non-string entr${invalid === 1 ? 'y' : 'ies'} ignored`);
  const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  if (unique.length < required) {
    return makeItem(
      'auto.layout.tags',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      `${unique.length} tag(s), need >=${required}${suffix}`,
    );
  }
  return makeItem(
    'auto.layout.tags',
    ITEM_CLASS.auto,
    RESULT.pass,
    `${unique.length} tags (>=${required})${suffix}`,
  );
}

function evaluateQuoteRatio(pack, profile) {
  const citations = pack?.citations;
  if (!isPlainObject(citations)) {
    return makeItem(
      'auto.compliance.quote_ratio',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      'quotation data missing; provide citations.total_chars and citations.quoted_chars',
    );
  }
  const total = citations.total_chars;
  const quoted = citations.quoted_chars;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(quoted) || quoted < 0 || quoted > total) {
    return makeItem(
      'auto.compliance.quote_ratio',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      `invalid quotation data: total_chars=${String(total)}, quoted_chars=${String(quoted)}`,
    );
  }
  const ratio = quoted / total;
  const percent = (ratio * 100).toFixed(1);
  if (ratio > profile.compliance.hardQuoteRatio) {
    return makeItem(
      'auto.compliance.quote_ratio',
      ITEM_CLASS.auto,
      RESULT.blocked,
      `quotation ratio ${percent}% exceeds the hard limit ` +
        `${(profile.compliance.hardQuoteRatio * 100).toFixed(1)}%; suspected copying -> blocked`,
    );
  }
  if (ratio > profile.compliance.maxQuoteRatio) {
    return makeItem(
      'auto.compliance.quote_ratio',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      `quotation ratio ${percent}% exceeds ${(profile.compliance.maxQuoteRatio * 100).toFixed(1)}%; ` +
        'rewrite in original wording or cut quoted text',
    );
  }
  return makeItem(
    'auto.compliance.quote_ratio',
    ITEM_CLASS.auto,
    RESULT.pass,
    `quotation ratio ${percent}% <= ${(profile.compliance.maxQuoteRatio * 100).toFixed(1)}%`,
  );
}

function evaluateRiskList(pack) {
  const risks = pack?.compliance?.risks;
  if (!Array.isArray(risks)) {
    return makeItem(
      'auto.compliance.risk_list',
      ITEM_CLASS.auto,
      RESULT.needsRework,
      'compliance risk list missing; provide compliance.risks (an empty array is a valid "no known risk")',
    );
  }

  let worst = RESULT.pass;
  const lines = [];
  risks.forEach((risk, index) => {
    const label = normalizeText(risk?.id) || `risk#${index + 1}`;
    if (!isPlainObject(risk)) {
      worst = raise(worst, RESULT.needsRework);
      lines.push(`${label}: invalid risk entry -> needs_rework`);
      return;
    }
    const severity = normalizeText(risk.severity).toLowerCase();
    const resolved = risk.resolved === true || normalizeText(risk.state).toLowerCase() === 'resolved';
    const detail = normalizeText(risk.detail);
    if (!['blocker', 'major', 'minor'].includes(severity)) {
      worst = raise(worst, RESULT.needsRework);
      lines.push(`${label}: unknown severity "${String(risk.severity)}" -> needs_rework`);
      return;
    }
    if (resolved) {
      lines.push(`${label}: ${severity} (resolved)`);
      return;
    }
    if (severity === 'blocker') {
      worst = raise(worst, RESULT.blocked);
      lines.push(`${label}: unresolved blocker${detail ? ` (${detail})` : ''} -> blocked`);
      return;
    }
    if (severity === 'major') {
      worst = raise(worst, RESULT.needsRework);
      lines.push(`${label}: unresolved major${detail ? ` (${detail})` : ''} -> needs_rework`);
      return;
    }
    lines.push(`${label}: unresolved minor${detail ? ` (${detail})` : ''}`);
  });

  if (risks.length === 0) lines.push('no known compliance risks declared');
  return makeItem('auto.compliance.risk_list', ITEM_CLASS.auto, worst, lines.join('; '));
}

/**
 * Evaluate a self-media article pack against a pinned acceptance profile.
 *
 * @param {object} pack article pack (see packages/profiles/README.md)
 * @param {object} [profile] pinned profile; defaults to `selfMediaProfileV1`
 * @param {{now?: number|string|Date}} [options] evaluation clock (tests should pin it)
 * @returns {{result: 'pass'|'needs_rework'|'blocked', items: Array<{id:string,class:'auto'|'independent',result:string,detail:string}>}}
 *
 * The returned result is an *acceptance* result only. It never expresses or
 * grants publishability; see `evaluatePublish` in ./publish.js.
 */
export function evaluateArticlePack(pack, profile = selfMediaProfileV1, options = {}) {
  assertProfile(profile);
  const now = resolveNow(options?.now);

  const items = [
    evaluateSchema(pack),
    evaluateFacts(pack, profile),
    evaluateFreshness(pack, profile, now),
    evaluateReviewer(pack),
    ...QUALITY_DIMENSIONS.map((dimension) => evaluateQualityDimension(pack, dimension, profile)),
    evaluateTitleCandidates(pack, profile),
    evaluateTags(pack, profile),
    evaluateQuoteRatio(pack, profile),
    evaluateRiskList(pack),
  ];

  let result = RESULT.pass;
  for (const item of items) result = raise(result, item.result);

  return { result, items };
}
