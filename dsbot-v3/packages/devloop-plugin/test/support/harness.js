/**
 * Shared fakes for the devloop-plugin suite.
 *
 * Every seam is an in-memory fake: no test opens a socket, spawns a process or
 * touches the real `~/.dsh`.
 */

import path from 'node:path';
import { createDevloopManager } from '../../src/index.js';

export const BASE_SHA = 'a'.repeat(40);
export const SUBMISSION_SHA = 'b'.repeat(40);

export function goal(overrides = {}) {
  return { title: 'Ship the export button', baseSha: BASE_SHA, ...overrides };
}

export function lane(overrides = {}) {
  return { lane: 'ui', dir: 'packages/ui', cost: 1, ...overrides };
}

export function startInput(overrides = {}) {
  return {
    goal: goal(),
    lanes: [lane()],
    budgetCny: 10,
    maxWorkers: 2,
    ...overrides,
  };
}

export function createClock(start = 1_700_000_000_000, step = 1_000) {
  let now = start;
  return () => {
    now += step;
    return now;
  };
}

/**
 * Scheduler whose `collect` is either empty (the loop waits) or returns every
 * dispatched work order once (the loop can be driven to completion).
 */
export function createScriptedScheduler({ collect = 'empty', maxSlots = 4 } = {}) {
  let active = 0;
  const dispatched = [];
  const calls = { dispatch: 0, collect: 0, rework: 0 };

  return {
    calls,
    dispatched,
    freeSlots() {
      return Math.max(0, maxSlots - active);
    },
    async dispatch(request) {
      calls.dispatch += 1;
      active += 1;
      const workOrderId = `wo-${request.taskId}-a${request.attempt}`;
      dispatched.push({ ...request, workOrderId });
      return { workOrderId };
    },
    async collect() {
      calls.collect += 1;
      if (collect === 'empty') return [];
      const items = dispatched.splice(0);
      active = Math.max(0, active - items.length);
      return items.map((item) => ({
        taskId: item.taskId,
        workOrderId: item.workOrderId,
        commit: SUBMISSION_SHA,
        costCny: 1,
        output: 'ok',
        tests: { passed: 3 },
      }));
    },
    async rework(request) {
      calls.rework += 1;
      const workOrderId = `${request.workOrderId}-rework${calls.rework}`;
      // A rework opens a new work order; queue its submission so the next
      // collect step can observe it.
      dispatched.push({
        taskId: request.taskId,
        lane: request.lane,
        workOrderId,
      });
      return { workOrderId };
    },
  };
}

export function createMerger() {
  const merges = [];
  return {
    merges,
    async merge(request) {
      merges.push(request);
      return {
        merged: true,
        commit: request.submission?.commit ?? SUBMISSION_SHA,
        pr: { number: merges.length },
      };
    },
  };
}

export function createVerifier(verdict = 'PASS', feedback = '') {
  const calls = [];
  return {
    calls,
    async verify(context) {
      calls.push(context);
      return { verdict, feedback };
    },
  };
}

/**
 * `sa` interface for `createSaScheduler`. A completed work order is idle, so
 * the scheduler can collect it while keeping the slot free.
 */
export function createFakeSa({ state = 'completed' } = {}) {
  const orders = [];
  return {
    orders,
    async dispatch({ ticket, idempotencyKey }) {
      const id = `sa-order-${orders.length + 1}`;
      orders.push({
        id,
        taskId: ticket.id,
        lane: ticket.lane,
        state,
        idempotencyKey,
        result: {
          commit: SUBMISSION_SHA,
          costCny: 1,
          output: 'ok',
          tests: { passed: 3 },
        },
      });
      return { id };
    },
    async list() {
      return orders.map((order) => ({ ...order }));
    },
    async rework({ id, ticket }) {
      const next = `${id}-r${orders.length + 1}`;
      orders.push({
        id: next,
        taskId: ticket.id,
        lane: ticket.lane,
        state,
        result: {
          commit: SUBMISSION_SHA,
          costCny: 1,
          output: 'ok',
          tests: { passed: 3 },
        },
      });
      return { id: next };
    },
  };
}

