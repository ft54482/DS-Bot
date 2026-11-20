/**
 * L46 Chief coordination layer.
 *
 * The Chief works at the goal level only (PRD §3, §5):
 *
 *   openGoal  create the goal task from a user objective
 *   delegate  create a business task and hand it to a registered BOT
 *   status    aggregate business state, acceptance, cost and blockers
 *   deliver   produce the result package once every business acceptance passed
 *
 * It never dispatches execution work. The business BOT owns that, so
 * `dispatchExecution` is an explicit `not_allowed` denial.
 *
 * This module deliberately contains no task, acceptance, budget or metric
 * implementation. It calls:
 *
 *   packages/runtime    task/run/acceptance/cost facade
 *   packages/agents     createChiefTools (scope + budget guarded delegation)
 *   packages/acceptance evaluate() for an independent business-acceptance view
 *   packages/metrics    computeMetrics() for the north-star projection
 *
 * All four are injected so tests can use fakes.
 */

import { createChiefTools, readAgentScope } from '../../agents/src/index.js';
import { CHIEF_CODES, CHIEF_TOOLS, GOAL_ACCEPTANCE_PROFILE } from './constants.js';

const EPSILON = 1e-9;
const RESERVED_AGENT_KEYS = new Set([
  'chief',
  'bots',
  'registry',
  'createChiefTools',
  'createBusinessTools',
  'AGENT_CODES',
  'AGENT_ROLES',
  'ROLE_TOOLS',
  'readAgentScope',
  'resolveProject',
  'resolveTaskScope',
  'budgetCap',
  'checkBudget',
  'subtreeSpend',
  'summarizeTask',
  'role',
  'toolNames',
  'default',
]);
const SCOPE_KEYS = new Set([
  'projects',
  'project',
  'executors',
  'tools',
  'spend_cny_cap',
  'max_delegate_level',
  'paths',
  'git',
  'network',
  'secrets',
]);

// ---------------------------------------------------------------------------
// Result contract helpers
// ---------------------------------------------------------------------------

function ok(tool, payload = {}) {
  return { ok: true, tool, ...payload };
}

function fail(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

function fromError(error, fallback = CHIEF_CODES.TOOL_ERROR) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : fallback;
  const result = fail(code, error?.message ?? String(error));
  if (error?.details !== undefined) result.details = error.details;
  return result;
}

function guard(fn) {
  try {
    return fn();
  } catch (error) {
    return fromError(error);
  }
}

// ---------------------------------------------------------------------------
// Small input helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function readText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      result: fail(CHIEF_CODES.VALIDATION_ERROR, `${field} must be a non-empty string`, { field }),
    };
  }
  return { ok: true, value };
}

function budgetCap(budget) {
  if (!isPlainObject(budget)) return null;
  for (const key of ['capCny', 'cny_cap', 'cap_cny']) {
    const value = budget[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function readBudget(value, field) {
  if (value == null) return { ok: true, cap: null, budget: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return {
        ok: false,
        result: fail(CHIEF_CODES.VALIDATION_ERROR, `${field} must be a non-negative finite number`, {
          field,
          value,
        }),
      };
    }
    return { ok: true, cap: value, budget: { capCny: value } };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      result: fail(CHIEF_CODES.VALIDATION_ERROR, `${field} must be a number or a budget object`, {
        field,
      }),
    };
  }
  const cap = budgetCap(value);
  if (cap === null) {
    return {
      ok: false,
      result: fail(
        CHIEF_CODES.VALIDATION_ERROR,
        `${field} must declare a non-negative capCny`,
        { field, budget: value },
      ),
    };
  }
  return { ok: true, cap, budget: clone(value) };
}

function readScopeValue(value, field) {
  if (value == null) return { ok: true, value: {} };
  if (typeof value === 'string') return { ok: true, value: { projects: [value] } };
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== 'string' || entry === '')) {
      return {
        ok: false,
        result: fail(CHIEF_CODES.VALIDATION_ERROR, `${field} must contain non-empty strings`, {
          field,
        }),
      };
    }
    return { ok: true, value: { projects: [...new Set(value)] } };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      result: fail(CHIEF_CODES.VALIDATION_ERROR, `${field} must be a plain object`, { field }),
    };
  }
  return { ok: true, value: clone(value) };
}

function normalizeScope(value, field) {
  const parsed = readScopeValue(value, field);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, value: readAgentScope(parsed.value, field) };
  } catch (error) {
    return {
      ok: false,
      result: fail(CHIEF_CODES.VALIDATION_ERROR, error.message, { field }),
    };
  }
}

