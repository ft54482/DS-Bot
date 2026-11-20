import {
  DEDUPE_WINDOW_MS,
  MAX_ESCALATIONS,
  NOTIFY_EVENTS,
  SUPPRESS_REASONS,
} from './constants.js';
import { resolveClock, taskIdOf } from './normalize.js';
import {
  buildEscalation,
  buildFailed,
  buildOverBudget,
  buildStuck,
} from './templates.js';

/**
 * Default sender: writes one JSON line to stdout with `console.log` only.
 *
 * The notifier is deliberately not allowed to reach the network or the file
 * system on its own. A deployment injects its Feishu/webhook/IM sender; tests
 * inject a collecting function.
 */
export function defaultSend(notification) {
  console.log(JSON.stringify(notification));
}

/**
 * Create an alerting notifier.
 *
 * @param {object} [options]
 * @param {(notification: object) => unknown} [options.send] injected sender;
 *   the default only calls `console.log`.
 * @param {number|string|Date|(() => number|string|Date)} [options.now] clock,
 *   injected so the five-minute dedupe window is deterministic in tests.
 * @param {number} [options.dedupeWindowMs=300000] dedupe window.
 * @param {number} [options.maxEscalations=2] delivered escalation cap per task.
 * @returns {{stuck: Function, failed: Function, overBudget: Function, escalate: Function}}
 */
export function createNotifier(options = {}) {
  const {
    send = defaultSend,
    now,
    clock,
    dedupeWindowMs = DEDUPE_WINDOW_MS,
    maxEscalations = MAX_ESCALATIONS,
  } = options ?? {};

  if (typeof send !== 'function') {
    throw new TypeError('createNotifier requires `send` to be a function');
  }
  if (typeof dedupeWindowMs !== 'number' || !Number.isFinite(dedupeWindowMs) || dedupeWindowMs < 0) {
    throw new TypeError('`dedupeWindowMs` must be a finite, non-negative number');
  }
  if (!Number.isInteger(maxEscalations) || maxEscalations < 1) {
    throw new TypeError('`maxEscalations` must be a positive integer');
  }

  const getNow = resolveClock(now ?? clock);
  const lastSentAt = new Map();
  const escalationsByTask = new Map();
  let sequence = 0;

  function deliver(notification, at) {
    const key = notification.dedupe_key;
    const previous = lastSentAt.get(key);

    // At exactly five minutes the event is old enough to notify again; only a
    // strictly shorter interval is a duplicate.
    if (previous !== undefined && at - previous < dedupeWindowMs) {
      return {
        delivered: false,
        reason: SUPPRESS_REASONS.DUPLICATE,
        notification,
      };
    }

    send(notification);
    lastSentAt.set(key, at);

    if (notification.event === NOTIFY_EVENTS.ESCALATION) {
      const taskId = notification.task.id;
      escalationsByTask.set(taskId, (escalationsByTask.get(taskId) ?? 0) + 1);
    }

    return { delivered: true, reason: null, notification };
  }

  function nextSequence() {
    sequence += 1;
    return sequence;
  }

  function emitStuck(task) {
    const at = getNow();
    return deliver(buildStuck(task, { at, seq: nextSequence() }), at);
  }

  function emitFailed(run, reason) {
    const at = getNow();
    return deliver(buildFailed(run, reason, { at, seq: nextSequence() }), at);
  }

  function emitOverBudget(task) {
    const at = getNow();
    return deliver(buildOverBudget(task, { at, seq: nextSequence() }), at);
  }

  function emitEscalation(task, level) {
    const at = getNow();
    const taskId = taskIdOf(task);
    const delivered = escalationsByTask.get(taskId) ?? 0;

    if (delivered >= maxEscalations) {
      return {
        delivered: false,
        reason: SUPPRESS_REASONS.ESCALATION_LIMIT,
        notification: buildEscalation(task, {
          at,
          seq: nextSequence(),
          level: level ?? delivered + 1,
        }),
      };
    }

    return deliver(
      buildEscalation(task, {
        at,
        seq: nextSequence(),
        level: level ?? delivered + 1,
      }),
      at,
    );
  }

  return {
    stuck: emitStuck,
    failed: emitFailed,
    overBudget: emitOverBudget,
    escalate: emitEscalation,
  };
}

export { DEDUPE_WINDOW_MS, MAX_ESCALATIONS, NOTIFY_EVENTS, SUPPRESS_REASONS };
export { defaultSend as sendToConsole };
