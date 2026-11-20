#!/usr/bin/env node
// Re-runnable demo seeder + verifier for the DS Bot V3 control database.
//
// `--out <dir>` creates `<dir>/control.sqlite` from the shipped L1 migration and
// inserts one small, deterministic three-level task tree (1 goal / 2 business /
// 3 execution), one passed acceptance and three cost records. Running it again
// on the same directory replaces the demo database.
//
// `--verify <dir>` re-opens the database read-only and checks that the demo data
// is complete and internally consistent. Exit code 0 = all checks pass,
// 1 = anything is missing or inconsistent.
//
// Only node: built-ins are used; there is no network access and no npm install.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_REL = 'packages/store/migrations/001_init.sql';
const SCHEMA_VERSION = 1;
const DB_NAME = 'control.sqlite';
const PROJECT = 'demo';

// Fixed clock so every seed produces the same timestamps.
const BASE_TS = Date.UTC(2026, 10, 20, 8, 0, 0);
const at = (minutes) => BASE_TS + minutes * 60_000;

const TASK = {
  goal: 'task-demo-goal',
  businessContent: 'task-demo-biz-content',
  businessOps: 'task-demo-biz-ops',
  render: 'task-demo-exec-render',
  captions: 'task-demo-exec-captions',
  checklist: 'task-demo-exec-checklist',
};

const RUN = {
  render: 'run-demo-render-1',
  captions: 'run-demo-captions-1',
  checklist: 'run-demo-checklist-1',
};

const ACCEPTANCE = { render: 'acc-demo-render-exec' };

const DEMO_COMMIT = '7d3f5a1c9b2e4f6081a2c3d4e5f60718293a4b5c';
const DEMO_FINGERPRINT =
  'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const DEMO_ARTIFACT =
  'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809';

class UsageError extends Error {}

function message(error) {
  return error && error.message ? error.message : String(error);
}

function assert(condition, text) {
  if (!condition) throw new Error(text);
}

function printUsage() {
  console.log(`Usage:
  node tools/seed/seed.mjs --out <dir>
  node tools/seed/seed.mjs --verify <dir>

Options:
  --out <dir>      create/replace <dir>/control.sqlite with the demo fixture
  --verify <dir>   check the fixture in <dir>/control.sqlite (exit 0/1)
  -h, --help       show this help`);
}

