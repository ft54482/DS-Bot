import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StoreError, toStoreError } from './errors.js';
import {
  DEFAULT_MIGRATIONS_DIR,
  SCHEMA_VERSION,
  applyMigrations,
  configureConnection,
  getSchemaVersion,
} from './schema.js';

export const TASK_LEVELS = ['goal', 'business', 'execution'];
export const TASK_STATES = [
  'planned',
  'queued',
  'running',
  'accepting',
  'reworking',
  'stopping',
  'completed',
  'blocked',
  'paused',
  'cancelled',
];
export const TASK_DOMAINS = ['self_media', 'video', 'agent_dev', 'dsbot_dev', 'ops'];
export const RUN_STATES = [
  'queued',
  'dispatched',
  'dispatch_unknown',
  'running',
  'reported',
  'accepted',
  'rejected',
  'invalidated',
  'superseded',
  'failed',
  'cancelled',
  'lost',
  'timed_out',
];
export const EXECUTOR_KINDS = ['tool_chain', 'dsh_session', 'superagent', 'manual'];
export const ACCEPTANCE_STAGES = ['execution', 'business', 'goal'];
export const ACCEPTANCE_STATES = ['open', 'passed', 'rejected', 'invalidated', 'superseded'];
export const ACCEPTANCE_MODES = ['auto', 'independent', 'human'];
export const OUTBOX_INTENTS = [
  'delegate',
  'dispatch_run',
  'cancel_run',
  'send_message',
  'request_acceptance',
  'stop_subtree',
];
export const OUTBOX_STATES = ['pending', 'sending', 'sent', 'acked', 'failed', 'unknown'];
export const COST_KINDS = ['llm', 'tool', 'acceptance', 'other'];

const TASK_FILTERS = {
  level: 'level',
  state: 'state',
  project: 'project',
  domain: 'domain',
  owner_ref: 'owner_ref',
  parent_task_id: 'parent_task_id',
  delegator_ref: 'delegator_ref',
};

function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError('validation_error', `${field} is required`);
  }
  return value;
}

