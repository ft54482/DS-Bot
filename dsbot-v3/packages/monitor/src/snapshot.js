import {
  DEFAULT_POLICY,
  REJECTED_RUN_STATES,
  STUCK_REASONS,
} from './policy.js';
import {
  firstFinite,
  firstString,
  firstTime,
  isRecord,
  parseTime,
  round4,
  toIso,
  toList,
} from './normalize.js';

/**
 * Build a read-only status snapshot for the cockpit/master control.
 *
 * `runtime` is a point-in-time view collected elsewhere (task ledger + executor
 * observations). This function performs no I/O: no database, no filesystem and
 * no network. When `now` is injected it also avoids the ambient clock, which
 * makes every timeout rule deterministic and testable.
 *
 * Returned shape (additive fields are limited to stuck evidence and pending
 * decision metadata):
 *
 * {
 *   generated_at: ISO-8601,
 *   tasks: [{ id, level, state, owner, cost }],
 *   stuck: [{ id, reason, detail, evidence_ref, evidence }],
 *   pending_decision: [{ id, kind, task_id, summary, evidence }],
 *   budget: { spent, cap }
 * }
 *
 * @param {{ runtime: object, now?: number|string|Date|function }} input
 */
export function buildSnapshot({ runtime, now } = {}) {
  if (!isRecord(runtime)) {
    throw new TypeError('buildSnapshot requires a runtime object');
  }

  const at = resolveNow(now, runtime);
  const policy = resolvePolicy(runtime);
  const tasks = normalizeTasks(runtime.tasks);
  const runs = normalizeRuns(runtime.runs);
  const escalations = normalizeEscalations(runtime.escalations);
  const interventions = normalizeInterventions(
    runtime.interventions ?? runtime.user_interventions ?? runtime.userInterventions,
  );
  const ledger = resolveLedger(runtime);
  const executors = indexExecutors(runtime.executors);

  const ledgerByTask = sumLedgerByTask(ledger);
  const runsByTask = groupByTask(runs);
  const openEscalationsByTask = groupByTask(escalations.filter(isOpenEscalation));
  const openInterventionsByTask = groupByTask(interventions.filter(isOpenIntervention));

  const taskViews = [];
  const stuck = [];
  let taskCostTotal = 0;

  for (const task of tasks) {
    const cost = task.cost ?? ledgerByTask.get(task.id) ?? 0;
    taskCostTotal += cost;
    taskViews.push({
      id: task.id,
      level: task.level,
      state: task.state,
      owner: task.owner,
      cost: round4(cost),
    });

    const entry = detectStuck(task, {
      at,
      policy,
      runsByTask,
      openEscalationsByTask,
      openInterventionsByTask,
      executors,
    });
    if (entry !== null) stuck.push(entry);
  }

  return {
    generated_at: toIso(at),
    tasks: taskViews,
    stuck,
    pending_decision: buildPendingDecisions(escalations, interventions),
    budget: buildBudget(runtime, taskCostTotal, ledger),
  };
}

function resolveNow(nowValue, runtime) {
  let value = nowValue;
  if (typeof value === 'function') value = value();
  if (value === undefined || value === null) {
    const fallback = runtime.now;
    value = typeof fallback === 'function' ? fallback() : fallback;
  }
  if (value === undefined || value === null) value = Date.now();
  const at = parseTime(value);
  if (at === null) {
    throw new TypeError(
      'buildSnapshot requires a valid `now` (epoch milliseconds, ISO-8601 string, Date, or function)',
    );
  }
  return at;
}

function resolvePolicy(runtime) {
  const policy = isRecord(runtime.policy) ? runtime.policy : {};
  const thresholds = isRecord(runtime.thresholds) ? runtime.thresholds : {};

  const acceptingTimeout = firstFinite(
    policy.accepting_timeout_ms,
    policy.acceptingTimeoutMs,
    thresholds.accepting_timeout_ms,
    thresholds.acceptingTimeoutMs,
    runtime.accepting_timeout_ms,
    runtime.acceptingTimeoutMs,
  );
  const reworkThreshold = firstFinite(
    policy.rework_rounds_threshold,
    policy.reworkRoundsThreshold,
    thresholds.rework_rounds_threshold,
    thresholds.reworkRoundsThreshold,
    runtime.rework_rounds_threshold,
    runtime.reworkRoundsThreshold,
  );

  return {
    accepting_timeout_ms:
      acceptingTimeout !== null && acceptingTimeout >= 0
        ? acceptingTimeout
        : DEFAULT_POLICY.accepting_timeout_ms,
    // The acceptance rule is "at least 2 consecutive rounds"; configuration may
    // raise the bar for a deployment but cannot lower it below the contract.
    rework_rounds_threshold:
      reworkThreshold !== null && reworkThreshold >= DEFAULT_POLICY.rework_rounds_threshold
        ? Math.floor(reworkThreshold)
        : DEFAULT_POLICY.rework_rounds_threshold,
  };
}

