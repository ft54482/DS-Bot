/** Small, dependency-free normalisation helpers shared by the recovery plan. */

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First non-empty string (or finite number rendered as a string). */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** First finite number. */
export function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Parse epoch milliseconds, an ISO-8601 string or a Date. */
export function parseTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const at = value.getTime();
    return Number.isFinite(at) ? at : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

/** First parseable timestamp. */
export function firstTime(...values) {
  for (const value of values) {
    const at = parseTime(value);
    if (at !== null) return at;
  }
  return null;
}

/** ISO-8601 for a timestamp, or null. */
export function toIso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/** Validate an optional list and return it with a helpful error label. */
export function toList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`runtime.${label} must be an array`);
  }
  return value;
}

/** Lower-case a string observation for state comparisons. */
export function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}
