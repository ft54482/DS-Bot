import { serviceError } from '../../service/src/errors.js';
import { ACTIVE_RUN_STATES } from '../../service/src/states.js';

/**
 * Adapter between the L2 service's injected store contract and the L1 SQLite
 * store (`packages/store`).
 *
 * The service owns a handful of fields the L1 schema does not model yet
 * (`state_version`, `revision`, `cycle_no`, lease/dispatch blobs, acceptance
 * items, ...). Those fields are persisted as a JSON sidecar in columns the SQL
 * schema already exposes for free-form JSON (`task.acceptance_criteria`,
 * `run.authorization_json`, `acceptance.notes`), while the columns that have
 * schema guards (`task.state`, `acceptance.state`, `stage`, `parent_task_id`)
 * are written normally so the L1 triggers still run.
 *
 * Only API-layer code imports this file; `packages/store` stays untouched.
 */
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

const TASK_META_FIELDS = [
  'stateVersion',
  'revision',
  'cycleNo',
  'subject',
  'subjectFingerprint',
  'budget',
  'currentRunId',
  'openAcceptanceId',
  'blockedReason',
  'pausedReason',
  'stopState',
  'stopUnknown',
  'stopRequestedAt',
  'stopRequestedBy',
  'stopReason',
  'stopVerifiedAt',
  'unsafeStop',
  'startedAt',
  'queuedAt',
  'terminalAt',
  'goal',
  'project',
];

const ACCEPTANCE_TABLE_STATE = Object.freeze({
  open: 'open',
  passed: 'passed',
  revise: 'rejected',
  failed: 'rejected',
  blocked: 'rejected',
  void: 'invalidated',
  superseded: 'superseded',
});

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return clone(fallback);
  if (typeof value === 'object') return clone(value);
  try {
    return JSON.parse(value);
  } catch {
    return clone(fallback);
  }
}

function json(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  return JSON.stringify(value);
}

function tableState(state) {
  return ACCEPTANCE_TABLE_STATE[state] ?? 'open';
}

function acceptanceMode(acceptance) {
  const items = Array.isArray(acceptance.items) ? acceptance.items : [];
  if (items.some((item) => item?.class === 'human')) return 'human';
  if (items.some((item) => item?.class === 'independent')) return 'independent';
  return 'auto';
}

