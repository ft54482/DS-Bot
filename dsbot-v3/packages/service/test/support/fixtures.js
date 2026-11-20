import { createTaskService } from '../../src/index.js';
import { createMemoryStore } from '../../src/memory-store.js';

export const COMMIT = 'a'.repeat(40);
export const SHA256 = 'b'.repeat(64);

/** Deterministic ids/clock keep assertions readable and events reproducible. */
export function createHarness({ startAt = 1_700_000_000_000 } = {}) {
  let tick = 0;
  let counter = 0;
  const store = createMemoryStore();
  const service = createTaskService({
    store,
    clock: () => startAt + tick++,
    idFactory: (prefix) => `${prefix}-${++counter}`,
  });
  return { store, service };
}

export function validClaim(overrides = {}) {
  return {
    commit: COMMIT,
    dirty: false,
    manifest: [{ path: 'packages/service/src/index.js', sha256: SHA256 }],
    nonce: 'nonce-1',
    ...overrides,
  };
}

/** execution task -> dispatched run -> running. */
export function startRunningTask(service, options = {}) {
  const task = service.createTask({
    level: 'execution',
    title: options.title ?? 'state machine fixture',
    ...options.task,
  });
  const { run } = service.dispatchTask({
    taskId: task.id,
    idempotencyKey: options.dispatchKey ?? 'dispatch-1',
  });
  const acked = service.ackRun({ runId: run.id });
  return { task: acked.task, run: acked.run };
}

/** Drive an execution task to accepting with an open acceptance. */
export function startAcceptingTask(service, options = {}) {
  const { task, run } = startRunningTask(service, options);
  const claimed = service.claimRun({
    runId: run.id,
    claim: options.claim ?? validClaim(),
    acceptanceItems: options.acceptanceItems ?? [],
    idempotencyKey: options.claimKey,
  });
  return {
    ...claimed,
    initialTask: task,
  };
}

export function passedItemStates(acceptance) {
  return Object.fromEntries(acceptance.items.map((item) => [item.key, 'pass']));
}
