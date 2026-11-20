import {
  firstFinite,
  firstString,
  firstTime,
  isRecord,
  parseTime,
  round,
  toList,
} from './normalize.js';

const HOUR_MS = 60 * 60 * 1000;

const ACCEPTED_TASK_STATES = new Set(['completed', 'done', 'accepted', 'passed']);
const PASS_VERDICTS = new Set(['pass', 'passed', 'accepted']);
const REWORK_KINDS = new Set(['rework', 'reworking', 'revision', 'revise']);
const NON_REWORK_KINDS = new Set(['initial', 'first', 'primary', 'retry', 'recovery', 'research']);

/**
 * Project the task ledger onto the PRD north-star metrics.
 *
 * `computeMetrics` is a pure projection: it performs no I/O and mutates none of
 * its inputs. When `clock` (or `now`) is supplied it also avoids the ambient
 * clock, so `totals.generated_at` is deterministic.
 *
 * Returned shape (the five keys are the contract):
 *
 * {
 *   cost_per_accepted_task: number | null,
 *   lead_time: { median_hours, p90_hours, samples, missing },
 *   rework_rounds: number | null,
 *   interventions: number | null,
 *   totals: { ... }
 * }
 *
 * A metric is `null` when its denominator has no accepted tasks or when the
 * inputs needed to compute it are missing. Missing values are never coerced to
 * zero; `totals.missing` and `totals.data_complete` expose the gap.
 *
 * @param {{
 *   tasks?: object[]|Map|object,
 *   runs?: object[]|Map|object,
 *   acceptances?: object[]|Map|object,
 *   costs?: object[]|Map|object,
 *   interventions?: object[]|Map|object,
 *   clock?: number|string|Date|(() => number|string|Date),
 *   now?: number|string|Date|(() => number|string|Date)
 * }} input
 */