export function createSqliteServiceStore(sqliteStore) {
  if (!sqliteStore || !sqliteStore.db) {
    throw serviceError('validation_error', 'createSqliteServiceStore requires an open Store');
  }
  const db = sqliteStore.db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_idempotency (
      key         TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_stop_verification (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      record_json TEXT NOT NULL
    );
  `);

  function taskMeta(task) {
    const meta = {};
    for (const field of TASK_META_FIELDS) meta[field] = task[field] ?? null;
    meta.stateVersion = task.stateVersion ?? 1;
    meta.revision = task.revision ?? 0;
    meta.cycleNo = task.cycleNo ?? 1;
    meta.authScope = task.authScope ?? null;
    return meta;
  }

  function taskFromRow(row) {
    if (!row) return null;
    const meta = parseJson(row.acceptance_criteria, {});
    return {
      id: row.id,
      level: row.level,
      parentTaskId: row.parent_task_id,
      title: row.title,
      owner: row.owner_ref,
      state: row.state,
      stateVersion: meta.stateVersion ?? 1,
      revision: meta.revision ?? 0,
      cycleNo: meta.cycleNo ?? 1,
      subject: meta.subject ?? null,
      subjectFingerprint: meta.subjectFingerprint ?? null,
      acceptanceProfile: parseJson(row.acceptance_profile, null),
      budget:
        meta.budget ??
        (row.budget_cny_cap === null ? null : { capCny: row.budget_cny_cap }),
      authScope: meta.authScope ?? parseJson(row.authorization_json, null),
      currentRunId: meta.currentRunId ?? null,
      openAcceptanceId: meta.openAcceptanceId ?? null,
      blockedReason: meta.blockedReason ?? null,
      pausedReason: meta.pausedReason ?? null,
      stopState: meta.stopState ?? null,
      stopUnknown: meta.stopUnknown ?? false,
      stopRequestedAt: meta.stopRequestedAt ?? null,
      stopRequestedBy: meta.stopRequestedBy ?? null,
      stopReason: meta.stopReason ?? null,
      stopVerifiedAt: meta.stopVerifiedAt ?? null,
      unsafeStop: meta.unsafeStop ?? false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: meta.startedAt ?? null,
      queuedAt: meta.queuedAt ?? null,
      terminalAt: meta.terminalAt ?? row.closed_at ?? null,
      goal: meta.goal ?? row.goal ?? null,
      project: meta.project ?? row.project ?? null,
    };
  }

  function runFromRow(row) {
    if (!row) return null;
    const meta = parseJson(row.authorization_json, {});
    const stored = meta.serviceRun ?? {};
    return {
      ...stored,
      id: row.id,
      taskId: row.task_id,
      state: row.state,
      stateVersion: meta.stateVersion ?? stored.stateVersion ?? 1,
      attemptNo: stored.attemptNo ?? row.run_no,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? stored.startedAt ?? null,
      endedAt: row.ended_at ?? stored.endedAt ?? null,
      failureReason: row.exit_reason ?? stored.failureReason ?? null,
    };
  }

  function acceptanceFromRow(row) {
    if (!row) return null;
    const meta = parseJson(row.notes, {});
    const stored = meta.service ?? {};
    return {
      ...stored,
      id: row.id,
      taskId: row.target_task_id,
      runId: row.run_id,
      stage: row.stage,
      state: stored.state ?? (row.state === 'rejected' ? 'failed' : row.state),
      stateVersion: meta.stateVersion ?? stored.stateVersion ?? 1,
      subjectFingerprint: row.subject_fingerprint ?? stored.subjectFingerprint ?? null,
      items: stored.items ?? parseJson(row.criteria_json, []),
      openedAt: stored.openedAt ?? row.created_at,
      decidedAt: row.decided_at ?? stored.decidedAt ?? null,
      updatedAt: stored.updatedAt ?? row.decided_at ?? row.created_at,
    };
  }

  return {
    kind: 'sqlite-via-store',

    // ------------------------------------------------------------------
    // task
    // ------------------------------------------------------------------
    createTask(task) {
      sqliteStore.createTask({
        id: task.id,
        level: task.level,
        title: task.title,
        goal: task.subject?.goal ?? task.goal ?? task.title,
        project: task.subject?.project ?? task.project ?? 'default',
        domain: 'ops',
        acceptance_profile: json(task.acceptanceProfile, null),
        state: task.state ?? 'planned',
        parent_task_id: task.parentTaskId ?? null,
        delegator_kind:
          task.level === 'goal' ? 'human' : task.level === 'business' ? 'chief' : 'bot',
        delegator_ref: task.owner ?? 'api',
        owner_ref: task.owner ?? 'api',
        authorization_json: json(task.authScope ?? {}),
        acceptance_criteria: json(taskMeta(task)),
        hard_rules_json: '[]',
        budget_cny_cap: task.budget?.capCny ?? task.budget?.cny ?? null,
        idempotency_key: `task:${task.id}`,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        closed_at: task.terminalAt ?? null,
      });
      return this.getTask(task.id);
    },

    getTask(taskId) {
      return taskFromRow(db.prepare('SELECT * FROM task WHERE id = ?').get(taskId));
    },

    updateTask(taskId, patch, options = {}) {
      const current = this.getTask(taskId);
      if (!current) throw serviceError('not_found', `task ${taskId} does not exist`, { taskId });
      if (
        options.expectedStateVersion !== undefined &&
        options.expectedStateVersion !== null &&
        current.stateVersion !== options.expectedStateVersion
      ) {
        throw serviceError(
          'state_conflict',
          `task ${taskId} state version mismatch (expected ${options.expectedStateVersion}, actual ${current.stateVersion})`,
          {
            taskId,
            expectedStateVersion: options.expectedStateVersion,
            actualStateVersion: current.stateVersion,
          },
        );
      }
      const next = { ...current, ...clone(patch), stateVersion: current.stateVersion + 1 };
      const updatedAt = next.updatedAt ?? Date.now();
      db.prepare(
        `UPDATE task
            SET state = ?, acceptance_criteria = ?, updated_at = ?, closed_at = ?
          WHERE id = ?`,
      ).run(
        next.state,
        json(taskMeta(next)),
        updatedAt,
        next.terminalAt ?? null,
        taskId,
      );
      return this.getTask(taskId);
    },

    listTasks(filter = {}) {
      const where = [];
      const params = [];
      const columns = { parentTaskId: 'parent_task_id', state: 'state', level: 'level' };
      for (const [key, column] of Object.entries(columns)) {
        if (filter[key] !== undefined && filter[key] !== null) {
          where.push(`${column} = ?`);
          params.push(filter[key]);
        }
      }
      const sql = `SELECT * FROM task ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at ASC`;
      return db
        .prepare(sql)
        .all(...params)
        .map(taskFromRow);
    },

    // ------------------------------------------------------------------
    // run
    // ------------------------------------------------------------------
    createRun(run) {
      sqliteStore.createRun({
        id: run.id,
        task_id: run.taskId,
        run_no: run.attemptNo ?? 1,
        attempt: run.attemptNo ?? 1,
        state: run.state ?? 'queued',
        executor_kind: run.executorKind ?? 'dsh_session',
        idempotency_key: `run:${run.id}`,
        authorization_json: json({
          stateVersion: run.stateVersion ?? 1,
          serviceRun: run,
        }),
        started_at: run.startedAt ?? null,
        ended_at: run.endedAt ?? null,
        exit_reason: run.failureReason ?? null,
        created_at: run.createdAt,
        updated_at: run.updatedAt,
      });
      return this.getRun(run.id);
    },

    getRun(runId) {
      return runFromRow(db.prepare('SELECT * FROM run WHERE id = ?').get(runId));
    },

    updateRun(runId, patch, options = {}) {
      const current = this.getRun(runId);
      if (!current) throw serviceError('not_found', `run ${runId} does not exist`, { runId });
      if (
        options.expectedStateVersion !== undefined &&
        options.expectedStateVersion !== null &&
        current.stateVersion !== options.expectedStateVersion
      ) {
        throw serviceError(
          'state_conflict',
          `run ${runId} state version mismatch (expected ${options.expectedStateVersion}, actual ${current.stateVersion})`,
          {
            runId,
            expectedStateVersion: options.expectedStateVersion,
            actualStateVersion: current.stateVersion,
          },
        );
      }
      const next = { ...current, ...clone(patch), stateVersion: current.stateVersion + 1 };
      db.prepare(
        `UPDATE run
            SET state = ?, authorization_json = ?, started_at = ?, ended_at = ?,
                exit_reason = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        next.state,
        json({ stateVersion: next.stateVersion, serviceRun: next }),
        next.startedAt ?? null,
        next.endedAt ?? null,
        next.failureReason ?? null,
        next.updatedAt ?? Date.now(),
        runId,
      );
      return this.getRun(runId);
    },

    listRuns(filter = {}) {
      const where = [];
      const params = [];
      if (filter.taskId !== undefined && filter.taskId !== null) {
        where.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter.state !== undefined && filter.state !== null) {
        where.push('state = ?');
        params.push(filter.state);
      }
      const sql = `SELECT * FROM run ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at ASC`;
      return db
        .prepare(sql)
        .all(...params)
        .map(runFromRow);
    },

    listActiveRuns(taskId) {
      return this.listRuns({ taskId }).filter((run) => ACTIVE_RUN_STATES.includes(run.state));
    },

    // ------------------------------------------------------------------
    // claim (L2 rich claim; L1 only has an id/text shell)
    // ------------------------------------------------------------------
    createClaim(claim) {
      db.prepare(
        `INSERT INTO claim (id, task_id, run_id, stage, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        claim.id,
        claim.taskId,
        claim.runId ?? null,
        claim.stage,
        json(claim),
        claim.createdAt ?? Date.now(),
      );
      return clone(claim);
    },

    listClaims(filter = {}) {
      const where = [];
      const params = [];
      if (filter.runId !== undefined) {
        where.push('run_id = ?');
        params.push(filter.runId);
      }
      if (filter.taskId !== undefined) {
        where.push('task_id = ?');
        params.push(filter.taskId);
      }
      const sql = `SELECT text FROM claim ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at ASC`;
      return db
        .prepare(sql)
        .all(...params)
        .map((row) => parseJson(row.text, null))
        .filter(Boolean);
    },

    // ------------------------------------------------------------------
    // acceptance
    // ------------------------------------------------------------------
    createAcceptance(acceptance) {
      sqliteStore.createAcceptance({
        id: acceptance.id,
        stage: acceptance.stage,
        target_task_id: acceptance.taskId,
        run_id: acceptance.runId ?? null,
        subject: json(acceptance.subject, null),
        subject_fingerprint: acceptance.subjectFingerprint ?? null,
        state: tableState(acceptance.state),
        mode: acceptanceMode(acceptance),
        criteria: acceptance.items ?? [],
        reviewer: acceptance.decidedBy ?? null,
        notes: json({ stateVersion: acceptance.stateVersion ?? 1, service: acceptance }),
        created_at: acceptance.openedAt,
        decided_at: acceptance.decidedAt ?? null,
      });
      return this.getAcceptance(acceptance.id);
    },

    getAcceptance(acceptanceId) {
      return acceptanceFromRow(
        db.prepare('SELECT * FROM acceptance WHERE id = ?').get(acceptanceId),
      );
    },

    updateAcceptance(acceptanceId, patch, options = {}) {
      const current = this.getAcceptance(acceptanceId);
      if (!current) {
        throw serviceError('not_found', `acceptance ${acceptanceId} does not exist`, {
          acceptanceId,
        });
      }
      if (
        options.expectedStateVersion !== undefined &&
        options.expectedStateVersion !== null &&
        current.stateVersion !== options.expectedStateVersion
      ) {
        throw serviceError(
          'state_conflict',
          `acceptance ${acceptanceId} state version mismatch (expected ${options.expectedStateVersion}, actual ${current.stateVersion})`,
          {
            acceptanceId,
            expectedStateVersion: options.expectedStateVersion,
            actualStateVersion: current.stateVersion,
          },
        );
      }
      const next = { ...current, ...clone(patch), stateVersion: current.stateVersion + 1 };
      db.prepare(
        `UPDATE acceptance
            SET state = ?, subject_fingerprint = ?, notes = ?, reviewer = ?, decided_at = ?
          WHERE id = ?`,
      ).run(
        tableState(next.state),
        next.subjectFingerprint ?? null,
        json({ stateVersion: next.stateVersion, service: next }),
        next.decidedBy ?? null,
        next.decidedAt ?? null,
        acceptanceId,
      );
      return this.getAcceptance(acceptanceId);
    },

    listAcceptances(filter = {}) {
      const where = [];
      const params = [];
      if (filter.taskId !== undefined) {
        where.push('target_task_id = ?');
        params.push(filter.taskId);
      }
      if (filter.stage !== undefined) {
        where.push('stage = ?');
        params.push(filter.stage);
      }
      if (filter.runId !== undefined) {
        where.push('run_id = ?');
        params.push(filter.runId);
      }
      const sql = `SELECT * FROM acceptance ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                   ORDER BY created_at ASC`;
      let rows = db
        .prepare(sql)
        .all(...params)
        .map(acceptanceFromRow);
      if (filter.state !== undefined) {
        rows = rows.filter((acceptance) => acceptance.state === filter.state);
      }
      if (filter.openOnly === true) {
        rows = rows.filter((acceptance) => acceptance.state === 'open');
      }
      return rows;
    },

    // ------------------------------------------------------------------
    // append-only event ledger
    // ------------------------------------------------------------------
    appendEvent(event) {
      const info = db
        .prepare(
          `INSERT INTO task_event
             (id, task_id, run_id, type, from_state, to_state, actor, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.taskId ?? '__global__',
          event.runId ?? null,
          event.type,
          event.payload?.from_state ?? null,
          event.payload?.to_state ?? null,
          event.actor ?? 'system',
          json(event),
          event.createdAt ?? Date.now(),
        );
      return { ...clone(event), seq: Number(info.lastInsertRowid) };
    },

    listEvents(filter = {}) {
      const rows = db
        .prepare('SELECT rowid AS seq, payload_json FROM task_event ORDER BY rowid ASC')
        .all();
      return rows
        .map((row) => {
          const event = parseJson(row.payload_json, {});
          return { ...event, seq: Number(row.seq) };
        })
        .filter((event) => {
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
      const row = db
        .prepare('SELECT payload_json FROM task_event ORDER BY rowid DESC LIMIT 1')
        .get();
      return row ? (parseJson(row.payload_json, {}).hash ?? null) : null;
    },

    // ------------------------------------------------------------------
    // idempotency
    // ------------------------------------------------------------------
    getIdempotency(key) {
      const row = db.prepare('SELECT record_json FROM api_idempotency WHERE key = ?').get(key);
      return row ? parseJson(row.record_json, null) : null;
    },

    putIdempotency(key, record) {
      db.prepare(
        `INSERT INTO api_idempotency (key, record_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET record_json = excluded.record_json`,
      ).run(key, json(record));
      return clone(record);
    },

    // ------------------------------------------------------------------
    // stop verification
    // ------------------------------------------------------------------
    appendStopVerification(record) {
      const info = db
        .prepare('INSERT INTO api_stop_verification (record_json) VALUES (?)')
        .run(json(record));
      return { ...clone(record), seq: Number(info.lastInsertRowid) };
    },

    listStopVerifications(filter = {}) {
      return db
        .prepare('SELECT seq, record_json FROM api_stop_verification ORDER BY seq ASC')
        .all()
        .map((row) => ({ ...parseJson(row.record_json, {}), seq: Number(row.seq) }))
        .filter((record) => {
          if (filter.taskId !== undefined && record.taskId !== filter.taskId) return false;
          if (filter.runId !== undefined && record.runId !== filter.runId) return false;
          return true;
        });
    },
  };
}
