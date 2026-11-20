import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation (the same rule as
 * packages/service/src/canonical.js): keys sorted at every depth, undefined
 * values dropped, so structurally equal values always hash the same.
 */
export function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashValue(value) {
  return sha256Hex(canonicalize(value));
}

/**
 * Fingerprint of the content a publish authorization would bind to
 * (docs/prd/01-data-model.sql `publish_authorization.content_fingerprint`,
 * docs/prd/15-status-matrix.md T-07: any content change invalidates the
 * authorization).
 *
 * Only publishable content is included: the chosen title, body, key-fact
 * statements, tags and cover copy. Title *candidates* are intentionally
 * excluded, because a candidate that is not published cannot invalidate a
 * license for the chosen title. Changing any included field changes the
 * fingerprint, and a previously granted authorization stops matching.
 */
export function contentFingerprint(pack) {
  const article = pack?.article;
  const facts = Array.isArray(pack?.facts) ? pack.facts : [];
  return `sha256:${hashValue({
    schema_version: pack?.schema_version ?? 1,
    article: {
      title: typeof article?.title === 'string' ? article.title : null,
      body: typeof article?.body === 'string' ? article.body : null,
    },
    facts: facts.map((fact) => ({
      id: typeof fact?.id === 'string' ? fact.id : null,
      statement: typeof fact?.statement === 'string' ? fact.statement : null,
    })),
    layout: {
      tags: Array.isArray(pack?.layout?.tags) ? pack.layout.tags : [],
      cover_copy: typeof pack?.layout?.cover_copy === 'string' ? pack.layout.cover_copy : null,
    },
  })}`;
}
