/** Small, dependency-free normalization helpers shared by the context pack. */

export function isRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map)
  );
}

/** First non-empty string, accepting finite numbers as their decimal form. */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Accepts the shapes a service adapter can reasonably pass: an array, a Map,
 * an iterable, or an id-keyed object. Entries of an id-keyed object inherit
 * the key as `id` when they do not carry one.
 */
export function toList(value, label) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    return [...value];
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => {
      if (!isRecord(entry)) return entry;
      return { ...entry, id: firstString(entry.id, entry.task_id, entry.taskId) ?? key };
    });
  }
  throw new TypeError(`\`${label}\` must be an array, Map, iterable, or id-keyed object`);
}

export function toStringList(value) {
  return toArray(value)
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim() === '' ? null : entry.trim();
      if (isRecord(entry)) {
        return firstString(
          entry.text,
          entry.label,
          entry.summary,
          entry.value,
          entry.name,
        );
      }
      return null;
    })
    .filter((entry) => entry !== null);
}

/** Deduplicate strings while preserving first-seen order. */
export function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-copy JSON-shaped data. Functions, symbols and bigint are dropped rather
 * than leaking non-serializable values into a prompt. Dates become ISO strings.
 */
export function cloneValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const cloned = cloneValue(entry);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  return value;
}