export function createFakeGit() {
  const merges = [];
  return {
    merges,
    async merge(request) {
      merges.push(request);
      return { merged: true, commit: request.commit ?? SUBMISSION_SHA };
    },
  };
}

export function createFakeGh() {
  const pullRequests = [];
  return {
    pullRequests,
    async openPr(request) {
      pullRequests.push(request);
      return {
        number: pullRequests.length,
        url: `https://example.test/pull/${pullRequests.length}`,
      };
    },
  };
}

/** Verifier-agent runner satisfying the five-method contract. */
export function createFakeRunner({
  exit = 0,
  output = '# tests 3\n# pass 3\n# fail 0\n',
  changed = ['packages/ui/src/button.js'],
} = {}) {
  const calls = [];
  return {
    calls,
    async resolveHead() {
      return SUBMISSION_SHA;
    },
    async prepare(_pr, options) {
      calls.push({ step: 'prepare', options });
      return { worktree: '/fake/worktree' };
    },
    async head() {
      return SUBMISSION_SHA;
    },
    async changedFiles() {
      return [...changed];
    },
    async run({ command }) {
      calls.push({ step: 'run', command });
      return { exit, output };
    },
  };
}

/**
 * In-memory provisioner fs adapter. The seven methods match the provisioner
 * contract; nothing here reaches the real disk.
 */
export function createFakeFs({ home = path.resolve('.fake-dsh-home'), files = {}, dirs = [] } = {}) {
  const fileMap = new Map();
  const dirSet = new Set();
  const normalize = (target) => path.resolve(target);

  function addAncestors(directory) {
    let current = normalize(directory);
    const { root } = path.parse(current);
    for (;;) {
      dirSet.add(current);
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const [target, content] of Object.entries(files)) {
    const normalized = normalize(target);
    fileMap.set(normalized, String(content));
    addAncestors(path.dirname(normalized));
  }
  for (const directory of dirs) addAncestors(directory);
  addAncestors(home);

  return {
    home,
    _files: fileMap,
    _dirs: dirSet,
    homedir() {
      return home;
    },
    exists(target) {
      const normalized = normalize(target);
      return fileMap.has(normalized) || dirSet.has(normalized);
    },
    readFile(target) {
      const normalized = normalize(target);
      if (!fileMap.has(normalized)) {
        const error = new Error(`ENOENT: no such file or directory, open '${normalized}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return fileMap.get(normalized);
    },
    writeFile(target, data) {
      const normalized = normalize(target);
      addAncestors(path.dirname(normalized));
      fileMap.set(normalized, String(data));
    },
    mkdir(target) {
      addAncestors(target);
    },
    remove(target) {
      const normalized = normalize(target);
      const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
      for (const key of [...fileMap.keys()]) {
        if (key === normalized || key.startsWith(prefix)) fileMap.delete(key);
      }
      for (const directory of [...dirSet]) {
        if (directory === normalized || directory.startsWith(prefix)) dirSet.delete(directory);
      }
    },
    list(target) {
      const normalized = normalize(target);
      if (!dirSet.has(normalized)) return [];
      const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
      const names = new Set();
      for (const key of [...fileMap.keys(), ...dirSet]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest !== '' && !rest.includes(path.sep)) names.add(rest);
      }
      return [...names].sort();
    },
  };
}

/**
 * Manager wired with scripted scheduler/merger/verifier fakes and deterministic
 * clock/id factory. Overrides win over every default.
 */
export function createHarness(overrides = {}) {
  const {
    scheduler = createScriptedScheduler(),
    merger = createMerger(),
    verifier = createVerifier(),
    clock = createClock(),
    idFactory = (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return `loop-test-${sequence}`;
      };
    })(),
    ...rest
  } = overrides;

  const manager = createDevloopManager({
    scheduler,
    merger,
    verifier,
    clock,
    idFactory,
    ...rest,
  });
  return { manager, scheduler, merger, verifier };
}
