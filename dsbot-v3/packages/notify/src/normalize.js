/**
 * Small, dependency-free input helpers. The notifier receives ledger-shaped
 * objects from several call sites, so it accepts the snake_case fields used by
 * `@dsbot/monitor` and the camelCase variants used by JS callers.
 */

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Epoch milliseconds from a number, Date or ISO-8601 string. */
export function parseTime(value) {
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    ms = Date.parse(value);
  } else {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
}

/** Resolve the injected clock into a function returning epoch milliseconds. */
export function resolveClock(now) {
  if (now === undefined || now === null) return () => Date.now();
  if (typeof now === 'function') {
    return () => {
      const at = parseTime(now());
      if (at === null) {
        throw new TypeError('notifier `now` must return a valid epoch time');
      }
      return at;
    };
  }
  const fixed = parseTime(now);
  if (fixed === null) {
    throw new TypeError('notifier `now` must be a function, number, Date or ISO-8601 string');
  }
  return () => fixed;
}

export function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/** Normalize the task summary embedded in every notification template. */
export function normalizeTask(value, label = 'task') {
  const task = requireRecord(value, label);
  const id = firstString(task.id, task.task_id, task.taskId);
  if (id === null) {
    throw new TypeError(`${label}.id is required`);
  }
  return {
    id,
    level:
      firstString(task.level, task.task_level, task.taskLevel) ??
      firstFinite(task.level, task.task_level, task.taskLevel),
    state: firstString(task.state, task.status),
    owner: firstString(
      task.owner,
      task.owner_ref,
      task.ownerRef,
      task.owner_id,
      task.ownerId,
    ),
  };
}

export function taskIdOf(value, label = 'task') {
  const task = requireRecord(value, label);
  const id = firstString(task.id, task.task_id, task.taskId);
  if (id === null) {
    throw new TypeError(`${label}.id is required`);
  }
  return id;
}

/** Normalize the run summary. A run id is required for a stable dedupe key. */
export function normalizeRun(value, label = 'run') {
  const run = requireRecord(value, label);
  const task = isRecord(run.task) ? run.task : null;
  const id = firstString(run.id, run.run_id, run.runId);
  if (id === null) {
    throw new TypeError(`${label}.id is required`);
  }
  return {
    id,
    task_id: firstString(
      run.task_id,
      run.taskId,
      task === null ? null : firstString(task.id, task.task_id, task.taskId),
    ),
    state: firstString(run.state, run.status),
    attempt: firstFinite(run.attempt),
    run_no: firstFinite(run.run_no, run.runNo),
  };
}

/**
 * Turn the caller's reason (string, Error, or `{message}` object) into the
 * string carried by the template. Missing input uses the event-specific
 * fallback instead of emitting an empty reason.
 */
export function normalizeReason(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (value instanceof Error) {
    const message = value.message?.trim();
    return message ? message : fallback;
  }
  if (isRecord(value)) {
    const message = firstString(value.message, value.reason, value.code, value.detail);
    if (message !== null) return message;
    return fallback;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

/**
 * Escalation levels are normally 1 and 2. A non-empty string label is also
 * accepted (deployments may name levels); numeric strings become numbers so
 * output stays stable across callers.
 */
export function normalizeLevel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new TypeError('escalation level must be a finite number or a non-empty string');
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }
  throw new TypeError('escalation level must be a finite number or a non-empty string');
}
