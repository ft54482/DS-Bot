#!/usr/bin/env node
// Re-runnable schema verifier for the DS Bot V3 data model.
//
// It executes docs/prd/01-data-model.sql against an in-memory SQLite database
// (node:sqlite, no npm dependencies) and proves that the schema can be created
// and that the structural guards really reject invalid writes.
//
// Usage: node tools/verify/verify.mjs
// Exit code: 0 when every check passes, 1 otherwise.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ddlRel = 'docs/prd/01-data-model.sql';
const ddlPath = resolve(repoRoot, ddlRel);
const now = Date.now();

const results = [];
let db;
let ddlDigest = 'unavailable';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    results.push({ ok: false, name, detail: message });
  }
}

function objectNames(type) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => row.name);
}

function expectSqlError(fn, pattern) {
  try {
    fn();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    assert(pattern.test(message), `unexpected error message: ${message}`);
    return message;
  }
  throw new Error('statement succeeded, but the guard should have rejected it');
}

function insertTask({ id, level, state, parentTaskId = null }) {
  db.prepare(
    `INSERT INTO task (
       id, level, title, goal, project, state,
       parent_task_id, delegator_kind, delegator_ref, owner_ref,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    level,
    `verify ${id}`,
    'schema verifier fixture',
    'verify',
    state,
    parentTaskId,
    'human',
    'human:verify',
    'human:verify',
    now,
    now,
  );
}

function insertAcceptance({ id, stage, taskId, state }) {
  db.prepare(
    `INSERT INTO acceptance (
       id, stage, target_task_id, state, mode, criteria_json, created_at
     ) VALUES (?, ?, ?, ?, 'auto', '[]', ?)`,
  ).run(id, stage, taskId, state, now);
}

// ---------------------------------------------------------------------------
// 1. The DDL must execute on a fresh in-memory database.
// ---------------------------------------------------------------------------
check(`execute ${ddlRel} on an in-memory node:sqlite database`, () => {
  const sql = readFileSync(ddlPath, 'utf8');
  assert(sql.trim().length > 0, `${ddlRel} is empty`);
  ddlDigest = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  db = new DatabaseSync(':memory:');
  db.exec(sql);
  return `${(sql.length / 1024).toFixed(1)} KiB applied`;
});

// ---------------------------------------------------------------------------
// 2. Schema inventory.
// ---------------------------------------------------------------------------
check('table count >= 30', () => {
  const tables = objectNames('table');
  assert(tables.length >= 30, `expected >= 30 tables, found ${tables.length}`);
  return `${tables.length} tables`;
});

check('view count = 3', () => {
  const views = objectNames('view');
  assert(
    views.length === 3,
    `expected 3 views, found ${views.length}: ${views.join(', ') || '(none)'}`,
  );
  return `${views.length} views: ${views.join(', ')}`;
});

check('trigger count = 3 (including trg_completed_guard)', () => {
  const triggers = objectNames('trigger');
  assert(
    triggers.length === 3,
    `expected 3 triggers, found ${triggers.length}: ${triggers.join(', ') || '(none)'}`,
  );
  assert(
    triggers.includes('trg_completed_guard'),
    `trg_completed_guard missing; found: ${triggers.join(', ')}`,
  );
  return `${triggers.length} triggers: ${triggers.join(', ')}`;
});

check('schema_version has a record', () => {
  const rows = db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all();
  assert(rows.length > 0, 'schema_version is empty');
  return rows.map((row) => `version=${row.version} applied_at=${row.applied_at}`).join('; ');
});

// ---------------------------------------------------------------------------
// 3. Guard one: a task cannot become completed without a passed acceptance at
//    its own level.
// ---------------------------------------------------------------------------
check('guard 1 rejects completion without a passed acceptance at this level', () => {
  insertTask({ id: 'task-guard-1', level: 'goal', state: 'accepting' });

  const firstError = expectSqlError(
    () => db.prepare("UPDATE task SET state = 'completed' WHERE id = ?").run('task-guard-1'),
    /cannot complete/,
  );
  const stateAfterFirst = db.prepare('SELECT state FROM task WHERE id = ?').get('task-guard-1').state;
  assert(stateAfterFirst === 'accepting', `task state changed to ${stateAfterFirst} after rejection`);

  // A passed acceptance for a different stage must not satisfy the goal level.
  insertAcceptance({ id: 'acc-wrong-level', stage: 'business', taskId: 'task-guard-1', state: 'passed' });
  expectSqlError(
    () => db.prepare("UPDATE task SET state = 'completed' WHERE id = ?").run('task-guard-1'),
    /cannot complete/,
  );

  return `rejected: "${firstError}"`;
});

check('guard 1 allows completion once a passed acceptance exists at this level', () => {
  insertAcceptance({ id: 'acc-goal-level', stage: 'goal', taskId: 'task-guard-1', state: 'passed' });
  db.prepare("UPDATE task SET state = 'completed' WHERE id = ?").run('task-guard-1');
  const state = db.prepare('SELECT state FROM task WHERE id = ?').get('task-guard-1').state;
  assert(state === 'completed', `expected state completed, got ${state}`);
  return 'goal-level passed acceptance accepted; task state = completed';
});

// ---------------------------------------------------------------------------
// 4. Guard two: a goal cannot directly own an execution task.
// ---------------------------------------------------------------------------
check('guard 2 rejects an execution task directly under a goal', () => {
  insertTask({ id: 'task-goal-2', level: 'goal', state: 'planned' });

  const error = expectSqlError(
    () =>
      insertTask({
        id: 'task-exec-under-goal',
        level: 'execution',
        state: 'planned',
        parentTaskId: 'task-goal-2',
      }),
    /invalid task hierarchy/,
  );

  const inserted = db
    .prepare('SELECT COUNT(*) AS n FROM task WHERE id = ?')
    .get('task-exec-under-goal').n;
  assert(inserted === 0, 'rejected execution task was still inserted');
  return `rejected: "${error}"`;
});

check('guard 2 still allows an adjacent business task under a goal', () => {
  insertTask({
    id: 'task-business-under-goal',
    level: 'business',
    state: 'planned',
    parentTaskId: 'task-goal-2',
  });
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM task WHERE id = ?')
    .get('task-business-under-goal').n;
  assert(count === 1, 'valid adjacent child was not inserted');
  return 'goal -> business insert accepted';
});

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const failed = results.filter((item) => !item.ok);
const passed = results.length - failed.length;

console.log('DS Bot V3 DDL verifier');
console.log(`DDL:    ${ddlRel} (sha256 ${ddlDigest})`);
console.log(`SQLite: ${db ? db.prepare('SELECT sqlite_version() AS v').get().v : 'not opened'} (node:sqlite, in-memory)`);
console.log(`Node:   ${process.version}`);
console.log('');

for (const item of results) {
  const status = item.ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${item.name}`);
  if (item.detail) console.log(`       ${item.detail}`);
}

console.log('');
console.log(`Summary: ${passed} passed, ${failed.length} failed`);

if (db) {
  try {
    db.close();
  } catch {
    // ignore close failures while reporting
  }
}

if (failed.length > 0) {
  console.log('Result: FAILED');
  process.exitCode = 1;
} else {
  console.log('Result: OK');
  process.exitCode = 0;
}
