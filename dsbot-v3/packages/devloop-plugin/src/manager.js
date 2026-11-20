/**
 * Dev loop manager: the stateful seam behind the three model-facing tools.
 *
 * It composes four existing packages and owns nothing else:
 *
 *   goal-engine  -> decompose() turns the goal into lane task books
 *   autoloop     -> createLoop() drives plan/dispatch/collect/verify/merge
 *   provisioner  -> optional per-loop SuperAgent instance provisioning
 *   verifier-agent -> independent PASS/FAIL verdict for a submission
 *
 * Every external seam (sa / git / gh / runner / fs) is injected. This module
 * never imports a filesystem module, never opens a socket, never reads
 * `~/.dsh` and never uses the ambient clock unless the caller leaves the
 * default in place.
 *
 * The four sibling packages are loaded by package name (see `./deps.js`), so
 * the same source loads from this checkout and from an installed profile.
 */

import { loadDependency } from './deps.js';
import { DevloopError, devloopError, ERROR_CODES } from './errors.js';

const [autoloop, goalEngine, provisioner, verifierAgent] = await Promise.all([
  loadDependency('autoloop'),
  loadDependency('goalEngine'),
  loadDependency('provisioner'),
  loadDependency('verifierAgent'),
]);

const {
  createGitGhMerger,
  createLoop,
  createMemoryStore,
  createSaScheduler,
  DEFAULT_MAX_TASK_COST_CNY,
} = autoloop;
const { decompose } = goalEngine;
const { provision: provisionInstance } = provisioner;
const { verify: verifyPr } = verifierAgent;

/** Default executor concurrency when the tool caller omits `maxWorkers`. */
export const DEFAULT_MAX_WORKERS = 4;

/**
 * Placeholder base commit used when the caller supplies neither a goal/lane
 * base sha nor `options.baseSha`. goal-engine requires a 40-hex base in every
 * task book; real deployments should always pass a full `origin/main` sha.
 */
export const DEFAULT_BASE_SHA = '0'.repeat(40);

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Goal states accepted as done by the internal plan port. */
const MERGED = 'merged';

/**
 * Create one manager. A deployment creates one manager per process/profile;
 * each `loop_start` creates an independent autoloop instance and memory store.
 *
 * @param {object} [options]
 * @param {{ decompose: Function }} [options.goalEngine] goal-engine override
 * @param {Function} [options.loopFactory] autoloop factory override
 * @param {{ verify: Function } | Function} [options.verifier] verifier port override
 * @param {Function} [options.verify] verifier-agent entry point override
 * @param {{ provision: Function } | Function} [options.provisioner] provisioner override
 * @param {false | object} [options.provision] enable per-loop provisioning
 * @param {object} [options.fs] injected provisioner fs adapter
 * @param {object} [options.probe] injected provisioner health probe
 * @param {object} [options.sa] injected SuperAgent interface for the scheduler
 * @param {object} [options.git] injected git interface for the merger
 * @param {object|null} [options.gh] injected GitHub interface for the merger
 * @param {object} [options.runner] injected verifier-agent runner
 * @param {object} [options.scheduler] prebuilt autoloop scheduler
 * @param {object} [options.merger] prebuilt autoloop merger
 * @param {Function} [options.storeFactory] per-loop store factory
 * @param {Function} [options.clock] epoch-millisecond clock
 * @param {Function} [options.idFactory] deterministic loop id factory
 * @param {string} [options.baseSha] fallback 40-hex base commit
 */
