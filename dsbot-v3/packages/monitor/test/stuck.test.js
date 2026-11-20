import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, DEFAULT_POLICY, STUCK_REASONS } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function snapshotWith(runtimeOverrides, now = NOW) {
  return buildSnapshot({ runtime: runtimeOverrides, now });
}

test('accepting beyond the default timeout is stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-accepting',
        level: 'business',
        state: 'accepting',
        owner_ref: 'bot:content',
        state_entered_at: NOW - 25 * HOUR,
      },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  const [entry] = snapshot.stuck;
  assert.equal(entry.id, 'task-accepting');
  assert.equal(entry.reason, STUCK_REASONS.ACCEPTING_TIMEOUT);
  assert.match(entry.detail, /25\.0h/);
  assert.match(entry.detail, /24\.0h/);
  assert.equal(entry.evidence_ref, 'task:task-accepting');
  assert.equal(entry.evidence.type, 'task');
  assert.equal(entry.evidence.state, 'accepting');
  assert.equal(entry.evidence.age_ms, 25 * HOUR);
  assert.equal(entry.evidence.threshold_ms, DEFAULT_POLICY.accepting_timeout_ms);
  assert.equal(entry.evidence.since, new Date(NOW - 25 * HOUR).toISOString());
});

test('accepting below the timeout is not stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-accepting',
        level: 'business',
        state: 'accepting',
        state_entered_at: NOW - 1 * HOUR,
      },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
});

test('accepting timeout is configurable and prefers accepting_since', () => {
  const runtime = {
    policy: { accepting_timeout_ms: 2 * HOUR },
    tasks: [
      {
        id: 'task-accepting',
        level: 'business',
        state: 'accepting',
        accepting_since: NOW - 3 * HOUR,
        updated_at: NOW - 10 * 60 * 1000,
      },
    ],
  };

  const snapshot = snapshotWith(runtime);

  assert.equal(snapshot.stuck.length, 1);
  assert.equal(snapshot.stuck[0].evidence.age_ms, 3 * HOUR);
  assert.equal(snapshot.stuck[0].evidence.threshold_ms, 2 * HOUR);
});

test('accepting falls back to updated_at and created_at', () => {
  const updated = snapshotWith({
    tasks: [
      {
        id: 'task-updated',
        level: 'business',
        state: 'accepting',
        updated_at: NOW - 30 * HOUR,
      },
    ],
  });
  assert.equal(updated.stuck.length, 1);
  assert.equal(updated.stuck[0].evidence.age_ms, 30 * HOUR);

  const created = snapshotWith({
    tasks: [
      {
        id: 'task-created',
        level: 'business',
        state: 'accepting',
        created_at: NOW - 30 * HOUR,
      },
    ],
  });
  assert.equal(created.stuck.length, 1);
  assert.equal(created.stuck[0].evidence.age_ms, 30 * HOUR);
});

test('accepting without any timestamp is not flagged as a timeout', () => {
  const snapshot = snapshotWith({
    tasks: [
      { id: 'task-unknown', level: 'business', state: 'accepting' },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
});

test('reworking for two explicit rounds is stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
        rework_rounds: 2,
      },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  const [entry] = snapshot.stuck;
  assert.equal(entry.reason, STUCK_REASONS.REWORK_ROUNDS);
  assert.equal(entry.evidence.rework_rounds, 2);
  assert.equal(entry.evidence.threshold, 2);
  assert.match(entry.evidence_ref, /task-rework/);
});

test('reworking for one round is not stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
        rework_rounds: 1,
      },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
});

test('reworking derives consecutive rounds from rejected runs', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
      },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-rework', run_no: 1, state: 'rejected' },
      { id: 'run-2', task_id: 'task-rework', run_no: 2, state: 'rejected' },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  const [entry] = snapshot.stuck;
  assert.equal(entry.evidence.rework_rounds, 2);
  assert.deepEqual(entry.evidence.rework_run_ids, ['run-2', 'run-1']);
  assert.deepEqual(entry.evidence.sources, ['run.state=rejected']);
  assert.equal(entry.evidence_ref, 'task:task-rework/runs:run-2,run-1');
});

