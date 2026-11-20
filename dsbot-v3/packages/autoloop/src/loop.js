/**
 * L34 dev-loop driver.
 *
 * One `step()` executes exactly one state of:
 *
 *   plan -> dispatch -> collect -> verify -> merge -> next
 *
 * and returns `{ state, actions, next }`, where `state` is the state that just
 * ran, `actions` is the ordered list of side effects that state decided, and
 * `next` is the state the following `step()` will execute. `stop` and `done`
 * are terminal.
 *
 * Everything external is injected:
 *
 *   goalEngine.plan(context)              -> { goal?, tasks?, done? }
 *   scheduler.freeSlots()                 -> non-negative integer
 *   scheduler.dispatch(request)           -> { workOrderId } | workOrderId
 *   scheduler.collect()                   -> submission[]
 *   scheduler.rework(request)             -> { workOrderId } | workOrderId
 *   verifier.verify(context)              -> JSON `{verdict:"PASS"|"FAIL"}`
 *   merger.merge(context)                 -> { merged: true, commit?, pr? }
 *   store.load() / store.save(snapshot)   -> crash-recovery snapshot
 *   clock()                               -> epoch milliseconds
 *
 * `sa`, `git` and `gh` may be injected instead of a scheduler/merger; the
 * adapters in `adapters.js` compose them. No module here reads the ambient
 * clock, spawns a process, touches a file or calls the network.
 *
 * Stop-loss (issue #75):
 *   - at most 2 rework rounds per lane (`maxReworkRounds`);
 *   - at most 30 CNY per task (`maxTaskCostCny`);
 *   - 2 consecutive completed rounds without a merge (`maxNoProgressRounds`).
 *
 * Every step persists the snapshot before returning, so `resume()` can reload
 * it and continue. A task already in `dispatched` state is never dispatched
 * again by `resume()`; its idempotency key additionally protects the adapter
 * from an at-least-once crash window.
 */

import {
  DEFAULT_MAX_SLOTS,
  LOOP_STATES,
  SNAPSHOT_VERSION,
  TASK_STATES,
} from './constants.js';
import { createGitGhMerger, createSaScheduler } from './adapters.js';
import { clone } from './store.js';
import {
  isNoProgressExhausted,
  isReworkExhausted,
  isTaskOverBudget,
  resolveLimits,
} from './stop_loss.js';
import { parseVerdict } from './verdict.js';

const STATE_SET = new Set(Object.values(LOOP_STATES));
const TASK_STATE_SET = new Set(Object.values(TASK_STATES));

/**
 * @param {object} options
 * @param {{ plan: Function }} options.goalEngine
 * @param {object} [options.scheduler]
 * @param {object} options.verifier
 * @param {object} [options.merger]
 * @param {object} options.store
 * @param {() => number} options.clock
 * @param {object} [options.sa] SuperAgent interface used to build a scheduler
 * @param {object} [options.git] git interface used to build a merger
 * @param {object} [options.gh] optional GitHub interface for the merger
 * @param {number} [options.maxReworkRounds=2]
 * @param {number} [options.maxTaskCostCny=30]
 * @param {number} [options.maxNoProgressRounds=2]
 * @param {number} [options.maxSlots=4]
 * @param {string} [options.loopId]
 * @param {string|null} [options.goal]
 */