export function createDevloopManager(options = {}) {
  if (!isPlainObject(options)) {
    throw devloopError(ERROR_CODES.invalidInput, 'manager options must be an object');
  }

  const engine = options.goalEngine ?? { decompose };
  const loopFactory = options.loopFactory ?? createLoop;
  const verifyFn = options.verify ?? verifyPr;
  const clock = options.clock ?? Date.now;
  const idFactory = options.idFactory ?? defaultIdFactory();
  const maxReworkRounds = options.maxReworkRounds;
  const maxNoProgressRounds = options.maxNoProgressRounds;

  requireFunction(engine.decompose, 'goalEngine.decompose');
  requireFunction(loopFactory, 'loopFactory');
  requireFunction(verifyFn, 'verify');
  requireFunction(clock, 'clock');
  requireFunction(idFactory, 'idFactory');

  /** @type {Map<string, object>} loopId -> live record */
  const loops = new Map();
  /** @type {Map<string, string>} normalized goal key -> loopId, never removed */
  const loopsByGoal = new Map();
  /** @type {Set<string>} goal keys reserved by an in-flight start */
  const pendingGoals = new Set();

  /**
   * Start a loop for a goal.
   *
   * Duplicate goals are rejected with `loop_exists`, including a goal whose
   * previous loop already stopped: the stop marker is irreversible.
   *
   * @param {{ goal: string|object, lanes: object[], budgetCny: number,
   *   maxWorkers?: number, baseSha?: string, prdIndex?: object }} input
   * @returns {Promise<object>} `{ loopId, state, iteration, running, ... }`
   */
  async function start(input) {
    const parsed = parseStart(input);
    const goalKey = normalizeGoalKey(parsed.title);

    if (loopsByGoal.has(goalKey) || pendingGoals.has(goalKey)) {
      throw devloopError(
        ERROR_CODES.loopExists,
        `a loop for goal "${parsed.title}" already exists`,
        { goal: parsed.title, loopId: loopsByGoal.get(goalKey) ?? null },
      );
    }

    pendingGoals.add(goalKey);
    let record = null;
    try {
      const decomposition = decomposeGoal(parsed, engine);
      const loopId = makeLoopId(goalKey, loops, idFactory);
      record = createRecord({ loopId, parsed, decomposition, clock });
      record.loop = buildLoop(record, loopFactory, options, verifyFn, {
        maxReworkRounds,
        maxNoProgressRounds,
      });
      await provisionRecord(record, options);
      loops.set(loopId, record);
      await driveInitial(record);
      loopsByGoal.set(goalKey, loopId);
      return startResult(record);
    } catch (error) {
      if (record !== null) loops.delete(record.loopId);
      throw normalizeError(error);
    } finally {
      pendingGoals.delete(goalKey);
    }
  }

  /**
   * Read the public loop status.
   *
   * @param {string} loopId
   * @returns {{ state: string, iteration: number, running: boolean,
   *   stoppedReason?: string }}
   */
  function status(loopId) {
    return statusOf(requireLoop(loopId, loops));
  }

  /**
   * Stop a loop with an irreversible marker.
   *
   * @param {string} loopId
   * @param {string} [reason='manual']
   * @returns {Promise<object>} status plus `loopId` and `irreversible: true`
   */
  async function stop(loopId, reason = 'manual') {
    const record = requireLoop(loopId, loops);
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw devloopError(ERROR_CODES.invalidInput, 'reason must be a non-empty string');
    }
    const label = reason.trim();

    if (record.stopped || record.irreversible) return stopResult(record);
    const current = statusOf(record);
    if (current.state === 'stopped') {
      record.stopped = true;
      record.irreversible = true;
      record.stopReason = current.stoppedReason ?? label;
      return stopResult(record);
    }

    try {
      await record.loop.stop(label, { source: 'loop_stop', irreversible: true });
    } catch (error) {
      throw devloopError(
        ERROR_CODES.loopError,
        `cannot stop loop "${record.loopId}": ${messageOf(error)}`,
        { loopId: record.loopId },
      );
    }
    record.stopped = true;
    record.irreversible = true;
    record.stopReason = label;
    record.stoppedAt = clock();
    return stopResult(record);
  }

  /**
   * Run at most `maxSteps` autoloop states, stopping at a terminal state or at
   * the first empty collect (`wait`). Host-side drivers may poll this; the
   * three model tools never call it.
   *
   * @param {string} loopId
   * @param {{ maxSteps?: number }} [options]
   * @returns {Promise<object>} the resulting public status
   */
  async function advance(loopId, { maxSteps = 16 } = {}) {
    const record = requireLoop(loopId, loops);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw devloopError(ERROR_CODES.invalidInput, 'maxSteps must be an integer >= 1');
    }
    for (let step = 0; step < maxSteps; step += 1) {
      const snapshot = snapshotOf(record);
      if (isTerminalSnapshot(snapshot)) break;
      const result = await record.loop.step();
      if (result.next === 'stop' || result.next === 'done') break;
      if (result.next === 'dispatch' && onlySlotsFull(result.actions)) break;
      if (result.next === 'collect' && waited(result.actions)) break;
    }
    return statusOf(record);
  }

  /**
   * One machine-readable summary, for diagnostics and the host UI.
   *
   * @param {string} loopId
   * @returns {object}
   */
  function get(loopId) {
    return summaryOf(requireLoop(loopId, loops));
  }

  /** @returns {object[]} summaries of every loop this manager created */
  function list() {
    return [...loops.values()].map(summaryOf);
  }

  return Object.freeze({ start, status, stop, advance, get, list });
}

