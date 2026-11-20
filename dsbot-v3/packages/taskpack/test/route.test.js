import test from 'node:test';
import assert from 'node:assert/strict';

import { choosePath, TaskPackError } from '../src/index.js';
import {
  FULL_CAPABILITY,
  assertPackError,
  basePack,
} from './helpers.js';

const SESSION_ONLY = {
  dsh_session: { available: true },
};

const SUPERAGENT_ONLY = {
  dsh_session: { available: false, reason: 'bridge offline' },
  superagent: { available: true },
};

test('routes a simple single-step pack to dsh_session with a reason', () => {
  const decision = choosePath({
    taskPack: basePack(),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'dsh_session');
  assert.deepEqual(decision.routing_reason, {
    path: 'dsh_session',
    score: 0,
    why: ['simple_single_step'],
    degraded: false,
  });
});

test('routes more than five estimated steps to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { estimated_steps: 6 } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.equal(decision.routing_reason.path, 'superagent');
  assert.ok(decision.routing_reason.why.includes('steps>5'));
  assert.ok(decision.routing_reason.score >= 1);
  assert.equal(decision.routing_reason.degraded, false);
});

test('five estimated steps stay on dsh_session', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { estimated_steps: 5 } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'dsh_session');
  assert.ok(decision.routing_reason.why.includes('steps<=5'));
});

test('routes a multi-stage task to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { stages: ['probe', 'implement', 'verify'] } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('multi_stage'));
});

test('routes a task requiring multiple verification rounds to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { multiple_rounds: true } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('multiple_rounds'));
});

test('routes a task requiring an isolated worktree to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { isolated_worktree: true } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('isolated_worktree'));
});

test('routes a long-running task to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { long_running: true } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('long_running'));
});

test('routes a multi-file change to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { multi_file: true } }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('multi_file'));
});

test('routes independent acceptance checks to superagent', () => {
  const decision = choosePath({
    taskPack: basePack({
      acceptance: {
        auto: ['node --test exits 0'],
        independent: ['a reviewer reruns the tests'],
      },
    }),
    capability: FULL_CAPABILITY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.ok(decision.routing_reason.why.includes('independent_acceptance'));
});

test('degrades to dsh_session with degraded:true when superagent is missing', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { estimated_steps: 12 } }),
    capability: SESSION_ONLY,
  });

  assert.equal(decision.executor_kind, 'dsh_session');
  assert.equal(decision.routing_reason.path, 'dsh_session');
  assert.equal(decision.routing_reason.requested_path, 'superagent');
  assert.equal(decision.routing_reason.degraded, true);
  assert.match(
    decision.routing_reason.reason,
    /superagent capability unavailable: not reported by the capability probe/,
  );
  assert.ok(decision.routing_reason.why.includes('superagent_unavailable'));
});

test('carries the capability probe reason into the degradation reason', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { long_running: true } }),
    capability: {
      dsh_session: { available: true },
      superagent: { available: false, reason: 'G-SA-1: no local ticket API' },
    },
  });

  assert.equal(decision.executor_kind, 'dsh_session');
  assert.equal(decision.routing_reason.degraded, true);
  assert.match(
    decision.routing_reason.reason,
    /superagent capability unavailable: G-SA-1: no local ticket API/,
  );
});

test('degrades the other way when dsh_session is unavailable', () => {
  const decision = choosePath({
    taskPack: basePack(),
    capability: SUPERAGENT_ONLY,
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.equal(decision.routing_reason.requested_path, 'dsh_session');
  assert.equal(decision.routing_reason.degraded, true);
  assert.match(
    decision.routing_reason.reason,
    /dsh_session capability unavailable: bridge offline/,
  );
});

test('throws executor_unavailable when neither path is available', () => {
  assert.throws(
    () =>
      choosePath({
        taskPack: basePack(),
        capability: { dsh_session: false, superagent: false },
      }),
    (error) => {
      assert.ok(error instanceof TaskPackError);
      assert.equal(error.code, 'executor_unavailable');
      assert.equal(error.path, 'capability');
      return true;
    },
  );
});

test('rejects an invalid task pack before routing', () => {
  const pack = basePack();
  delete pack.goal;

  assertPackError(
    () => choosePath({ taskPack: pack, capability: FULL_CAPABILITY }),
    'invalid_pack',
    'goal',
  );
});

test('treats a malformed capability entry as unavailable, never as silent success', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { multi_file: true } }),
    capability: { dsh_session: { available: true }, superagent: 'yes' },
  });

  assert.equal(decision.executor_kind, 'dsh_session');
  assert.equal(decision.routing_reason.degraded, true);
  assert.match(
    decision.routing_reason.reason,
    /superagent capability unavailable: entry is malformed/,
  );
});

test('accepts boolean capability entries', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { multi_file: true } }),
    capability: { dsh_session: true, superagent: true },
  });

  assert.equal(decision.executor_kind, 'superagent');
  assert.equal(decision.routing_reason.degraded, false);
});

test('routing_reason matches the PRD audit shape', () => {
  const decision = choosePath({
    taskPack: basePack({ signals: { stages: ['a', 'b'] } }),
    capability: FULL_CAPABILITY,
  });

  assert.deepEqual(Object.keys(decision).sort(), [
    'executor_kind',
    'routing_reason',
  ]);
  assert.equal(decision.routing_reason.path, decision.executor_kind);
  assert.equal(typeof decision.routing_reason.score, 'number');
  assert.ok(Array.isArray(decision.routing_reason.why));
  assert.ok(decision.routing_reason.why.length > 0);
  assert.equal(typeof decision.routing_reason.degraded, 'boolean');
});
