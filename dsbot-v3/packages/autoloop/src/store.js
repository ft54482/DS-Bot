/**
 * Snapshot storage.
 *
 * The driver only needs `load()` and `save(snapshot)`. A store may persist the
 * snapshot as JSON, in SQLite or in memory; it must return the last saved value
 * unchanged and it must survive a process restart for `resume()` to mean
 * anything. `createMemoryStore` is the test/demo implementation.
 */

/**
 * @typedef {object} LoopStore
 * @property {() => object | string | null | Promise<object | string | null>} load
 * @property {(snapshot: object) => void | Promise<void>} save
 */

/**
 * Deep copy a snapshot so a caller cannot mutate driver state through the
 * object it passed in or received back.
 */
export function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * In-memory store used by tests and the README example.
 *
 * The returned `load()` value is a copy: mutating the driver snapshot does not
 * silently change what a restart would see.
 *
 * @param {object|null} [initial]
 */
export function createMemoryStore(initial = null) {
  let value = initial === null ? null : clone(initial);

  return {
    load() {
      return value === null ? null : clone(value);
    },
    save(snapshot) {
      value = clone(snapshot);
    },
    /** Inspect what is actually stored (tests/diagnostics only). */
    peek() {
      return value === null ? null : clone(value);
    },
  };
}