function parseStart(input) {
  if (!isPlainObject(input)) {
    throw devloopError(ERROR_CODES.invalidInput, 'loop_start expects an object');
  }
  const title = goalTitle(input.goal);
  if (title === '') {
    throw devloopError(ERROR_CODES.emptyGoal, 'goal must not be empty');
  }
  if (!Array.isArray(input.lanes) || input.lanes.length === 0) {
    throw devloopError(ERROR_CODES.invalidInput, 'lanes must be a non-empty array', {
      field: 'lanes',
    });
  }
  if (typeof input.budgetCny !== 'number' || !Number.isFinite(input.budgetCny) || input.budgetCny <= 0) {
    throw devloopError(ERROR_CODES.invalidInput, 'budgetCny must be a positive finite number', {
      field: 'budgetCny',
    });
  }
  const maxWorkers = input.maxWorkers ?? DEFAULT_MAX_WORKERS;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 64) {
    throw devloopError(ERROR_CODES.invalidInput, 'maxWorkers must be an integer between 1 and 64', {
      field: 'maxWorkers',
    });
  }

  const explicitBase = normalizeSha(input.baseSha ?? goalBaseSha(input.goal), 'baseSha');
  const everyLaneHasBase = input.lanes.every(
    (lane) => isPlainObject(lane) && normalizeSha(laneBaseSha(lane), 'lane.baseSha') !== null,
  );
  // A real base is preferred; a placeholder keeps the documented four-argument
  // tool call usable when the caller has not captured origin/main yet.
  const baseSha = explicitBase ?? (everyLaneHasBase ? null : DEFAULT_BASE_SHA);

  const totalCost = sumLaneCosts(input.lanes);
  if (totalCost > input.budgetCny) {
    throw devloopError(
      ERROR_CODES.budgetExceeded,
      `lane costs ${totalCost} exceed budgetCny ${input.budgetCny}`,
      { total: totalCost, limit: input.budgetCny },
    );
  }

  return {
    goal: input.goal,
    title,
    lanes: input.lanes,
    budgetCny: input.budgetCny,
    maxWorkers,
    baseSha,
    prdIndex: input.prdIndex,
  };
}

function decomposeGoal(parsed, engine) {
  const goal = isPlainObject(parsed.goal) ? { ...parsed.goal } : { title: parsed.title };
  if (parsed.baseSha !== null) goal.baseSha = parsed.baseSha;

  let decomposition;
  try {
    decomposition = engine.decompose({
      goal,
      lanes: parsed.lanes,
      budget: { limit: parsed.budgetCny, unit: 'cny' },
      ...(parsed.prdIndex === undefined ? {} : { prdIndex: parsed.prdIndex }),
    });
  } catch (error) {
    throw normalizeEngineError(error);
  }
  if (!isPlainObject(decomposition) || !Array.isArray(decomposition.milestones)) {
    throw devloopError(
      ERROR_CODES.invalidInput,
      'goal engine returned no milestones array',
    );
  }
  return decomposition;
}

