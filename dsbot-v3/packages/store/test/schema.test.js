import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, openStore } from '../src/index.js';

const MVP_TABLES = [
  'acceptance',
  'acceptance_item',
  'claim',
  'cost_ledger',
  'dispatch_outbox',
  'event_inbox',
  'event_watermark',
  'evidence',
  'publish_authorization',
  'run',
  'task',
  'task_event',
];

const GUARD_TRIGGERS = [
  'trg_completed_guard',
  'trg_task_level_adjacent_insert',
  'trg_task_level_immutable',
];

function withStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-store-'));
  const path = join(dir, 'control.sqlite');
  const store = openStore({ path });
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return store;
}

function tableNames(store) {
  return store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

test('migration creates schema_version and the 12 MVP tables', (t) => {
  const store = withStore(t);

  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const versions = store.db
    .prepare('SELECT version, applied_at FROM schema_version ORDER BY version')
    .all();
  assert.equal(versions.length, 1);
  assert.equal(Number(versions[0].version), SCHEMA_VERSION);
  assert.ok(Number(versions[0].applied_at) > 0);

  const tables = tableNames(store);
  for (const table of MVP_TABLES) {
    assert.ok(tables.includes(table), `missing MVP table: ${table}`);
  }
  assert.deepEqual(
    [...tables].sort(),
    [...MVP_TABLES, 'schema_version'].sort(),
    'unexpected table outside the L1 scope',
  );
});

test('migration installs all three guards and enables FK/WAL', (t) => {
  const store = withStore(t);

  const triggers = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(triggers, GUARD_TRIGGERS);

  const foreignKeys = store.db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(foreignKeys.foreign_keys), 1);

  const journal = store.db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
});

test('reopening an existing database skips applied migrations', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-store-'));
  const path = join(dir, 'control.sqlite');

  const first = openStore({ path });
  first.close();

  const second = openStore({ path });
  t.after(() => {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(second.schemaVersion(), SCHEMA_VERSION);
  const versions = second.db.prepare('SELECT version FROM schema_version').all();
  assert.deepEqual(versions.map((row) => Number(row.version)), [SCHEMA_VERSION]);
});

test('rejects a database schema newer than this build', (t) => {
  const store = withStore(t);
  const newer = SCHEMA_VERSION + 1;
  store.db
    .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
    .run(newer, Date.now());
  assert.throws(
    () => store.migrate(),
    (error) => {
      assert.equal(error.code, 'schema_version_unsupported');
      return true;
    },
  );
});
