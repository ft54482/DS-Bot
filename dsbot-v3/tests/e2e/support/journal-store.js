/**
 * Test-only persistence for the L2 service store contract.
 *
 * The service keeps state behind an injected store (see
 * `packages/service/src/memory-store.js`). This fixture wraps that store and
 * journals every write operation to a JSON file. Opening the same file again
 * replays the journal into a fresh in-memory store, which is how the e2e test
 * simulates a task-service restart without sharing an object with the previous
 * process. Reads are always served from the in-memory projection.
 *
 * It is deliberately a harness, not a second state machine: no transition or
 * guard logic is reimplemented here, and a future SQLite service-store adapter
 * can replace it without changing the e2e assertions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createMemoryStore } from '../../../packages/service/src/memory-store.js';

const WRITE_METHODS = new Set([
  'createTask',
  'updateTask',
  'createRun',
  'updateRun',
  'createClaim',
  'createAcceptance',
  'updateAcceptance',
  'appendEvent',
  'putIdempotency',
  'appendStopVerification',
]);

function loadJournal(path) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new TypeError(`journal ${path} must contain an array`);
  }
  return parsed;
}

function persistJournal(path, journal) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(journal), 'utf8');
}

export function createJournaledStore(path) {
  const inner = createMemoryStore();
  const journal = loadJournal(path);

  // Rebuild the projection from the persisted operations. Replaying writes in
  // the original order is deterministic: state versions, event sequence, event
  // hash chain and idempotency records all come out identical.
  for (const entry of journal) {
    if (!entry || typeof entry.method !== 'string' || !Array.isArray(entry.args)) {
      throw new TypeError(`invalid journal entry in ${path}`);
    }
    if (!WRITE_METHODS.has(entry.method)) {
      throw new TypeError(`journal entry ${entry.method} is not a write method`);
    }
    inner[entry.method](...entry.args);
  }

  const store = {
    kind: 'journaled-memory',
    path,
    journalEntries: () => journal.length,
  };

  for (const [name, value] of Object.entries(inner)) {
    if (typeof value !== 'function') {
      store[name] = value;
      continue;
    }
    if (WRITE_METHODS.has(name)) {
      store[name] = (...args) => {
        const result = value.apply(inner, args);
        journal.push({ method: name, args: structuredClone(args) });
        persistJournal(path, journal);
        return result;
      };
    } else {
      store[name] = (...args) => value.apply(inner, args);
    }
  }

  return store;
}