function createRecord({ loopId, parsed, decomposition, clock }) {
  const now = clock();
  const costs = laneCostMap(parsed.lanes);
  const laneConfigs = new Map();
  const tasks = [];

  for (const milestone of decomposition.milestones) {
    for (const lane of milestone.lanes) {
      const taskBook = lane.taskBook;
      laneConfigs.set(lane.lane, {
        lane: lane.lane,
        dir: lane.dir,
        acceptanceCommands: [...taskBook.acceptanceCommands],
        allowedPaths: [...taskBook.allowedPaths],
        minCases: taskBook.minCases,
        baseSha: taskBook.workBase.sha,
      });
      const cost = costs.get(lane.lane);
      tasks.push({
        id: `${milestone.id}:${lane.lane}`,
        lane: lane.lane,
        title: `${milestone.title} / ${lane.lane}`,
        goal: taskBook.background,
        ...(cost !== undefined && cost > 0 ? { budgetCny: cost } : {}),
      });
    }
  }

  return {
    loopId,
    goalKey: normalizeGoalKey(parsed.title),
    goalTitle: parsed.title,
    goal: parsed.goal,
    budgetCny: parsed.budgetCny,
    maxWorkers: parsed.maxWorkers,
    baseSha: parsed.baseSha,
    tasks,
    laneConfigs,
    snapshot: { state: 'plan', round: 0, stop: null },
    loop: null,
    instance: null,
    stopped: false,
    irreversible: false,
    stopReason: null,
    stoppedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildLoop(record, loopFactory, options, verifyFn, limits) {
  const scheduler = buildScheduler(record, options);
  const merger = buildMerger(options);
  const store = typeof options.storeFactory === 'function'
    ? options.storeFactory(record)
    : createMemoryStore();
  if (!isPlainObject(store) || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw devloopError(
      ERROR_CODES.missingDependency,
      'storeFactory must return a store with load() and save()',
    );
  }

  const maxTaskCostCny = Math.min(DEFAULT_MAX_TASK_COST_CNY, record.budgetCny);
  try {
    return loopFactory({
      loopId: record.loopId,
      goal: record.goalTitle,
      goalEngine: createPlanPort(record),
      scheduler,
      merger,
      verifier: createVerifierPort(record, options, verifyFn),
      store,
      clock: options.clock ?? Date.now,
      maxSlots: record.maxWorkers,
      maxTaskCostCny,
      ...(limits.maxReworkRounds === undefined ? {} : { maxReworkRounds: limits.maxReworkRounds }),
      ...(limits.maxNoProgressRounds === undefined
        ? {}
        : { maxNoProgressRounds: limits.maxNoProgressRounds }),
    });
  } catch (error) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      `cannot create autoloop: ${messageOf(error)}`,
    );
  }
}

function buildScheduler(record, options) {
  if (options.scheduler !== undefined) {
    if (!isPlainObject(options.scheduler)) {
      throw devloopError(ERROR_CODES.missingDependency, 'scheduler must be an object');
    }
    return options.scheduler;
  }
  if (!isPlainObject(options.sa)) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      'loop_start requires an injected sa interface or scheduler',
    );
  }
  try {
    return createSaScheduler({ sa: options.sa, maxSlots: record.maxWorkers });
  } catch (error) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      `cannot build the sa scheduler: ${messageOf(error)}`,
    );
  }
}

function buildMerger(options) {
  if (options.merger !== undefined) {
    if (!isPlainObject(options.merger)) {
      throw devloopError(ERROR_CODES.missingDependency, 'merger must be an object');
    }
    return options.merger;
  }
  if (!isPlainObject(options.git)) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      'loop_start requires an injected git interface or merger',
    );
  }
  try {
    return createGitGhMerger({ git: options.git, gh: options.gh ?? null });
  } catch (error) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      `cannot build the git merger: ${messageOf(error)}`,
    );
  }
}

function createPlanPort(record) {
  let announced = false;
  return {
    plan(context) {
      if (!announced) {
        announced = true;
        return {
          goal: record.goalTitle,
          tasks: record.tasks.map((task) => ({ ...task })),
        };
      }
      const tasks = Array.isArray(context?.tasks) ? context.tasks : [];
      if (tasks.length > 0 && tasks.every((task) => task.state === MERGED)) {
        return { done: true };
      }
      return {};
    },
  };
}

function createVerifierPort(record, options, verifyFn) {
  if (options.verifier !== undefined) {
    const verifier = typeof options.verifier === 'function'
      ? { verify: options.verifier }
      : options.verifier;
    if (!isPlainObject(verifier) || typeof verifier.verify !== 'function') {
      throw devloopError(
        ERROR_CODES.missingDependency,
        'verifier must expose verify()',
      );
    }
    return verifier;
  }

  return {
    async verify(context) {
      const task = context?.task ?? {};
      const lane = record.laneConfigs.get(task.lane) ?? {};
      const commit = context?.submission?.commit;
      if (typeof commit !== 'string' || !FULL_SHA.test(commit)) {
        return fail('invalid_submission', `task ${task.id ?? '?'} has no full commit sha`);
      }
      if (!isPlainObject(options.runner)) {
        return fail('missing_runner', 'no verifier-agent runner was injected');
      }
      const base = lane.baseSha ?? record.baseSha ?? DEFAULT_BASE_SHA;
      if (typeof base !== 'string' || !FULL_SHA.test(base)) {
        return fail('invalid_base', `lane ${task.lane} has no full base sha`);
      }
      const command = lane.acceptanceCommands?.[0];
      if (typeof command !== 'string' || command.trim() === '') {
        return fail('invalid_lane', `lane ${task.lane} has no acceptance command`);
      }

      try {
        return await verifyFn({
          pr: {
            number: context.submission?.prNumber ?? context.task?.prNumber ?? 0,
            base,
            head: commit,
          },
          lane: task.lane,
          allowedDirs: [lane.dir],
          command,
          minCases: lane.minCases ?? 1,
          runner: options.runner,
        });
      } catch (error) {
        return fail('verifier_error', messageOf(error));
      }
    },
  };
}