function normalizeTasks(value) {
  const seen = new Set();
  return toList(value, 'tasks').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.tasks[${index}] must be an object`);
    }
    const id = firstString(entry.id, entry.task_id, entry.taskId);
    if (id === null) {
      throw new TypeError(`runtime.tasks[${index}].id is required`);
    }
    if (seen.has(id)) {
      throw new TypeError(`runtime.tasks contains duplicate id ${id}`);
    }
    seen.add(id);

    const history = entry.rework_history ?? entry.reworkHistory;

    return {
      id,
      level: firstString(entry.level, entry.task_level, entry.taskLevel),
      state: firstString(entry.state, entry.status),
      owner: firstString(
        entry.owner,
        entry.owner_ref,
        entry.ownerRef,
        entry.owner_id,
        entry.ownerId,
      ),
      cost: firstFinite(entry.cost, entry.cost_cny, entry.costCny),
      acceptingSince: firstTime(
        entry.accepting_since,
        entry.acceptingSince,
        entry.accepting_at,
        entry.acceptingAt,
      ),
      stateEnteredAt: firstTime(
        entry.state_entered_at,
        entry.stateEnteredAt,
        entry.state_changed_at,
        entry.stateChangedAt,
        entry.updated_at,
        entry.updatedAt,
      ),
      createdAt: firstTime(entry.created_at, entry.createdAt),
      reworkRounds: firstFinite(
        entry.rework_rounds,
        entry.reworkRounds,
        entry.rework_count,
        entry.reworkCount,
      ),
      reworkHistory: Array.isArray(history) ? history.length : null,
      blockedReason: firstString(
        entry.blocked_reason,
        entry.blockedReason,
        entry.block_reason,
        entry.blockReason,
      ),
      escalated:
        entry.escalated === true ||
        entry.escalated === 1 ||
        firstString(
          entry.escalation_id,
          entry.escalationId,
          entry.open_escalation_id,
          entry.openEscalationId,
        ) !== null,
      executorId: firstString(
        entry.executor_id,
        entry.executorId,
        entry.executor_instance_id,
        entry.executorInstanceId,
      ),
    };
  });
}

function normalizeRuns(value) {
  return toList(value, 'runs').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.runs[${index}] must be an object`);
    }
    return {
      id:
        firstString(entry.id, entry.run_id, entry.runId) ?? `run:${index + 1}`,
      taskId: firstString(entry.task_id, entry.taskId),
      runNo: firstFinite(entry.run_no, entry.runNo),
      attempt: firstFinite(entry.attempt) ?? 1,
      state: firstString(entry.state, entry.status),
      createdAt: firstTime(entry.created_at, entry.createdAt),
    };
  });
}

function normalizeEscalations(value) {
  return toList(value, 'escalations').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.escalations[${index}] must be an object`);
    }
    return {
      id:
        firstString(entry.id, entry.escalation_id, entry.escalationId) ??
        `escalation:${index + 1}`,
      taskId: firstString(
        entry.task_id,
        entry.taskId,
        entry.from_task_id,
        entry.fromTaskId,
      ),
      kind: firstString(entry.kind, entry.type) ?? 'unknown',
      state: firstString(entry.state, entry.status),
      detail: firstString(entry.detail, entry.summary, entry.question) ?? '',
      createdAt: firstTime(entry.created_at, entry.createdAt),
      answeredAt: firstTime(entry.answered_at, entry.answeredAt),
    };
  });
}

function normalizeInterventions(value) {
  return toList(value, 'interventions').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.interventions[${index}] must be an object`);
    }
    return {
      id:
        firstString(entry.id, entry.intervention_id, entry.interventionId) ??
        `intervention:${index + 1}`,
      taskId: firstString(entry.task_id, entry.taskId),
      question: firstString(entry.question, entry.summary, entry.detail) ?? '',
      answer: firstString(entry.answer),
      state: firstString(entry.state, entry.status),
      askedAt: firstTime(entry.asked_at, entry.askedAt),
      answeredAt: firstTime(entry.answered_at, entry.answeredAt),
    };
  });
}

function resolveLedger(runtime) {
  const ledgerValue = runtime.cost_ledger ?? runtime.costLedger;
  if (ledgerValue !== undefined && ledgerValue !== null) {
    return normalizeLedgerRows(ledgerValue, 'cost_ledger');
  }
  return normalizeCostRows(
    runtime.costs ?? runtime.cost_by_task ?? runtime.costByTask,
  );
}

