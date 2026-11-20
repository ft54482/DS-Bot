import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcile } from '../src/index.js';
import {
  NOW,
  STALE_MS,
  freshRun,
  probeSpy,
  runtime,
  staleRun,
} from './support/fixtures.js';

test('a stale dispatched run with an unreachable executor is marked lost', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => ({ queryable: false, error: 'connection refused' }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 1);
  const [lost] = result.markLost;
  assert.equal(lost.run_id, 'run-1');
  assert.equal(lost.id, 'run-1');
  assert.equal(lost.task_id, 'task-1');
  assert.equal(lost.state, 'dispatched');
  assert.equal(lost.action, 'mark_lost');
  assert.equal(lost.reason, 'executor_unqueryable');
  assert.equal(lost.evidence.probe.queryable, false);
  assert.equal(lost.evidence.probe.error, 'connection refused');
  assert.equal(lost.idempotency_key, 'recovery:markLost:run-1');
  assert.equal(lost.event.type, 'run.lost');
});

test('a stale dispatched run that the executor can query as idle is re-dispatched', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => ({ queryable: true, running: false }),
  });

  assert.equal(result.markLost.length, 0);
  assert.equal(result.redispatch.length, 1);
  const [entry] = result.redispatch;
  assert.equal(entry.run_id, 'run-1');
  assert.equal(entry.id, 'run-1');
  assert.equal(entry.action, 'redispatch');
  assert.equal(entry.reason, 'heartbeat_stale_queryable_idle');
  assert.equal(entry.idempotency_key, 'recovery:redispatch:run-1');
  assert.equal(entry.event.type, 'run.redispatched');
  assert.equal(entry.probe.queryable, true);
});

test('a stale running run whose executor reports a dead state is re-dispatched', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun({ state: 'running' })] }),
    executorProbe: () => ({ queryable: true, state: 'not_found' }),
  });

  assert.equal(result.redispatch.length, 1);
  assert.equal(result.redispatch[0].state, 'running');
  assert.equal(result.redispatch[0].reason, 'heartbeat_stale_queryable_idle');
});

test('a stale run whose executor still reports it as running is kept', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun({ state: 'running' })] }),
    // A long operation can outlive the heartbeat threshold; the executor is
    // the authority on whether it is still alive.
    executorProbe: () => ({ queryable: true, running: true }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 0);
  assert.deepEqual(result.kept, [
    {
      kind: 'run',
      id: 'run-1',
      run_id: 'run-1',
      task_id: 'task-1',
      state: 'running',
      reason: 'executor_alive',
    },
  ]);
});

test('a fresh heartbeat is kept and the executor is never probed', () => {
  const probe = probeSpy({ queryable: false });
  const result = reconcile({
    runtime: runtime({ runs: [freshRun()] }),
    executorProbe: probe,
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 0);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].reason, 'heartbeat_fresh');
  assert.equal(probe.calls.length, 0);
});

test('an active lease keeps a run alive even when the heartbeat is stale', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun({ state: 'running', lease_until: NOW + 30_000 })],
    }),
    executorProbe: () => {
      throw new Error('must not be probed');
    },
  });

  assert.equal(result.markLost.length, 0);
  assert.equal(result.kept[0].reason, 'lease_active');
});

test('accepted, completed and reported runs are left untouched', () => {
  const probe = probeSpy({ queryable: false });
  const result = reconcile({
    runtime: runtime({
      runs: [
        staleRun({ id: 'run-accepted', state: 'accepted' }),
        staleRun({ id: 'run-completed', state: 'completed' }),
        staleRun({ id: 'run-reported', state: 'reported' }),
      ],
    }),
    executorProbe: probe,
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 0);
  assert.deepEqual(
    result.kept.map((entry) => [entry.run_id, entry.reason]),
    [
      ['run-accepted', 'terminal_state'],
      ['run-completed', 'terminal_state'],
      ['run-reported', 'terminal_state'],
    ],
  );
  assert.equal(probe.calls.length, 0);
});

test('queued runs are not lost and are not probed', () => {
  const probe = probeSpy({ queryable: false });
  const result = reconcile({
    runtime: runtime({ runs: [staleRun({ state: 'queued' })] }),
    executorProbe: probe,
  });

  assert.equal(result.markLost.length, 0);
  assert.equal(result.kept[0].reason, 'not_dispatched');
  assert.equal(probe.calls.length, 0);
});

test('a pending outbox row with no send marker is safe to re-dispatch without probing', () => {
  const probe = probeSpy({ queryable: false });
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun()],
      outbox: [
        {
          id: 'outbox-run-1',
          run_id: 'run-1',
          intent: 'dispatch_run',
          state: 'pending',
          idempotency_key: 'dispatch:run-1:1',
        },
      ],
    }),
    executorProbe: probe,
  });

  assert.equal(result.markLost.length, 0);
  assert.equal(result.redispatch.length, 1);
  const [entry] = result.redispatch;
  assert.equal(entry.reason, 'outbox_never_sent');
  assert.equal(entry.outbox_id, 'outbox-run-1');
  assert.equal(entry.outbox_idempotency_key, 'dispatch:run-1:1');
  assert.equal(probe.calls.length, 0);
});

