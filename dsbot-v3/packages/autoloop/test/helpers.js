// Shared fakes for the autoloop tests.
//
// Every port is a plain object with counters; no timer, network, process or
// filesystem is involved. Tests can inspect `ports.*Calls`, queue submissions
// in `ports.ready`, or override a single result with a function.

import { createLoop } from '../src/loop.js';
import { createMemoryStore } from '../src/store.js';

export function createHarness(options = {}) {
  const plans = options.plans ?? [{ tasks: [] }];
  let planIndex = 0;
  let now = options.now ?? 1_700_000_000_000;
  let maxSlots = options.maxSlots ?? 4;
  let active = options.active ?? 0;
  let failDispatchTimes = options.failDispatchTimes ?? 0;
  let workOrderSeq = 0;

  const planCalls = [];
  const dispatchCalls = [];
  const collectCalls = [];
  const reworkCalls = [];
  const verifyCalls = [];
  const mergeCalls = [];
  const ready = [...(options.ready ?? [])];

  const goalEngine = {
    async plan(context) {
      planCalls.push(context);
      const entry =
        plans[Math.min(planIndex, plans.length - 1)] ??
        { tasks: [] };
      planIndex += 1;
      return typeof entry === 'function'
        ? entry(context)
        : structuredClone(entry);
    },
  };

  const scheduler = {
    async freeSlots() {
      return Math.max(0, maxSlots - active);
    },
    async dispatch(request) {
      dispatchCalls.push(request);
      if (failDispatchTimes > 0) {
        failDispatchTimes -= 1;
        throw new Error('dispatch backend down');
      }
      active += 1;
      workOrderSeq += 1;
      return { workOrderId: `wo-${workOrderSeq}` };
    },
    async collect() {
      collectCalls.push({ at: now, queued: ready.length });
      const limit = options.collectLimit ?? ready.length;
      const out = ready.splice(0, limit);
      active = Math.max(0, active - out.length);
      return out;
    },
    async rework(request) {
      reworkCalls.push(request);
      active += 1;
      workOrderSeq += 1;
      return { workOrderId: `wo-${workOrderSeq}` };
    },
  };

  const verdicts = options.verdicts ?? {};
  const verifier = {
    async verify(context) {
      verifyCalls.push(context);
      const entry = verdicts[context.task.id];
      if (typeof entry === 'function') return entry(context);
      if (Array.isArray(entry)) {
        return entry.length > 1 ? entry.shift() : entry[0];
      }
      return entry ?? '{"verdict":"PASS"}';
    },
  };

  const merges = options.merges ?? {};
  const merger = {
    async merge(context) {
      mergeCalls.push(context);
      const entry = merges[context.task.id];
      if (typeof entry === 'function') return entry(context);
      if (entry instanceof Error) throw entry;
      if (entry === undefined) {
        return { merged: true, commit: `merge-${context.task.id}` };
      }
      return structuredClone(entry);
    },
  };

  const store = options.store ?? createMemoryStore();

  const loop = createLoop({
    goalEngine,
    scheduler,
    verifier,
    merger,
    store,
    clock: () => now,
    loopId: options.loopId ?? 'loop-test',
    maxReworkRounds: options.maxReworkRounds,
    maxTaskCostCny: options.maxTaskCostCny,
    maxNoProgressRounds: options.maxNoProgressRounds,
  });

  return {
    loop,
    store,
    ports: {
      goalEngine,
      scheduler,
      verifier,
      merger,
      planCalls,
      dispatchCalls,
      collectCalls,
      reworkCalls,
      verifyCalls,
      mergeCalls,
      ready,
      setActive(value) {
        active = value;
      },
      getActive() {
        return active;
      },
      setMaxSlots(value) {
        maxSlots = value;
      },
      setFailDispatchTimes(value) {
        failDispatchTimes = value;
      },
    },
    now() {
      return now;
    },
    advance(ms) {
      now += ms;
      return now;
    },
  };
}

/** Find the first action of `type`, or undefined. */
export function actionOf(result, type) {
  return result.actions.find((action) => action.type === type);
}

/** All actions of `type`. */
export function actionsOf(result, type) {
  return result.actions.filter((action) => action.type === type);
}