function normalizeLedgerRows(value, label) {
  return toList(value, label).map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.${label}[${index}] must be an object`);
    }
    return {
      taskId: firstString(entry.task_id, entry.taskId),
      cost:
        firstFinite(
          entry.cost_cny,
          entry.costCny,
          entry.cost,
          entry.amount,
        ) ?? 0,
    };
  });
}

function normalizeCostRows(value) {
  if (value === undefined || value === null) return [];
  if (isRecord(value)) {
    return Object.entries(value).map(([taskId, amount]) => ({
      taskId,
      cost: firstFinite(amount) ?? 0,
    }));
  }
  return normalizeLedgerRows(value, 'costs');
}

function sumLedgerByTask(ledger) {
  const totals = new Map();
  for (const row of ledger) {
    if (row.taskId === null) continue;
    totals.set(row.taskId, (totals.get(row.taskId) ?? 0) + row.cost);
  }
  return totals;
}

function groupByTask(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.taskId === null) continue;
    if (!groups.has(entry.taskId)) groups.set(entry.taskId, []);
    groups.get(entry.taskId).push(entry);
  }
  return groups;
}

function indexExecutors(value) {
  const executors = new Map();
  for (const entry of toList(value, 'executors')) {
    if (!isRecord(entry)) continue;
    const id = firstString(entry.id, entry.executor_id, entry.executorId);
    if (id === null) continue;
    const lastSeen = firstTime(entry.last_seen_at, entry.lastSeenAt);
    executors.set(id, {
      id,
      kind: firstString(entry.kind, entry.type),
      state: firstString(entry.state, entry.status),
      last_seen_at: lastSeen === null ? null : toIso(lastSeen),
    });
  }
  return executors;
}

function detectStuck(task, context) {
  if (task.state === 'accepting') return acceptingTimeout(task, context);
  if (task.state === 'reworking') return reworkRounds(task, context);
  if (task.state === 'blocked') return blockedNotEscalated(task, context);
  return null;
}

function acceptingTimeout(task, { at, policy, executors }) {
  const since = task.acceptingSince ?? task.stateEnteredAt ?? task.createdAt;
  if (since === null) return null;

  const age = at - since;
  if (!(age >= policy.accepting_timeout_ms)) return null;

  const field =
    task.acceptingSince !== null
      ? 'task.accepting_since'
      : task.stateEnteredAt !== null
        ? 'task.state_entered_at'
        : 'task.created_at';

  const evidence = withExecutor(
    {
      type: 'task',
      ref: `task:${task.id}`,
      field,
      state: 'accepting',
      since: toIso(since),
      age_ms: age,
      threshold_ms: policy.accepting_timeout_ms,
    },
    task,
    executors,
  );

  return {
    id: task.id,
    reason: STUCK_REASONS.ACCEPTING_TIMEOUT,
    detail: `accepting for ${formatDuration(age)} (threshold ${formatDuration(policy.accepting_timeout_ms)})`,
    evidence_ref: `task:${task.id}`,
    evidence,
  };
}

function reworkRounds(task, { policy, runsByTask, executors }) {
  const derived = leadingRejectedRuns(task.id, runsByTask);
  const rounds = Math.max(
    Math.floor(task.reworkRounds ?? 0),
    Math.floor(task.reworkHistory ?? 0),
    derived.rounds,
  );
  if (rounds < policy.rework_rounds_threshold) return null;

  const sources = [];
  if ((task.reworkRounds ?? 0) > 0 || (task.reworkHistory ?? 0) > 0) {
    sources.push('task.rework_rounds');
  }
  if (derived.rounds > 0) sources.push('run.state=rejected');

  const evidence = withExecutor(
    {
      type: 'task',
      ref: `task:${task.id}`,
      field: 'task.state',
      state: 'reworking',
      rework_rounds: rounds,
      threshold: policy.rework_rounds_threshold,
      rework_run_ids: derived.runIds,
      sources,
    },
    task,
    executors,
  );

  return {
    id: task.id,
    reason: STUCK_REASONS.REWORK_ROUNDS,
    detail: `reworking through ${rounds} consecutive ${plural(rounds, 'round')} (threshold ${policy.rework_rounds_threshold})`,
    evidence_ref:
      derived.runIds.length > 0
        ? `task:${task.id}/runs:${derived.runIds.join(',')}`
        : `task:${task.id}`,
    evidence,
  };
}

function blockedNotEscalated(
  task,
  { openEscalationsByTask, openInterventionsByTask, executors },
) {
  const openEscalations = openEscalationsByTask.get(task.id) ?? [];
  const openInterventions = openInterventionsByTask.get(task.id) ?? [];
  if (task.escalated || openEscalations.length > 0 || openInterventions.length > 0) {
    return null;
  }

  const evidence = withExecutor(
    {
      type: 'task',
      ref: `task:${task.id}`,
      field: 'task.state',
      state: 'blocked',
      blocked_reason: task.blockedReason,
      open_escalations: 0,
      open_interventions: 0,
      checked: 'escalation.state=open',
    },
    task,
    executors,
  );

  return {
    id: task.id,
    reason: STUCK_REASONS.BLOCKED_NOT_ESCALATED,
    detail:
      task.blockedReason === null
        ? 'blocked with no open escalation'
        : `blocked (${task.blockedReason}) with no open escalation`,
    evidence_ref: `task:${task.id}`,
    evidence,
  };
}

function leadingRejectedRuns(taskId, runsByTask) {
  const runs = (runsByTask.get(taskId) ?? []).slice().sort(compareRunsDesc);
  const seenRounds = new Set();
  const rejected = [];

  for (const run of runs) {
    if (!REJECTED_RUN_STATES.includes(run.state)) break;
    const roundKey = run.runNo ?? run.id;
    if (!seenRounds.has(roundKey)) {
      seenRounds.add(roundKey);
      rejected.push(run);
    }
  }

  return {
    rounds: seenRounds.size,
    runIds: rejected.map((run) => run.id),
  };
}

function compareRunsDesc(left, right) {
  const leftNo = left.runNo ?? Number.NEGATIVE_INFINITY;
  const rightNo = right.runNo ?? Number.NEGATIVE_INFINITY;
  if (leftNo !== rightNo) return rightNo - leftNo;

  if (left.attempt !== right.attempt) return right.attempt - left.attempt;
  if ((left.createdAt ?? 0) !== (right.createdAt ?? 0)) {
    return (right.createdAt ?? 0) - (left.createdAt ?? 0);
  }
  return String(right.id).localeCompare(String(left.id));
}

function isOpenEscalation(escalation) {
  if (escalation.answeredAt !== null) return false;
  if (escalation.state === null) return true;
  return !CLOSED_STATES.has(escalation.state.toLowerCase());
}

function isOpenIntervention(intervention) {
  if (intervention.answeredAt !== null) return false;
  if (intervention.answer !== null) return false;
  if (intervention.state === null) return true;
  return !CLOSED_STATES.has(intervention.state.toLowerCase());
}

const CLOSED_STATES = new Set([
  'closed',
  'answered',
  'resolved',
  'cancelled',
  'canceled',
  'dismissed',
]);

function buildPendingDecisions(escalations, interventions) {
  const pending = [];

  for (const escalation of escalations) {
    if (!isOpenEscalation(escalation)) continue;
    pending.push({
      id: escalation.id,
      escalation_id: escalation.id,
      kind: escalation.kind,
      task_id: escalation.taskId,
      summary: escalation.detail,
      evidence: {
        type: 'escalation',
        ref: `escalation:${escalation.id}`,
        state: escalation.state ?? 'open',
      },
      sortAt: escalation.createdAt,
    });
  }

  for (const intervention of interventions) {
    if (!isOpenIntervention(intervention)) continue;
    pending.push({
      id: intervention.id,
      intervention_id: intervention.id,
      kind: 'intervention',
      task_id: intervention.taskId,
      summary: intervention.question,
      evidence: {
        type: 'intervention',
        ref: `intervention:${intervention.id}`,
        state: intervention.state ?? 'open',
      },
      sortAt: intervention.askedAt,
    });
  }

  pending.sort((left, right) => {
    const leftAt = left.sortAt ?? Number.POSITIVE_INFINITY;
    const rightAt = right.sortAt ?? Number.POSITIVE_INFINITY;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return String(left.id).localeCompare(String(right.id));
  });

  return pending.map(({ sortAt, ...entry }) => entry);
}

function buildBudget(runtime, taskCostTotal, ledger) {
  const budget = isRecord(runtime.budget) ? runtime.budget : {};
  const budgetValue = isRecord(runtime.budget) ? null : runtime.budget;

  const explicitSpent = firstFinite(
    budget.spent,
    budget.spent_cny,
    budget.spentCny,
    budget.used,
    budget.consumed,
  );
  const explicitCap = firstFinite(
    budget.cap,
    budget.cap_cny,
    budget.capCny,
    budget.limit,
    budgetValue,
    runtime.budget_cny_cap,
    runtime.budgetCnyCap,
    runtime.budget_cap,
    runtime.budgetCapCny,
    runtime.cap,
  );

  let spent = explicitSpent;
  if (spent === null) {
    spent =
      ledger.length > 0
        ? ledger.reduce((total, row) => total + row.cost, 0)
        : taskCostTotal;
  }

  return {
    spent: round4(spent ?? 0),
    cap: explicitCap === null ? null : round4(explicitCap),
  };
}

function withExecutor(evidence, task, executors) {
  if (task.executorId === null) return evidence;
  const executor = executors.get(task.executorId);
  if (executor === undefined) return evidence;
  return { ...evidence, executor };
}

function formatDuration(ms) {
  if (ms >= 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
  if (ms >= 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  return `${Math.round(ms / 1000)}s`;
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}
