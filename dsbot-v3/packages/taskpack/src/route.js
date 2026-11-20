/**
 * Dual-path routing (`docs/prd/16-execution-paths.md` §4).
 *
 * `choosePath({taskPack, capability})` returns
 *
 *     { executor_kind: "dsh_session" | "superagent",
 *       routing_reason: { path, score, why, degraded, … } }
 *
 * The BOT decides, never the user. The reasons are machine-readable so they
 * can be stored as `run.routing_reason` and audited later (T-PATH-03).
 *
 * Rules, in order:
 *   - the task pack must satisfy the task pack schema;
 *   - a pack with any complexity signal (more than five estimated steps, more
 *     than one stage, independent acceptance checks, multiple verification
 *     rounds, an isolated worktree, a multi-file change or a long-running
 *     task) requests `superagent`; otherwise it requests `dsh_session`;
 *   - if the requested path is unavailable in `capability`, the router chooses
 *     the other path and MUST mark the decision `degraded: true` with a
 *     reason. A degradation is never silent; when neither path is available
 *     the router throws `executor_unavailable` instead of pretending.
 *
 * Pure: no IO, clock, randomness or input mutation.
 */

import { MAX_SESSION_STEPS } from './constants.js';
import { TaskPackError, taskPackErrorFrom } from './errors.js';
import { acceptanceIndependent, firstText } from './normalize.js';
import { validatePack } from './validate.js';
import { isPlainObject } from './values.js';

/**
 * @param {{taskPack: object, capability: object}} input
 * @returns {{executor_kind: 'dsh_session' | 'superagent', routing_reason: object}}
 * @throws {TaskPackError} `invalid_pack` / `unknown_field` for a bad pack,
 *   `executor_unavailable` when neither path is available
 */
export function choosePath({ taskPack, capability } = {}) {
  const validated = validatePack(taskPack);
  if (!validated.ok) throw taskPackErrorFrom(validated.errors);

  const assessment = classifyTaskPack(taskPack);
  const requested = assessment.executor_kind;
  const requestedCapability = readCapability(capability, requested);

  if (requestedCapability.available) {
    return {
      executor_kind: requested,
      routing_reason: {
        path: requested,
        score: assessment.score,
        why: assessment.why,
        degraded: false,
      },
    };
  }

  const fallback = requested === 'superagent' ? 'dsh_session' : 'superagent';
  const fallbackCapability = readCapability(capability, fallback);
  if (!fallbackCapability.available) {
    throw new TaskPackError(
      'executor_unavailable',
      'capability',
      `neither executor path is available (${requested}: ${requestedCapability.reason}; ${fallback}: ${fallbackCapability.reason})`,
    );
  }

  return {
    executor_kind: fallback,
    routing_reason: {
      path: fallback,
      requested_path: requested,
      score: assessment.score,
      why: [...assessment.why, `${requested}_unavailable`],
      degraded: true,
      reason: `${requested} capability unavailable: ${requestedCapability.reason}`,
    },
  };
}

/**
 * Classify a validated task pack without considering capabilities. Exported
 * so a caller can log the raw assessment even when routing later degrades.
 *
 * @param {object} taskPack
 * @returns {{executor_kind: 'dsh_session' | 'superagent', score: number, why: string[]}}
 */
export function classifyTaskPack(taskPack) {
  const signals = isPlainObject(taskPack?.signals) ? taskPack.signals : {};
  const reasons = [];
  let score = 0;

  if (signals.estimated_steps !== undefined) {
    if (signals.estimated_steps > MAX_SESSION_STEPS) {
      score += 1;
      reasons.push(`steps>${MAX_SESSION_STEPS}`);
    } else {
      reasons.push(`steps<=${MAX_SESSION_STEPS}`);
    }
  }

  if (Array.isArray(signals.stages)) {
    if (signals.stages.length > 1) {
      score += 1;
      reasons.push('multi_stage');
    } else {
      reasons.push('single_stage');
    }
  }

  if (signals.multi_file !== undefined) {
    if (signals.multi_file) {
      score += 1;
      reasons.push('multi_file');
    } else {
      reasons.push('single_file');
    }
  }

  if (signals.multiple_rounds !== undefined) {
    if (signals.multiple_rounds) {
      score += 1;
      reasons.push('multiple_rounds');
    } else {
      reasons.push('single_round_verification');
    }
  }

  if (signals.isolated_worktree !== undefined) {
    if (signals.isolated_worktree) {
      score += 1;
      reasons.push('isolated_worktree');
    } else {
      reasons.push('shared_workspace');
    }
  }

  if (signals.long_running !== undefined) {
    if (signals.long_running) {
      score += 1;
      reasons.push('long_running');
    } else {
      reasons.push('short_running');
    }
  }

  if (acceptanceIndependent(taskPack?.acceptance).length > 0) {
    score += 1;
    reasons.push('independent_acceptance');
  }

  if (reasons.length === 0) reasons.push('simple_single_step');

  return {
    executor_kind: score > 0 ? 'superagent' : 'dsh_session',
    score,
    why: reasons,
  };
}

/**
 * Normalize one capability probe entry.
 *
 * Accepted shapes:
 *   - `true` / `false`;
 *   - `{available: true|false, reason?, why?, message?}`.
 *
 * Anything missing or malformed counts as unavailable, with a reason; a
 * missing probe is never treated as "available" (that would degrade silently).
 *
 * @returns {{available: boolean, reason: string | null}}
 */
export function readCapability(capability, kind) {
  const entry = isPlainObject(capability) ? capability[kind] : undefined;

  if (entry === true) return { available: true, reason: null };
  if (entry === false) {
    return { available: false, reason: 'reported unavailable' };
  }

  if (isPlainObject(entry)) {
    if (entry.available === true) return { available: true, reason: null };
    const reason = firstText(entry.reason, entry.why, entry.message);
    return {
      available: false,
      reason: reason ?? 'reported unavailable',
    };
  }

  if (entry === undefined) {
    return {
      available: false,
      reason: 'not reported by the capability probe',
    };
  }

  return {
    available: false,
    reason: 'entry is malformed',
  };
}