test('reworking counts run_no once even when a round has multiple attempts', () => {
  const snapshot = snapshotWith({
    tasks: [
      { id: 'task-rework', level: 'execution', state: 'reworking' },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-rework', run_no: 1, attempt: 1, state: 'rejected' },
      { id: 'run-2a', task_id: 'task-rework', run_no: 2, attempt: 1, state: 'rejected' },
      { id: 'run-2b', task_id: 'task-rework', run_no: 2, attempt: 2, state: 'rejected' },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  assert.equal(snapshot.stuck[0].evidence.rework_rounds, 2);
});

test('reworking stops counting at the first non-rejected round', () => {
  const snapshot = snapshotWith({
    tasks: [
      { id: 'task-rework', level: 'execution', state: 'reworking' },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-rework', run_no: 1, state: 'rejected' },
      { id: 'run-2', task_id: 'task-rework', run_no: 2, state: 'accepted' },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
});

test('reworking history and configurable threshold are honored', () => {
  const history = snapshotWith({
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
        rework_history: [{ round: 1 }, { round: 2 }],
      },
    ],
  });
  assert.equal(history.stuck.length, 1);
  assert.equal(history.stuck[0].evidence.rework_rounds, 2);

  const raised = snapshotWith({
    policy: { rework_rounds_threshold: 3 },
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
        rework_rounds: 2,
      },
    ],
  });
  assert.deepEqual(raised.stuck, []);

  const belowContract = snapshotWith({
    policy: { rework_rounds_threshold: 1 },
    tasks: [
      {
        id: 'task-rework',
        level: 'execution',
        state: 'reworking',
        rework_rounds: 1,
      },
    ],
  });
  assert.deepEqual(belowContract.stuck, []);
});

test('blocked without an escalation is stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-blocked',
        level: 'execution',
        state: 'blocked',
        blocked_reason: 'budget',
      },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  const [entry] = snapshot.stuck;
  assert.equal(entry.reason, STUCK_REASONS.BLOCKED_NOT_ESCALATED);
  assert.match(entry.detail, /budget/);
  assert.equal(entry.evidence.blocked_reason, 'budget');
  assert.equal(entry.evidence.open_escalations, 0);
});

test('blocked with an open escalation is not stuck and appears in pending_decision', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-blocked',
        level: 'execution',
        state: 'blocked',
        blocked_reason: 'budget',
      },
    ],
    escalations: [
      {
        id: 'esc-1',
        task_id: 'task-blocked',
        kind: 'budget',
        detail: 'Budget is exhausted.',
        state: 'open',
      },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
  assert.equal(snapshot.pending_decision.length, 1);
  assert.equal(snapshot.pending_decision[0].id, 'esc-1');
});

test('blocked with a task-level escalation reference is not stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-blocked',
        level: 'execution',
        state: 'blocked',
        escalation_id: 'esc-1',
      },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
});

test('blocked with a closed escalation is still stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      { id: 'task-blocked', level: 'execution', state: 'blocked' },
    ],
    escalations: [
      {
        id: 'esc-closed',
        task_id: 'task-blocked',
        kind: 'blocked',
        state: 'closed',
      },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  assert.equal(snapshot.stuck[0].reason, STUCK_REASONS.BLOCKED_NOT_ESCALATED);
});

test('blocked with an open human intervention is not stuck', () => {
  const snapshot = snapshotWith({
    tasks: [
      { id: 'task-blocked', level: 'execution', state: 'blocked' },
    ],
    interventions: [
      {
        id: 'int-1',
        task_id: 'task-blocked',
        question: 'Which source should I use?',
      },
    ],
  });

  assert.deepEqual(snapshot.stuck, []);
  assert.equal(snapshot.pending_decision.length, 1);
  assert.equal(snapshot.pending_decision[0].kind, 'intervention');
});

test('stuck evidence carries executor state when the runtime provides it', () => {
  const lastSeen = NOW - 60 * 1000;
  const snapshot = snapshotWith({
    tasks: [
      {
        id: 'task-blocked',
        level: 'execution',
        state: 'blocked',
        executor_id: 'exec-1',
      },
    ],
    executors: [
      {
        id: 'exec-1',
        kind: 'dsh_session',
        state: 'degraded',
        last_seen_at: lastSeen,
      },
    ],
  });

  assert.equal(snapshot.stuck.length, 1);
  assert.deepEqual(snapshot.stuck[0].evidence.executor, {
    id: 'exec-1',
    kind: 'dsh_session',
    state: 'degraded',
    last_seen_at: new Date(lastSeen).toISOString(),
  });
});
