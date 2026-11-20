import { ACTIVE_RUN_STATES } from './states.js';
import { serviceError } from './errors.js';

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

/**
 * In-memory implementation of the injected state-store interface.
 *
 * The service depends only on the methods below; a SQLite/Postgres adapter can
 * replace this object without touching the state machine. Every write is
 * copy-on-write, every read returns a clone, so callers cannot mutate the
 * ledger by accident.
 *
 * Store contract
 *  - createTask/getTask/updateTask/listTasks
 *  - createRun/getRun/updateRun/listRuns/listActiveRuns
 *  - createClaim/listClaims
 *  - createAcceptance/getAcceptance/updateAcceptance/listAcceptances
 *  - appendEvent/listEvents/lastEventHash
 *  - getIdempotency/putIdempotency
 *  - appendStopVerification/listStopVerifications
 */
export function createMemoryStore() {
  const tasks = new Map();
  const runs = new Map();
  const acceptances = new Map();
  const claims = new Map();
  const events = [];
  const idempotency = new Map();
  const stopVerifications = [];
  let eventSeq = 0;

  function require(map, id, kind) {
    if (!map.has(id)) {
      throw serviceError('not_found', `${kind} ${id} does not exist`, { kind, id });
    }
    return map.get(id);
  }

  function insert(map, entity, kind) {
    if (map.has(entity.id)) {
      throw serviceError('validation_error', `${kind} ${entity.id} already exists`, {
        kind,
        id: entity.id,
      });
    }
    map.set(entity.id, clone(entity));
    return clone(entity);
  }

  function update(map, id, patch, expectedStateVersion, kind) {
    const current = require(map, id, kind);
    if (
      expectedStateVersion !== undefined &&
      expectedStateVersion !== null &&
      current.stateVersion !== expectedStateVersion
    ) {
      throw serviceError(
        'state_conflict',
        `${kind} ${id} state version mismatch (expected ${expectedStateVersion}, actual ${current.stateVersion})`,
        { kind, id, expectedStateVersion, actualStateVersion: current.stateVersion },
      );
    }
    const next = {
      ...current,
      ...clone(patch),
      stateVersion: current.stateVersion + 1,
    };
    map.set(id, next);
    return clone(next);
  }

  return {
    kind: 'memory',

    createTask(task) {
      return insert(tasks, task, 'task');
    },
    getTask(id) {
      return mapGet(tasks, id);
    },
    updateTask(id, patch, options = {}) {
      return update(tasks, id, patch, options.expectedStateVersion, 'task');
    },
    listTasks(filter = {}) {
      return filterValues(tasks, filter, (task) => {
        if (filter.parentTaskId !== undefined && task.parentTaskId !== filter.parentTaskId) {
          return false;
        }
        if (filter.state !== undefined && task.state !== filter.state) return false;
        if (filter.level !== undefined && task.level !== filter.level) return false;
        return true;
      });
    },

    createRun(run) {
      return insert(runs, run, 'run');
    },
    getRun(id) {
      return mapGet(runs, id);
    },
    updateRun(id, patch, options = {}) {
      return update(runs, id, patch, options.expectedStateVersion, 'run');
    },
    listRuns(filter = {}) {
      return filterValues(runs, filter, (run) => {
        if (filter.taskId !== undefined && run.taskId !== filter.taskId) return false;
        if (filter.state !== undefined && run.state !== filter.state) return false;
        return true;
      });
    },
    listActiveRuns(taskId) {
      return filterValues(
        runs,
        { taskId },
        (run) => run.taskId === taskId && ACTIVE_RUN_STATES.includes(run.state),
      );
    },

    createClaim(claim) {
      return insert(claims, claim, 'claim');
    },
    listClaims(filter = {}) {
      return filterValues(claims, filter, (claim) => {
        if (filter.runId !== undefined && claim.runId !== filter.runId) return false;
        if (filter.taskId !== undefined && claim.taskId !== filter.taskId) return false;
        return true;
      });
    },

    createAcceptance(acceptance) {
      return insert(acceptances, acceptance, 'acceptance');
    },
    getAcceptance(id) {
      return mapGet(acceptances, id);
    },
    updateAcceptance(id, patch, options = {}) {
      return update(acceptances, id, patch, options.expectedStateVersion, 'acceptance');
    },
    listAcceptances(filter = {}) {
      return filterValues(acceptances, filter, (acceptance) => {
        if (filter.taskId !== undefined && acceptance.taskId !== filter.taskId) return false;
        if (filter.stage !== undefined && acceptance.stage !== filter.stage) return false;
        if (filter.state !== undefined && acceptance.state !== filter.state) return false;
        if (filter.runId !== undefined && acceptance.runId !== filter.runId) return false;
        if (filter.openOnly === true && acceptance.state !== 'open') return false;
        return true;
      });
    },

    appendEvent(event) {
      eventSeq += 1;
      const stored = { ...clone(event), seq: eventSeq };
      events.push(stored);
      return clone(stored);
    },
    listEvents(filter = {}) {
      return filterValues(new Map(events.map((event) => [String(event.seq), event])), filter, (event) => {
        if (filter.type !== undefined && event.type !== filter.type) return false;
        if (filter.taskId !== undefined && event.taskId !== filter.taskId) return false;
        if (filter.runId !== undefined && event.runId !== filter.runId) return false;
        if (filter.acceptanceId !== undefined && event.acceptanceId !== filter.acceptanceId) {
          return false;
        }
        return true;
      });
    },
    lastEventHash() {
      return events.length === 0 ? null : events[events.length - 1].hash;
    },

    getIdempotency(key) {
      return idempotency.has(key) ? clone(idempotency.get(key)) : null;
    },
    putIdempotency(key, record) {
      idempotency.set(key, clone(record));
      return clone(record);
    },

    appendStopVerification(record) {
      const stored = { ...clone(record), seq: stopVerifications.length + 1 };
      stopVerifications.push(stored);
      return clone(stored);
    },
    listStopVerifications(filter = {}) {
      return filterValues(
        new Map(stopVerifications.map((entry) => [String(entry.seq), entry])),
        filter,
        (entry) => {
          if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false;
          if (filter.runId !== undefined && entry.runId !== filter.runId) return false;
          return true;
        },
      );
    },
  };
}

function mapGet(map, id) {
  return map.has(id) ? clone(map.get(id)) : null;
}

function filterValues(map, filter, predicate) {
  const result = [];
  for (const entity of map.values()) {
    if (predicate(entity)) result.push(clone(entity));
  }
  return result;
}
