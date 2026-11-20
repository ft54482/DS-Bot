/**
 * Output projections and human-readable formatting.
 *
 * JSON output is intentionally projected instead of echoing runtime objects:
 * internal fields stay private and assertions can rely on a fixed key set.
 */

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function pickFirst(record, keys, fallback = null) {
  if (!record) return fallback;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return fallback;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Deterministic JSON: object keys are sorted at every depth. */
export function stableStringify(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      const output = {};
      for (const key of Object.keys(input).sort()) output[key] = sort(input[key]);
      return output;
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

export function toTaskView(task) {
  const source = asRecord(task);
  if (!source) return null;
  return {
    id: source.id ?? null,
    level: source.level ?? null,
    state: source.state ?? null,
    title: source.title ?? null,
    parent_task_id: pickFirst(source, ['parentTaskId', 'parent_task_id']),
    current_run_id: pickFirst(source, ['currentRunId', 'current_run_id']),
    blocked_reason: pickFirst(source, ['blockedReason', 'blocked_reason']),
    stop_state: pickFirst(source, ['stopState', 'stop_state']),
    stop_unknown: Boolean(pickFirst(source, ['stopUnknown', 'stop_unknown'], false)),
    created_at: pickFirst(source, ['createdAt', 'created_at']),
    updated_at: pickFirst(source, ['updatedAt', 'updated_at']),
  };
}

export function toRunView(run) {
  const source = asRecord(run);
  if (!source) return null;
  return {
    id: source.id ?? null,
    task_id: pickFirst(source, ['taskId', 'task_id']),
    state: source.state ?? null,
    executor_kind: pickFirst(source, ['executorKind', 'executor_kind']),
    attempt_no: pickFirst(source, ['attemptNo', 'attempt_no', 'attempt']),
    created_at: pickFirst(source, ['createdAt', 'created_at']),
  };
}

export function toAcceptanceView(acceptance) {
  const source = asRecord(acceptance);
  if (!source) return null;
  return {
    id: source.id ?? null,
    task_id: pickFirst(source, ['taskId', 'task_id']),
    run_id: pickFirst(source, ['runId', 'run_id']),
    state: source.state ?? null,
    stage: source.stage ?? null,
    round_no: pickFirst(source, ['roundNo', 'round_no']),
    decided_at: pickFirst(source, ['decidedAt', 'decided_at']),
  };
}

export function toCostEntryView(entry) {
  const source = asRecord(entry);
  if (!source) return null;
  return {
    kind: source.kind ?? null,
    run_id: pickFirst(source, ['runId', 'run_id']),
    tokens_in: numberOrNull(pickFirst(source, ['tokensIn', 'tokens_in'])),
    tokens_out: numberOrNull(pickFirst(source, ['tokensOut', 'tokens_out'])),
    tokens_cached: numberOrNull(pickFirst(source, ['tokensCached', 'tokens_cached'])),
    cost_cny: numberOrNull(pickFirst(source, ['costCny', 'cost_cny'])),
    created_at: pickFirst(source, ['createdAt', 'created_at']),
  };
}

export function toCostView(result, fallbackTaskId) {
  const source = asRecord(result);
  if (!source) {
    return {
      task_id: fallbackTaskId ?? null,
      tokens_in: null,
      tokens_out: null,
      tokens_cached: null,
      cost_cny: null,
      entry_count: 0,
      entries: [],
    };
  }
  const totals = asRecord(source.total) ?? asRecord(source.totals) ?? source;
  const entriesField = source.entries;
  const rawEntries = Array.isArray(entriesField)
    ? entriesField
    : Array.isArray(source.items)
      ? source.items
      : Array.isArray(source.rows)
        ? source.rows
        : [];
  const entryCount =
    numberOrNull(pickFirst(source, ['entryCount', 'entry_count'])) ??
    (typeof entriesField === 'number' ? entriesField : rawEntries.length);
  return {
    task_id: pickFirst(source, ['taskId', 'task_id'], fallbackTaskId ?? null),
    tokens_in: numberOrNull(pickFirst(totals, ['tokensIn', 'tokens_in'])),
    tokens_out: numberOrNull(pickFirst(totals, ['tokensOut', 'tokens_out'])),
    tokens_cached: numberOrNull(pickFirst(totals, ['tokensCached', 'tokens_cached'])),
    cost_cny: numberOrNull(pickFirst(totals, ['costCny', 'cost_cny'])),
    entry_count: entryCount,
    entries: rawEntries.map(toCostEntryView).filter(Boolean),
  };
}

function formatTitle(title) {
  return JSON.stringify(title ?? null);
}

function show(value) {
  return value === null || value === undefined ? '-' : String(value);
}

/** Human-readable output; JSON mode bypasses this formatter entirely. */
export function formatHuman(command, data) {
  if (command === 'task.create') {
    const task = data.task;
    return `created task ${show(task.id)} level=${show(task.level)} state=${show(task.state)} title=${formatTitle(task.title)}\n`;
  }
  if (command === 'task.list') {
    if (data.count === 0) return 'no tasks\n';
    return (
      data.tasks
        .map(
          (task) =>
            `${show(task.id)}  ${show(task.level)}  ${show(task.state)}  ${formatTitle(task.title)}`,
        )
        .join('\n') + '\n'
    );
  }
  if (command === 'task.get') {
    const task = data.task;
    const lines = [
      `task ${show(task.id)} level=${show(task.level)} state=${show(task.state)} title=${formatTitle(task.title)}`,
      `runs=${data.runs.length} acceptances=${data.acceptances.length}`,
    ];
    if (data.open_acceptance) {
      lines.push(
        `open_acceptance ${show(data.open_acceptance.id)} state=${show(data.open_acceptance.state)}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
  if (command === 'dispatch') {
    return `dispatched task=${show(data.task.id)} run=${show(data.run.id)} state=${show(data.run.state)}\n`;
  }
  if (command === 'accept') {
    return `acceptance=${show(data.acceptance?.id)} verdict=${show(data.verdict)} state=${show(data.acceptance?.state)} task=${show(data.task?.id)}\n`;
  }
  if (command === 'stop') {
    return `stop task=${show(data.task.id)} state=${show(data.task.state)} stop_state=${show(data.stop_state)} verified=${data.verified === true}\n`;
  }
  if (command === 'cost') {
    return `cost task=${show(data.task_id)} cny=${show(data.cost_cny)} tokens_in=${show(data.tokens_in)} tokens_out=${show(data.tokens_out)} tokens_cached=${show(data.tokens_cached)} entries=${show(data.entry_count)}\n`;
  }
  return '';
}

export { asRecord, numberOrNull };