test('an ambiguous outbox is marked lost, never re-dispatched', () => {
  for (const state of ['sending', 'sent', 'unknown']) {
    const result = reconcile({
      runtime: runtime({
        runs: [staleRun()],
        outbox: [
          {
            id: `outbox-${state}`,
            run_id: 'run-1',
            intent: 'dispatch_run',
            state,
          },
        ],
      }),
      executorProbe: () => ({ queryable: true, running: false }),
    });

    assert.equal(result.redispatch.length, 0, `${state} must not be re-dispatched`);
    assert.equal(result.markLost.length, 1);
    assert.equal(result.markLost[0].reason, 'dispatch_ambiguous');
    assert.equal(result.markLost[0].evidence.outbox_state, state);
  }
});

test('a pending outbox that already carries a send marker is ambiguous', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun()],
      outbox: [
        {
          id: 'outbox-run-1',
          run_id: 'run-1',
          intent: 'dispatch_run',
          state: 'pending',
          send_started_at: NOW - STALE_MS,
        },
      ],
    }),
    executorProbe: () => ({ queryable: true, running: false }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'dispatch_ambiguous');
});

test('a failed outbox is marked lost instead of being re-dispatched blindly', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun()],
      outbox: [
        {
          id: 'outbox-run-1',
          run_id: 'run-1',
          intent: 'dispatch_run',
          state: 'failed',
        },
      ],
    }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'dispatch_failed');
});

test('a probe that throws is treated as unreachable', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => {
      throw new Error('executor offline');
    },
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 1);
  assert.equal(result.markLost[0].reason, 'executor_unqueryable');
  assert.equal(result.markLost[0].evidence.probe.error, 'executor offline');
});

test('a missing probe is not proof of a dead attempt', () => {
  const result = reconcile({ runtime: runtime({ runs: [staleRun()] }) });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 1);
  const [entry] = result.markLost;
  assert.equal(entry.reason, 'executor_unqueryable');
  assert.equal(entry.evidence.probe.attempted, false);
  assert.equal(entry.evidence.probe.error, 'executorProbe not provided');
});

test('an empty probe answer is a lost run, not a re-dispatch', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => null,
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'executor_no_answer');
});

test('a queryable but inconclusive probe answer is a lost run', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => ({ queryable: true }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'executor_state_unknown');
});

test('a run with no timestamps at all is considered stale', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [{ id: 'run-bare', task_id: 'task-1', state: 'running' }],
    }),
  });

  assert.equal(result.markLost.length, 1);
  assert.equal(result.markLost[0].reason, 'executor_unqueryable');
  assert.equal(result.markLost[0].evidence.last_activity_at, null);
  assert.equal(result.markLost[0].evidence.age_ms, null);
});

test('a pending cancel outbox never triggers a re-dispatch', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun({ state: 'running' })],
      outbox: [
        {
          id: 'outbox-cancel',
          run_id: 'run-1',
          intent: 'cancel_run',
          state: 'pending',
        },
      ],
    }),
    executorProbe: () => ({ queryable: false }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'executor_unqueryable');
});

test('a single label-less outbox row is treated as the dispatch intent', () => {
  const result = reconcile({
    runtime: runtime({
      runs: [staleRun()],
      outbox: [{ id: 'outbox-run-1', run_id: 'run-1', state: 'pending' }],
    }),
  });

  assert.equal(result.redispatch.length, 1);
  assert.equal(result.redispatch[0].reason, 'outbox_never_sent');
});

test('an Error object returned by the probe is unreachable', () => {
  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => ({ error: new Error('socket closed') }),
  });

  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost[0].reason, 'executor_unqueryable');
  assert.equal(result.markLost[0].evidence.probe.error, 'socket closed');
});

test('the heartbeat threshold can be injected through the runtime policy', () => {
  const run = staleRun({ heartbeat_at: NOW - 2_000 });
  const strict = reconcile({
    runtime: runtime({ runs: [run], policy: { heartbeat_stall_ms: 1_000 } }),
    executorProbe: () => ({ queryable: false }),
  });
  assert.equal(strict.markLost.length, 1);

  const lenient = reconcile({
    runtime: runtime({ runs: [run], heartbeat_stall_ms: 60_000 }),
    executorProbe: () => ({ queryable: false }),
  });
  assert.equal(lenient.markLost.length, 0);
  assert.equal(lenient.kept[0].reason, 'heartbeat_fresh');
});
