/**
 * Small input/context helpers shared by the Chief and business tool sets.
 */

import { budgetCap } from './budget.js';
import { isPlainObject } from '../../authz/src/values.js';
import { resolveProject, resolveTaskScope, checkProject } from './scope.js';
import { validationError } from './result.js';

export function assertRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('create*Tools requires { runtime }');
  }
  for (const path of ['tasks.get', 'tasks.list', 'cost.total']) {
    const [group, method] = path.split('.');
    assertFunction(runtime[group], method, `runtime.${path}`);
  }
}

export function assertFunction(target, method, label) {
  if (!target || typeof target[method] !== 'function') {
    throw new TypeError(`${label} is required`);
  }
}

export function readString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, result: validationError(`${field} must be a non-empty string`, { field }) };
  }
  return { ok: true, value };
}

/** Read an optional CNY cap from `budget` object or a scalar alias. */
export function readRequestedCap(input) {
  if (input?.budget != null) {
    if (!isPlainObject(input.budget)) {
      return { ok: false, result: validationError('budget must be a plain object', { field: 'budget' }) };
    }
    const cap = budgetCap(input.budget);
    if (cap === null) {
      return {
        ok: false,
        result: validationError('budget must declare a non-negative capCny', { budget: input.budget }),
      };
    }
    return { ok: true, cap, budget: structuredClone(input.budget) };
  }
  for (const key of ['budgetCny', 'budget_cny']) {
    if (input?.[key] != null) {
      const cap = input[key];
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
        return { ok: false, result: validationError(`${key} must be a non-negative finite number`, { field: key }) };
      }
      return { ok: true, cap, budget: { capCny: cap } };
    }
  }
  return { ok: true, cap: null, budget: null };
}

export function readSubject(value) {
  if (value == null) return { ok: true, subject: {} };
  if (!isPlainObject(value)) {
    return { ok: false, result: validationError('subject must be a plain object', { field: 'subject' }) };
  }
  return { ok: true, subject: structuredClone(value) };
}

/**
 * Resolve the scope and project for one task, or return the denial result.
 * Every task-touching tool funnels through this so project and delegated-scope
 * checks cannot drift apart.
 */
export function taskAccess(runtime, botScope, task) {
  const resolved = resolveTaskScope(botScope, task);
  if (!resolved.ok) return resolved;

  const project = resolveProject(runtime, task);
  const projectCheck = checkProject(resolved.scope, project);
  if (!projectCheck.ok) {
    return {
      ok: false,
      code: projectCheck.code,
      message: projectCheck.message,
      details: projectCheck.details,
    };
  }
  return { ok: true, scope: resolved.scope, project };
}

/** True when the caller tries to mark a human-class acceptance item as passed. */
export function humanSignoffAttempt(itemStates) {
  if (itemStates == null || typeof itemStates !== 'object') return null;
  const entries = Array.isArray(itemStates)
    ? itemStates.filter((entry) => entry && typeof entry.key === 'string').map((entry) => [entry.key, entry])
    : Object.entries(itemStates).map(([key, entry]) => [
        key,
        typeof entry === 'string' ? { state: entry } : { key, ...(entry ?? {}) },
      ]);
  for (const [key, entry] of entries) {
    if (key.startsWith('human.') && entry?.state === 'pass') return key;
  }
  return null;
}

export function summarizeTasks(runtime, tasks) {
  return tasks.map((task) => ({
    id: task.id,
    level: task.level,
    parentTaskId: task.parentTaskId,
    title: task.title,
    state: task.state,
    project: resolveProject(runtime, task),
    updatedAt: task.updatedAt,
  }));
}