function parseArgs(argv) {
  const options = { out: null, verify: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    const match = /^--(out|verify)(?:=(.*))?$/.exec(arg);
    if (!match) throw new UsageError(`unknown argument: ${arg}`);

    let value = match[2];
    if (value === undefined) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`--${match[1]} requires a directory`);
      }
      index += 1;
    }
    if (value.length === 0) {
      throw new UsageError(`--${match[1]} requires a directory`);
    }
    options[match[1]] = value;
  }

  if (options.help) return options;
  if ((options.out ? 1 : 0) + (options.verify ? 1 : 0) !== 1) {
    throw new UsageError('pass exactly one of --out <dir> or --verify <dir>');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

function taskRows() {
  return [
    {
      id: TASK.goal,
      level: 'goal',
      title: 'Demo goal: publish the L18 launch pack',
      goal: 'Produce and verify the demo launch pack used by the L18 walkthrough',
      domain: 'self_media',
      deliverable_kind: 'content_pack',
      acceptance_profile: 'goal.objective_v1',
      state: 'running',
      priority: 10,
      parent_task_id: null,
      delegator_kind: 'human',
      delegator_ref: 'human:demo-operator',
      owner_ref: 'bot:chief',
      authorization_json: JSON.stringify({
        projects: [PROJECT],
        paths: ['episodes/demo/**'],
        tools: ['node'],
        spend_cny_cap: 20,
      }),
      acceptance_criteria: JSON.stringify([
        { id: 'goal.pack', text: 'the launch clip and delivery checklist are accepted' },
      ]),
      budget_cny_cap: 20,
      budget_tokens_cap: 500_000,
      created_at: at(0),
      updated_at: at(180),
    },
    {
      id: TASK.businessContent,
      level: 'business',
      title: 'Business: produce the demo clip',
      goal: 'Turn the demo brief into a reviewed launch clip',
      domain: 'video',
      deliverable_kind: 'film',
      acceptance_profile: 'business.product_v1',
      state: 'running',
      priority: 20,
      parent_task_id: TASK.goal,
      delegator_kind: 'chief',
      delegator_ref: 'bot:chief',
      owner_ref: 'bot:video',
      acceptance_criteria: JSON.stringify([
        { id: 'business.clip', text: 'the clip plays end to end and matches the brief' },
      ]),
      budget_cny_cap: 12,
      created_at: at(5),
      updated_at: at(170),
    },
    {
      id: TASK.businessOps,
      level: 'business',
      title: 'Business: prepare the delivery checklist',
      goal: 'Verify the demo package can be handed to an external reviewer',
      domain: 'ops',
      deliverable_kind: 'report',
      acceptance_profile: 'business.product_v1',
      state: 'running',
      priority: 30,
      parent_task_id: TASK.goal,
      delegator_kind: 'chief',
      delegator_ref: 'bot:chief',
      owner_ref: 'bot:ops',
      acceptance_criteria: JSON.stringify([
        { id: 'business.checklist', text: 'every delivery item has an owner and a result' },
      ]),
      budget_cny_cap: 8,
      created_at: at(6),
      updated_at: at(160),
    },
    {
      id: TASK.render,
      level: 'execution',
      title: 'Execution: render the launch clip',
      goal: 'Render episodes/demo/launch.mp4 and record its hash',
      domain: 'video',
      deliverable_kind: 'film',
      state: 'accepting',
      priority: 40,
      parent_task_id: TASK.businessContent,
      delegator_kind: 'bot',
      delegator_ref: 'bot:video',
      owner_ref: 'bot:video',
      budget_cny_cap: 5,
      execution_done_at: at(120),
      created_at: at(10),
      updated_at: at(120),
    },
    {
      id: TASK.captions,
      level: 'execution',
      title: 'Execution: revise caption timing',
      goal: 'Fix the caption drift found in the first business review',
      domain: 'video',
      deliverable_kind: 'film',
      state: 'reworking',
      priority: 45,
      parent_task_id: TASK.businessContent,
      delegator_kind: 'bot',
      delegator_ref: 'bot:video',
      owner_ref: 'bot:video',
      budget_cny_cap: 3,
      execution_done_at: at(130),
      created_at: at(11),
      updated_at: at(150),
    },
    {
      id: TASK.checklist,
      level: 'execution',
      title: 'Execution: confirm the external review slot',
      goal: 'Wait for the external reviewer to confirm the delivery window',
      domain: 'ops',
      deliverable_kind: 'report',
      state: 'blocked',
      priority: 50,
      parent_task_id: TASK.businessOps,
      delegator_kind: 'bot',
      delegator_ref: 'bot:ops',
      owner_ref: 'bot:ops',
      budget_cny_cap: 1,
      created_at: at(12),
      updated_at: at(140),
    },
  ];
}

function runRows() {
  return [
    {
      id: RUN.render,
      task_id: TASK.render,
      run_no: 1,
      attempt: 1,
      state: 'accepted',
      executor_kind: 'superagent',
      session_id: 'demo-session-render',
      workspace_path: 'demo/workspace/render',
      base_commit: DEMO_COMMIT,
      model: 'demo-model',
      executor_identity: 'superagent:ticket-demo-render',
      authorization_ref: TASK.render,
      tokens_in: 4200,
      tokens_out: 1800,
      tokens_cached: 900,
      cost_cny: 0.42,
      started_at: at(20),
      ended_at: at(120),
      exit_reason: 'accepted',
      created_at: at(15),
      updated_at: at(120),
    },
    {
      id: RUN.captions,
      task_id: TASK.captions,
      run_no: 1,
      attempt: 1,
      state: 'rejected',
      executor_kind: 'dsh_session',
      session_id: 'demo-session-captions',
      workspace_path: 'demo/workspace/captions',
      model: 'demo-model',
      executor_identity: 'dsh:session-demo-captions',
      authorization_ref: TASK.captions,
      tokens_in: 1200,
      tokens_out: 500,
      tokens_cached: 100,
      cost_cny: 0.18,
      started_at: at(30),
      ended_at: at(130),
      exit_reason: 'business acceptance rejected: caption timing drift',
      created_at: at(25),
      updated_at: at(130),
    },
    {
      id: RUN.checklist,
      task_id: TASK.checklist,
      run_no: 1,
      attempt: 1,
      state: 'queued',
      executor_kind: 'manual',
      session_id: null,
      workspace_path: 'demo/workspace/checklist',
      model: null,
      executor_identity: 'human:demo-operator',
      authorization_ref: TASK.checklist,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
      cost_cny: 0,
      started_at: null,
      ended_at: null,
      exit_reason: null,
      created_at: at(40),
      updated_at: at(40),
    },
  ];
}

function acceptanceRows() {
  return [
    {
      id: ACCEPTANCE.render,
      stage: 'execution',
      target_task_id: TASK.render,
      run_id: RUN.render,
      subject: `commit:${DEMO_COMMIT}`,
      subject_fingerprint: DEMO_FINGERPRINT,
      target_commit: DEMO_COMMIT,
      artifact_hashes: JSON.stringify([
        {
          path: 'episodes/demo/launch.mp4',
          sha256: DEMO_ARTIFACT,
          bytes: 1_048_576,
        },
      ]),
      state: 'passed',
      mode: 'auto',
      criteria_json: JSON.stringify([
        { id: 'execution.render', class: 'auto', text: 'launch.mp4 exists and probes as playable' },
        { id: 'execution.manifest', class: 'auto', text: 'manifest hashes match the artifact' },
      ]),
      reviewer: 'system:acceptance',
      notes: 'auto checks passed',
      created_at: at(125),
      decided_at: at(128),
    },
  ];
}

function costRows() {
  return [
    {
      id: 'cost-demo-render-llm',
      task_id: TASK.render,
      run_id: RUN.render,
      kind: 'llm',
      tokens_in: 4200,
      tokens_out: 1800,
      tokens_cached: 900,
      cost_cny: 0.42,
      at: at(121),
      detail: 'render run token usage',
    },
    {
      id: 'cost-demo-captions-tool',
      task_id: TASK.captions,
      run_id: RUN.captions,
      kind: 'tool',
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
      cost_cny: 0.18,
      at: at(131),
      detail: 'caption tool usage',
    },
    {
      id: 'cost-demo-checklist-other',
      task_id: TASK.checklist,
      run_id: RUN.checklist,
      kind: 'other',
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
      cost_cny: 0.01,
      at: at(141),
      detail: 'external review slot reservation',
    },
  ];
}

// ---------------------------------------------------------------------------
// Insert helpers (the shipped migration is the schema authority)
// ---------------------------------------------------------------------------

function insertTask(db, task) {
  db.prepare(`
    INSERT INTO task (
      id, level, title, goal, project, domain, deliverable_kind,
      acceptance_profile, state, priority, parent_task_id, delegator_kind,
      delegator_ref, owner_ref, authorization_json, acceptance_criteria,
      hard_rules_json, budget_cny_cap, budget_tokens_cap, execution_done_at,
      business_done_at, goal_met_at, active_session_id, executor_instance_id,
      idempotency_key, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.level,
    task.title,
    task.goal,
    PROJECT,
    task.domain,
    task.deliverable_kind ?? null,
    task.acceptance_profile ?? null,
    task.state,
    task.priority ?? 50,
    task.parent_task_id ?? null,
    task.delegator_kind,
    task.delegator_ref,
    task.owner_ref,
    task.authorization_json ?? '{}',
    task.acceptance_criteria ?? '[]',
    task.hard_rules_json ?? '[]',
    task.budget_cny_cap ?? null,
    task.budget_tokens_cap ?? null,
    task.execution_done_at ?? null,
    task.business_done_at ?? null,
    task.goal_met_at ?? null,
    task.active_session_id ?? null,
    task.executor_instance_id ?? null,
    `seed:${task.id}`,
    task.created_at,
    task.updated_at ?? task.created_at,
    task.closed_at ?? null,
  );
}

function insertRun(db, run) {
  db.prepare(`
    INSERT INTO run (
      id, task_id, run_no, attempt, state, executor_kind, session_id,
      workspace_path, base_commit, model, executor_identity, authorization_ref,
      authorization_json, idempotency_key, started_at, ended_at, exit_reason,
      tokens_in, tokens_out, tokens_cached, cost_cny, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.task_id,
    run.run_no,
    run.attempt,
    run.state,
    run.executor_kind,
    run.session_id ?? null,
    run.workspace_path ?? null,
    run.base_commit ?? null,
    run.model ?? null,
    run.executor_identity ?? null,
    run.authorization_ref ?? null,
    '{}',
    `seed:${run.id}`,
    run.started_at ?? null,
    run.ended_at ?? null,
    run.exit_reason ?? null,
    run.tokens_in ?? 0,
    run.tokens_out ?? 0,
    run.tokens_cached ?? 0,
    run.cost_cny ?? 0,
    run.created_at,
    run.updated_at ?? run.created_at,
  );
}

function insertAcceptance(db, acceptance) {
  db.prepare(`
    INSERT INTO acceptance (
      id, stage, target_task_id, run_id, subject, subject_fingerprint,
      target_commit, artifact_hashes, state, mode, criteria_json, reviewer,
      notes, created_at, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    acceptance.id,
    acceptance.stage,
    acceptance.target_task_id,
    acceptance.run_id ?? null,
    acceptance.subject ?? null,
    acceptance.subject_fingerprint ?? null,
    acceptance.target_commit ?? null,
    acceptance.artifact_hashes ?? '[]',
    acceptance.state,
    acceptance.mode,
    acceptance.criteria_json ?? '[]',
    acceptance.reviewer ?? null,
    acceptance.notes ?? null,
    acceptance.created_at,
    acceptance.decided_at ?? null,
  );
}

function insertCost(db, cost) {
  db.prepare(`
    INSERT INTO cost_ledger (
      id, task_id, run_id, kind, tokens_in, tokens_out, tokens_cached,
      cost_cny, at, detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cost.id,
    cost.task_id,
    cost.run_id ?? null,
    cost.kind,
    cost.tokens_in ?? 0,
    cost.tokens_out ?? 0,
    cost.tokens_cached ?? 0,
    cost.cost_cny ?? 0,
    cost.at,
    cost.detail ?? null,
  );
}

function readStats(db) {
  const levels = Object.fromEntries(
    db.prepare('SELECT level, COUNT(*) AS n FROM task GROUP BY level').all()
      .map((row) => [row.level, Number(row.n)]),
  );
  const states = Object.fromEntries(
    db.prepare('SELECT state, COUNT(*) AS n FROM task GROUP BY state').all()
      .map((row) => [row.state, Number(row.n)]),
  );
  const acceptance = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN state = 'passed' THEN 1 ELSE 0 END), 0) AS passed
    FROM acceptance
  `).get();
  const cost = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(cost_cny), 0) AS total_cny
    FROM cost_ledger
  `).get();

  return {
    levels,
    states,
    acceptance: { total: Number(acceptance.total), passed: Number(acceptance.passed) },
    cost: { rows: Number(cost.rows), totalCny: Number(cost.total_cny) },
  };
}

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

