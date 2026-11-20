#!/usr/bin/env node
/**
 * L28 store/service performance baseline.
 *
 * Runs three samples of each metric and reports the median. The SQLite store is
 * opened from a throw-away directory created by this process and removed before
 * exit; nothing is written inside the repository.
 *
 * Metrics (all over 1000 operations):
 *   store_insert_1k_ms  bulk-insert 1000 tasks in one transaction
 *   store_query_1k_ms   1000 primary-key lookups (Store#getTask)
 *   transition_1k_ms    1000 task state transitions through the L2 service
 *                       (planned -> queued via TaskService#queueTask)
 *
 * Exit code 0 when every median is within its threshold, 1 otherwise.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '../../packages/store/src/index.js';
import { createMemoryStore, createTaskService } from '../../packages/service/src/index.js';

const OPERATIONS = 1000;
const SAMPLES = 3;

const THRESHOLDS = Object.freeze({
  store_insert_1k_ms: 2000,
  store_query_1k_ms: 1000,
  transition_1k_ms: 500,
});

const TASK_TEMPLATE = Object.freeze({
  level: 'goal',
  goal: 'L28 store/service performance baseline',
  project: 'superagent-lab-smoke',
  domain: 'ops',
  delegator_kind: 'human',
  delegator_ref: 'perf:benchmark',
  owner_ref: 'perf:benchmark',
});

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Insert and query one fresh SQLite store. Each sample gets its own database so
 * page cache or WAL state from a previous sample cannot flatter the next one.
 */
function sampleStore(rootDir, sample) {
  const dbPath = join(rootDir, `sample-${sample}.sqlite`);
  const ids = Array.from({ length: OPERATIONS }, (_, index) => `perf-task-${sample}-${index}`);
  const store = openStore({ path: dbPath });
  try {
    const insertStarted = performance.now();
    store.transaction(() => {
      for (let index = 0; index < OPERATIONS; index += 1) {
        store.createTask({
          ...TASK_TEMPLATE,
          id: ids[index],
          title: `perf task ${sample}-${index}`,
        });
      }
    });
    const insertMs = performance.now() - insertStarted;

    const queryStarted = performance.now();
    for (const id of ids) {
      if (!store.getTask(id)) {
        throw new Error(`store query returned no row for ${id}`);
      }
    }
    const queryMs = performance.now() - queryStarted;

    return { insertMs, queryMs };
  } finally {
    store.close();
  }
}

/**
 * Run 1000 planned -> queued transitions through the L2 state machine. The
 * service owns its in-memory store, so this measures guards, transition checks,
 * event hashing and state updates rather than SQLite commit latency.
 */
function sampleTransition() {
  const service = createTaskService({ store: createMemoryStore() });
  const taskIds = [];
  for (let index = 0; index < OPERATIONS; index += 1) {
    taskIds.push(service.createTask({ title: `perf transition ${index}` }).id);
  }

  const started = performance.now();
  for (const taskId of taskIds) {
    service.queueTask({ taskId });
  }
  return performance.now() - started;
}

function main() {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsbot-perf-'));
  try {
    const insertSamples = [];
    const querySamples = [];
    const transitionSamples = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const { insertMs, queryMs } = sampleStore(rootDir, sample);
      insertSamples.push(insertMs);
      querySamples.push(queryMs);
      transitionSamples.push(sampleTransition());
    }

    const medians = {
      store_insert_1k_ms: median(insertSamples),
      store_query_1k_ms: median(querySamples),
      transition_1k_ms: median(transitionSamples),
    };
    const result = {
      store_insert_1k_ms: roundMs(medians.store_insert_1k_ms),
      store_query_1k_ms: roundMs(medians.store_query_1k_ms),
      transition_1k_ms: roundMs(medians.transition_1k_ms),
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    const exceeded = Object.entries(THRESHOLDS).filter(
      ([metric, threshold]) => medians[metric] > threshold,
    );
    for (const [metric, threshold] of exceeded) {
      process.stderr.write(`[FAIL] ${metric}=${result[metric]}ms > ${threshold}ms\n`);
    }
    if (exceeded.length > 0) process.exitCode = 1;
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

main();
