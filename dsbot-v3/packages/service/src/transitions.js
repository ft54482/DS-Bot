/**
 * Legal transition tables.
 *
 * Task rows: PRD 03 §3.2 (T-01..T-36) plus the `reworking` alias from
 * 02-api-contract §2.3 (acceptance revise -> reworking, then -> running when the
 * derived rework run starts). Run rows: PRD 03 §3.5 (R-01..R-24), with cancel
 * paths expressed without the intermediate `cancelling` state (see states.js).
 * Acceptance rows: PRD 03 §4.7/§4.8.
 *
 * These are pure data + pure predicates; the service adds guards and the
 * persistence side effects only after a transition is known to be legal.
 */
const task = {
  planned: ['queued', 'blocked', 'paused', 'cancelled', 'stopping'],
  queued: ['running', 'blocked', 'paused', 'cancelled', 'stopping'],
  running: ['accepting', 'blocked', 'paused', 'queued', 'cancelled', 'stopping'],
  accepting: [
    'completed',
    'queued',
    'reworking',
    'blocked',
    'paused',
    'running',
    'cancelled',
    'stopping',
  ],
  reworking: ['running', 'queued', 'blocked', 'paused', 'cancelled', 'stopping'],
  blocked: ['queued', 'accepting', 'planned', 'cancelled', 'stopping'],
  paused: ['queued', 'planned', 'accepting', 'cancelled', 'stopping'],
  // completed -> queued is an explicit human reopen (T-31);
  // completed -> blocked invalidates the ancestor after a descendant reopen (T-35).
  completed: ['queued', 'blocked'],
  stopping: ['cancelled', 'blocked'],
  cancelled: [],
};

const run = {
  queued: ['dispatched', 'cancelled'],
  dispatched: ['running', 'dispatch_unknown', 'cancelled'],
  dispatch_unknown: ['running', 'queued', 'failed', 'cancelled'],
  running: ['reported', 'failed', 'lost', 'timed_out', 'cancelled'],
  reported: ['accepted', 'rejected', 'invalidated', 'superseded', 'cancelled'],
  failed: ['superseded'],
  lost: ['superseded'],
  timed_out: ['superseded'],
  accepted: [],
  rejected: [],
  cancelled: [],
  invalidated: [],
  superseded: [],
};

const acceptance = {
  open: ['passed', 'revise', 'failed', 'blocked', 'void', 'superseded'],
  passed: [],
  revise: [],
  failed: [],
  blocked: [],
  void: [],
  superseded: [],
};

function freezeTable(table) {
  const frozen = {};
  for (const [from, to] of Object.entries(table)) {
    frozen[from] = Object.freeze([...to]);
  }
  return Object.freeze(frozen);
}

export const TASK_TRANSITIONS = freezeTable(task);
export const RUN_TRANSITIONS = freezeTable(run);
export const ACCEPTANCE_TRANSITIONS = freezeTable(acceptance);

function check(table, from, to) {
  if (!Object.prototype.hasOwnProperty.call(table, from)) {
    return { allowed: false, from, to, reason: 'unknown_from_state' };
  }
  if (from === to) {
    return { allowed: false, from, to, reason: 'self_transition' };
  }
  if (!table[from].includes(to)) {
    return { allowed: false, from, to, reason: 'not_in_transition_table' };
  }
  return { allowed: true, from, to, reason: null };
}

export function checkTaskTransition(from, to) {
  return check(TASK_TRANSITIONS, from, to);
}

export function checkRunTransition(from, to) {
  return check(RUN_TRANSITIONS, from, to);
}

export function checkAcceptanceTransition(from, to) {
  return check(ACCEPTANCE_TRANSITIONS, from, to);
}

export function nextTaskStates(from) {
  return [...(TASK_TRANSITIONS[from] ?? [])];
}

export function nextRunStates(from) {
  return [...(RUN_TRANSITIONS[from] ?? [])];
}

export function nextAcceptanceStates(from) {
  return [...(ACCEPTANCE_TRANSITIONS[from] ?? [])];
}