export function computeMetrics(input = {}) {
  const options = isRecord(input) ? input : {};
  const clockAt = resolveClock(options);

  const tasks = normalizeTasks(options.tasks);
  const runs = normalizeRuns(options.runs);
  const acceptances = normalizeAcceptances(options.acceptances);

  const taskById = new Map();
  for (const task of tasks) {
    if (taskById.has(task.id)) {
      throw new TypeError(`duplicate task id: ${task.id}`);
    }
    taskById.set(task.id, task);
  }

  const runById = new Map();
  for (const run of runs) {
    if (runById.has(run.id)) {
      throw new TypeError(`duplicate run id: ${run.id}`);
    }
    runById.set(run.id, run);
  }

  const costs = normalizeCosts(options.costs);
  const costIndex = indexCosts(costs, runById, taskById);

  const children = buildChildren(tasks);
  const runsByTask = new Map();
  for (const run of runs) {
    if (!runsByTask.has(run.task_id)) runsByTask.set(run.task_id, []);
    runsByTask.get(run.task_id).push(run);
  }

  const passedByTask = new Map();
  for (const acceptance of acceptances) {
    if (!acceptance.passed || acceptance.task_id === null) continue;
    if (!passedByTask.has(acceptance.task_id)) passedByTask.set(acceptance.task_id, []);
    passedByTask.get(acceptance.task_id).push(acceptance);
  }

  const acceptedTasks = [];
  for (const task of tasks) {
    const ownPasses = (passedByTask.get(task.id) ?? []).filter((acceptance) =>
      stageMatches(task, acceptance),
    );
    const ownDecidedAt = minTime(ownPasses.map((acceptance) => acceptance.decided_at));
    const acceptedAt = task.accepted_at ?? ownDecidedAt;
    const accepted = ACCEPTED_TASK_STATES.has(task.state) || acceptedAt !== null;
    if (!accepted) continue;

    const leadHours = leadTimeHours(task.created_at, acceptedAt);
    acceptedTasks.push({
      ...task,
      accepted_at: acceptedAt,
      lead_hours: leadHours,
    });
  }

  const scopeTaskIds = unionSubtrees(acceptedTasks.map((task) => task.id), children);
  const scopedRuns = runs.filter((run) => scopeTaskIds.has(run.task_id));

  const cost = collectAcceptedCost(acceptedTasks, {
    children,
    taskById,
    runsByTask,
    costsByRun: costIndex.byRun,
    directByTask: costIndex.byTask,
  });

  const leadSamples = acceptedTasks
    .map((task) => task.lead_hours)
    .filter((hours) => hours !== null)
    .sort((left, right) => left - right);
  const leadMissing = acceptedTasks.length - leadSamples.length;

  const acceptanceScope = acceptances.filter(
    (acceptance) => acceptance.task_id !== null && scopeTaskIds.has(acceptance.task_id),
  );
  const intervention = collectInterventions({
    acceptedTasks,
    scopeTaskIds,
    taskById,
    acceptances: acceptanceScope,
    explicit: options.interventions ?? options.user_interventions ?? options.userInterventions,
  });

  const reworkRuns = scopedRuns.filter(isReworkRun);
  const allReworkRuns = runs.filter(isReworkRun);
  const reworkKnown = acceptedTasks.length > 0 && scopedRuns.length > 0;

  const acceptedCount = acceptedTasks.length;
  const costKnown = cost.known;
  const interventionsKnown = intervention.known;
  const leadComplete = leadMissing === 0;

  const median = percentile(leadSamples, 50);
  const p90 = percentile(leadSamples, 90);

  return {
    cost_per_accepted_task:
      acceptedCount > 0 && costKnown ? round(cost.total / acceptedCount) : null,
    lead_time: {
      median_hours: median,
      p90_hours: p90,
      samples: leadSamples.length,
      missing: leadMissing,
    },
    rework_rounds:
      acceptedCount > 0 && reworkKnown ? round(reworkRuns.length / acceptedCount) : null,
    interventions:
      acceptedCount > 0 && interventionsKnown
        ? round(intervention.count / acceptedCount)
        : null,
    totals: {
      tasks: tasks.length,
      accepted_tasks: acceptedCount,
      runs: runs.length,
      accepted_runs: scopedRuns.length,
      rework_runs: allReworkRuns.length,
      accepted_rework_runs: reworkRuns.length,
      interventions: interventionsKnown ? intervention.count : null,
      cost_cny: costKnown ? round(cost.total) : null,
      known_cost_cny: round(cost.total),
      lead_time_samples: leadSamples.length,
      missing: {
        cost: acceptedTasks.filter((task) => !taskCostKnown(task, cost)).length,
        lead_time: leadMissing,
        rework: reworkKnown ? 0 : acceptedCount,
        interventions: interventionsKnown ? 0 : acceptedCount,
      },
      data_complete:
        acceptedCount === 0 ||
        (costKnown && leadComplete && reworkKnown && interventionsKnown),
      generated_at: new Date(clockAt).toISOString(),
    },
  };
}

function resolveClock(options) {
  let value = options.clock;
  if (typeof value === 'function') value = value();
  if (value === undefined || value === null) {
    value = options.now;
    if (typeof value === 'function') value = value();
  }
  if (value === undefined || value === null) value = Date.now();
  const at = parseTime(value);
  if (at === null) {
    throw new TypeError(
      'computeMetrics requires a valid `clock`/`now` (epoch milliseconds, ISO-8601 string, Date, or function)',
    );
  }
  return at;
}

