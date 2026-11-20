/**
 * Error raised when a task pack cannot be built, validated or routed.
 *
 * `code` is the machine-readable failure (`invalid_pack`, `unknown_field`,
 * `unsupported_schema_version`, `budget_exceeded`, `executor_unavailable`),
 * `path` is the field path (`goal`, `workspace.path`, `context_refs[1]`, `$`
 * for the whole value) and `errors` keeps every failure found in one pass.
 */
export class TaskPackError extends TypeError {
  constructor(code, path, message, errors = []) {
    super(`${code} at ${path || '$'}: ${message}`);
    this.name = 'TaskPackError';
    this.code = code;
    this.path = path || '$';
    this.errors = errors;
  }
}

/** Build a `TaskPackError` from the first entry of a validation error list. */
export function taskPackErrorFrom(errors) {
  const first = errors[0];
  if (!first) {
    return new TaskPackError('invalid_pack', '$', 'task pack is invalid');
  }
  return new TaskPackError(first.code, first.path, first.message, errors);
}
