/**
 * Adapters that turn narrow external interfaces into the ports `createLoop`
 * consumes. They are optional: a caller may inject its own scheduler/merger,
 * but the two factories below prove that `sa`, `git` and `gh` are ordinary
 * injected interfaces and that tests never need a real process, network call
 * or repository.
 *
 * `createSaScheduler`
 *   sa.dispatch({ ticket, idempotencyKey, meta }) -> { id } | string
 *   sa.list()                                     -> work-order[]
 *   sa.rework({ id, feedback, ticket })           -> { id } | string
 *
 * `createGitGhMerger`
 *   git.merge({ lane, commit, taskId })           -> { merged, commit?, conflict? }
 *   gh.openPr({ lane, commit, taskId, title })    -> { url?, number? }   (optional)
 */

import { DEFAULT_MAX_SLOTS } from './constants.js';

const SA_TERMINAL_STATES = new Set([
  'cancelled',
  'closed',
  'done',
  'failed',
  'merged',
  'rejected',
  'stopped',
]);

const SA_IDLE_STATES = new Set([
  'completed',
  'done',
  'reported',
  'review',
  'submitted',
]);

/**
 * @param {{
 *   sa: { dispatch: Function, list: Function, rework: Function },
 *   maxSlots?: number,
 * }} options
 */
export function createSaScheduler({ sa, maxSlots = DEFAULT_MAX_SLOTS } = {}) {
  if (!isPlainObject(sa)) {
    throw new TypeError('createSaScheduler requires an sa interface');
  }
  for (const method of ['dispatch', 'list', 'rework']) {
    if (typeof sa[method] !== 'function') {
      throw new TypeError(`createSaScheduler sa.${method} must be a function`);
    }
  }
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new TypeError('createSaScheduler maxSlots must be an integer >= 1');
  }

  const collected = new Set();

  async function entries() {
    const list = await sa.list();
    if (!Array.isArray(list)) {
      throw new TypeError('createSaScheduler sa.list() must return an array');
    }
    return list.map(normalizeWorkOrder);
  }

  return {
    /**
     * A slot is empty when fewer than `maxSlots` work orders are actively
     * running. A work order waiting in review/collected is not occupying an
     * executor; an unknown non-terminal state is treated as active (fail
     * closed) so the driver cannot oversubscribe a real SuperAgent instance.
     */
    async freeSlots() {
      const list = await entries();
      const active = list.filter(
        (entry) =>
          !SA_TERMINAL_STATES.has(entry.state) && !SA_IDLE_STATES.has(entry.state),
      ).length;
      return Math.max(0, maxSlots - active);
    },

    async dispatch(request) {
      const result = await sa.dispatch({
        ticket: {
          id: request.taskId,
          taskId: request.taskId,
          lane: request.lane,
          title: request.title,
          goal: request.goal,
          budgetCny: request.budgetCny,
          attempt: request.attempt,
          reworkRound: request.reworkRound,
        },
        idempotencyKey: request.idempotencyKey,
        meta: {
          round: request.round,
          attempt: request.attempt,
          reworkRound: request.reworkRound,
        },
      });
      return { workOrderId: workOrderIdOf(result, 'sa.dispatch') };
    },

    /**
     * Return every submitted work order once. Work orders already returned are
     * remembered so a polling adapter cannot make the driver verify twice.
     */
    async collect() {
      const list = await entries();
      const submissions = [];
      for (const entry of list) {
        if (!SA_IDLE_STATES.has(entry.state)) continue;
        if (collected.has(entry.id)) continue;
        collected.add(entry.id);
        submissions.push({
          taskId: entry.taskId,
          workOrderId: entry.id,
          commit: entry.result.commit,
          costCny: entry.result.costCny,
          output: entry.result.output,
          tests: entry.result.tests,
        });
      }
      return submissions;
    },

    async rework(request) {
      const result = await sa.rework({
        id: request.workOrderId,
        feedback: request.feedback,
        ticket: {
          id: request.taskId,
          taskId: request.taskId,
          lane: request.lane,
          title: request.title,
          goal: request.goal,
          budgetCny: request.budgetCny,
          reworkRound: request.reworkRound,
        },
      });
      const workOrderId = workOrderIdOf(result, 'sa.rework');
      // An adapter may rework in place (same id) or open a new work order.
      // Either way the next submission must be collectable again.
      collected.delete(workOrderId);
      collected.delete(request.workOrderId);
      return { workOrderId };
    },

    config: Object.freeze({ maxSlots }),
  };
}

/**
 * @param {{
 *   git: { merge: Function },
 *   gh?: { openPr?: Function } | null,
 * }} options
 */
export function createGitGhMerger({ git, gh = null } = {}) {
  if (!isPlainObject(git) || typeof git.merge !== 'function') {
    throw new TypeError('createGitGhMerger requires git.merge()');
  }
  if (gh !== null && !isPlainObject(gh)) {
    throw new TypeError('createGitGhMerger gh must be an object when supplied');
  }

  return {
    async merge({ task, submission, round }) {
      const result = await git.merge({
        lane: task.lane,
        commit: submission?.commit ?? null,
        taskId: task.id,
        round,
      });

      const merged =
        result === true ||
        (isPlainObject(result) && (result.merged === true || result.ok === true));
      if (!merged) {
        return {
          merged: false,
          error:
            (isPlainObject(result) && (result.error ?? result.conflict)) ??
            'git merge did not report merged=true',
        };
      }

      const commit =
        (isPlainObject(result) && result.commit) ?? submission?.commit ?? null;

      let pr = null;
      let ghError = null;
      if (typeof gh?.openPr === 'function') {
        try {
          pr = await gh.openPr({
            lane: task.lane,
            commit,
            taskId: task.id,
            title: task.title,
          });
        } catch (error) {
          ghError = errorMessage(error);
        }
      }

      return {
        merged: true,
        commit,
        pr,
        ...(ghError === null ? {} : { ghError }),
      };
    },
  };
}

function normalizeWorkOrder(raw) {
  if (!isPlainObject(raw)) {
    throw new TypeError('createSaScheduler sa.list() returned a non-object entry');
  }
  const id = stringOf(raw.id) ?? stringOf(raw.workOrderId) ?? stringOf(raw.work_order_id);
  if (id === null) {
    throw new TypeError('createSaScheduler sa.list() entry has no id');
  }
  const taskId =
    stringOf(raw.taskId) ??
    stringOf(raw.task_id) ??
    stringOf(raw.ticketId) ??
    stringOf(raw.ticket_id);
  if (taskId === null) {
    throw new TypeError(`createSaScheduler work order ${id} has no taskId`);
  }

  const result = isPlainObject(raw.result)
    ? raw.result
    : isPlainObject(raw.submission)
      ? raw.submission
      : {};

  return {
    id,
    taskId,
    state: String(raw.state ?? raw.status ?? '').trim().toLowerCase(),
    result: {
      commit: result.commit ?? result.commitSha ?? result.commit_sha ?? null,
      costCny: result.costCny ?? result.cost_cny ?? result.cost ?? null,
      output: result.output ?? null,
      tests: result.tests ?? null,
    },
  };
}

function workOrderIdOf(result, label) {
  const id =
    stringOf(result) ??
    (isPlainObject(result)
      ? stringOf(result.id) ??
        stringOf(result.workOrderId) ??
        stringOf(result.work_order_id) ??
        stringOf(result.ticketId)
      : null);
  if (id === null) {
    throw new TypeError(`${label}() must return a work order id`);
  }
  return id;
}

function stringOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
