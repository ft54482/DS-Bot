import assert from 'node:assert/strict';
import test from 'node:test';

import { collectEvents, reconcile } from '../src/index.js';
import { NOW, freshRun, runtime, staleRun } from './support/fixtures.js';

function snapshot() {
  return runtime({
    runs: [
      staleRun({ id: 'run-unqueryable', task_id: 'task-1', state: 'running' }),
      staleRun({ id: 'run-queryable', task_id: 'task-2', state: 'dispatched' }),
      freshRun({ id: 'run-fresh', task_id: 'task-3', state: 'running' }),
      staleRun({ id: 'run-accepted', task_id: 'task-4', state: 'accepted' }),
    ],
    worktrees: [
      { path: '/tmp/wt/tracked', ticket_id: 'task-3' },
      { path: '/tmp/wt/orphan', ticket_id: 'task-404' },
    ],
    tickets: [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }, { id: 'task-4' }],
  });
}

function probe(run) {
  return run.run_id === 'run-queryable'
    ? { queryable: true, running: false }
    : { queryable: false, error: 'no route' };
}

test('two restarts over the same snapshot produce the same plan', () => {
  const first = reconcile({ runtime: snapshot(), executorProbe: probe });
  const second = reconcile({ runtime: snapshot(), executorProbe: probe });

  assert.deepEqual(second, first);
  assert.equal(first.markLost.length, 1);
  assert.equal(first.redispatch.length, 1);
  assert.equal(first.orphans.length, 1);
});

test('input order does not change the plan', () => {
  const baseline = reconcile({ runtime: snapshot(), executorProbe: probe });

  const reversed = snapshot();
  reversed.runs.reverse();
  reversed.worktrees.reverse();
  reversed.tickets.reverse();

  assert.deepEqual(
    reconcile({ runtime: reversed, executorProbe: probe }),
    baseline,
  );
});

test('a lost decision applied between restarts is not applied twice', () => {
  const first = reconcile({ runtime: snapshot(), executorProbe: probe });
  const lostIds = new Set(first.markLost.map((entry) => entry.run_id));
  assert.deepEqual([...lostIds], ['run-unqueryable']);

  // Simulate the caller applying the plan: the run row now holds the lost
  // state, which is terminal for recovery.
  const applied = snapshot();
  applied.runs = applied.runs.map((run) =>
    lostIds.has(run.id) ? { ...run, state: 'lost' } : run,
  );

  const second = reconcile({ runtime: applied, executorProbe: probe });
  assert.equal(second.markLost.length, 0);
  assert.ok(
    second.kept.some(
      (entry) => entry.run_id === 'run-unqueryable' && entry.reason === 'terminal_state',
    ),
  );
  // Orphan reporting is unchanged across restart.
  assert.deepEqual(second.orphans, first.orphans);
});

test('a re-dispatched run is not re-dispatched a second time after its state advances', () => {
  const first = reconcile({ runtime: snapshot(), executorProbe: probe });
  const redispatched = first.redispatch[0].run_id;
  assert.equal(redispatched, 'run-queryable');

  const applied = snapshot();
  applied.runs = applied.runs.map((run) =>
    run.id === redispatched
      ? { ...run, state: 'running', heartbeat_at: NOW - 1_000 }
      : run,
  );

  const second = reconcile({ runtime: applied, executorProbe: probe });
  assert.equal(second.redispatch.length, 0);
  assert.ok(
    second.kept.some(
      (entry) => entry.run_id === redispatched && entry.reason === 'heartbeat_fresh',
    ),
  );
});

test('every lost decision contributes exactly one run.lost event', () => {
  const result = reconcile({ runtime: snapshot(), executorProbe: probe });
  const events = collectEvents(result);

  assert.equal(events.length, 3, 'one event each for redispatch, lost and orphan');
  const lostEvents = events.filter((event) => event.type === 'run.lost');
  assert.equal(lostEvents.length, result.markLost.length);
  assert.deepEqual(
    lostEvents.map((event) => event.run_id),
    result.markLost.map((entry) => entry.run_id),
  );
  assert.equal(lostEvents[0].key, 'run.lost:run-unqueryable');
  assert.equal(lostEvents[0].from_state, 'running');
  assert.equal(lostEvents[0].reason, 'executor_unqueryable');
  assert.equal(lostEvents[0].at, new Date(NOW).toISOString());
});

test('decision keys and event keys stay unique and deterministic', () => {
  const result = reconcile({ runtime: snapshot(), executorProbe: probe });

  const decisionKeys = [
    ...result.redispatch.map((entry) => entry.idempotency_key),
    ...result.markLost.map((entry) => entry.idempotency_key),
  ];
  assert.equal(new Set(decisionKeys).size, decisionKeys.length);

  const eventKeys = collectEvents(result).map((event) => event.key);
  assert.equal(new Set(eventKeys).size, eventKeys.length);
  assert.deepEqual(decisionKeys, [
    'recovery:redispatch:run-queryable',
    'recovery:markLost:run-unqueryable',
  ]);
});

test('the orphan plan never contains a delete or cleanup action', () => {
  const result = reconcile({ runtime: snapshot(), executorProbe: probe });

  assert.deepEqual(
    result.orphans.map((entry) => entry.action),
    ['report_only'],
  );
  assert.deepEqual(
    result.orphans.map((entry) => entry.deleted),
    [false],
  );
});
