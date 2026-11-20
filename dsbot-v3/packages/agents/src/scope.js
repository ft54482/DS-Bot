/**
 * Scope reads and checks for the agent tool surface.
 *
 * The authority model itself lives in `packages/authz`; this module only
 * projects a task tree onto that model:
 *
 *  - a bot's configured scope is validated once at construction;
 *  - a task's own `authScope` is intersected with the bot scope, so a narrower
 *    delegation can never be widened by the tool layer;
 *  - `projects` decides which task trees the bot may touch;
 *  - `executors` (or the legacy `tools` alias) decides which executor kinds it
 *    may dispatch to. An absent allow-list is fail-closed, never "all".
 */

import { effectiveScope } from '../../authz/src/index.js';
import { cloneValue, isPlainObject } from '../../authz/src/values.js';
import { LEVEL_RANK } from '../../authz/src/constants.js';
import { AGENT_CODES } from './constants.js';
import { authorizationExceeded } from './result.js';

const STRING_LIST_KEYS = Object.freeze(['projects', 'executors', 'tools']);

function readStringList(scope, key, label) {
  const value = scope[key];
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new TypeError(`${label}.${key} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

/**
 * Validate and normalise a bot scope. Unknown keys are preserved: `authz` owns
 * their containment semantics (`git`, extra capabilities, ...).
 *
 * @param {object|null|undefined} scope
 * @param {string} [label]
 * @returns {Readonly<object>}
 * @throws {TypeError} when the scope is malformed
 */
export function readAgentScope(scope, label = 'scope') {
  if (scope == null) return Object.freeze({});
  if (!isPlainObject(scope)) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const normalized = cloneValue(scope);
  for (const key of STRING_LIST_KEYS) {
    const list = readStringList(normalized, key, label);
    if (list !== undefined) normalized[key] = list;
  }

  const cap = normalized.spend_cny_cap;
  if (cap != null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0)) {
    throw new TypeError(`${label}.spend_cny_cap must be a non-negative finite number`);
  }

  const level = normalized.max_delegate_level;
  if (level != null && !Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)) {
    throw new TypeError(
      `${label}.max_delegate_level must be one of ${Object.keys(LEVEL_RANK).join(', ')}`,
    );
  }

  return Object.freeze(normalized);
}

/**
 * Intersect the bot scope with a task's delegated auth scope.
 *
 * @returns {{ok: true, scope: object} | {ok: false, code: string, message: string, details?: object}}
 */
export function resolveTaskScope(botScope, task) {
  const taskAuthScope = task?.authScope ?? null;
  if (taskAuthScope == null) return { ok: true, scope: botScope };

  const intersection = effectiveScope(botScope, taskAuthScope);
  if (!intersection.ok) {
    return authorizationExceeded(
      `task ${task.id} carries a delegated scope that exceeds the bot scope`,
      { taskId: task.id, violations: intersection.violations },
    );
  }
  return { ok: true, scope: Object.freeze(intersection.scope) };
}

/**
 * Project a task tree's project.
 *
 * The task's own `subject.project`, an explicit `authScope.project`, or a
 * single delegated `authScope.projects` entry wins; ancestors are consulted
 * because a child inherits its tree. A readiness claim replaces an aggregate
 * task's subject with `{children:[...]}`, so as a final step the nearest
 * consistent project among descendants is used. More than one distinct project
 * in a subtree is ambiguous and returns null (fail closed).
 */
export function resolveProject(runtime, task) {
  const direct = projectOfTask(task);
  if (direct !== null) return direct;

  let cursor = task;
  const seenAncestors = new Set();
  while (
    cursor &&
    typeof cursor === 'object' &&
    typeof cursor.parentTaskId === 'string' &&
    cursor.parentTaskId !== ''
  ) {
    if (seenAncestors.has(cursor.parentTaskId)) break;
    seenAncestors.add(cursor.parentTaskId);
    cursor = runtime.tasks.get(cursor.parentTaskId);
    const inherited = projectOfTask(cursor);
    if (inherited !== null) return inherited;
  }

  const projects = new Set();
  const seen = new Set();
  const queue = [task.id];
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    const node = runtime.tasks.get(taskId);
    const project = projectOfTask(node);
    if (project !== null) projects.add(project);
    for (const child of runtime.tasks.list({ parentTaskId: taskId })) queue.push(child.id);
  }
  return projects.size === 1 ? [...projects][0] : null;
}

function projectOfTask(task) {
  const subjectProject = task?.subject?.project;
  if (typeof subjectProject === 'string' && subjectProject !== '') return subjectProject;

  const authProject = task?.authScope?.project;
  if (typeof authProject === 'string' && authProject !== '') return authProject;

  const authProjects = task?.authScope?.projects;
  if (Array.isArray(authProjects) && authProjects.length === 1) return authProjects[0];

  return null;
}

/** Check a project against `scope.projects` (absent = unconstrained). */
export function checkProject(scope, project) {
  if (!Array.isArray(scope.projects)) return { ok: true };
  if (typeof project !== 'string' || project === '') {
    return {
      ok: false,
      code: AGENT_CODES.AUTHORIZATION_EXCEEDED,
      reason: 'project_unknown',
      message: 'the task has no project, so it cannot be proven inside the bot scope',
      details: { reason: 'project_unknown' },
    };
  }
  if (!scope.projects.includes(project)) {
    return {
      ok: false,
      code: AGENT_CODES.AUTHORIZATION_EXCEEDED,
      reason: 'project_not_in_scope',
      message: `project ${project} is outside the bot scope`,
      details: { reason: 'project_not_in_scope', project, allowed: scope.projects },
    };
  }
  return { ok: true };
}

/** Executor allow-list; `executors` takes precedence over the `tools` alias. */
export function executorAllowList(scope) {
  const list = scope.executors ?? scope.tools;
  return Array.isArray(list) ? list : null;
}

/** Check an executor kind against the scope allow-list (absent = deny all). */
export function checkExecutor(scope, executorKind) {
  const allowed = executorAllowList(scope);
  if (allowed === null) {
    return {
      ok: false,
      code: AGENT_CODES.AUTHORIZATION_EXCEEDED,
      reason: 'executor_scope_missing',
      message: 'the bot scope does not declare an executor allow-list',
      details: { reason: 'executor_scope_missing', executorKind },
    };
  }
  if (!allowed.includes(executorKind)) {
    return {
      ok: false,
      code: AGENT_CODES.AUTHORIZATION_EXCEEDED,
      reason: 'executor_not_in_scope',
      message: `executor ${executorKind} is outside the bot scope`,
      details: { reason: 'executor_not_in_scope', executorKind, allowed },
    };
  }
  return { ok: true };
}

/** True when `level` is at or below the scope's delegation ceiling. */
export function checkDelegationLevel(scope, level) {
  const ceiling = scope.max_delegate_level;
  if (ceiling == null) return { ok: true };
  if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)) {
    return {
      ok: false,
      code: AGENT_CODES.VALIDATION_ERROR,
      message: `unknown task level: ${level}`,
    };
  }
  if (LEVEL_RANK[level] > LEVEL_RANK[ceiling]) {
    return {
      ok: false,
      code: AGENT_CODES.AUTHORIZATION_EXCEEDED,
      reason: 'level_exceeds_scope',
      message: `level ${level} exceeds the scope ceiling ${ceiling}`,
      details: { level, ceiling },
    };
  }
  return { ok: true };
}

/** Walk the subtree iteratively; returns tasks in depth-first order. */
export function walkSubtree(runtime, rootTaskId) {
  const result = [];
  const seen = new Set();
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    const task = runtime.tasks.get(taskId);
    result.push(task);
    for (const child of runtime.tasks.list({ parentTaskId: task.id })) {
      queue.push(child.id);
    }
  }
  return result;
}