function seed(outArg) {
  const outDir = resolve(outArg);
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
    throw new Error(`--out is not a directory: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true });

  const dbPath = join(outDir, DB_NAME);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = dbPath + suffix;
    if (existsSync(target)) rmSync(target, { force: true });
  }

  const migrationPath = join(repoRoot, MIGRATION_REL);
  if (!existsSync(migrationPath)) {
    throw new Error(`migration not found: ${MIGRATION_REL}`);
  }
  const migration = readFileSync(migrationPath, 'utf8');

  const db = new DatabaseSync(dbPath);
  try {
    // A rollback journal keeps the fixture in one portable file: opening it
    // read-only for --verify must not leave -wal/-shm sidecars behind. The
    // application's own store enables WAL when it opens the database.
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(migration);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version    INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, BASE_TS);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const task of taskRows()) insertTask(db, task);
      for (const run of runRows()) insertRun(db, run);
      for (const acceptance of acceptanceRows()) insertAcceptance(db, acceptance);
      for (const cost of costRows()) insertCost(db, cost);

      // Exercise the completion guard instead of inserting a fake completed row:
      // the execution task may only become completed because its own-level
      // acceptance is already passed.
      db.prepare(`
        UPDATE task
           SET state = 'completed', execution_done_at = ?, updated_at = ?, closed_at = ?
         WHERE id = ?
      `).run(at(128), at(129), at(129), TASK.render);

      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Keep the original failure.
      }
      throw error;
    }

    const stats = readStats(db);

    console.log(`Seed OK: ${dbPath}`);
    console.log(`  schema v${SCHEMA_VERSION} from ${MIGRATION_REL}`);
    console.log(
      `  tasks: ${stats.levels.goal} goal / ${stats.levels.business} business / ` +
        `${stats.levels.execution} execution`,
    );
    console.log(
      `  task states: completed ${stats.states.completed ?? 0}, ` +
        `reworking ${stats.states.reworking ?? 0}, blocked ${stats.states.blocked ?? 0}`,
    );
    console.log(
      `  acceptance: ${stats.acceptance.total} row(s), ` +
        `${stats.acceptance.passed} passed`,
    );
    console.log(
      `  costs: ${stats.cost.rows} row(s), total CNY ${stats.cost.totalCny.toFixed(2)}`,
    );
  } finally {
    db.close();
  }

  const selfCheck = verify(dbPath, { quiet: true });
  if (!selfCheck.ok) {
    console.error('Seed self-check FAILED:');
    for (const failure of selfCheck.failures) {
      console.error(`  [FAIL] ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('  self-check: PASS');
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

function resolveDbPath(input) {
  const target = resolve(input);
  if (existsSync(target) && statSync(target).isFile()) return target;
  return join(target, DB_NAME);
}

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    // Older node:sqlite builds may not know the readOnly option. Open normally
    // but forbid writes for the lifetime of the verifier connection.
    let db;
    try {
      db = new DatabaseSync(path);
      db.exec('PRAGMA query_only = ON');
      return db;
    } catch {
      if (db) db.close();
      throw error;
    }
  }
}