function projectOfScope(scope, explicit = null) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const subjectProject = scope?.subject?.project;
  if (typeof subjectProject === 'string' && subjectProject !== '') return subjectProject;
  if (typeof scope?.project === 'string' && scope.project !== '') return scope.project;
  if (Array.isArray(scope?.projects) && scope.projects.length === 1) return scope.projects[0];
  return null;
}

function projectOfTask(task) {
  const subjectProject = task?.subject?.project;
  if (typeof subjectProject === 'string' && subjectProject !== '') return subjectProject;
  if (typeof task?.authScope?.project === 'string' && task.authScope.project !== '') {
    return task.authScope.project;
  }
  if (Array.isArray(task?.authScope?.projects) && task.authScope.projects.length === 1) {
    return task.authScope.projects[0];
  }
  return null;
}

function mergeScopes(...scopes) {
  const merged = {};
  for (const scope of scopes) {
    if (isPlainObject(scope)) Object.assign(merged, scope);
  }
  return merged;
}

function readGoalId(input) {
  return readText(input?.goalId ?? input?.goal_id ?? input?.goalTaskId, 'goalId');
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

function isChiefToolset(value, { strict = true } = {}) {
  if (!value || typeof value !== 'object' || typeof value.delegate !== 'function') return false;
  if (strict) {
    return value.role === 'chief' || (Array.isArray(value.toolNames) && value.toolNames.includes('delegate'));
  }
  return true;
}

function looksLikeScope(value) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((key) => SCOPE_KEYS.has(key));
}

function delegationScopeOf(scope) {
  const delegation = {};
  for (const key of [
    'projects',
    'project',
    'max_delegate_level',
    'paths',
    'git',
    'network',
    'secrets',
  ]) {
    if (scope[key] !== undefined) delegation[key] = scope[key];
  }
  return delegation;
}

function normalizeBotDescriptor(descriptor, name) {
  if (descriptor == null) {
    throw new TypeError(`agent ${name} descriptor is required`);
  }
  let scope = {};
  let acceptanceProfile = null;
  let tools = descriptor;
  if (isPlainObject(descriptor)) {
    const rawScope =
      descriptor.scope ??
      descriptor.authScope ??
      (looksLikeScope(descriptor) ? descriptor : null);
    if (rawScope != null) scope = readAgentScope(rawScope, `agent ${name}.scope`);
    acceptanceProfile = descriptor.acceptanceProfile ?? descriptor.profile ?? null;
    tools = descriptor.tools ?? descriptor.agent ?? null;
  }
  return Object.freeze({
    name,
    scope,
    // The bot's executor allow-list and spend cap stay bot configuration. The
    // delegated task gets the project/hierarchy ceiling, not the bot's tools.
    delegationScope: delegationScopeOf(scope),
    acceptanceProfile,
    tools,
  });
}

function normalizeAgents({ agents, runtime, scope }) {
  if (!agents || (typeof agents !== 'object' && typeof agents !== 'function')) {
    throw new TypeError('createChief requires { agents } (a bot registry or agent tools)');
  }

  let chiefTools = null;
  if (isChiefToolset(agents.chief, { strict: false })) {
    chiefTools = agents.chief;
  } else if (isChiefToolset(agents)) {
    chiefTools = agents;
  } else if (typeof agents.createChiefTools === 'function') {
    chiefTools = agents.createChiefTools({ runtime, scope });
  } else {
    chiefTools = createChiefTools({ runtime, scope });
  }

  const registry = new Map();
  const register = (name, descriptor) => {
    if (typeof name !== 'string' || name === '') return;
    if (registry.has(name)) throw new TypeError(`duplicate agent registration: ${name}`);
    registry.set(name, normalizeBotDescriptor(descriptor, name));
  };

  if (agents instanceof Map) {
    for (const [name, descriptor] of agents) register(name, descriptor);
  } else if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (typeof entry === 'string') {
        register(entry, {});
      } else if (isPlainObject(entry)) {
        register(entry.name ?? entry.id, entry);
      }
    }
  } else {
    if (isPlainObject(agents.bots)) {
      for (const [name, descriptor] of Object.entries(agents.bots)) register(name, descriptor);
    }
    if (isPlainObject(agents.registry)) {
      for (const [name, descriptor] of Object.entries(agents.registry)) register(name, descriptor);
    }
    if (!isChiefToolset(agents) && typeof agents.createChiefTools !== 'function') {
      for (const [name, descriptor] of Object.entries(agents)) {
        if (RESERVED_AGENT_KEYS.has(name) || registry.has(name)) continue;
        register(name, descriptor);
      }
    }
  }

  return { chiefTools, bots: registry };
}