export function createLoop(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('createLoop expects an options object');
  }

  const { goalEngine, verifier, store, clock } = options;
  let scheduler = options.scheduler;
  let merger = options.merger;

  requireFunction(goalEngine?.plan, 'goalEngine.plan');
  requireFunction(verifier?.verify, 'verifier.verify');
  requireFunction(store?.load, 'store.load');
  requireFunction(store?.save, 'store.save');
  requireFunction(clock, 'clock');

  if (!scheduler && options.sa) {
    scheduler = createSaScheduler({
      sa: options.sa,
      maxSlots: options.maxSlots ?? DEFAULT_MAX_SLOTS,
    });
  }
  if (!merger && options.git) {
    merger = createGitGhMerger({ git: options.git, gh: options.gh ?? null });
  }

  if (!scheduler) {
    throw new TypeError(
      'createLoop requires scheduler or sa (with freeSlots/dispatch/collect/rework)',
    );
  }
  for (const method of ['freeSlots', 'dispatch', 'collect', 'rework']) {
    requireFunction(scheduler[method], `scheduler.${method}`);
  }
  if (!merger) {
    throw new TypeError('createLoop requires merger or git (with merge())');
  }
  requireFunction(merger.merge, 'merger.merge');

  const limits = resolveLimits(options);
  const loopId =
    stringOf(options.loopId) ??
    `loop-${Math.random().toString(36).slice(2, 10)}`;
  const initialGoal = stringOf(options.goal);

  let snapshot = null;
  let initialized = false;
  let inFlightStep = null;

  function nowMs() {
    const value = clock();
    if (!Number.isFinite(value)) {
      throw new TypeError('createLoop clock() must return epoch milliseconds');
    }
    return value;
  }

  function freshSnapshot(at) {
    return {
      version: SNAPSHOT_VERSION,
      loopId,
      goal: initialGoal,
      goalDone: false,
      state: LOOP_STATES.PLAN,
      round: 0,
      roundMerged: 0,
      noProgressRounds: 0,
      noProgressCountedRound: 0,
      spentCny: 0,
      stop: null,
      tasks: {},
      order: [],
      lanes: {},
      stats: emptyStats(),
      createdAt: at,
      updatedAt: at,
    };
  }

  async function loadRaw() {
    const raw = await store.load();
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw new TypeError(
          `createLoop store.load() returned invalid JSON: ${error.message}`,
        );
      }
    }
    return raw;
  }

  async function persist(at) {
    snapshot.updatedAt = at;
    await store.save(clone(snapshot));
  }

  async function ensureInitialized(at) {
    if (initialized) return;
    const raw = await loadRaw();
    if (raw === null) {
      snapshot = freshSnapshot(at);
      initialized = true;
      await persist(at);
      return;
    }
    snapshot = normalizeSnapshot(raw, at, loopId, limits);
    initialized = true;
  }

  /**
   * Reload the last persisted snapshot and stop before the next state. This is
   * the explicit crash-recovery entry point; `step()` also auto-loads on first
   * use, so a caller may simply create the loop and continue stepping.
   *
   * @returns {Promise<{state: string, actions: object[], next: string}>}
   */
  async function resume() {
    const at = nowMs();
    const raw = await loadRaw();
    const loaded = raw !== null;
    snapshot = loaded
      ? normalizeSnapshot(raw, at, loopId, limits)
      : freshSnapshot(at);
    initialized = true;
    if (!loaded) await persist(at);

    const inFlight = loaded
      ? tasksInOrder()
          .filter((task) => task.state === TASK_STATES.DISPATCHED)
          .map((task) => ({ taskId: task.id, workOrderId: task.workOrderId }))
      : [];

    return {
      state: snapshot.state,
      actions: [
        {
          type: loaded ? 'resume' : 'init',
          state: snapshot.state,
          round: snapshot.round,
          inFlight,
          tasks: Object.keys(snapshot.tasks).length,
        },
      ],
      next: snapshot.state,
    };
  }

  /**
   * Run one state. Concurrent calls share the same in-flight step so a slow
   * adapter cannot dispatch the same planned task twice.
   *
   * @returns {Promise<{state: string, actions: object[], next: string}>}
   */
  function step() {
    if (inFlightStep) return inFlightStep;
    inFlightStep = runStep().finally(() => {
      inFlightStep = null;
    });
    return inFlightStep;
  }

  async function runStep() {
    const at = nowMs();
    await ensureInitialized(at);

    if (snapshot.stop) {
      snapshot.state = LOOP_STATES.STOP;
      await persist(at);
      return {
        state: LOOP_STATES.STOP,
        actions: [
          {
            type: 'stop',
            reason: snapshot.stop.reason,
            detail: snapshot.stop.detail,
            at,
            replay: true,
          },
        ],
        next: LOOP_STATES.STOP,
      };
    }

    const executed = snapshot.state;
    let actions;

    switch (executed) {
      case LOOP_STATES.PLAN:
        actions = await runPlan(at);
        break;
      case LOOP_STATES.DISPATCH:
        actions = await runDispatch(at);
        break;
      case LOOP_STATES.COLLECT:
        actions = await runCollect(at);
        break;
      case LOOP_STATES.VERIFY:
        actions = await runVerify(at);
        break;
      case LOOP_STATES.MERGE:
        actions = await runMerge(at);
        break;
      case LOOP_STATES.NEXT:
        actions = runNext(at);
        break;
      case LOOP_STATES.STOP:
        actions = [
          {
            type: 'stop',
            reason: snapshot.stop?.reason ?? 'stopped',
            detail: snapshot.stop?.detail ?? null,
            at,
            replay: true,
          },
        ];
        break;
      case LOOP_STATES.DONE:
        actions = [{ type: 'done', round: snapshot.round, at }];
        break;
      default:
        throw new TypeError(`createLoop cannot execute state ${executed}`);
    }

    if (snapshot.stop) snapshot.state = LOOP_STATES.STOP;
    await persist(at);
    return { state: executed, actions, next: snapshot.state };
  }

  async function runPlan(at) {
    snapshot.round += 1;
    snapshot.roundMerged = 0;

    const context = {
      loopId: snapshot.loopId,
      round: snapshot.round,
      goal: snapshot.goal,
      now: at,
      spentCny: snapshot.spentCny,
      noProgressRounds: snapshot.noProgressRounds,
      tasks: tasksInOrder().map((task) => clone(task)),
      completed: tasksInOrder()
        .filter((task) => task.state === TASK_STATES.MERGED)
        .map((task) => task.id),
      failed: tasksInOrder()
        .filter((task) =>
          [TASK_STATES.MERGE_FAILED, TASK_STATES.ERROR, TASK_STATES.STOPPED].includes(
            task.state,
          ),
        )
        .map((task) => task.id),
    };

    const result = await goalEngine.plan(context);
    if (!isPlainObject(result)) {
      throw new TypeError('createLoop goalEngine.plan() must return an object');
    }
    if (result.tasks !== undefined && !Array.isArray(result.tasks)) {
      throw new TypeError('createLoop goalEngine.plan().tasks must be an array');
    }

    if (typeof result.goal === 'string' && result.goal.trim() !== '') {
      snapshot.goal = result.goal.trim();
    }
    const done = result.done === true;
    if (done) snapshot.goalDone = true;

    const taskIds = [];
    const skipped = [];
    const seen = new Set();
    // A done plan means the goal is reached: any tasks it still carries are
    // stale and must not be dispatched.
    for (const raw of done ? [] : (result.tasks ?? [])) {
      const task = createPlannedTask(raw, snapshot.round, limits);
      if (seen.has(task.id) || snapshot.tasks[task.id]) {
        skipped.push({
          type: 'plan_skipped',
          taskId: task.id,
          lane: task.lane,
          reason: 'duplicate_task_id',
        });
        continue;
      }
      seen.add(task.id);
      snapshot.tasks[task.id] = task;
      snapshot.order.push(task.id);
      ensureLane(task.lane);
      taskIds.push(task.id);
    }

    const actions = [
      {
        type: 'plan',
        round: snapshot.round,
        goal: snapshot.goal,
        taskIds,
        done,
      },
      ...skipped,
    ];
    if (done) actions.push({ type: 'goal_done', round: snapshot.round });

    snapshot.state = routeFromTasks({ includePlanned: true });
    return actions;
  }

  async function runDispatch(at) {
    const actions = [];
    let slots = await readSlots();

    if (slots === 0) {
      actions.push({ type: 'slots_full', freeSlots: 0, round: snapshot.round });
    }

    for (const task of tasksInOrder()) {
      if (task.state !== TASK_STATES.PLANNED) continue;
      if (snapshot.stop) break;

      if (stopForBudget(task, at, actions)) break;

      if (slots <= 0) {
        actions.push({
          type: 'dispatch_skipped',
          taskId: task.id,
          lane: task.lane,
          reason: 'no_slot',
        });
        continue;
      }

      const attempt = task.attempt + 1;
      // Use the snapshot's loop id, not this process's constructor option, so
      // a restarted driver still derives the same idempotency key.
      const idempotencyKey = `autoloop:${snapshot.loopId}:${task.id}:a${attempt}`;
      try {
        const result = await scheduler.dispatch({
          idempotencyKey,
          taskId: task.id,
          lane: task.lane,
          title: task.title,
          goal: task.goal,
          budgetCny: task.budgetCny,
          round: snapshot.round,
          attempt,
          reworkRound: task.reworkCount,
          task: clone(task),
          now: at,
        });
        const workOrderId = readWorkOrderId(result, 'scheduler.dispatch');

        task.state = TASK_STATES.DISPATCHED;
        task.workOrderId = workOrderId;
        task.attempt = attempt;
        task.dispatchedAt = at;
        task.lastError = null;
        snapshot.stats.dispatched += 1;
        slots -= 1;
        actions.push({
          type: 'dispatch',
          taskId: task.id,
          lane: task.lane,
          workOrderId,
          attempt,
          idempotencyKey,
          round: snapshot.round,
        });
      } catch (error) {
        task.lastError = errorMessage(error);
        actions.push({
          type: 'dispatch_failed',
          taskId: task.id,
          lane: task.lane,
          attempt,
          error: task.lastError,
        });
      }
    }

    if (!snapshot.stop) {
      snapshot.state = routeAfterDispatch();
    }
    return actions;
  }

  async function runCollect(at) {
    const actions = [];
    const raw = await scheduler.collect();
    const submissions = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.submissions)
        ? raw.submissions
        : null;
    if (submissions === null) {
      throw new TypeError(
        'createLoop scheduler.collect() must return an array or { submissions }',
      );
    }

    for (const entry of submissions) {
      const submission = normalizeSubmission(entry);
      if (submission === null) {
        actions.push({
          type: 'ignored_submission',
          reason: 'invalid_submission',
        });
        continue;
      }

      const task = snapshot.tasks[submission.taskId];
      if (!task) {
        actions.push({
          type: 'ignored_submission',
          taskId: submission.taskId,
          workOrderId: submission.workOrderId,
          reason: 'unknown_task',
        });
        continue;
      }
      if (task.state !== TASK_STATES.DISPATCHED) {
        actions.push({
          type: 'ignored_submission',
          taskId: task.id,
          workOrderId: submission.workOrderId,
          reason: 'task_not_dispatched',
        });
        continue;
      }
      if (
        task.workOrderId !== null &&
        submission.workOrderId !== null &&
        submission.workOrderId !== task.workOrderId
      ) {
        actions.push({
          type: 'ignored_submission',
          taskId: task.id,
          workOrderId: submission.workOrderId,
          reason: 'stale_work_order',
        });
        continue;
      }

      const costCny = money(task.costCny + submission.costCny);
      task.costCny = costCny;
      snapshot.spentCny = money(snapshot.spentCny + submission.costCny);
      task.submission = {
        workOrderId: submission.workOrderId ?? task.workOrderId,
        commit: submission.commit,
        costCny: submission.costCny,
        output: submission.output,
        tests: submission.tests,
        receivedAt: at,
      };
      task.state = TASK_STATES.SUBMITTED;
      task.submittedAt = at;
      snapshot.stats.submitted += 1;

      actions.push({
        type: 'submission',
        taskId: task.id,
        lane: task.lane,
        workOrderId: task.submission.workOrderId,
        costCny: submission.costCny,
        commit: submission.commit,
        round: snapshot.round,
      });

      if (stopForBudget(task, at, actions)) break;
    }

    if (snapshot.stop) return actions;

    if (hasTaskState(TASK_STATES.SUBMITTED)) {
      snapshot.state = LOOP_STATES.VERIFY;
      return actions;
    }
    if (hasTaskState(TASK_STATES.DISPATCHED)) {
      actions.push({
        type: 'wait',
        reason: 'submission_pending',
        pending: taskIdsWithState(TASK_STATES.DISPATCHED),
        round: snapshot.round,
      });
      snapshot.state = LOOP_STATES.COLLECT;
      return actions;
    }
    if (hasTaskState(TASK_STATES.PLANNED)) {
      const slots = await readSlots();
      if (slots > 0) {
        snapshot.state = LOOP_STATES.DISPATCH;
      } else {
        actions.push({
          type: 'wait',
          reason: 'no_slot',
          pending: taskIdsWithState(TASK_STATES.PLANNED),
          round: snapshot.round,
        });
        snapshot.state = LOOP_STATES.COLLECT;
      }
      return actions;
    }

    snapshot.state = LOOP_STATES.NEXT;
    return actions;
  }

  async function runVerify(at) {
    const actions = [];

    for (const task of tasksInOrder()) {
      if (task.state !== TASK_STATES.SUBMITTED) continue;

      let raw;
      try {
        raw = await verifier.verify({
          task: clone(task),
          submission: clone(task.submission),
          lane: task.lane,
          round: snapshot.round,
          now: at,
        });
      } catch (error) {
        raw = {
          verdict: 'FAIL',
          reason: 'verifier_error',
          feedback: errorMessage(error),
        };
      }

      const parsed = parseVerdict(raw);
      task.verdict = {
        verdict: parsed.verdict,
        reason: parsed.reason,
        feedback: parsed.feedback,
        at,
      };
      task.verifiedAt = at;
      task.state =
        parsed.verdict === 'PASS' ? TASK_STATES.PASSED : TASK_STATES.FAILED;
      snapshot.stats.verified += 1;

      actions.push({
        type: 'verify',
        taskId: task.id,
        lane: task.lane,
        verdict: parsed.verdict,
        reason: parsed.reason,
        feedback: parsed.feedback,
        round: snapshot.round,
      });
    }

    snapshot.state =
      hasTaskState(TASK_STATES.PASSED) || hasTaskState(TASK_STATES.FAILED)
        ? LOOP_STATES.MERGE
        : LOOP_STATES.NEXT;
    return actions;
  }

  async function runMerge(at) {
    const actions = [];

    // PASS -> merge. A verifier PASS is the only path to `merger.merge`.
    for (const task of tasksInOrder()) {
      if (task.state !== TASK_STATES.PASSED) continue;
      if (snapshot.stop) break;
      if (stopForBudget(task, at, actions)) break;

      try {
        const result = await merger.merge({
          task: clone(task),
          submission: clone(task.submission),
          verdict: clone(task.verdict),
          lane: task.lane,
          round: snapshot.round,
          now: at,
        });

        if (!isPlainObject(result) || result.merged !== true) {
          throw new Error(
            isPlainObject(result) && result.error
              ? String(result.error)
              : 'merger.merge() did not report merged=true',
          );
        }

        task.state = TASK_STATES.MERGED;
        task.merge = {
          commit: result.commit ?? task.submission?.commit ?? null,
          pr: result.pr ?? result.prUrl ?? null,
          ghError: result.ghError ?? null,
          at,
        };
        task.mergedAt = at;
        task.lastError = null;
        snapshot.roundMerged += 1;
        snapshot.noProgressRounds = 0;
        snapshot.stats.merged += 1;

        actions.push({
          type: 'merge',
          taskId: task.id,
          lane: task.lane,
          commit: task.merge.commit,
          pr: task.merge.pr,
          round: snapshot.round,
        });
      } catch (error) {
        task.state = TASK_STATES.MERGE_FAILED;
        task.lastError = errorMessage(error);
        snapshot.stats.failed += 1;
        actions.push({
          type: 'merge_failed',
          taskId: task.id,
          lane: task.lane,
          error: task.lastError,
          round: snapshot.round,
        });
      }
    }

    if (snapshot.stop) return actions;

    // FAIL -> rework, unless the task or its lane has used both allowed rounds.
    for (const task of tasksInOrder()) {
      if (task.state !== TASK_STATES.FAILED) continue;
      if (snapshot.stop) break;
      if (stopForBudget(task, at, actions)) break;

      const laneRounds = laneReworkRounds(task.lane);
      if (isReworkExhausted(task, laneRounds, limits)) {
        task.state = TASK_STATES.STOPPED;
        task.lastError = 'rework_exceeded';
        snapshot.stats.stopped += 1;
        const detail = {
          taskId: task.id,
          lane: task.lane,
          reworkCount: task.reworkCount,
          laneReworkRounds: laneRounds,
          maxReworkRounds: limits.maxReworkRounds,
        };
        if (setStop('rework_exceeded', detail, at)) {
          actions.push(stopAction('rework_exceeded', detail, at));
        }
        break;
      }

      const reworkRound = task.reworkCount + 1;
      const attempt = task.attempt + 1;
      const idempotencyKey = `autoloop:${snapshot.loopId}:${task.id}:r${reworkRound}`;
      const feedback = task.verdict?.feedback ?? 'verification failed';
      try {
        const result = await scheduler.rework({
          idempotencyKey,
          taskId: task.id,
          lane: task.lane,
          title: task.title,
          goal: task.goal,
          budgetCny: task.budgetCny,
          workOrderId: task.workOrderId,
          feedback,
          round: snapshot.round,
          attempt,
          reworkRound,
          task: clone(task),
          now: at,
        });
        const workOrderId = readWorkOrderId(result, 'scheduler.rework');

        task.reworkCount = reworkRound;
        snapshot.lanes[task.lane].reworkRounds = laneRounds + 1;
        task.state = TASK_STATES.DISPATCHED;
        task.attempt = attempt;
        task.workOrderId = workOrderId;
        task.dispatchedAt = at;
        task.submission = null;
        task.verdict = null;
        task.lastError = null;
        snapshot.stats.reworked += 1;

        actions.push({
          type: 'rework',
          taskId: task.id,
          lane: task.lane,
          reworkRound,
          workOrderId,
          feedback,
          round: snapshot.round,
        });
      } catch (error) {
        task.state = TASK_STATES.ERROR;
        task.lastError = errorMessage(error);
        snapshot.stats.failed += 1;
        actions.push({
          type: 'rework_failed',
          taskId: task.id,
          lane: task.lane,
          reworkRound,
          error: task.lastError,
          round: snapshot.round,
        });
      }
    }

    if (!snapshot.stop) {
      snapshot.state = routeAfterMerge();
    }
    return actions;
  }

  function runNext(at) {
    const actions = [];

    if (snapshot.stop) {
      snapshot.state = LOOP_STATES.STOP;
      actions.push(
        stopAction(snapshot.stop.reason, snapshot.stop.detail, at, true),
      );
      return actions;
    }

    if (hasTaskState(TASK_STATES.DISPATCHED)) {
      snapshot.state = LOOP_STATES.COLLECT;
      actions.push(nextAction(LOOP_STATES.COLLECT));
      return actions;
    }
    if (hasTaskState(TASK_STATES.SUBMITTED)) {
      snapshot.state = LOOP_STATES.VERIFY;
      actions.push(nextAction(LOOP_STATES.VERIFY));
      return actions;
    }
    if (
      hasTaskState(TASK_STATES.PASSED) ||
      hasTaskState(TASK_STATES.FAILED)
    ) {
      snapshot.state = LOOP_STATES.MERGE;
      actions.push(nextAction(LOOP_STATES.MERGE));
      return actions;
    }
    if (hasTaskState(TASK_STATES.PLANNED)) {
      snapshot.state = LOOP_STATES.DISPATCH;
      actions.push(nextAction(LOOP_STATES.DISPATCH));
      return actions;
    }

    if (snapshot.goalDone) {
      snapshot.state = LOOP_STATES.DONE;
      actions.push({ type: 'goal_done', round: snapshot.round, at });
      return actions;
    }

    if (snapshot.roundMerged > 0) {
      snapshot.noProgressRounds = 0;
    } else if (snapshot.noProgressCountedRound !== snapshot.round) {
      snapshot.noProgressRounds += 1;
      snapshot.noProgressCountedRound = snapshot.round;
    }

    if (isNoProgressExhausted(snapshot.noProgressRounds, limits)) {
      const detail = {
        noProgressRounds: snapshot.noProgressRounds,
        round: snapshot.round,
        maxNoProgressRounds: limits.maxNoProgressRounds,
      };
      if (setStop('no_progress', detail, at)) {
        actions.push(stopAction('no_progress', detail, at));
      }
      return actions;
    }

    snapshot.state = LOOP_STATES.PLAN;
    actions.push(nextAction(LOOP_STATES.PLAN));
    return actions;
  }

  function nextAction(route) {
    return {
      type: 'next',
      route,
      round: snapshot.round,
      roundMerged: snapshot.roundMerged,
      noProgressRounds: snapshot.noProgressRounds,
    };
  }

  function stopForBudget(task, at, actions) {
    if (!isTaskOverBudget(task, limits)) return false;
    if (!isTerminalTask(task)) {
      task.state = TASK_STATES.STOPPED;
      task.lastError = 'budget_exceeded';
      snapshot.stats.stopped += 1;
    }
    const detail = {
      taskId: task.id,
      lane: task.lane,
      costCny: task.costCny,
      capCny: limits.maxTaskCostCny,
    };
    if (setStop('budget_exceeded', detail, at)) {
      actions.push(stopAction('budget_exceeded', detail, at));
    }
    return true;
  }

  function setStop(reason, detail, at) {
    if (snapshot.stop) return false;
    snapshot.stop = { reason, detail: clone(detail), at };
    snapshot.state = LOOP_STATES.STOP;
    return true;
  }

  function stopAction(reason, detail, at, replay = false) {
    return {
      type: 'stop',
      reason,
      detail,
      at,
      ...(replay ? { replay: true } : {}),
    };
  }

  function taskIdsWithState(state) {
    return tasksInOrder()
      .filter((task) => task.state === state)
      .map((task) => task.id);
  }

  function hasTaskState(...states) {
    const wanted = new Set(states);
    return tasksInOrder().some((task) => wanted.has(task.state));
  }

  function tasksInOrder() {
    const tasks = [];
    for (const id of snapshot.order) {
      const task = snapshot.tasks[id];
      if (task) tasks.push(task);
    }
    return tasks;
  }

  function ensureLane(lane) {
    if (!snapshot.lanes[lane]) snapshot.lanes[lane] = { reworkRounds: 0 };
  }

  function laneReworkRounds(lane) {
    return snapshot.lanes[lane]?.reworkRounds ?? 0;
  }

  function routeFromTasks({ includePlanned = false } = {}) {
    if (includePlanned && hasTaskState(TASK_STATES.PLANNED)) {
      return LOOP_STATES.DISPATCH;
    }
    if (hasTaskState(TASK_STATES.DISPATCHED)) return LOOP_STATES.COLLECT;
    if (hasTaskState(TASK_STATES.SUBMITTED)) return LOOP_STATES.VERIFY;
    if (hasTaskState(TASK_STATES.PASSED) || hasTaskState(TASK_STATES.FAILED)) {
      return LOOP_STATES.MERGE;
    }
    return LOOP_STATES.NEXT;
  }

  function routeAfterDispatch() {
    if (
      hasTaskState(TASK_STATES.DISPATCHED) ||
      hasTaskState(TASK_STATES.PLANNED)
    ) {
      return LOOP_STATES.COLLECT;
    }
    return routeFromTasks();
  }

  function routeAfterMerge() {
    if (hasTaskState(TASK_STATES.DISPATCHED)) return LOOP_STATES.COLLECT;
    if (hasTaskState(TASK_STATES.SUBMITTED)) return LOOP_STATES.VERIFY;
    if (hasTaskState(TASK_STATES.PASSED) || hasTaskState(TASK_STATES.FAILED)) {
      return LOOP_STATES.MERGE;
    }
    return LOOP_STATES.NEXT;
  }

  async function readSlots() {
    const value = await scheduler.freeSlots();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(
        'createLoop scheduler.freeSlots() must return a non-negative number',
      );
    }
    return Math.floor(value);
  }

  return Object.freeze({
    step,
    resume,

    /**
     * Stop the loop explicitly (human/parent decision). Idempotent.
     *
     * @param {string} [reason='manual']
     * @param {object|null} [detail]
     */
    async stop(reason = 'manual', detail = null) {
      const label = stringOf(reason) ?? 'manual';
      const at = nowMs();
      await ensureInitialized(at);
      if (!snapshot.stop) setStop(label, detail, at);
      snapshot.state = LOOP_STATES.STOP;
      await persist(at);
      return clone(snapshot);
    },

    /** Last known snapshot, or null before the first load/step. */
    snapshot() {
      return snapshot === null ? null : clone(snapshot);
    },

    config: Object.freeze({
      loopId,
      maxReworkRounds: limits.maxReworkRounds,
      maxTaskCostCny: limits.maxTaskCostCny,
      maxNoProgressRounds: limits.maxNoProgressRounds,
    }),
  });
}

