/**
 * Small value helpers shared by the gates. Everything here is pure: values are
 * only read, never mutated.
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

/**
 * Conservative "child is contained by parent" check used for dimension values
 * whose exact semantics are not fixed by the PRD (extra scope keys and
 * `rule.match`):
 *
 * - arrays: every child element must be covered by some parent element;
 * - objects: every child key must exist in the parent and be contained;
 * - numbers: a smaller number is narrower;
 * - booleans: `false` is narrower than `true`;
 * - everything else: equality.
 */
export function isSubsetValue(parent, child) {
  if (Object.is(parent, child)) return true;

  if (Array.isArray(parent) && Array.isArray(child)) {
    return child.every((childItem) =>
      parent.some((parentItem) => isSubsetValue(parentItem, childItem)),
    );
  }

  if (isPlainObject(parent) && isPlainObject(child)) {
    return Object.keys(child).every(
      (key) => hasOwn(parent, key) && isSubsetValue(parent[key], child[key]),
    );
  }

  if (typeof parent === 'number' && typeof child === 'number') {
    return child <= parent;
  }

  if (typeof parent === 'boolean' && typeof child === 'boolean') {
    return parent || !child;
  }

  return false;
}

/** Deep copy for arrays and plain objects; primitives are returned as-is. */
export function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
    return copy;
  }
  return value;
}
