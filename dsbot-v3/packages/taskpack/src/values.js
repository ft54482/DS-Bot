/**
 * Small pure value helpers. Values are only read, never mutated.
 */

/** True for object literals (including null-prototype objects), not arrays. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Deep copy for arrays and plain objects; primitives are returned as-is. */
export function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneValue(entry);
    }
    return copy;
  }
  return value;
}