function verify(inputArg, { quiet = false } = {}) {
  const dbPath = resolveDbPath(inputArg);
  const results = [];
  let db = null;

  const add = (name, ok, detail = '') => results.push({ name, ok, detail });
  const check = (name, fn) => {
    try {
      const detail = fn();
      add(name, true, detail == null ? '' : String(detail));
    } catch (error) {
      add(name, false, message(error));
    }
  };

  if (!existsSync(dbPath)) {
    add(`database exists (${DB_NAME})`, false, `not found: ${dbPath}`);
  } else {
    try {
      db = openReadOnly(dbPath);
    } catch (error) {
      add(`open ${DB_NAME} read-only`, false, message(error));
    }
  }

  if (db) {
    check('SQLite integrity_check', () => {
      const rows = db.prepare('PRAGMA integrity_check').all();
      const messages = rows.map((row) => row.integrity_check);
      assert(
        messages.length === 1 && messages[0] === 'ok',
        `integrity_check returned: ${messages.join('; ') || '(no rows)'}`,
      );
      return `SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v}`;
    });

    check('foreign keys have no violations', () => {
      const rows = db.prepare('PRAGMA foreign_key_check').all();
      assert(rows.length === 0, `${rows.length} violation(s): ${JSON.stringify(rows.slice(0, 3))}`);
      return '0 violations';
    });

    check('schema: L1 tables, guards and version', () => {
      const objects = db.prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      ).all();
      const names = new Set(objects.map((row) => row.name));
      const requiredTables = [
        'task',
        'run',
        'dispatch_outbox',
        'event_inbox',
        'event_watermark',
        'claim',
        'acceptance',
        'acceptance_item',
        'evidence',
        'cost_ledger',
        'task_event',
        'publish_authorization',
        'schema_version',
      ];
      const missingTables = requiredTables.filter((name) => !names.has(name));
      assert(missingTables.length === 0, `missing table(s): ${missingTables.join(', ')}`);

      const requiredTriggers = [
        'trg_task_level_adjacent_insert',
        'trg_task_level_immutable',
        'trg_completed_guard',
      ];
      const missingTriggers = requiredTriggers.filter((name) => !names.has(name));
      assert(missingTriggers.length === 0, `missing trigger(s): ${missingTriggers.join(', ')}`);

      const version = Number(
        db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version ?? 0,
      );
      assert(
        version === SCHEMA_VERSION,
        `schema_version is ${version}, expected ${SCHEMA_VERSION}`,
      );
      return `${requiredTables.length} tables, ${requiredTriggers.length} guards, schema v${version}`;
    });

    check('tasks: 1 goal / 2 business / 3 execution', () => {
      const counts = Object.fromEntries(
        db.prepare('SELECT level, COUNT(*) AS n FROM task GROUP BY level').all()
          .map((row) => [row.level, Number(row.n)]),
      );
      assert(counts.goal === 1, `expected 1 goal, found ${counts.goal ?? 0}`);
      assert(counts.business === 2, `expected 2 business, found ${counts.business ?? 0}`);
      assert(counts.execution === 3, `expected 3 execution, found ${counts.execution ?? 0}`);
      return `goal ${counts.goal}, business ${counts.business}, execution ${counts.execution}`;
    });

    check('task hierarchy: goal -> business -> execution', () => {
      const rows = db.prepare(`
        SELECT t.id, t.level, p.level AS parent_level
          FROM task t
          LEFT JOIN task p ON p.id = t.parent_task_id
      `).all();
      const invalid = rows.filter((row) => {
        if (row.level === 'goal') return row.parent_level !== null;
        if (row.level === 'business') return row.parent_level !== 'goal';
        if (row.level === 'execution') return row.parent_level !== 'business';
        return true;
      });
      assert(
        invalid.length === 0,
        `invalid parent(s): ${invalid
          .map((row) => `${row.id}(${row.level})<-${row.parent_level ?? 'null'}`)
          .join(', ')}`,
      );
      return `${rows.length} task(s) with adjacent parents`;
    });

    check('task states: exactly one reworking and one blocked', () => {
      const counts = Object.fromEntries(
        db.prepare('SELECT state, COUNT(*) AS n FROM task GROUP BY state').all()
          .map((row) => [row.state, Number(row.n)]),
      );
      assert(counts.reworking === 1, `expected 1 reworking, found ${counts.reworking ?? 0}`);
      assert(counts.blocked === 1, `expected 1 blocked, found ${counts.blocked ?? 0}`);
      return `reworking ${counts.reworking}, blocked ${counts.blocked}`;
    });

    check('acceptance: exactly one passed row at the task level', () => {
      const total = Number(db.prepare('SELECT COUNT(*) AS n FROM acceptance').get().n);
      assert(total === 1, `expected exactly 1 acceptance row, found ${total}`);

      const row = db.prepare(`
        SELECT a.id, a.stage, a.target_task_id, a.run_id, t.level AS target_level,
               t.state AS target_state, t.execution_done_at, t.business_done_at,
               t.goal_met_at, r.state AS run_state
          FROM acceptance a
          JOIN task t ON t.id = a.target_task_id
          LEFT JOIN run r ON r.id = a.run_id
         WHERE a.state = 'passed'
      `).get();
      assert(row, 'no passed acceptance found');
      assert(
        row.stage === row.target_level,
        `acceptance stage ${row.stage} does not match target level ${row.target_level}`,
      );
      assert(
        row.target_state === 'completed',
        `passed acceptance target is "${row.target_state}", expected "completed"`,
      );

      const doneColumn = {
        execution: 'execution_done_at',
        business: 'business_done_at',
        goal: 'goal_met_at',
      }[row.stage];
      assert(row[doneColumn] != null, `${doneColumn} is not set on the accepted target`);
      if (row.run_id) {
        assert(
          row.run_state === 'accepted',
          `acceptance run is "${row.run_state}", expected "accepted"`,
        );
      }
      return `${row.id}: ${row.stage} -> ${row.target_task_id} (completed)`;
    });

    check('completion invariant: no completed task without its own passed acceptance', () => {
      const missing = Number(db.prepare(`
        SELECT COUNT(*) AS n
          FROM task t
         WHERE t.state = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM acceptance a
              WHERE a.target_task_id = t.id
                AND a.stage = t.level
                AND a.state = 'passed'
           )
      `).get().n);
      assert(missing === 0, `${missing} completed task(s) lack a passed acceptance`);

      const completed = Number(
        db.prepare("SELECT COUNT(*) AS n FROM task WHERE state = 'completed'").get().n,
      );
      return `${completed} completed task(s) satisfy the guard`;
    });

    check('cost ledger: exactly 3 positive rows', () => {
      const rows = db.prepare('SELECT id, cost_cny FROM cost_ledger ORDER BY at, id').all();
      assert(rows.length === 3, `expected exactly 3 cost rows, found ${rows.length}`);
      const invalid = rows.filter((row) => !(Number(row.cost_cny) > 0));
      assert(
        invalid.length === 0,
        `non-positive cost row(s): ${invalid.map((row) => row.id).join(', ')}`,
      );
      const total = rows.reduce((sum, row) => sum + Number(row.cost_cny), 0);
      return `${rows.length} rows, total CNY ${total.toFixed(2)}`;
    });

    check('cost ledger references existing tasks and runs', () => {
      const orphanTask = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM cost_ledger c
         LEFT JOIN task t ON t.id = c.task_id
         WHERE t.id IS NULL
      `).get().n);
      assert(orphanTask === 0, `${orphanTask} cost row(s) reference a missing task`);

      const orphanRun = Number(db.prepare(`
        SELECT COUNT(*) AS n FROM cost_ledger c
         LEFT JOIN run r ON r.id = c.run_id
         WHERE c.run_id IS NOT NULL AND r.id IS NULL
      `).get().n);
      assert(orphanRun === 0, `${orphanRun} cost row(s) reference a missing run`);
      return 'all cost rows resolve';
    });

    try {
      db.close();
    } catch {
      // Ignore close failures while reporting.
    }
    db = null;
  }

  const failures = results.filter((result) => !result.ok);
  const ok = failures.length === 0 && results.length > 0;

  if (!quiet) {
    console.log('Demo control.sqlite verifier');
    console.log(`Database: ${dbPath}`);
    console.log('');
    for (const result of results) {
      console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}`);
      if (result.detail) console.log(`       ${result.detail}`);
    }
    console.log('');
    console.log(`Summary: ${results.length - failures.length} passed, ${failures.length} failed`);
    console.log(`Result: ${ok ? 'OK' : 'FAILED'}`);
  }

  return { dbPath, ok, results, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    if (options.out) {
      seed(options.out);
      return;
    }
    const result = verify(options.verify);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`seed: ${error.message}`);
      printUsage();
    } else {
      console.error(`seed: ${message(error)}`);
    }
    process.exitCode = 1;
  }
}

main();
