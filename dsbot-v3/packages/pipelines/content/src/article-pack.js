/**
 * Article pack shape for the self-media content chain.
 *
 * The delivered pack is the contract between the content executor (S3) and the
 * self-media acceptance profile (S4):
 *
 * {
 *   title_candidates: string[],
 *   body: string,
 *   sources: [{ url, fetched_at, sha256, excerpt }],
 *   facts: [{ claim, source_refs: string[] }],
 *   review: { score, issues: [{ code, message, severity }] },
 *   layout: { ... }
 * }
 *
 * `status`, `needs_rework`, `warnings` and `generated_at` are additive fields
 * used by the chain; the required shape stays exactly the one above.
 */

import { createHash } from 'node:crypto';

export const PACK_VERSION = 1;

export const PACK_REQUIRED_KEYS = Object.freeze([
  'title_candidates',
  'body',
  'sources',
  'facts',
  'review',
  'layout',
]);

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Collapse whitespace and bound an excerpt so a source entry stays reviewable. */
export function excerptOf(text, max = 280) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFetchedAt(value) {
  return isNonEmptyString(value) || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Structural check of a finished article pack. Returns every issue instead of
 * throwing so the adapter and tests can report an honest failure.
 */
export function validateArticlePack(pack) {
  const issues = [];
  if (!isPlainObject(pack)) return { ok: false, issues: ['pack'] };

  for (const key of PACK_REQUIRED_KEYS) {
    if (!(key in pack)) issues.push(`missing:${key}`);
  }

  if ('status' in pack && typeof pack.status !== 'string') issues.push('status');
  if ('needs_rework' in pack && typeof pack.needs_rework !== 'boolean') issues.push('needs_rework');
  if ('generated_at' in pack && !isFetchedAt(pack.generated_at)) issues.push('generated_at');

  if (!Array.isArray(pack.title_candidates)) {
    issues.push('title_candidates');
  } else if (pack.title_candidates.some((title) => !isNonEmptyString(title))) {
    issues.push('title_candidates[]');
  }

  if (typeof pack.body !== 'string') issues.push('body');

  if (!Array.isArray(pack.sources)) {
    issues.push('sources');
  } else {
    for (const [index, source] of pack.sources.entries()) {
      if (!isPlainObject(source)) {
        issues.push(`sources[${index}]`);
        continue;
      }
      if (!isNonEmptyString(source.url)) issues.push(`sources[${index}].url`);
      if (!isFetchedAt(source.fetched_at)) issues.push(`sources[${index}].fetched_at`);
      if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
        issues.push(`sources[${index}].sha256`);
      }
      if (typeof source.excerpt !== 'string') issues.push(`sources[${index}].excerpt`);
    }
  }

  if (!Array.isArray(pack.facts)) {
    issues.push('facts');
  } else {
    for (const [index, fact] of pack.facts.entries()) {
      if (!isPlainObject(fact)) {
        issues.push(`facts[${index}]`);
        continue;
      }
      if (!isNonEmptyString(fact.claim)) issues.push(`facts[${index}].claim`);
      if (!Array.isArray(fact.source_refs) || fact.source_refs.some((ref) => !isNonEmptyString(ref))) {
        issues.push(`facts[${index}].source_refs`);
      }
    }
  }

  if (!isPlainObject(pack.review)) {
    issues.push('review');
  } else {
    if (typeof pack.review.score !== 'number' || !Number.isFinite(pack.review.score)) {
      issues.push('review.score');
    } else if (pack.review.score < 0 || pack.review.score > 100) {
      issues.push('review.score_range');
    }
    if (!Array.isArray(pack.review.issues)) issues.push('review.issues');
    if ('needs_rework' in pack.review && typeof pack.review.needs_rework !== 'boolean') {
      issues.push('review.needs_rework');
    }
  }

  if (!isPlainObject(pack.layout)) issues.push('layout');

  return { ok: issues.length === 0, issues };
}
