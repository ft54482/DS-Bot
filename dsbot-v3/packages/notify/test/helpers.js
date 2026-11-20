import { createNotifier } from '../src/index.js';

export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const MINUTE = 60 * 1000;

export const TASK = Object.freeze({
  id: 'task-1',
  level: 'business',
  state: 'running',
  owner: 'bot:content',
});

export const RUN = Object.freeze({
  id: 'run-1',
  task_id: 'task-1',
  state: 'failed',
  attempt: 1,
  run_no: 2,
});

/**
 * Fixed-clock harness: `advance` moves time, `sent` records every notification
 * that actually reached the injected sender.
 */
export function createHarness(overrides = {}) {
  let at = NOW;
  const sent = [];
  const notifier = createNotifier({
    send: (notification) => sent.push(notification),
    now: () => at,
    ...overrides,
  });
  return {
    notifier,
    sent,
    advance(ms) {
      at += ms;
      return at;
    },
    setAt(value) {
      at = value;
      return at;
    },
    now() {
      return at;
    },
  };
}

export function requiredKeys(notification) {
  return ['task', 'run', 'reason', 'level'].every((key) =>
    Object.prototype.hasOwnProperty.call(notification, key),
  );
}
