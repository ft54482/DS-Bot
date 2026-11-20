/** Small, dependency-free normalization helpers for the metrics projection. */

export function isRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map)
  );
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function parseTime(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function firstTime(...values) {
  for (const value of values) {
    const parsed = parseTime(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function round(value, digits = 6) {
  return Number.parseFloat(Number(value).toFixed(digits));
}

/**
 * Accepts the shapes a read-only repository adapter can reasonably hand over:
 * an array, a Map, an iterable, or an id-keyed object. Entries of an id-keyed
 * object inherit the key as `id` when they do not carry one.
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
      return {
        ...entry,
        id: firstString(entry.id, entry.run_id, entry.runId) ?? key,
      };
    });
  }
  throw new TypeError(`${label} must be an array, Map, or id-keyed object`);
}
