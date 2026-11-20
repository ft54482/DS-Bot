import { NOTIFY_EVENTS } from './constants.js';
import {
  isRecord,
  normalizeLevel,
  normalizeReason,
  normalizeRun,
  normalizeTask,
} from './normalize.js';

/**
 * Every notification carries the same four context fields, even when they are
 * not applicable: `task` and `run` objects, the `reason` string and the
 * escalation `level` (null for non-escalation events). Consumers can therefore
 * render one template without shape checks.
 */
function template({ event, at, seq, task, run, reason, level, title, message, dedupeKey }) {
  return {
    id: `${event}-${at}-${seq}`,
    event,
    kind: event,
    created_at: new Date(at).toISOString(),
    task,
    run,
    reason,
    level,
    title,
    message,
    dedupe_key: dedupeKey,
  };
}

function taskReason(task, fallback) {
  return normalizeReason(
    task.reason ?? task.blocked_reason ?? task.blockedReason ?? task.detail,
    fallback,
  );
}

export function buildStuck(task, { at, seq }) {
  const subject = normalizeTask(task, 'task');
  const reason = taskReason(task, 'stuck');
  const taskId = subject.id;

  return template({
    event: NOTIFY_EVENTS.STUCK,
    at,
    seq,
    task: subject,
    run: null,
    reason,
    level: null,
    title: `Task ${taskId} is stuck`,
    message: `Task ${taskId} is stuck: ${reason}`,
    dedupeKey: `${NOTIFY_EVENTS.STUCK}:${taskId}`,
  });
}

export function buildFailed(run, reasonInput, { at, seq }) {
  const subject = normalizeRun(run, 'run');
  const task = isRecord(run.task)
    ? normalizeTask(run.task, 'run.task')
    : subject.task_id === null
      ? null
      : { id: subject.task_id, level: null, state: null, owner: null };
  const reason = normalizeReason(
    reasonInput ?? run.failure_reason ?? run.failureReason ?? run.reason,
    'unknown_failure',
  );

  return template({
    event: NOTIFY_EVENTS.FAILED,
    at,
    seq,
    task,
    run: subject,
    reason,
    level: null,
    title: `Run ${subject.id} failed`,
    message:
      task === null
        ? `Run ${subject.id} failed: ${reason}`
        : `Run ${subject.id} for task ${task.id} failed: ${reason}`,
    dedupeKey: `${NOTIFY_EVENTS.FAILED}:${subject.id}`,
  });
}

export function buildOverBudget(task, { at, seq }) {
  const subject = normalizeTask(task, 'task');
  const reason = taskReason(task, 'budget_exceeded');
  const taskId = subject.id;

  return template({
    event: NOTIFY_EVENTS.OVER_BUDGET,
    at,
    seq,
    task: subject,
    run: null,
    reason,
    level: null,
    title: `Task ${taskId} is over budget`,
    message: `Task ${taskId} is over budget: ${reason}`,
    dedupeKey: `${NOTIFY_EVENTS.OVER_BUDGET}:${taskId}`,
  });
}

export function buildEscalation(task, { at, seq, level }) {
  const subject = normalizeTask(task, 'task');
  const resolvedLevel = normalizeLevel(level);
  const reason = taskReason(task, 'escalation');
  const taskId = subject.id;

  return template({
    event: NOTIFY_EVENTS.ESCALATION,
    at,
    seq,
    task: subject,
    run: null,
    reason,
    level: resolvedLevel,
    title: `Task ${taskId} escalated to level ${resolvedLevel}`,
    message: `Task ${taskId} escalated to level ${resolvedLevel}: ${reason}`,
    dedupeKey: `${NOTIFY_EVENTS.ESCALATION}:${taskId}:${String(resolvedLevel)}`,
  });
}
