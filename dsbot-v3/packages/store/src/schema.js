import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreError } from './errors.js';

/** Migrations shipped with this package (migrations/NNN_*.sql). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

/** Highest schema version this build knows how to create. */
export const SCHEMA_VERSION = 1;

const MIGRATION_FILE = /^(\d+)_.*\.sql$/;

/** Apply connection pragmas from docs/prd/01-data-model.sql. */
export function configureConnection(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

function ensureSchemaVersionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

/** Current applied schema version, or 0 for an empty database. */
export function getSchemaVersion(db) {
  ensureSchemaVersionTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  return Number(row?.version ?? 0);
}

/** Migrations on disk, sorted by numeric version. */
export function listMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return readdirSync(migrationsDir)
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      return match ? { version: Number(match[1]), name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply every pending migration in one transaction per file and record it in
 * schema_version. Safe to call on every startup: applied versions are skipped.
 */
export function applyMigrations(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  ensureSchemaVersionTable(db);
  const current = getSchemaVersion(db);
  const pending = listMigrations(migrationsDir).filter((m) => m.version > current);

  for (const migration of pending) {
    const sql = readFileSync(join(migrationsDir, migration.name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
      ).run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original migration failure.
      }
      throw new StoreError(
        'migration_failed',
        `migration ${migration.name} failed: ${error?.message ?? error}`,
        { cause: error, sqliteCode: error?.code },
      );
    }
  }

  const applied = getSchemaVersion(db);
  if (applied > SCHEMA_VERSION) {
    throw new StoreError(
      'schema_version_unsupported',
      `database schema version ${applied} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  return applied;
}