// ---------------------------------------------------------------------------
// Runtime read helpers
// ---------------------------------------------------------------------------

function costTotal(runtime, taskId) {
  if (typeof runtime.cost?.total !== 'function') return { cny: 0, entries: 0 };
  const total = runtime.cost.total(taskId);
  const cny = Number(total?.costCny ?? total?.cost_cny ?? total?.cny ?? 0);
  const entries = Number(total?.entries ?? 0);
  return {
    cny: Number.isFinite(cny) ? cny : 0,
    entries: Number.isFinite(entries) ? entries : 0,
  };
}

function subtreeTasks(runtime, rootTaskId) {
  const seen = new Set();
  const queue = [rootTaskId];
  const result = [];
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    const task = runtime.tasks.get(taskId);
    result.push(task);
    for (const child of runtime.tasks.list({ parentTaskId: taskId, limit: 1000 })) {
      queue.push(child.id);
    }
  }
  return result;
}

function subtreeSpend(runtime, rootTaskId) {
  return subtreeTasks(runtime, rootTaskId).reduce(
    (total, task) => total + costTotal(runtime, task.id).cny,
    0,
  );
}

function remainingGoalBudget(runtime, goal) {
  const cap = budgetCap(goal.budget);
  if (cap === null) return null;
  return Math.max(0, cap - subtreeSpend(runtime, goal.id));
}

function listAcceptances(runtime, filter = {}) {
  if (typeof runtime.acceptances?.list === 'function') {
    const list = runtime.acceptances.list({ limit: 1000, ...filter });
    if (Array.isArray(list)) return list;
  }
  return [];
}

function allAcceptances(runtime) {
  return listAcceptances(runtime, {});
}

function sortAcceptanceRounds(records) {
  return [...records].sort((left, right) => {
    const round = (left.roundNo ?? left.round_no ?? 0) - (right.roundNo ?? right.round_no ?? 0);
    if (round !== 0) return round;
    const leftAt = left.decidedAt ?? left.decided_at ?? left.openedAt ?? left.opened_at ?? 0;
    const rightAt = right.decidedAt ?? right.decided_at ?? right.openedAt ?? right.opened_at ?? 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
  });
}

function latestAcceptance(runtime, task, stage, acceptances = null) {
  const records = (acceptances ?? listAcceptances(runtime, { taskId: task.id, stage })).filter(
    (acceptance) =>
      acceptance &&
      acceptance.taskId === task.id &&
      (acceptance.stage ?? task.level) === stage,
  );
  const usable = records.filter((acceptance) => !acceptance.supersededAt);
  const ordered = sortAcceptanceRounds(usable.length > 0 ? usable : records);
  if (ordered.length > 0) return ordered[ordered.length - 1];
  if (task.openAcceptanceId && typeof runtime.acceptances?.get === 'function') {
    const open = runtime.acceptances.get(task.openAcceptanceId);
    if (open) return open;
  }
  return null;
}

function rubricFromAcceptance(acceptance) {
  const items = Array.isArray(acceptance.items) ? acceptance.items : [];
  return {
    id: acceptance.id ?? null,
    stage: 'business',
    items: items.map((item) => ({
      id: item.key ?? item.id,
      key: item.key ?? item.id,
      required: item.required !== false,
      verdict: item.state === 'waived' ? 'pass' : item.state,
      detail: item.detail,
    })),
  };
}

function acceptanceConclusion({ evaluateBusiness, task, acceptance }) {
  if (!acceptance) {
    return { result: 'missing', accepted: false, evaluation: null };
  }

  const items = Array.isArray(acceptance.items) ? acceptance.items : [];
  let evaluation = null;
  if (items.length > 0 && typeof evaluateBusiness === 'function') {
    try {
      evaluation = evaluateBusiness({
        stage: 'business',
        task,
        evidence: Array.isArray(acceptance.evidence) ? acceptance.evidence : [],
        rubric: rubricFromAcceptance(acceptance),
      });
    } catch (error) {
      evaluation = {
        result: 'blocked',
        items: [],
        error: error?.message ?? String(error),
      };
    }
  }

  const judged = evaluation?.result ?? null;
  let result;
  if (acceptance.state === 'passed') {
    // A passed round can still be downgraded when an independent evaluation
    // finds a failed or unjudgeable required item. It is never upgraded.
    result = judged === 'pass' || judged === null ? 'pass' : judged;
  } else if (acceptance.state === 'open') {
    result = 'pending';
  } else if (['blocked', 'void', 'superseded'].includes(acceptance.state)) {
    result = 'blocked';
  } else if (['revise', 'failed'].includes(acceptance.state)) {
    result = judged === 'blocked' ? 'blocked' : 'rework';
  } else {
    result = judged ?? 'blocked';
  }

  return {
    result,
    accepted: result === 'pass' && acceptance.state === 'passed',
    evaluation,
  };
}

