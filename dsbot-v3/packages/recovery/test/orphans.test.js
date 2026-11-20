import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcile } from '../src/index.js';
import { NOW, runtime } from './support/fixtures.js';

test('a worktree without a ticket is reported as an orphan and not deleted', () => {
  const worktree = { path: '/tmp/wt/task-9-r1' };
  const result = reconcile({ runtime: runtime({ worktrees: [worktree] }) });

  assert.equal(result.orphans.length, 1);
  const [orphan] = result.orphans;
  assert.equal(orphan.kind, 'worktree');
  assert.equal(orphan.id, '/tmp/wt/task-9-r1');
  assert.equal(orphan.path, '/tmp/wt/task-9-r1');
  assert.equal(orphan.ticket_id, null);
  assert.equal(orphan.action, 'report_only');
  assert.equal(orphan.reason, 'worktree_without_ticket');
  assert.equal(orphan.deleted, false);
  assert.equal(orphan.event.type, 'worktree.orphan');
  assert.deepEqual(worktree, { path: '/tmp/wt/task-9-r1' }, 'input is untouched');
  assert.equal(result.redispatch.length, 0);
  assert.equal(result.markLost.length, 0);
});

test('a worktree whose ticket is in the snapshot is kept', () => {
  const result = reconcile({
    runtime: runtime({
      worktrees: [{ path: '/tmp/wt/task-1-r1', ticket_id: 'task-1' }],
      tickets: [{ id: 'task-1', state: 'running' }],
    }),
  });

  assert.equal(result.orphans.length, 0);
  assert.deepEqual(result.kept, [
    {
      kind: 'worktree',
      id: '/tmp/wt/task-1-r1',
      path: '/tmp/wt/task-1-r1',
      ticket_id: 'task-1',
      state: null,
      reason: 'worktree_tracked',
    },
  ]);
});

test('a worktree whose ticket no longer exists is an orphan', () => {
  const result = reconcile({
    runtime: runtime({
      worktrees: [{ path: '/tmp/wt/task-2-r1', ticket_id: 'task-2' }],
      tickets: ['task-1'],
    }),
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].reason, 'worktree_ticket_missing');
  assert.equal(result.orphans[0].ticket_id, 'task-2');
  assert.equal(result.orphans[0].deleted, false);
});

test('when no ticket snapshot is supplied, a referenced ticket is trusted', () => {
  const snapshot = runtime({
    worktrees: [
      { path: '/tmp/wt/task-1-r1', task_id: 'task-1' },
      { path: '/tmp/wt/unclaimed' },
    ],
  });
  delete snapshot.tickets;

  const result = reconcile({ runtime: snapshot });

  assert.deepEqual(
    result.orphans.map((entry) => entry.path),
    ['/tmp/wt/unclaimed'],
  );
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].reason, 'worktree_tracked');
});

test('orphan entries are stable and identifiable by path', () => {
  const result = reconcile({
    runtime: runtime({
      worktrees: [
        { path: '/tmp/wt/b', ticket_id: null },
        { path: '/tmp/wt/a', ticket_id: 'missing' },
      ],
      tickets: [{ id: 'task-1' }],
    }),
  });

  assert.deepEqual(
    result.orphans.map((entry) => entry.path),
    ['/tmp/wt/a', '/tmp/wt/b'],
  );
  assert.deepEqual(
    result.orphans.map((entry) => entry.event.key),
    ['worktree.orphan:/tmp/wt/a', 'worktree.orphan:/tmp/wt/b'],
  );
  assert.equal(result.orphans[0].event.at, new Date(NOW).toISOString());
});

test('a healthy worktree and an orphan can coexist in one plan', () => {
  const result = reconcile({
    runtime: runtime({
      worktrees: [
        { path: '/tmp/wt/tracked', ticket_id: 'task-1', state: 'leased' },
        { path: '/tmp/wt/orphan', state: 'released' },
      ],
      tickets: [{ id: 'task-1' }],
    }),
  });

  assert.equal(result.orphans.length, 1);
  assert.equal(result.orphans[0].path, '/tmp/wt/orphan');
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].path, '/tmp/wt/tracked');
  assert.equal(result.kept[0].state, 'leased');
});