async function provisionRecord(record, options) {
  const config = options.provision;
  if (config === undefined || config === null || config === false) return;
  if (!isPlainObject(config)) {
    throw devloopError(ERROR_CODES.invalidInput, 'provision must be an object or false');
  }
  if (!isPlainObject(options.fs)) {
    throw devloopError(
      ERROR_CODES.missingDependency,
      'provisioning requires an injected fs adapter',
    );
  }
  const provision = typeof options.provisioner === 'function'
    ? options.provisioner
    : options.provisioner?.provision ?? provisionInstance;
  if (typeof provision !== 'function') {
    throw devloopError(
      ERROR_CODES.missingDependency,
      'provisioning requires provisioner.provision()',
    );
  }

  const name = typeof config.name === 'string' && config.name.trim() !== ''
    ? config.name.trim()
    : record.loopId;
  try {
    const instance = await provision({
      name,
      repo: config.repo,
      port: config.port ?? 'auto',
      model: config.model,
      workRoot: config.workRoot,
      account: config.account,
      maxWorkers: record.maxWorkers,
      fs: options.fs,
      probe: options.probe,
      isPortFree: options.isPortFree,
    });
    record.instance = instance === undefined || instance === null
      ? null
      : {
          name,
          profileDir: instance.profileDir ?? null,
          port: instance.port ?? null,
          created: instance.created ?? null,
        };
  } catch (error) {
    throw devloopError(
      ERROR_CODES.provisionFailed,
      `provisioner failed: ${messageOf(error)}`,
      { loopId: record.loopId, cause: error?.code ?? null },
    );
  }
}

async function driveInitial(record) {
  for (let step = 0; step < 4; step += 1) {
    if (isTerminalSnapshot(snapshotOf(record))) return;
    const result = await record.loop.step();
    if (result.state === 'collect' || result.next === 'stop' || result.next === 'done') return;
    if (result.next === 'collect') return;
    if (result.next === 'dispatch' && onlySlotsFull(result.actions)) return;
  }
}

function statusOf(record) {
  const snapshot = snapshotOf(record);
  const autoState = typeof snapshot?.state === 'string' ? snapshot.state : 'plan';
  const stopped = Boolean(snapshot?.stop) || autoState === 'stop';
  const state = stopped ? 'stopped' : autoState;
  const iteration = Number.isInteger(snapshot?.round)
    ? snapshot.round
    : Number.isInteger(record.snapshot?.round)
      ? record.snapshot.round
      : 0;
  const running = !stopped && state !== 'done';

  return {
    state,
    iteration,
    running,
    ...(stopped
      ? { stoppedReason: snapshot?.stop?.reason ?? record.stopReason ?? 'stopped' }
      : {}),
  };
}

function startResult(record) {
  return {
    loopId: record.loopId,
    ...statusOf(record),
    tasks: record.tasks.length,
    budgetCny: record.budgetCny,
    baseSha: record.baseSha,
    ...(record.instance === null ? {} : { instance: record.instance }),
  };
}

function stopResult(record) {
  return {
    loopId: record.loopId,
    ...statusOf(record),
    irreversible: true,
  };
}

