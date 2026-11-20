import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { collectEvents, reconcile } from '../src/index.js';
import { NOW, deepFreeze, probeSpy, runtime, staleRun } from './support/fixtures.js';

const SRC_DIR = new URL('../src/', import.meta.url);

test('reconcile validates its runtime input', () => {
  assert.throws(() => reconcile(), /requires a runtime object/);
  assert.throws(() => reconcile({ runtime: null }), /requires a runtime object/);
  assert.throws(
    () => reconcile({ runtime: runtime({ runs: {} }) }),
    /runtime\.runs must be an array/,
  );
  assert.throws(
    () =>
      reconcile({
        runtime: runtime({ runs: [{ task_id: 'task-1', state: 'running' }] }),
      }),
    /runtime\.runs\[0\]\.id is required/,
  );
});

test('reconcile rejects duplicate run ids and malformed worktrees', () => {
  assert.throws(
    () =>
      reconcile({
        runtime: runtime({
          runs: [staleRun(), staleRun({ task_id: 'task-2' })],
        }),
      }),
    /duplicate id run-1/,
  );

  assert.throws(
    () => reconcile({ runtime: runtime({ worktrees: [{ ticket_id: 'task-1' }] }) }),
    /runtime\.worktrees\[0\]\.path is required/,
  );

  assert.throws(
    () =>
      reconcile({
        runtime: runtime({
          worktrees: [{ path: '/tmp/wt' }, { path: '/tmp/wt' }],
        }),
      }),
    /duplicate path \/tmp\/wt/,
  );
});

test('reconcile validates the clock and the probe', () => {
  assert.throws(
    () => reconcile({ runtime: runtime(), now: 'not-a-date' }),
    /requires a valid now/,
  );
  assert.throws(
    () => reconcile({ runtime: runtime(), executorProbe: 'probe' }),
    /executorProbe must be a function/,
  );
});

test('the result exposes exactly the four recovery buckets in order', () => {
  const result = reconcile({ runtime: runtime() });
  assert.deepEqual(Object.keys(result), ['redispatch', 'markLost', 'orphans', 'kept']);
});

test('reconcile never mutates its frozen input', () => {
  const snapshot = deepFreeze(
    runtime({
      runs: [staleRun({ id: 'run-a' }), staleRun({ id: 'run-b', state: 'running' })],
      outbox: [
        {
          id: 'outbox-run-a',
          run_id: 'run-a',
          intent: 'dispatch_run',
          state: 'pending',
        },
      ],
      worktrees: [
        { path: '/tmp/wt/a', ticket_id: 'task-1' },
        { path: '/tmp/wt/b' },
      ],
      tickets: [{ id: 'task-1' }],
    }),
  );

  const probe = probeSpy({ queryable: false });
  const result = reconcile({ runtime: snapshot, executorProbe: probe });

  assert.equal(result.redispatch.length, 1);
  assert.equal(result.markLost.length, 1);
  assert.equal(result.orphans.length, 1);
});

test('the implementation has no network, filesystem or database imports', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 3);

  const specifiers = [];
  for (const name of files) {
    const source = readFileSync(new URL(name, SRC_DIR), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      specifiers.push(match[1]);
    }
    assert.doesNotMatch(
      source,
      /\b(fetch|readFile|writeFile|openSync|createServer|connect)\s*\(/,
      `${name} must not perform I/O`,
    );
  }

  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('./'),
      `unexpected external import ${specifier}`,
    );
  }
});

test('the package declares no runtime dependencies', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies, undefined);
});

test('collectEvents validates the plan it is given', () => {
  assert.throws(() => collectEvents(null), /requires a reconcile result/);
  assert.throws(
    () => collectEvents({ redispatch: [], markLost: null, orphans: [], kept: [] }),
    /result\.markLost must be an array/,
  );

  const result = reconcile({
    runtime: runtime({ runs: [staleRun()] }),
    executorProbe: () => ({ queryable: false }),
  });
  assert.equal(collectEvents(result).length, 1);
  assert.equal(collectEvents(result)[0].at, new Date(NOW).toISOString());
});