function normalizeTasks(value) {
  return toList(value, 'tasks').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`tasks[${index}] must be an object`);
    }
    const id = firstString(entry.id, entry.task_id, entry.taskId);
    if (id === null) {
      throw new TypeError(`tasks[${index}] requires an id`);
    }

    const rawInterventions =
      entry.interventions ?? entry.human_interventions ?? entry.humanInterventions ??
      entry.user_interventions ?? entry.userInterventions;
    const rawInterventionCount = firstFinite(
      entry.intervention_count,
      entry.interventionCount,
      entry.human_intervention_count,
      entry.humanInterventionCount,
    );
    const interventionCount =
      rawInterventionCount !== null && rawInterventionCount >= 0
        ? Math.trunc(rawInterventionCount)
        : null;
    const interventionListCount = countable(rawInterventions);

    return {
      id,
      level: normalizeWord(firstString(entry.level, entry.task_level, entry.taskLevel)),
      state: normalizeWord(firstString(entry.state, entry.status)),
      parent_id: firstString(
        entry.parent_task_id,
        entry.parentTaskId,
        entry.parent_id,
        entry.parentId,
      ),
      created_at: firstTime(
        entry.created_at,
        entry.createdAt,
        entry.queued_at,
        entry.queuedAt,
      ),
      accepted_at: firstTime(
        entry.accepted_at,
        entry.acceptedAt,
        entry.completed_at,
        entry.completedAt,
      ),
      cost: nonNegativeOrNull(
        firstFinite(entry.cost_cny, entry.costCny, entry.cost, entry.amount),
      ),
      intervention_count: interventionCount,
      intervention_list_count: interventionListCount,
      has_intervention_data:
        rawInterventions !== undefined ||
        interventionCount !== null,
    };
  });
}