function summaryOf(record) {
  return {
    loopId: record.loopId,
    goal: record.goalTitle,
    budgetCny: record.budgetCny,
    maxWorkers: record.maxWorkers,
    baseSha: record.baseSha,
    ...statusOf(record),
    irreversible: record.irreversible,
    taskCount: record.tasks.length,
    instance: record.instance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function snapshotOf(record) {
  if (record.loop !== null && typeof record.loop?.snapshot === 'function') {
    const snapshot = record.loop.snapshot();
    if (snapshot !== null && snapshot !== undefined) return snapshot;
  }
  return record.snapshot ?? null;
}

function isTerminalSnapshot(snapshot) {
  return Boolean(snapshot?.stop) || snapshot?.state === 'stop' || snapshot?.state === 'done';
}

function onlySlotsFull(actions) {
  return Array.isArray(actions) && actions.length > 0 && actions.every((action) => action.type === 'slots_full');
}

function waited(actions) {
  return Array.isArray(actions) && actions.some((action) => action.type === 'wait');
}

function requireLoop(loopId, loops) {
  if (typeof loopId !== 'string' || loopId.trim() === '') {
    throw devloopError(ERROR_CODES.invalidInput, 'loopId must be a non-empty string');
  }
  const id = loopId.trim();
  const record = loops.get(id);
  if (record === undefined) {
    throw devloopError(ERROR_CODES.notFound, `loop "${id}" was not found`, { loopId: id });
  }
  return record;
}

function makeLoopId(goalKey, loops, idFactory) {
  const raw = idFactory(goalKey);
  const base = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'loop';
  let candidate = base;
  let suffix = 2;
  while (loops.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function defaultIdFactory() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `loop-${Date.now().toString(36)}-${sequence.toString(36)}`;
  };
}

function goalTitle(goal) {
  if (typeof goal === 'string') return goal.trim();
  if (isPlainObject(goal)) {
    const title = goal.title ?? goal.name ?? goal.subject;
    if (typeof title !== 'string') {
      throw devloopError(
        ERROR_CODES.invalidInput,
        'goal.title must be a non-empty string',
        { field: 'goal.title' },
      );
    }
    return title.trim();
  }
  throw devloopError(
    ERROR_CODES.invalidInput,
    'goal must be a non-empty string or an object with a title',
  );
}

function goalBaseSha(goal) {
  return isPlainObject(goal) ? goal.baseSha ?? goal.base_sha ?? goal.base : undefined;
}

function laneBaseSha(lane) {
  return lane.baseSha ?? lane.base_sha ?? lane.base;
}

function normalizeSha(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !FULL_SHA.test(value.trim())) {
    throw devloopError(
      ERROR_CODES.invalidInput,
      `${field} must be a 40-character hexadecimal commit sha`,
      { field },
    );
  }
  return value.trim().toLowerCase();
}

function sumLaneCosts(lanes) {
  let total = 0;
  for (const [index, lane] of lanes.entries()) {
    if (!isPlainObject(lane)) {
      throw devloopError(ERROR_CODES.invalidInput, `lanes[${index}] must be an object`, {
        index,
      });
    }
    const cost = lane.cost ?? lane.weight ?? 1;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      throw devloopError(
        ERROR_CODES.invalidInput,
        `lanes[${index}].cost must be a non-negative finite number`,
        { index },
      );
    }
    total += cost;
  }
  return total;
}

function laneCostMap(lanes) {
  const costs = new Map();
  for (const lane of lanes) {
    const name = lane?.lane ?? lane?.name ?? lane?.id;
    if (typeof name !== 'string' || name.trim() === '') continue;
    const cost = lane.cost ?? lane.weight ?? 1;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      costs.set(name.trim(), cost);
    }
  }
  return costs;
}

function normalizeGoalKey(title) {
  return title.replace(/\s+/g, ' ').trim();
}

function normalizeEngineError(error) {
  if (error instanceof DevloopError) return error;
  const message = messageOf(error);
  if (error?.code === 'budget_exceeded' || error?.code === 'empty_goal') {
    return new DevloopError(error.code, message, error.details);
  }
  return new DevloopError(
    ERROR_CODES.invalidInput,
    message,
    error?.code === undefined ? undefined : { ...(error.details ?? {}), cause: error.code },
  );
}

function normalizeError(error) {
  if (error instanceof DevloopError) return error;
  const message = messageOf(error);
  if (error?.code === 'budget_exceeded' || error?.code === 'empty_goal') {
    return new DevloopError(error.code, message, error.details);
  }
  return new DevloopError(
    ERROR_CODES.loopError,
    message,
    error?.code === undefined ? undefined : { cause: error.code },
  );
}

function fail(reason, feedback) {
  return { verdict: 'FAIL', reason, feedback };
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw devloopError(
      ERROR_CODES.missingDependency,
      `${name} must be a function`,
      { dependency: name },
    );
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
