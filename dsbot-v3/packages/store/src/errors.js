/**
 * Store-level errors.
 *
 * Codes mirror docs/prd/02-api-contract.md §1 so a later service layer can map
 * them to HTTP status codes without re-parsing SQLite messages:
 *   hierarchy_violation / hierarchy_immutable / missing_acceptance /
 *   invalid_state_transition / conflict / foreign_key_violation /
 *   constraint_violation / validation_error / not_found /
 *   schema_version_unsupported
 */
export class StoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'StoreError';
    this.code = code;
    if (options.sqliteCode !== undefined) this.sqliteCode = options.sqliteCode;
    if (options.details !== undefined) this.details = options.details;
  }
}

const SQLITE_MESSAGE_CODES = [
  [/invalid task hierarchy/, 'hierarchy_violation'],
  [/task level and parent are immutable/, 'hierarchy_immutable'],
  [/cannot complete: no passed acceptance at this level/, 'missing_acceptance'],
  [/UNIQUE constraint failed/, 'conflict'],
  [/FOREIGN KEY constraint failed/, 'foreign_key_violation'],
  [/NOT NULL constraint failed/, 'constraint_violation'],
  [/CHECK constraint failed/, 'constraint_violation'],
];

/** Wrap a raw sqlite/native error into a StoreError with a stable code. */
export function toStoreError(error) {
  if (error instanceof StoreError) return error;
  const message = error?.message ?? String(error);
  for (const [pattern, code] of SQLITE_MESSAGE_CODES) {
    if (pattern.test(message)) {
      return new StoreError(code, message, {
        cause: error,
        sqliteCode: error?.code,
      });
    }
  }
  return new StoreError('sqlite_error', message, {
    cause: error,
    sqliteCode: error?.code,
  });
}