function normalizeRuns(value) {
  return toList(value, 'runs').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runs[${index}] must be an object`);
    }
    const taskId = firstString(entry.task_id, entry.taskId);
    if (taskId === null) {
      throw new TypeError(`runs[${index}] requires task_id`);
    }
    const id = firstString(entry.id, entry.run_id, entry.runId) ?? `run-${index}`;
    const runNo = firstFinite(entry.run_no, entry.runNo, entry.number);
    const attempt = firstFinite(entry.attempt);

    return {
      id,
      task_id: taskId,
      run_no: runNo !== null ? runNo : null,
      attempt: attempt !== null ? attempt : null,
      kind: normalizeWord(firstString(entry.kind, entry.role, entry.type, entry.action)),
      rework:
        entry.rework === true ||
        entry.is_rework === true ||
        entry.isRework === true ||
        entry.reworked === true,
      parent_run_id: firstString(
        entry.parent_run_id,
        entry.parentRunId,
        entry.rework_of,
        entry.reworkOf,
      ),
      rework_reason: firstString(entry.rework_reason, entry.reworkReason),
      cost: nonNegativeOrNull(
        firstFinite(entry.cost_cny, entry.costCny, entry.cost, entry.amount),
      ),
    };
  });
}

function normalizeAcceptances(value) {
  return toList(value, 'acceptances').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`acceptances[${index}] must be an object`);
    }
    const verdict = normalizeWord(
      firstString(entry.state, entry.status, entry.verdict, entry.result),
    );
    const mode = normalizeWord(firstString(entry.mode, entry.reviewer_mode, entry.reviewerMode));

    return {
      id: firstString(entry.id, entry.acceptance_id, entry.acceptanceId) ?? `acceptance-${index}`,
      task_id: firstString(
        entry.target_task_id,
        entry.targetTaskId,
        entry.task_id,
        entry.taskId,
      ),
      stage: normalizeWord(firstString(entry.stage)),
      run_id: firstString(entry.run_id, entry.runId),
      passed: entry.passed === true || PASS_VERDICTS.has(verdict),
      decided_at: firstTime(
        entry.decided_at,
        entry.decidedAt,
        entry.created_at,
        entry.createdAt,
      ),
      mode,
      human: mode === 'human' || mode === 'manual',
      has_mode: mode !== null,
    };
  });
}

function normalizeCosts(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) || value instanceof Map) {
    return dedupeCosts(
      [...(value instanceof Map ? value.values() : value)].map((entry, index) =>
        normalizeCost(entry, index),
      ),
    );
  }
  if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    return dedupeCosts([...value].map((entry, index) => normalizeCost(entry, index)));
  }
  if (isRecord(value)) {
    return dedupeCosts(
      Object.entries(value).map(([key, entry], index) => {
        if (typeof entry === 'number' || typeof entry === 'string') {
          return normalizeCost({ ref: key, cost_cny: entry }, index);
        }
        if (isRecord(entry)) {
          const hasTarget =
            firstString(entry.run_id, entry.runId, entry.task_id, entry.taskId) !== null;
          return normalizeCost(
            { ...entry, ref: entry.ref ?? (hasTarget ? undefined : key), id: entry.id ?? key },
            index,
          );
        }
        return normalizeCost(entry, index);
      }),
    );
  }
  throw new TypeError('costs must be an array, Map, or id-keyed object');
}

function dedupeCosts(costs) {
  const seen = new Set();
  return costs.filter((cost) => {
    if (seen.has(cost.id)) return false;
    seen.add(cost.id);
    return true;
  });
}

function normalizeCost(entry, index) {
  if (!isRecord(entry)) {
    return {
      id: `cost-${index}`,
      run_id: null,
      task_id: null,
      ref: null,
      amount: null,
    };
  }
  const amount = firstFinite(
    entry.cost_cny,
    entry.costCny,
    entry.cost,
    entry.amount,
    entry.cny,
  );
  return {
    id: firstString(entry.id, entry.cost_id, entry.costId) ?? `cost-${index}`,
    run_id: firstString(entry.run_id, entry.runId),
    task_id: firstString(entry.task_id, entry.taskId),
    ref: firstString(entry.ref, entry.key),
    amount: nonNegativeOrNull(amount),
  };
}

function indexCosts(costs, runById, taskById) {
  const byRun = new Map();
  const byTask = new Map();

  for (const cost of costs) {
    let runId = cost.run_id;
    let taskId = cost.task_id;

    if (runId === null && cost.ref !== null && runById.has(cost.ref)) {
      runId = cost.ref;
    }
    if (taskId === null && cost.ref !== null && taskById.has(cost.ref)) {
      taskId = cost.ref;
    }

    if (runId !== null && runById.has(runId)) {
      if (!byRun.has(runId)) byRun.set(runId, []);
      byRun.get(runId).push(cost);
      continue;
    }
    if (taskId !== null && taskById.has(taskId)) {
      if (!byTask.has(taskId)) byTask.set(taskId, []);
      byTask.get(taskId).push(cost);
    }
  }

  return { byRun, byTask };
}

function buildChildren(tasks) {
  const children = new Map();
  for (const task of tasks) {
    if (task.parent_id === null) continue;
    if (!children.has(task.parent_id)) children.set(task.parent_id, []);
    children.get(task.parent_id).push(task.id);
  }
  return children;
}

function subtreeIds(rootId, children) {
  const seen = new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return seen;
}

function unionSubtrees(rootIds, children) {
  const union = new Set();
  for (const rootId of rootIds) {
    for (const id of subtreeIds(rootId, children)) union.add(id);
  }
  return union;
}

function collectAcceptedCost(acceptedTasks, context) {
  const perTask = new Map();
  let total = 0;
  let known = true;

  for (const task of acceptedTasks) {
    const result = sumSubtreeCost(task.id, context);
    perTask.set(task.id, result);
    total += result.cost;
    if (!result.known) known = false;
  }

  return { known: acceptedTasks.length === 0 || known, total, perTask };
}

function sumSubtreeCost(rootId, { children, taskById, runsByTask, costsByRun, directByTask }) {
  let total = 0;
  let known = true;
  let hasData = false;

  for (const taskId of subtreeIds(rootId, children)) {
    const task = taskById.get(taskId);
    const taskRuns = runsByTask.get(taskId) ?? [];
    const directCosts = directByTask.get(taskId) ?? [];
    let ownHasData = false;

    for (const run of taskRuns) {
      ownHasData = true;
      hasData = true;
      const rows = costsByRun.get(run.id);
      if (rows && rows.length > 0) {
        for (const row of rows) {
          if (row.amount === null) known = false;
          else total += row.amount;
        }
      } else if (run.cost !== null) {
        total += run.cost;
      } else {
        known = false;
      }
    }

    for (const row of directCosts) {
      ownHasData = true;
      hasData = true;
      if (row.amount === null) known = false;
      else total += row.amount;
    }

    // A task-level cost is a fallback aggregate. It is ignored when runs or
    // ledger rows exist, so the same spend is not counted twice.
    if (!ownHasData && task && task.cost !== null) {
      hasData = true;
      total += task.cost;
    }
  }

  return { known: hasData && known, cost: total };
}

function collectInterventions({ acceptedTasks, scopeTaskIds, taskById, acceptances, explicit }) {
  if (explicit !== undefined && explicit !== null) {
    const entries = toList(explicit, 'interventions');
    const seen = new Set();
    let count = 0;
    entries.forEach((entry, index) => {
      const record = isRecord(entry) ? entry : {};
      const id = firstString(record.id, record.intervention_id, record.interventionId) ??
        `intervention-${index}`;
      if (seen.has(id)) return;
      seen.add(id);
      const taskId = firstString(record.task_id, record.taskId);
      if (taskId !== null && scopeTaskIds.has(taskId)) count += 1;
    });
    return { known: true, count };
  }

  let known = acceptedTasks.length === 0;
  let count = 0;
  const seenAcceptances = new Set();

  for (const taskId of scopeTaskIds) {
    const task = taskById.get(taskId);
    if (!task || !task.has_intervention_data) continue;
    known = true;
    if (task.intervention_count !== null) count += task.intervention_count;
    else if (task.intervention_list_count !== null) count += task.intervention_list_count;
  }

  for (const acceptance of acceptances) {
    if (acceptance.has_mode) known = true;
    if (!acceptance.human) continue;
    if (!scopeTaskIds.has(acceptance.task_id)) continue;
    if (acceptance.decided_at === null && !acceptance.passed) continue;
    if (seenAcceptances.has(acceptance.id)) continue;
    seenAcceptances.add(acceptance.id);
    count += 1;
  }

  return { known, count };
}

function isReworkRun(run) {
  if (run.rework) return true;
  if (REWORK_KINDS.has(run.kind)) return true;
  if (NON_REWORK_KINDS.has(run.kind)) return false;
  if (run.parent_run_id !== null || run.rework_reason !== null) return true;
  // `run_no` advances for rework in the L1 model; `attempt` covers retries of
  // the same run number, which are not rework rounds.
  if (run.run_no !== null && run.run_no > 1 && (run.attempt === null || run.attempt <= 1)) {
    return true;
  }
  return false;
}

function taskCostKnown(task, cost) {
  const result = cost.perTask.get(task.id);
  return result ? result.known : false;
}

function stageMatches(task, acceptance) {
  if (task.level === null || acceptance.stage === null) return true;
  return task.level === acceptance.stage;
}

function leadTimeHours(createdAt, acceptedAt) {
  if (createdAt === null || acceptedAt === null || acceptedAt < createdAt) return null;
  return (acceptedAt - createdAt) / HOUR_MS;
}

function percentile(sortedValues, percent) {
  if (sortedValues.length === 0) return null;
  if (percent === 50) {
    const middle = Math.floor(sortedValues.length / 2);
    if (sortedValues.length % 2 === 0) {
      return round((sortedValues[middle - 1] + sortedValues[middle]) / 2);
    }
    return round(sortedValues[middle]);
  }
  const rank = Math.ceil((percent / 100) * sortedValues.length) - 1;
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank));
  return round(sortedValues[index]);
}

function minTime(values) {
  let min = null;
  for (const value of values) {
    if (value === null) continue;
    if (min === null || value < min) min = value;
  }
  return min;
}

function nonNegativeOrNull(value) {
  return value !== null && value >= 0 ? value : null;
}

function normalizeWord(value) {
  return value === null ? null : value.toLowerCase();
}

function countable(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) || value instanceof Map) return value.size ?? value.length;
  if (typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    let count = 0;
    for (const _ of value) count += 1;
    return count;
  }
  if (isRecord(value)) return Object.keys(value).length;
  return null;
}
