/**
 * Budget gate for the agent tool surface.
 *
 * The arithmetic is `packages/authz`'s `effectiveBudget` (min-chain of task cap,
 * parent remaining and bot cap). This module supplies the runtime-derived
 * quantities it needs: capability from a task budget object, spend already
 * recorded on a task, and spend across an aggregate task's subtree.
 */

import { effectiveBudget } from '../../authz/src/index.js';
import { AGENT_CODES } from './constants.js';
import { budgetExceeded } from './result.js';

const EPSILON = 1e-9;

/**
 * Read a CNY cap from a task budget object. The service stores whatever shape
 * the caller supplied, so accept the PRD spelling and the common aliases.
 *
 * @returns {number|null} null when the task has no explicit cap
 */
export function budgetCap(budget) {
  if (budget == null || typeof budget !== 'object') return null;
  for (const key of ['capCny', 'cny_cap', 'cap_cny']) {
    const value = budget[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function spentOn(runtime, taskId) {
  return runtime.cost.total(taskId).costCny;
}

/** Sum the cost ledger across a task and every descendant. */
export function subtreeSpend(runtime, rootTaskId) {
  let total = 0;
  const seen = new Set();
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    total += spentOn(runtime, taskId);
    for (const child of runtime.tasks.list({ parentTaskId: taskId })) queue.push(child.id);
  }
  return total;
}

/**
 * Check that `requested` still fits under the effective cap.
 *
 * `requested` is the amount being committed now: a child budget allocation for
 * `plan`/`delegate`, or an optional cost estimate for `dispatch`. Existing spend
 * is always counted, and an exhausted parent cap blocks even a zero-cost call.
 *
 * @returns {{ok: true, cap: number, remaining: number} | {ok: false, code: string, message: string, details?: object}}
 */
export function checkBudget({ runtime, task = null, parentTask = null, scope = {}, requested = 0 }) {
  const taskCap = task ? budgetCap(task.budget) : null;
  const parentCap = parentTask ? budgetCap(parentTask.budget) : null;
  const parentSpent = parentTask ? subtreeSpend(runtime, parentTask.id) : 0;
  const parentRemaining = parentCap === null ? null : Math.max(0, parentCap - parentSpent);
  const spent = task ? spentOn(runtime, task.id) : 0;
  const amount = Number(requested ?? 0);

  if (!Number.isFinite(amount) || amount < 0) {
    return {
      ok: false,
      code: AGENT_CODES.VALIDATION_ERROR,
      message: 'requested budget must be a non-negative finite number',
      details: { requested },
    };
  }

  if (parentCap !== null && parentRemaining <= EPSILON) {
    return budgetExceeded(
      parentSpent > parentCap
        ? `parent task ${parentTask.id} already spent ${parentSpent} CNY over its ${parentCap} CNY cap`
        : `parent task ${parentTask.id} has no remaining budget`,
      { taskId: parentTask.id, cap: parentCap, spent: parentSpent, remaining: 0 },
    );
  }

  if (taskCap !== null && spent >= taskCap - EPSILON) {
    return budgetExceeded(
      `task ${task.id} already spent ${spent} CNY against a ${taskCap} CNY cap`,
      { taskId: task.id, cap: taskCap, spent },
    );
  }

  const gate = effectiveBudget({
    taskCap: taskCap ?? null,
    parentRemaining: parentRemaining ?? null,
    botCap: scope?.spend_cny_cap ?? null,
    requested: amount,
    spent,
    reserved: 0,
  });

  if (!gate.ok) {
    return budgetExceeded(
      `requested ${amount} CNY exceeds the effective cap of ${gate.cap} CNY`,
      {
        cap: gate.cap,
        requested: amount,
        spent,
        parentRemaining,
        botCap: scope?.spend_cny_cap ?? null,
        committed: gate.committed,
      },
    );
  }

  return { ok: true, cap: gate.cap, remaining: gate.remaining };
}