function optionalString(value) {
  return value === undefined || value === null ? null : String(value);
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new StoreError(
      'validation_error',
      `${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function optionalOneOf(value, allowed, field) {
  if (value === undefined || value === null) return null;
  return requireOneOf(value, allowed, field);
}

function toJson(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
    } catch {
      throw new StoreError('validation_error', `${field} must be valid JSON`);
    }
    return value;
  }
  return JSON.stringify(value);
}

function toRow(row) {
  return row ? { ...row } : null;
}

function toRows(rows) {
  return rows.map((row) => ({ ...row }));
}

/**
 * L1 task store over node:sqlite.
 *
 * One Store owns one DatabaseSync connection. All state transitions go through
 * DAO methods so the schema guards (triggers) and the append-only task_event
 * ledger stay in one transaction. `store.db` is exposed for read-only queries
 * and tests; writes should go through the DAO.
 */
export class Store {
  #db;
  #path;
  #txDepth = 0;
  #closed = false;

  constructor(db, { path = null } = {}) {
    this.#db = db;
    this.#path = path;
  }

  /** Open (and by default migrate) a store. `path` must be given explicitly. */
  static open({ path, migrationsDir = DEFAULT_MIGRATIONS_DIR, migrate = true } = {}) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new StoreError(
        'validation_error',
        'openStore requires an explicit { path } (use ":memory:" for tests)',
      );
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

    const db = new DatabaseSync(path);
    configureConnection(db);
    const store = new Store(db, { path });
    if (migrate) store.migrate({ migrationsDir });
    return store;
  }

  get db() {
    return this.#db;
  }

  get path() {
    return this.#path;
  }

  /** Apply pending migrations; returns the current schema version. */
  migrate({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
    const applied = applyMigrations(this.#db, migrationsDir);
    if (applied !== SCHEMA_VERSION) {
      throw new StoreError(
        'schema_version_unsupported',
        `expected schema version ${SCHEMA_VERSION}, database reports ${applied}`,
      );
    }
    return applied;
  }

  schemaVersion() {
    return getSchemaVersion(this.#db);
  }

  /** Run fn atomically. Nested calls join the outer transaction. */
  transaction(fn) {
    if (this.#txDepth > 0) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Keep the original failure.
      }
      throw toStoreError(error);
    } finally {
      this.#txDepth -= 1;
    }
  }

  // -------------------------------------------------------------------------
  // task
  // -------------------------------------------------------------------------

  /**
   * Create a task. Hierarchy rules are enforced by the schema trigger:
   * goal -> business -> execution, and a goal may not own an execution directly.
   */
  createTask(input = {}) {
    const now = input.created_at ?? Date.now();
    const id = optionalString(input.id) ?? makeId('task');
    const level = requireOneOf(input.level, TASK_LEVELS, 'level');
    const state = optionalOneOf(input.state, TASK_STATES, 'state') ?? 'planned';
    const domain = optionalOneOf(input.domain, TASK_DOMAINS, 'domain') ?? 'ops';
    const priority = input.priority ?? 50;
    if (!Number.isInteger(priority)) {
      throw new StoreError('validation_error', 'priority must be an integer');
    }

    const values = {
      id,
      level,
      title: requireString(input.title, 'title'),
      goal: requireString(input.goal, 'goal'),
      project: requireString(input.project, 'project'),
      domain,
      deliverable_kind: optionalString(input.deliverable_kind),
      acceptance_profile: optionalString(input.acceptance_profile),
      state,
      priority,
      parent_task_id: optionalString(input.parent_task_id),
      delegator_kind: requireOneOf(
        input.delegator_kind,
        ['human', 'chief', 'bot'],
        'delegator_kind',
      ),
      delegator_ref: requireString(input.delegator_ref, 'delegator_ref'),
      owner_ref: requireString(input.owner_ref, 'owner_ref'),
      authorization_json: toJson(
        input.authorization_json ?? input.authorization,
        'authorization',
        '{}',
      ),
      acceptance_criteria: toJson(
        input.acceptance_criteria,
        'acceptance_criteria',
        '[]',
      ),
      hard_rules_json: toJson(
        input.hard_rules_json ?? input.hard_rules,
        'hard_rules',
        '[]',
      ),
      budget_cny_cap: input.budget_cny_cap ?? null,
      budget_tokens_cap: input.budget_tokens_cap ?? null,
      execution_done_at: input.execution_done_at ?? null,
      business_done_at: input.business_done_at ?? null,
      goal_met_at: input.goal_met_at ?? null,
      active_session_id: optionalString(input.active_session_id),
      executor_instance_id: optionalString(input.executor_instance_id),
      idempotency_key: optionalString(input.idempotency_key),
      created_at: now,
      updated_at: now,
      closed_at: input.closed_at ?? null,
    };

    try {
      this.#db.prepare(`
        INSERT INTO task (
          id, level, title, goal, project, domain, deliverable_kind,
          acceptance_profile, state, priority, parent_task_id, delegator_kind,
          delegator_ref, owner_ref, authorization_json, acceptance_criteria,
          hard_rules_json, budget_cny_cap, budget_tokens_cap, execution_done_at,
          business_done_at, goal_met_at, active_session_id, executor_instance_id,
          idempotency_key, created_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.id,
        values.level,
        values.title,
        values.goal,
        values.project,
        values.domain,
        values.deliverable_kind,
        values.acceptance_profile,
        values.state,
        values.priority,
        values.parent_task_id,
        values.delegator_kind,
        values.delegator_ref,
        values.owner_ref,
        values.authorization_json,
        values.acceptance_criteria,
        values.hard_rules_json,
        values.budget_cny_cap,
        values.budget_tokens_cap,
        values.execution_done_at,
        values.business_done_at,
        values.goal_met_at,
        values.active_session_id,
        values.executor_instance_id,
        values.idempotency_key,
        values.created_at,
        values.updated_at,
        values.closed_at,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return this.getTask(values.id);
  }

  getTask(id) {
    if (!id) return null;
    return toRow(this.#db.prepare('SELECT * FROM task WHERE id = ?').get(id));
  }

  listTasks(filter = {}) {
    const where = [];
    const params = [];
    for (const [key, column] of Object.entries(TASK_FILTERS)) {
      if (filter[key] !== undefined && filter[key] !== null) {
        where.push(`${column} = ?`);
        params.push(filter[key]);
      }
    }
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new StoreError('validation_error', 'limit must be an integer between 1 and 1000');
    }
    const sql = `
      SELECT * FROM task
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `;
    return toRows(this.#db.prepare(sql).all(...params, limit));
  }

  /**
   * Advance task state. The schema's completion guard is deliberately not
   * duplicated here: completing without a passed acceptance at the same level
   * is rejected by the database with code "missing_acceptance".
   */
  updateTaskState(id, nextState, options = {}) {
    requireOneOf(nextState, TASK_STATES, 'state');
    const now = options.at ?? Date.now();
    return this.transaction(() => {
      const current = this.getTask(id);
      if (!current) {
        throw new StoreError('not_found', `task ${id} not found`);
      }
      if (options.expectedState && current.state !== options.expectedState) {
        throw new StoreError(
          'invalid_state_transition',
          `task ${id} is "${current.state}", expected "${options.expectedState}"`,
        );
      }
      if (current.state === nextState) return current;

      const terminal = nextState === 'completed' || nextState === 'cancelled';
      const closedAt = terminal ? (current.closed_at ?? now) : null;
      try {
        this.#db.prepare(`
          UPDATE task SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?
        `).run(nextState, now, closedAt, id);
      } catch (error) {
        throw toStoreError(error);
      }

      this.appendTaskEvent({
        task_id: id,
        run_id: options.runId ?? null,
        type: options.eventType ?? 'task.state_changed',
        from_state: current.state,
        to_state: nextState,
        actor: options.actor ?? 'system:store',
        payload: options.payload ?? {},
        created_at: now,
      });
      return this.getTask(id);
    });
  }

  // -------------------------------------------------------------------------
  // task_event (append-only)
  // -------------------------------------------------------------------------

  appendTaskEvent(event = {}) {
    const row = {
      id: optionalString(event.id) ?? makeId('evt'),
      task_id: requireString(event.task_id, 'task_id'),
      run_id: optionalString(event.run_id),
      type: requireString(event.type, 'type'),
      from_state: optionalString(event.from_state),
      to_state: optionalString(event.to_state),
      actor: requireString(event.actor, 'actor'),
      payload_json: toJson(event.payload_json ?? event.payload, 'payload', '{}'),
      created_at: event.created_at ?? Date.now(),
    };
    try {
      this.#db.prepare(`
        INSERT INTO task_event (
          id, task_id, run_id, type, from_state, to_state, actor, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.task_id,
        row.run_id,
        row.type,
        row.from_state,
        row.to_state,
        row.actor,
        row.payload_json,
        row.created_at,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return { ...row };
  }

  listTaskEvents(taskId, { limit = 100 } = {}) {
    requireString(taskId, 'task_id');
    // created_at is only millisecond precision, so events written in the same
    // millisecond tie. rowid is the insertion order and makes the ledger
    // deterministic; event ids are random UUIDs and must not decide order.
    return toRows(this.#db.prepare(`
      SELECT * FROM task_event WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?
    `).all(taskId, limit));
  }

  // -------------------------------------------------------------------------
  // run
  // -------------------------------------------------------------------------

  createRun(input = {}) {
    const now = input.created_at ?? Date.now();
    const id = optionalString(input.id) ?? makeId('run');
    const taskId = requireString(input.task_id, 'task_id');
    const runNo = input.run_no ?? Number(
      this.#db.prepare('SELECT COALESCE(MAX(run_no), 0) + 1 AS next FROM run WHERE task_id = ?')
        .get(taskId).next,
    );
    const attempt = input.attempt ?? 1;
    const state = optionalOneOf(input.state, RUN_STATES, 'state') ?? 'queued';
    const executorKind = requireOneOf(input.executor_kind, EXECUTOR_KINDS, 'executor_kind');
    const idempotencyKey = requireString(input.idempotency_key, 'idempotency_key');

    try {
      this.#db.prepare(`
        INSERT INTO run (
          id, task_id, run_no, attempt, state, executor_kind, session_id,
          workspace_path, base_commit, model, executor_identity, authorization_ref,
          authorization_json, idempotency_key, started_at, ended_at, exit_reason,
          tokens_in, tokens_out, tokens_cached, cost_cny, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        taskId,
        runNo,
        attempt,
        state,
        executorKind,
        optionalString(input.session_id),
        optionalString(input.workspace_path),
        optionalString(input.base_commit),
        optionalString(input.model),
        optionalString(input.executor_identity),
        optionalString(input.authorization_ref),
        toJson(input.authorization_json ?? input.authorization, 'authorization', '{}'),
        idempotencyKey,
        input.started_at ?? null,
        input.ended_at ?? null,
        optionalString(input.exit_reason),
        input.tokens_in ?? 0,
        input.tokens_out ?? 0,
        input.tokens_cached ?? 0,
        input.cost_cny ?? 0,
        now,
        now,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return this.getRun(id);
  }

  getRun(id) {
    if (!id) return null;
    return toRow(this.#db.prepare('SELECT * FROM run WHERE id = ?').get(id));
  }

  listRuns(taskId, { limit = 100 } = {}) {
    return toRows(this.#db.prepare(
      'SELECT * FROM run WHERE task_id = ? ORDER BY run_no DESC, attempt DESC LIMIT ?',
    ).all(taskId, limit));
  }

  // -------------------------------------------------------------------------
  // acceptance / items / evidence
  // -------------------------------------------------------------------------

  createAcceptance(input = {}) {
    const row = {
      id: optionalString(input.id) ?? makeId('acc'),
      stage: requireOneOf(input.stage, ACCEPTANCE_STAGES, 'stage'),
      target_task_id: requireString(input.target_task_id, 'target_task_id'),
      run_id: optionalString(input.run_id),
      subject: optionalString(input.subject),
      subject_fingerprint: optionalString(input.subject_fingerprint),
      target_commit: optionalString(input.target_commit),
      artifact_hashes: toJson(input.artifact_hashes, 'artifact_hashes', '[]'),
      state: optionalOneOf(input.state, ACCEPTANCE_STATES, 'state') ?? 'open',
      mode: requireOneOf(input.mode, ACCEPTANCE_MODES, 'mode'),
      criteria_json: toJson(input.criteria_json ?? input.criteria, 'criteria', '[]'),
      reviewer: optionalString(input.reviewer),
      notes: optionalString(input.notes),
      created_at: input.created_at ?? Date.now(),
      decided_at: input.decided_at ?? null,
    };
    try {
      this.#db.prepare(`
        INSERT INTO acceptance (
          id, stage, target_task_id, run_id, subject, subject_fingerprint,
          target_commit, artifact_hashes, state, mode, criteria_json, reviewer,
          notes, created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.stage,
        row.target_task_id,
        row.run_id,
        row.subject,
        row.subject_fingerprint,
        row.target_commit,
        row.artifact_hashes,
        row.state,
        row.mode,
        row.criteria_json,
        row.reviewer,
        row.notes,
        row.created_at,
        row.decided_at,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return this.getAcceptance(row.id);
  }

  getAcceptance(id) {
    if (!id) return null;
    return toRow(this.#db.prepare('SELECT * FROM acceptance WHERE id = ?').get(id));
  }

  listAcceptances(targetTaskId, { stage = null, limit = 100 } = {}) {
    const params = [targetTaskId];
    let sql = 'SELECT * FROM acceptance WHERE target_task_id = ?';
    if (stage) {
      sql += ' AND stage = ?';
      params.push(stage);
    }
    sql += ' ORDER BY created_at ASC, id ASC LIMIT ?';
    params.push(limit);
    return toRows(this.#db.prepare(sql).all(...params));
  }

  /** Record the verdict of an acceptance round (open -> passed/rejected/...). */
  decideAcceptance(id, state, options = {}) {
    requireOneOf(state, ACCEPTANCE_STATES, 'state');
    const current = this.getAcceptance(id);
    if (!current) throw new StoreError('not_found', `acceptance ${id} not found`);
    if (current.state === state) return current;
    try {
      this.#db.prepare(`
        UPDATE acceptance SET state = ?, reviewer = ?, notes = ?, decided_at = ? WHERE id = ?
      `).run(
        state,
        options.reviewer ?? current.reviewer,
        options.notes ?? current.notes,
        options.decidedAt ?? Date.now(),
        id,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return this.getAcceptance(id);
  }

  addAcceptanceItem(input = {}) {
    const row = {
      id: optionalString(input.id) ?? makeId('item'),
      acceptance_id: requireString(input.acceptance_id, 'acceptance_id'),
      class: requireOneOf(input.class, ['auto', 'independent', 'human'], 'class'),
      criterion: requireString(input.criterion, 'criterion'),
      result: optionalOneOf(input.result, ['pending', 'pass', 'fail', 'blocked'], 'result') ?? 'pending',
      detail: optionalString(input.detail),
      decided_by: optionalString(input.decided_by),
      decided_at: input.decided_at ?? null,
    };
    try {
      this.#db.prepare(`
        INSERT INTO acceptance_item (
          id, acceptance_id, class, criterion, result, detail, decided_by, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.acceptance_id,
        row.class,
        row.criterion,
        row.result,
        row.detail,
        row.decided_by,
        row.decided_at,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return { ...row };
  }

  listAcceptanceItems(acceptanceId) {
    return toRows(this.#db.prepare(
      'SELECT * FROM acceptance_item WHERE acceptance_id = ? ORDER BY id ASC',
    ).all(acceptanceId));
  }

  appendEvidence(input = {}) {
    const row = {
      id: optionalString(input.id) ?? makeId('ev'),
      acceptance_id: requireString(input.acceptance_id, 'acceptance_id'),
      kind: requireString(input.kind, 'kind'),
      ref: requireString(input.ref, 'ref'),
      sha256: optionalString(input.sha256),
      command: optionalString(input.command),
      output_excerpt: optionalString(input.output_excerpt),
      recorded_at: input.recorded_at ?? Date.now(),
      env_json: toJson(input.env_json ?? input.env, 'env', '{}'),
    };
    try {
      this.#db.prepare(`
        INSERT INTO evidence (
          id, acceptance_id, kind, ref, sha256, command, output_excerpt, recorded_at, env_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.acceptance_id,
        row.kind,
        row.ref,
        row.sha256,
        row.command,
        row.output_excerpt,
        row.recorded_at,
        row.env_json,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return { ...row };
  }

  listEvidence(acceptanceId) {
    return toRows(this.#db.prepare(
      'SELECT * FROM evidence WHERE acceptance_id = ? ORDER BY recorded_at ASC',
    ).all(acceptanceId));
  }

  // -------------------------------------------------------------------------
  // cost_ledger (append-only)
  // -------------------------------------------------------------------------

  recordCost(input = {}) {
    const row = {
      id: optionalString(input.id) ?? makeId('cost'),
      task_id: requireString(input.task_id, 'task_id'),
      run_id: optionalString(input.run_id),
      kind: requireOneOf(input.kind ?? 'other', COST_KINDS, 'kind'),
      tokens_in: input.tokens_in ?? 0,
      tokens_out: input.tokens_out ?? 0,
      tokens_cached: input.tokens_cached ?? 0,
      cost_cny: input.cost_cny ?? 0,
      at: input.at ?? Date.now(),
      detail: optionalString(input.detail),
    };
    try {
      this.#db.prepare(`
        INSERT INTO cost_ledger (
          id, task_id, run_id, kind, tokens_in, tokens_out, tokens_cached, cost_cny, at, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.task_id,
        row.run_id,
        row.kind,
        row.tokens_in,
        row.tokens_out,
        row.tokens_cached,
        row.cost_cny,
        row.at,
        row.detail,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return { ...row };
  }

  listCosts(taskId, { limit = 100 } = {}) {
    return toRows(this.#db.prepare(
      'SELECT * FROM cost_ledger WHERE task_id = ? ORDER BY at ASC LIMIT ?',
    ).all(taskId, limit));
  }

  // -------------------------------------------------------------------------
  // dispatch_outbox
  // -------------------------------------------------------------------------

  enqueueOutbox(input = {}) {
    const row = {
      id: optionalString(input.id) ?? makeId('outbox'),
      task_id: requireString(input.task_id, 'task_id'),
      run_id: optionalString(input.run_id),
      principal_ref: requireString(input.principal_ref, 'principal_ref'),
      intent: requireOneOf(input.intent, OUTBOX_INTENTS, 'intent'),
      payload_json: toJson(input.payload_json ?? input.payload, 'payload', '{}'),
      state: optionalOneOf(input.state, OUTBOX_STATES, 'state') ?? 'pending',
      idempotency_key: requireString(input.idempotency_key, 'idempotency_key'),
      attempts: input.attempts ?? 0,
      next_retry_at: input.next_retry_at ?? null,
      last_error: optionalString(input.last_error),
      created_at: input.created_at ?? Date.now(),
      sent_at: input.sent_at ?? null,
      acked_at: input.acked_at ?? null,
    };
    try {
      this.#db.prepare(`
        INSERT INTO dispatch_outbox (
          id, task_id, run_id, principal_ref, intent, payload_json, state,
          idempotency_key, attempts, next_retry_at, last_error, created_at,
          sent_at, acked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.task_id,
        row.run_id,
        row.principal_ref,
        row.intent,
        row.payload_json,
        row.state,
        row.idempotency_key,
        row.attempts,
        row.next_retry_at,
        row.last_error,
        row.created_at,
        row.sent_at,
        row.acked_at,
      );
    } catch (error) {
      throw toStoreError(error);
    }
    return this.getOutbox(row.id);
  }

  getOutbox(id) {
    if (!id) return null;
    return toRow(this.#db.prepare('SELECT * FROM dispatch_outbox WHERE id = ?').get(id));
  }

  // -------------------------------------------------------------------------
  // event_inbox / event_watermark
  // -------------------------------------------------------------------------

  /** Insert an inbound event; duplicate event_key is reported, not thrown. */
  appendInboxEvent(input = {}) {
    const eventKey = requireString(input.event_key, 'event_key');
    const row = {
      id: optionalString(input.id) ?? makeId('inbox'),
      source: requireString(input.source, 'source'),
      source_seq: input.source_seq ?? null,
      event_key: eventKey,
      task_id: optionalString(input.task_id),
      run_id: optionalString(input.run_id),
      principal_ref: optionalString(input.principal_ref),
      type: requireString(input.type, 'type'),
      payload_json: toJson(input.payload_json ?? input.payload, 'payload', '{}'),
      received_at: input.received_at ?? Date.now(),
      processed_at: input.processed_at ?? null,
      status: optionalOneOf(input.status, ['pending', 'processed', 'ignored', 'failed'], 'status') ?? 'pending',
    };
    let changes;
    try {
      changes = this.#db.prepare(`
        INSERT OR IGNORE INTO event_inbox (
          id, source, source_seq, event_key, task_id, run_id, principal_ref,
          type, payload_json, received_at, processed_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.source,
        row.source_seq,
        row.event_key,
        row.task_id,
        row.run_id,
        row.principal_ref,
        row.type,
        row.payload_json,
        row.received_at,
        row.processed_at,
        row.status,
      ).changes;
    } catch (error) {
      throw toStoreError(error);
    }
    const event = this.getInboxEventByKey(eventKey);
    return { inserted: Number(changes) === 1, event };
  }

  getInboxEventByKey(eventKey) {
    return toRow(this.#db.prepare('SELECT * FROM event_inbox WHERE event_key = ?').get(eventKey));
  }

  getWatermark(source) {
    return toRow(this.#db.prepare('SELECT * FROM event_watermark WHERE source = ?').get(source));
  }

  /** Advance the watermark monotonically (max of stored and incoming seq). */
  advanceWatermark(source, seq) {
    requireString(source, 'source');
    if (!Number.isInteger(seq) || seq < 0) {
      throw new StoreError('validation_error', 'seq must be a non-negative integer');
    }
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO event_watermark (source, last_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_seq = MAX(event_watermark.last_seq, excluded.last_seq),
        updated_at = excluded.updated_at
    `).run(source, seq, now);
    return this.getWatermark(source);
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}

/** Convenience factory; re-exported from src/index.js. */
export function openStore(options) {
  return Store.open(options);
}