function readList(value) {
  return Array.isArray(value) ? value : [];
}

function collectDeliverables(task, acceptance) {
  const candidates = [
    task?.deliverables,
    task?.subject?.deliverables,
    acceptance?.deliverables,
  ];
  const normalized = [];
  for (const list of candidates) {
    for (const entry of readList(list)) {
      if (typeof entry === 'string' && entry !== '') {
        normalized.push({ name: entry, path: entry, sha256: null });
      } else if (isPlainObject(entry)) {
        normalized.push(clone(entry));
      }
    }
  }
  return normalized;
}

function collectNeedsDecision(task) {
  const candidates = [
    task?.needs_decision,
    task?.needsDecision,
    task?.subject?.needs_decision,
    task?.subject?.needsDecision,
  ];
  const normalized = [];
  for (const list of candidates) {
    for (const entry of readList(list)) {
      if (typeof entry === 'string' && entry !== '') {
        normalized.push({ question: entry, options: [] });
      } else if (isPlainObject(entry)) {
        normalized.push(clone(entry));
      }
    }
  }
  return normalized;
}

function collectRisks(task) {
  const candidates = [task?.risks, task?.subject?.risks];
  return candidates.flatMap((list) =>
    readList(list).filter((entry) => typeof entry === 'string' && entry !== ''),
  );
}

function round6(value) {
  return Number(value.toFixed(6));
}

function countStates(tasks) {
  const counts = {};
  for (const task of tasks) {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
  }
  return counts;
}

function businessBlockers(task, acceptance, conclusion) {
  const blockers = [];
  const push = (code, message) => {
    if (!blockers.some((entry) => entry.code === code)) blockers.push({ code, message });
  };
  if (task.state === 'blocked') {
    push('task_blocked', task.blockedReason ?? `business task ${task.id} is blocked`);
  }
  if (task.state === 'paused') {
    push('task_paused', task.pausedReason ?? `business task ${task.id} is paused`);
  }
  if (task.state === 'cancelled') {
    push('task_cancelled', `business task ${task.id} was cancelled`);
  }
  if (!acceptance) {
    push('acceptance_missing', `business task ${task.id} has no acceptance round`);
  } else if (conclusion.result === 'pending') {
    push('acceptance_pending', `business task ${task.id} is still awaiting acceptance`);
  } else if (conclusion.result === 'rework') {
    push('acceptance_rework', `business task ${task.id} requires rework`);
  } else if (conclusion.result === 'blocked') {
    push('acceptance_blocked', `business task ${task.id} acceptance is blocked`);
  }
  return blockers;
}

function goalSignoff(runtime, goal, acceptances) {
  const acceptance = latestAcceptance(runtime, goal, 'goal', acceptances);
  if (!acceptance) return false;
  if (acceptance.state === 'passed') return true;
  return readList(acceptance.items).some(
    (item) => item?.key === 'human.goal_signoff' && item?.state === 'pass',
  );
}