function normalizeSnapshot(raw, at, loopId, limits) {
  if (!isPlainObject(raw)) {
    throw new TypeError('createLoop store.load() must return an object');
  }
  if (raw.version !== SNAPSHOT_VERSION) {
    throw new TypeError(
      `createLoop snapshot version ${raw.version} is not supported (expected ${SNAPSHOT_VERSION})`,
    );
  }

  const state = raw.state ?? LOOP_STATES.PLAN;
  if (!STATE_SET.has(state)) {
    throw new TypeError(`createLoop snapshot has unknown state ${state}`);
  }

  const tasks = {};
  if (raw.tasks !== undefined && !isPlainObject(raw.tasks)) {
    throw new TypeError('createLoop snapshot tasks must be an object');
  }
  for (const [id, stored] of Object.entries(raw.tasks ?? {})) {
    if (!isPlainObject(stored)) {
      throw new TypeError(`createLoop snapshot task ${id} must be an object`);
    }
    const task = normalizeStoredTask(id, stored, limits);
    tasks[id] = task;
  }

  const order = [];
  const seen = new Set();
  for (const id of Array.isArray(raw.order) ? raw.order : Object.keys(tasks)) {
    if (typeof id !== 'string' || !tasks[id] || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of Object.keys(tasks)) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  const lanes = {};
  for (const [lane, value] of Object.entries(
    isPlainObject(raw.lanes) ? raw.lanes : {},
  )) {
    lanes[lane] = {
      reworkRounds:
        Number.isInteger(value?.reworkRounds) && value.reworkRounds >= 0
          ? value.reworkRounds
          : 0,
    };
  }
  for (const task of Object.values(tasks)) {
    if (!lanes[task.lane]) lanes[task.lane] = { reworkRounds: 0 };
  }

  const stop =
    isPlainObject(raw.stop)
      ? {
          reason: stringOf(raw.stop.reason) ?? 'unknown',
          detail: raw.stop.detail ?? null,
          at: Number.isFinite(raw.stop.at) ? raw.stop.at : at,
        }
      : state === LOOP_STATES.STOP
        ? { reason: 'stopped', detail: null, at }
        : null;

  return {
    ...clone(raw),
    version: SNAPSHOT_VERSION,
    loopId: stringOf(raw.loopId) ?? loopId,
    goal: typeof raw.goal === 'string' ? raw.goal : null,
    goalDone: raw.goalDone === true,
    state,
    round: nonNegativeInteger(raw.round, 0),
    roundMerged: nonNegativeInteger(raw.roundMerged, 0),
    noProgressRounds: nonNegativeInteger(raw.noProgressRounds, 0),
    noProgressCountedRound: nonNegativeInteger(raw.noProgressCountedRound, 0),
    spentCny: nonNegativeNumber(raw.spentCny, 0),
    stop,
    tasks,
    order,
    lanes,
    stats: normalizeStats(raw.stats),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : at,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : at,
  };
}

function normalizeStoredTask(id, stored, limits) {
  const lane = stringOf(stored.lane);
  if (lane === null) {
    throw new TypeError(`createLoop snapshot task ${id} has no lane`);
  }
  const state = stored.state ?? TASK_STATES.PLANNED;
  if (!TASK_STATE_SET.has(state)) {
    throw new TypeError(`createLoop snapshot task ${id} has unknown state ${state}`);
  }

  return {
    id,
    lane,
    title: stringOf(stored.title) ?? id,
    goal: stringOf(stored.goal) ?? stringOf(stored.title) ?? id,
    budgetCny:
      Number.isFinite(stored.budgetCny) && stored.budgetCny > 0
        ? Math.min(stored.budgetCny, limits.maxTaskCostCny)
        : limits.maxTaskCostCny,
    state,
    round: nonNegativeInteger(stored.round, 0),
    attempt: nonNegativeInteger(stored.attempt, 0),
    reworkCount: nonNegativeInteger(stored.reworkCount, 0),
    workOrderId: stringOf(stored.workOrderId),
    costCny: nonNegativeNumber(stored.costCny, 0),
    submission: isPlainObject(stored.submission) ? stored.submission : null,
    verdict: isPlainObject(stored.verdict) ? stored.verdict : null,
    merge: isPlainObject(stored.merge) ? stored.merge : null,
    lastError: stringOf(stored.lastError),
    dispatchedAt: finiteOrNull(stored.dispatchedAt),
    submittedAt: finiteOrNull(stored.submittedAt),
    verifiedAt: finiteOrNull(stored.verifiedAt),
    mergedAt: finiteOrNull(stored.mergedAt),
  };
}

function createPlannedTask(raw, round, limits) {
  if (!isPlainObject(raw)) {
    throw new TypeError('createLoop goalEngine.plan() task entries must be objects');
  }
  const id = stringOf(raw.id) ?? stringOf(raw.taskId);
  if (id === null) {
    throw new TypeError('createLoop planned task has no id');
  }
  const lane = stringOf(raw.lane) ?? stringOf(raw.branch);
  if (lane === null) {
    throw new TypeError(`createLoop planned task ${id} has no lane`);
  }
  const title = stringOf(raw.title) ?? id;
  const goal = stringOf(raw.goal) ?? title;

  const requestedBudget =
    numberOrNull(raw.budgetCny) ?? numberOrNull(raw.budget_cny);
  if (requestedBudget !== null && requestedBudget <= 0) {
    throw new TypeError(
      `createLoop planned task ${id} budgetCny must be > 0 when supplied`,
    );
  }

  return {
    id,
    lane,
    title,
    goal,
    budgetCny: Math.min(
      requestedBudget ?? limits.maxTaskCostCny,
      limits.maxTaskCostCny,
    ),
    state: TASK_STATES.PLANNED,
    round,
    attempt: 0,
    reworkCount: 0,
    workOrderId: null,
    costCny: 0,
    submission: null,
    verdict: null,
    merge: null,
    lastError: null,
    dispatchedAt: null,
    submittedAt: null,
    verifiedAt: null,
    mergedAt: null,
  };
}

function normalizeSubmission(raw) {
  if (!isPlainObject(raw)) return null;
  const taskId = stringOf(raw.taskId) ?? stringOf(raw.task_id);
  if (taskId === null) return null;
  const workOrderId =
    stringOf(raw.workOrderId) ??
    stringOf(raw.work_order_id) ??
    stringOf(raw.id);
  const rawCost =
    numberOrNull(raw.costCny) ??
    numberOrNull(raw.cost_cny) ??
    numberOrNull(raw.cost) ??
    0;
  return {
    taskId,
    workOrderId,
    commit: stringOf(raw.commit) ?? stringOf(raw.commitSha) ?? null,
    costCny: rawCost < 0 ? 0 : money(rawCost),
    output: raw.output ?? raw.result ?? null,
    tests: raw.tests ?? null,
  };
}

function readWorkOrderId(result, label) {
  const id =
    stringOf(result) ??
    (isPlainObject(result)
      ? stringOf(result.workOrderId) ??
        stringOf(result.work_order_id) ??
        stringOf(result.id) ??
        stringOf(result.ticketId)
      : null);
  if (id === null) {
    throw new TypeError(`${label}() must return a work order id`);
  }
  return id;
}

function emptyStats() {
  return {
    dispatched: 0,
    submitted: 0,
    verified: 0,
    merged: 0,
    reworked: 0,
    failed: 0,
    stopped: 0,
  };
}

function normalizeStats(value) {
  const stats = emptyStats();
  if (!isPlainObject(value)) return stats;
  for (const key of Object.keys(stats)) {
    stats[key] = nonNegativeInteger(value[key], 0);
  }
  return stats;
}

function isTerminalTask(task) {
  return [
    TASK_STATES.MERGED,
    TASK_STATES.MERGE_FAILED,
    TASK_STATES.ERROR,
    TASK_STATES.STOPPED,
  ].includes(task.state);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function money(value) {
  return Math.round(value * 1e6) / 1e6;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createLoop ${name} must be a function`);
  }
}

function stringOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
