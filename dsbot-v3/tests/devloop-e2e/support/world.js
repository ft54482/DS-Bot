/**
 * Fake dev-loop world for L41.
 *
 * One world owns the fake GitHub, SuperAgent queue, verifier, git and the
 * observable store. `createFakeWorld()` builds a driver (`world.loop`) around
 * them. `world.restart()` builds a second driver over the same external state,
 * which is how the crash-recovery scenario simulates a killed process without
 * actually spawning one.
 *
 * The plan port reveals `batchSize` tasks per round from `tasks`; scenario A
 * passes the three task books produced by the real L33 goal engine and uses a
 * batch of one, so the goal is decomposed into three lanes and the loop runs
 * three work rounds before its final done plan.
 */

import { createLoop } from '../../../packages/autoloop/src/index.js';
import { createFakeStore } from './fake-store.js';
import {
  createFakeGit,
  createFakeGitHub,
  createFakeSuperAgent,
  createFakeVerifier,
} from './fakes.js';

export const DEFAULT_START = Date.UTC(2026, 10, 20, 10, 0, 0);
export const PASS = Object.freeze({
  verdict: 'PASS',
  reason: 'fake verifier: tests and review green',
});

export function fail(feedback = 'fake verifier: lane is still red') {
  return {
    verdict: 'FAIL',
    reason: 'fake verifier: red',
    feedback,
  };
}

function clone(value) {
  return structuredClone(value);
}

export function createClock(start = DEFAULT_START, stepMs = 1_000) {
  let current = start;
  const clock = () => {
    const value = current;
    current += stepMs;
    return value;
  };
  clock.now = () => current;
  clock.advance = (ms) => {
    current += ms;
    return current;
  };
  return clock;
}

export function createGoalEngine({ goal, tasks, batchSize = 1 }) {
  const planCalls = [];
  return {
    planCalls,
    plan(context) {
      planCalls.push(clone(context));
      const start = (context.round - 1) * batchSize;
      if (start >= tasks.length) return { goal, done: true };
      return {
        goal,
        tasks: tasks
          .slice(start, start + batchSize)
          .map((task) => clone(task)),
      };
    },
  };
}

function defaultTask(goal, budgetCny) {
  return {
    id: 'api-r1',
    lane: 'api',
    title: 'api iteration 1',
    goal,
    budgetCny,
  };
}

export function createFakeWorld(options = {}) {
  const goal = options.goal ?? 'ship the fake dev loop';
  const budgetCny = options.budgetCny ?? 30;
  const tasks = clone(
    options.tasks ?? [defaultTask(goal, budgetCny)],
  );
  const lanes = [...new Set(tasks.map((task) => task.lane))];
  const batchSize = options.batchSize ?? 1;
  const maxSlots =
    options.maxSlots ?? Math.max(1, lanes.length, batchSize);
  const store = options.store ?? createFakeStore();
  const clock = options.clock ?? createClock();
  const github = options.github ?? createFakeGitHub();
  const costOf = options.costOf ?? (() => 2);
  const sa = options.sa ?? createFakeSuperAgent({ github, costOf });
  const git = options.git ?? createFakeGit({ github, sa });
  const gh =
    options.gh ?? { openPr: (request) => github.openPr(request) };
  const verifier =
    options.verifier ??
    createFakeVerifier(options.verdict ?? (() => PASS));
  const goalEngine =
    options.goalEngine ?? createGoalEngine({ goal, tasks, batchSize });

  const driverOptions = {
    goalEngine,
    verifier,
    store,
    clock,
    loopId: options.loopId ?? 'devloop-e2e',
    maxSlots,
    maxReworkRounds: options.maxReworkRounds,
    maxTaskCostCny: options.maxTaskCostCny ?? budgetCny,
    maxNoProgressRounds: options.maxNoProgressRounds,
  };

  const createDriver = () =>
    createLoop({ ...driverOptions, sa, git, gh });

  const world = {
    goal,
    tasks,
    lanes,
    batchSize,
    rounds: Math.ceil(tasks.length / batchSize),
    maxSlots,
    budgetCny,
    store,
    clock,
    github,
    sa,
    git,
    gh,
    verifier,
    goalEngine,
    log: [],
    drivers: [],
    createDriver,
    loop: null,

    async step() {
      const result = await world.loop.step();
      const snapshot = world.loop.snapshot();
      const entry = {
        iteration: snapshot.round,
        state: result.state,
        next: result.next,
        actions: clone(result.actions),
        snapshot: clone(snapshot),
        at: snapshot.updatedAt,
      };
      world.log.push(entry);
      store.recordStep(entry);
      return entry;
    },

    async runToTerminal(maxSteps = 200) {
      for (let index = 0; index < maxSteps; index += 1) {
        const entry = await world.step();
        if (entry.next === 'done' || entry.next === 'stop') return entry;
      }
      throw new Error(
        `fake dev loop did not terminate within ${maxSteps} steps`,
      );
    },

    restart() {
      const driver = createDriver();
      world.loop = driver;
      world.drivers.push(driver);
      return driver;
    },

    snapshot() {
      return world.loop.snapshot();
    },

    status() {
      return store.status();
    },

    now() {
      return clock.now();
    },
  };

  world.loop = createDriver();
  world.drivers.push(world.loop);
  return world;
}