function acceptanceView(acceptance, conclusion) {
  if (!acceptance) {
    return {
      id: null,
      state: 'missing',
      roundNo: null,
      result: 'missing',
      accepted: false,
      decidedAt: null,
      evaluation: null,
    };
  }
  return {
    id: acceptance.id ?? null,
    state: acceptance.state ?? 'open',
    roundNo: acceptance.roundNo ?? acceptance.round_no ?? null,
    result: conclusion.result,
    accepted: conclusion.accepted,
    decidedAt: acceptance.decidedAt ?? acceptance.decided_at ?? null,
    evaluation: conclusion.evaluation,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.runtime runtime facade (tasks/runs/acceptances/cost)
 * @param {object|Map} options.agents professional BOT registry, or `{chief,bots}`,
 *   or the `@dsbot/agents` module namespace
 * @param {object} options.acceptance `{ evaluate }` from `@dsbot/acceptance`
 * @param {object} options.metrics `{ computeMetrics }` from `@dsbot/metrics`
 * @param {object} [options.scope] Chief's own authorization scope
 * @param {() => number} [options.clock] injectable clock for `generatedAt`
 */
export function createChief({
  runtime,
  agents,
  acceptance,
  metrics,
  scope = {},
  clock = () => Date.now(),
} = {}) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('createChief requires { runtime }');
  }
  for (const path of ['tasks.create', 'tasks.get', 'tasks.list', 'cost.total']) {
    const [group, method] = path.split('.');
    if (!runtime[group] || typeof runtime[group][method] !== 'function') {
      throw new TypeError(`createChief requires runtime.${path}`);
    }
  }
  if (!runtime.acceptances || typeof runtime.acceptances !== 'object') {
    throw new TypeError('createChief requires runtime.acceptances');
  }
  if (typeof acceptance !== 'object' || acceptance === null || typeof acceptance.evaluate !== 'function') {
    throw new TypeError('createChief requires acceptance.evaluate (packages/acceptance)');
  }
  if (typeof metrics !== 'object' || metrics === null || typeof metrics.computeMetrics !== 'function') {
    throw new TypeError('createChief requires metrics.computeMetrics (packages/metrics)');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createChief clock must be a function');
  }

  const chiefScope = readAgentScope(scope, 'chief scope');
  const evaluator = acceptance.evaluate.bind(acceptance);
  const computeMetrics = metrics.computeMetrics.bind(metrics);
  const { chiefTools, bots } = normalizeAgents({ agents, runtime, scope: chiefScope });

  // -------------------------------------------------------------------------
  // openGoal
  // -------------------------------------------------------------------------
  function openGoal(input = {}) {
    return guard(() => {
      const title = readText(input.title, 'title');
      if (!title.ok) return title.result;

      const scopeResult = normalizeScope(
        input.scope ?? (typeof input.project === 'string' ? { projects: [input.project] } : null),
        'scope',
      );
      if (!scopeResult.ok) return scopeResult.result;

      const requestedScope = scopeResult.value;
      const authScope = { ...requestedScope };
      delete authScope.subject;
      delete authScope.budget;
      delete authScope.budgetCny;

      const project = projectOfScope(
        requestedScope,
        typeof input.project === 'string' ? input.project : null,
      );
      if (project !== null && !Array.isArray(authScope.projects)) {
        authScope.projects = [project];
      }

      const budget = readBudget(
        input.budgetCny ??
          input.budget_cny ??
          input.budget ??
          requestedScope.budget ??
          requestedScope.budgetCny ??
          null,
        'budgetCny',
      );
      if (!budget.ok) return budget.result;

      if (
        chiefScope.spend_cny_cap != null &&
        budget.cap != null &&
        budget.cap > chiefScope.spend_cny_cap + EPSILON
      ) {
        return fail(
          CHIEF_CODES.BUDGET_EXCEEDED,
          `goal budget ${budget.cap} CNY exceeds the Chief cap of ${chiefScope.spend_cny_cap} CNY`,
          { cap: chiefScope.spend_cny_cap, requested: budget.cap },
        );
      }

      const subject = isPlainObject(requestedScope.subject)
        ? clone(requestedScope.subject)
        : {};
      if (project !== null) subject.project = project;
      subject.mustConfirm = input.mustConfirm !== false;
      if (input.subject != null) {
        if (!isPlainObject(input.subject)) {
          return fail(CHIEF_CODES.VALIDATION_ERROR, 'subject must be a plain object', {
            field: 'subject',
          });
        }
        Object.assign(subject, clone(input.subject));
      }

      const task = runtime.tasks.create({
        level: 'goal',
        title: title.value,
        owner: 'chief',
        subject,
        budget: budget.budget,
        acceptanceProfile: clone(GOAL_ACCEPTANCE_PROFILE),
        authScope: Object.keys(authScope).length > 0 ? authScope : null,
        actor: 'chief',
      });

      return ok('openGoal', { goalId: task.id, goal: task, task });
    });
  }

  // -------------------------------------------------------------------------
  // delegate
  // -------------------------------------------------------------------------
  function readBrief(value, botName) {
    let raw = value ?? {};
    if (typeof raw === 'string') raw = { title: raw, text: raw };
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        result: fail(CHIEF_CODES.VALIDATION_ERROR, 'brief must be a string or plain object', {
          field: 'brief',
        }),
      };
    }

    const title = readText(
      raw.title ??
        raw.name ??
        raw.summary ??
        (typeof raw.brief === 'string' ? raw.brief : null) ??
        `${botName}: delegation`,
      'brief.title',
    );
    if (!title.ok) return { ok: false, result: title.result };

    const scope = normalizeScope(raw.scope ?? raw.authScope ?? null, 'brief.scope');
    if (!scope.ok) return { ok: false, result: scope.result };

    const budget = readBudget(
      raw.budgetCny ?? raw.budget_cny ?? raw.budget ?? raw.capCny ?? null,
      'brief.budgetCny',
    );
    if (!budget.ok) return { ok: false, result: budget.result };

    let subject = {};
    if (raw.subject != null) {
      if (!isPlainObject(raw.subject)) {
        return {
          ok: false,
          result: fail(CHIEF_CODES.VALIDATION_ERROR, 'brief.subject must be a plain object', {
            field: 'brief.subject',
          }),
        };
      }
      subject = clone(raw.subject);
    }

    return {
      ok: true,
      value: {
        title: title.value,
        text: typeof raw.brief === 'string' ? raw.brief : typeof raw.text === 'string' ? raw.text : null,
        scope: scope.value,
        budget,
        subject,
        acceptanceProfile: raw.acceptanceProfile ?? raw.profile ?? null,
      },
    };
  }

  function delegate(input = {}) {
    return guard(() => {
      const goalId = readGoalId(input);
      if (!goalId.ok) return goalId.result;
      const bot = readText(input.bot ?? input.toBot, 'bot');
      if (!bot.ok) return bot.result;

      const goal = runtime.tasks.get(goalId.value);
      if (goal.level !== 'goal') {
        return fail(
          CHIEF_CODES.NOT_ALLOWED,
          'the Chief delegates business tasks under a goal; execution work belongs to a business BOT',
          { role: 'chief', tool: 'delegate', goalId: goal.id, level: goal.level },
        );
      }
      if (goal.state === 'cancelled' || goal.state === 'completed') {
        return fail(
          CHIEF_CODES.NOT_ALLOWED,
          `goal ${goal.id} is ${goal.state}; it cannot accept a new delegation`,
          { role: 'chief', tool: 'delegate', goalId: goal.id, state: goal.state },
        );
      }

      const registration = bots.get(bot.value);
      if (!registration) {
        return fail(
          CHIEF_CODES.UNKNOWN_BOT,
          `bot ${bot.value} is not registered with the Chief`,
          { bot: bot.value, registered: [...bots.keys()].sort() },
        );
      }

      const briefSource =
        typeof input.brief === 'string'
          ? { ...input, brief: input.brief }
          : isPlainObject(input.brief)
            ? { ...input, ...input.brief }
            : input;
      const brief = readBrief(briefSource, bot.value);
      if (!brief.ok) return brief.result;

      const childScope = mergeScopes(registration.delegationScope, brief.value.scope);
      if (
        registration.scope.spend_cny_cap != null &&
        brief.value.budget.cap != null &&
        brief.value.budget.cap > registration.scope.spend_cny_cap + EPSILON
      ) {
        return fail(
          CHIEF_CODES.BUDGET_EXCEEDED,
          `delegation ${brief.value.budget.cap} CNY exceeds bot ${bot.value} cap of ${registration.scope.spend_cny_cap} CNY`,
          {
            bot: bot.value,
            cap: registration.scope.spend_cny_cap,
            requested: brief.value.budget.cap,
          },
        );
      }

      const remaining = remainingGoalBudget(runtime, goal);
      if (
        remaining !== null &&
        brief.value.budget.cap != null &&
        brief.value.budget.cap > remaining + EPSILON
      ) {
        return fail(
          CHIEF_CODES.BUDGET_EXCEEDED,
          `delegation ${brief.value.budget.cap} CNY exceeds the goal remaining budget of ${round6(remaining)} CNY`,
          { goalId: goal.id, cap: round6(remaining), requested: brief.value.budget.cap },
        );
      }

      const subject = {
        ...brief.value.subject,
        bot: bot.value,
        ...(brief.value.text ? { brief: brief.value.text } : {}),
      };

      const result = chiefTools.delegate({
        goalTaskId: goal.id,
        title: brief.value.title,
        toBot: bot.value,
        budget: brief.value.budget.budget,
        scope: Object.keys(childScope).length > 0 ? childScope : undefined,
        subject,
        acceptanceProfile:
          brief.value.acceptanceProfile ?? registration.acceptanceProfile ?? null,
      });
      if (!result.ok) return result;

      return ok('delegate', {
        goalId: goal.id,
        bot: bot.value,
        task: result.task,
        businessTask: result.task,
      });
    });
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  function statusView(goalId) {
    const goal = runtime.tasks.get(goalId);
    if (goal.level !== 'goal') {
      return fail(
        CHIEF_CODES.NOT_ALLOWED,
        'the Chief status view is scoped to a goal task',
        { role: 'chief', tool: 'status', goalId: goal.id, level: goal.level },
      );
    }

    const acceptances = allAcceptances(runtime);
    const businesses = runtime.tasks
      .list({ parentTaskId: goal.id, limit: 1000 })
      .filter((task) => task.level === 'business');

    const views = businesses.map((task) => {
      const acceptance = latestAcceptance(runtime, task, 'business', acceptances);
      const conclusion = acceptanceConclusion({ evaluateBusiness: evaluator, task, acceptance });
      const cost = costTotal(runtime, task.id);
      return {
        id: task.id,
        taskId: task.id,
        title: task.title,
        level: 'business',
        state: task.state,
        owner: task.owner,
        project: projectOfTask(task),
        budget: { capCny: budgetCap(task.budget) },
        acceptance: acceptanceView(acceptance, conclusion),
        conclusion: {
          result: conclusion.result,
          accepted: conclusion.accepted,
        },
        cost: { cny: cost.cny, entries: cost.entries },
        blockers: businessBlockers(task, acceptance, conclusion),
        deliverables: collectDeliverables(task, acceptance),
        risks: collectRisks(task),
        needsDecision: collectNeedsDecision(task),
        updatedAt: task.updatedAt ?? task.updated_at ?? null,
      };
    });

    const tasks = subtreeTasks(runtime, goal.id);
    const taskIds = new Set(tasks.map((task) => task.id));
    let cny = 0;
    let entryCount = 0;
    for (const task of tasks) {
      const total = costTotal(runtime, task.id);
      cny += total.cny;
      entryCount += total.entries;
    }
    const capCny = budgetCap(goal.budget);

    let runs = null;
    try {
      if (typeof runtime.runs?.list === 'function') {
        runs = runtime.runs
          .list({})
          .filter((run) => taskIds.has(run.taskId ?? run.task_id));
      }
    } catch {
      runs = null;
    }

    let metricsValue = null;
    let metricsError = null;
    try {
      const costs = [];
      if (typeof runtime.cost.list === 'function') {
        for (const task of tasks) {
          const rows = runtime.cost.list(task.id);
          if (Array.isArray(rows)) costs.push(...rows);
        }
      }
      if (costs.length === 0) {
        for (const task of tasks) {
          const total = costTotal(runtime, task.id);
          if (total.cny > 0) {
            costs.push({ task_id: task.id, cost_cny: total.cny, kind: 'llm' });
          }
        }
      }
      metricsValue = computeMetrics({
        tasks,
        runs: runs ?? [],
        acceptances,
        costs,
        clock: clock(),
      });
    } catch (error) {
      metricsError = error?.message ?? String(error);
    }

    const acceptanceCounts = {
      total: views.length,
      passed: views.filter((view) => view.acceptance.result === 'pass').length,
      rework: views.filter((view) => view.acceptance.result === 'rework').length,
      blocked: views.filter((view) => view.acceptance.result === 'blocked').length,
      pending: views.filter((view) => view.acceptance.result === 'pending').length,
      missing: views.filter((view) => view.acceptance.result === 'missing').length,
    };
    acceptanceCounts.allPassed =
      views.length > 0 && acceptanceCounts.passed === views.length;

    const blockers = [
      ...views.flatMap((view) =>
        view.blockers.map((blocker) => ({
          taskId: view.id,
          title: view.title,
          ...blocker,
        })),
      ),
    ];
    if (goal.state === 'blocked') {
      blockers.unshift({
        taskId: goal.id,
        title: goal.title,
        code: 'goal_blocked',
        message: goal.blockedReason ?? `goal ${goal.id} is blocked`,
      });
    }

    return ok('status', {
      goalId: goal.id,
      goal: {
        id: goal.id,
        taskId: goal.id,
        title: goal.title,
        state: goal.state,
        owner: goal.owner,
        project: projectOfTask(goal),
        budget: { capCny },
        mustConfirm: goal.subject?.mustConfirm === true,
        confirmed: goalSignoff(runtime, goal, acceptances),
        updatedAt: goal.updatedAt ?? goal.updated_at ?? null,
      },
      businesses: views,
      counts: countStates(businesses),
      acceptance: acceptanceCounts,
      cost: {
        cny: round6(cny),
        capCny,
        remainingCny: capCny === null ? null : round6(Math.max(0, capCny - cny)),
        entries: entryCount,
        runs: runs === null ? null : runs.length,
      },
      blockers,
      metrics: metricsValue,
      ...(metricsError === null ? {} : { metricsError }),
      generatedAt: clock(),
    });
  }

  function status(input = {}) {
    return guard(() => {
      const goalId = readGoalId(input);
      if (!goalId.ok) return goalId.result;
      return statusView(goalId.value);
    });
  }

  // -------------------------------------------------------------------------
  // deliver
  // -------------------------------------------------------------------------
  function deliver(input = {}) {
    return guard(() => {
      const goalId = readGoalId(input);
      if (!goalId.ok) return goalId.result;

      const view = statusView(goalId.value);
      if (!view.ok) return view;

      if (view.businesses.length === 0) {
        const blockers = [
          {
            taskId: view.goalId,
            code: 'no_business_delegations',
            message: 'delegate at least one business task before delivering',
          },
        ];
        const blocked = fail(
          CHIEF_CODES.BLOCKED,
          `goal ${view.goalId} has no business delegations; there is nothing to deliver`,
          {
            goalId: view.goalId,
            blockers,
            pending: [],
          },
        );
        blocked.blockers = blockers;
        blocked.pending = [];
        return blocked;
      }

      const unaccepted = view.businesses.filter(
        (business) =>
          business.acceptance.state !== 'passed' ||
          business.acceptance.result !== 'pass' ||
          business.blockers.length > 0,
      );
      if (unaccepted.length > 0) {
        const pending = unaccepted.map((business) => ({
          taskId: business.id,
          title: business.title,
          state: business.state,
          acceptanceState: business.acceptance.state,
          result: business.acceptance.result,
          blockers: business.blockers,
        }));
        const blockers = pending.flatMap((entry) =>
          entry.blockers.length > 0
            ? entry.blockers.map((blocker) => ({
                taskId: entry.taskId,
                title: entry.title,
                ...blocker,
              }))
            : [
                {
                  taskId: entry.taskId,
                  title: entry.title,
                  code: 'acceptance_not_passed',
                  message: `business acceptance is ${entry.acceptanceState} (${entry.result})`,
                },
              ],
        );
        const blocked = fail(
          CHIEF_CODES.BLOCKED,
          `${unaccepted.length} of ${view.businesses.length} business delegation(s) have not passed acceptance`,
          {
            goalId: view.goalId,
            blockers,
            pending,
          },
        );
        blocked.blockers = blockers;
        blocked.pending = pending;
        return blocked;
      }

      const businesses = view.businesses.map((business) => ({
        task_id: business.id,
        title: business.title,
        owner: business.owner,
        acceptance_id: business.acceptance.id,
        state: business.acceptance.state,
        result: business.acceptance.result,
      }));

      const deliverables = view.businesses.flatMap((business) =>
        business.deliverables.map((entry) => ({
          ...entry,
          task_id: business.id,
          business: business.owner,
        })),
      );

      const needsDecision = [
        ...view.businesses.flatMap((business) => business.needsDecision),
      ];
      const needsConfirmation = view.goal.mustConfirm && !view.goal.confirmed;
      if (needsConfirmation) {
        needsDecision.push({
          question: `Confirm goal "${view.goal.title}" is complete and ready to deliver?`,
          options: ['confirm', 'reject'],
        });
      }

      const resultPackage = {
        task_id: view.goalId,
        goal_id: view.goalId,
        goalId: view.goalId,
        title: view.goal.title,
        outcome: 'done',
        summary: `${view.businesses.length} business delegation(s) passed acceptance for goal "${view.goal.title}".`,
        deliverables,
        acceptance: {
          stage: 'business',
          result: 'passed',
          businesses,
        },
        cost: {
          cny: view.cost.cny,
          capCny: view.cost.capCny,
          remainingCny: view.cost.remainingCny,
          entries: view.cost.entries,
          runs: view.cost.runs,
        },
        risks: view.businesses.flatMap((business) => business.risks),
        needs_decision: needsDecision,
        must_confirm: view.goal.mustConfirm,
        needs_confirmation: needsConfirmation,
      };

      const response = ok('deliver', resultPackage);
      Object.defineProperty(response, 'package', {
        value: resultPackage,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return response;
    });
  }

  // -------------------------------------------------------------------------
  // No-leapfrog denial
  // -------------------------------------------------------------------------
  function deny(tool) {
    return fail(
      CHIEF_CODES.NOT_ALLOWED,
      'the Chief must not dispatch execution work; a business BOT owns execution dispatch',
      { role: 'chief', tool },
    );
  }

  function dispatchExecution() {
    return deny('dispatchExecution');
  }

  const surface = {
    role: 'chief',
    toolNames: Object.freeze([...CHIEF_TOOLS]),
    openGoal,
    delegate,
    status,
    deliver,
    dispatchExecution,
  };
  for (const tool of ['dispatch', 'plan', 'rework']) {
    Object.defineProperty(surface, tool, {
      value: () => deny(tool),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return surface;
}
