import assert from 'node:assert/strict';
import test from 'node:test';

import { RESULT_FIELDS, verify } from '../src/index.js';
import {
  BASE,
  DEFAULT_DIRS,
  HEAD,
  MOVED,
  createRunner,
  makePr,
  tap,
} from './helpers.js';

const COMMAND = 'node --test packages/verifier-agent/test';

function call(overrides = {}) {
  return {
    pr: makePr(),
    lane: 'fast',
    allowedDirs: DEFAULT_DIRS,
    command: COMMAND,
    minCases: 12,
    runner: createRunner(),
    ...overrides,
  };
}

test('PASS: a clean scope, stable head and enough rerun cases', async () => {
  const runner = createRunner({
    files: ['packages/verifier-agent/src/verify.js', 'packages/verifier-agent/test/verify.test.js'],
    output: tap(12),
  });

  const result = await verify(call({ runner }));

  assert.deepEqual(result, {
    verdict: 'PASS',
    scopeOk: true,
    outside: [],
    exit: 0,
    cases: 12,
    headStable: true,
    reason: 'ok',
  });
  assert.deepEqual(Object.keys(result), RESULT_FIELDS);
  assert.equal(JSON.parse(JSON.stringify(result)).verdict, 'PASS');
  assert.equal(runner.calls.run.length, 1);
  assert.equal(runner.calls.run[0].command, COMMAND);
  assert.equal(runner.calls.run[0].lane, 'fast');
  assert.equal(runner.calls.prepare[0].expectedHead, HEAD);
});

test('FAIL: an out-of-scope file refuses to run the lane', async () => {
  const runner = createRunner({
    files: [
      'packages/verifier-agent/src/verify.js',
      'docs/prd/03-acceptance-spec.md',
      'packages/other/x.js',
    ],
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.scopeOk, false);
  assert.deepEqual(result.outside, ['docs/prd/03-acceptance-spec.md', 'packages/other/x.js']);
  assert.equal(result.exit, null);
  assert.equal(result.cases, 0);
  assert.equal(result.headStable, true);
  assert.match(result.reason, /^scope_violation:/);
  assert.equal(runner.calls.run.length, 0);
  assert.equal(runner.calls.prepare.length, 0);
});

test('FAIL: a sibling directory is not inside the allowed directory', async () => {
  const runner = createRunner({ files: ['packages/verifier-agent-other/src/x.js'] });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.scopeOk, false);
  assert.deepEqual(result.outside, ['packages/verifier-agent-other/src/x.js']);
  assert.equal(runner.calls.run.length, 0);
});

test('FAIL: a nonzero test exit is never PASS, even with many cases', async () => {
  const runner = createRunner({ exit: 1, output: tap(20, 2) });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.scopeOk, true);
  assert.equal(result.exit, 1);
  assert.equal(result.cases, 20);
  assert.equal(result.headStable, true);
  assert.match(result.reason, /^test_failed: exit 1$/);
});

test('FAIL: fewer cases than the floor fails; exactly the floor passes', async () => {
  const short = await verify(
    call({ runner: createRunner({ output: tap(5) }), minCases: 12 }),
  );
  assert.equal(short.verdict, 'FAIL');
  assert.equal(short.exit, 0);
  assert.equal(short.cases, 5);
  assert.match(short.reason, /^insufficient_cases: 5 < 12$/);

  const exact = await verify(
    call({ runner: createRunner({ output: tap(12) }), minCases: 12 }),
  );
  assert.equal(exact.verdict, 'PASS');
  assert.equal(exact.cases, 12);
});

test('FAIL: a head that moved before verification is not retried', async () => {
  const runner = createRunner({ resolveHead: () => MOVED });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.headStable, false);
  assert.equal(result.scopeOk, false);
  assert.match(result.reason, /^head_moved_before_verification: expected b{40}, got c{40}$/);
  assert.equal(runner.calls.changedFiles.length, 0);
  assert.equal(runner.calls.run.length, 0);
});

test('retry: a worktree switched during the run is replaced and rerun', async () => {
  const runner = createRunner({
    head: (worktree, call) => (call === 2 ? MOVED : HEAD),
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.headStable, true);
  assert.equal(result.cases, 12);
  assert.equal(runner.calls.prepare.length, 2);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true],
  );
  assert.deepEqual(
    runner.calls.run.map((entry) => entry.worktree),
    ['wt-1', 'wt-2'],
  );
});

test('FAIL: an authoritative head moved after the run voids the result', async () => {
  const runner = createRunner({
    resolveHead: (index) => (index === 0 ? HEAD : MOVED),
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.headStable, false);
  assert.match(result.reason, /^head_changed_during_verification:/);
});

test('retry: a contaminated run is rerun in a fresh worktree', async () => {
  const runner = createRunner({
    run: (args, index) => {
      if (index === 0) {
        return { exit: 0, output: tap(3), contaminated: true };
      }
      return { exit: 0, output: tap(12) };
    },
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.cases, 12);
  assert.equal(runner.calls.prepare.length, 2);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true],
  );
  assert.deepEqual(
    runner.calls.run.map((entry) => entry.worktree),
    ['wt-1', 'wt-2'],
  );
});

test('retry: an isolation error is rerun from an independent worktree', async () => {
  const isolation = Object.assign(new Error('clone switched to another branch'), {
    isolation: true,
  });
  const runner = createRunner({
    run: (args, index) => {
      if (index === 0) throw isolation;
      return { exit: 0, output: tap(12) };
    },
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'PASS');
  assert.equal(runner.calls.run.length, 2);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true],
  );
});

test('retry: a worktree prepared at the wrong head is replaced', async () => {
  const runner = createRunner({
    prepare: (index) => ({ worktree: index === 0 ? 'wt-stale' : 'wt-fresh' }),
    head: (worktree) => (worktree === 'wt-stale' ? MOVED : HEAD),
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.headStable, true);
  assert.equal(runner.calls.prepare.length, 2);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true],
  );
  assert.deepEqual(
    runner.calls.run.map((entry) => entry.worktree),
    ['wt-fresh'],
  );
});

test('FAIL: repeated worktree switches exhaust the fresh-worktree retries', async () => {
  const runner = createRunner({
    head: (worktree, call) => (call % 2 === 0 ? MOVED : HEAD),
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.headStable, false);
  assert.match(result.reason, /^isolation_failed:/);
  assert.equal(runner.calls.prepare.length, 3);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true, true],
  );
});

test('FAIL: repeated contamination exhausts the worktree retries', async () => {
  const runner = createRunner({
    run: () => ({ exit: 0, output: tap(12), contaminated: true }),
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.scopeOk, true);
  assert.equal(result.headStable, false);
  assert.equal(result.exit, null);
  assert.equal(result.cases, 0);
  assert.match(result.reason, /^isolation_failed:/);
  assert.equal(runner.calls.prepare.length, 3);
  assert.deepEqual(
    runner.calls.prepare.map((entry) => entry.fresh),
    [false, true, true],
  );
  assert.equal(runner.calls.run.length, 3);
});

test('FAIL: a runner exception becomes a reason, never a PASS', async () => {
  const runner = createRunner({
    run: () => {
      throw new Error('executor crashed');
    },
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.scopeOk, true);
  assert.equal(result.headStable, true);
  assert.equal(result.exit, null);
  assert.equal(result.cases, 0);
  assert.match(result.reason, /^runner_error: run: executor crashed$/);
});

test('FAIL: an unreachable head resolution is reported as runner_error', async () => {
  const runner = createRunner({
    resolveHead: () => {
      throw new Error('network offline');
    },
  });

  const result = await verify(call({ runner }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.headStable, false);
  assert.equal(result.scopeOk, false);
  assert.match(result.reason, /^runner_error: resolveHead: network offline$/);
  assert.equal(runner.calls.run.length, 0);
});

test('FAIL: a malformed run result is a runner_error', async () => {
  const noExit = await verify(call({ runner: createRunner({ run: () => ({ output: tap(12) }) }) }));
  assert.equal(noExit.verdict, 'FAIL');
  assert.match(noExit.reason, /^runner_error: run: run returned a non-integer exit/);

  const stringExit = await verify(call({ runner: createRunner({ run: () => ({ exit: '0', output: tap(12) }) }) }));
  assert.equal(stringExit.verdict, 'FAIL');
  assert.match(stringExit.reason, /^runner_error: run: run returned a non-integer exit/);
});

test('PASS: an uppercase pinned head still matches the resolved sha', async () => {
  const runner = createRunner({ resolveHead: () => HEAD.toUpperCase() });

  const result = await verify(call({ runner, pr: makePr({ head: HEAD.toUpperCase() }) }));

  assert.equal(result.verdict, 'PASS');
  assert.equal(result.headStable, true);
});

test('PASS: author self-reports are ignored; only rerun evidence counts', async () => {
  const runner = createRunner({ exit: 1, output: tap(12, 1) });
  const pr = makePr({
    title: 'tests pass',
    body: 'All tests pass locally, verified by the author.',
    author_report: { verdict: 'PASS', exit: 0, cases: 99 },
  });

  const result = await verify(call({ runner, pr }));

  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.exit, 1);
  assert.match(result.reason, /^test_failed: exit 1$/);
});

test('FAIL: invalid input returns a verdict instead of throwing', async () => {
  const cases = [
    {},
    { ...call(), runner: undefined },
    { ...call(), pr: { base: BASE, head: 'b' } },
    { ...call(), allowedDirs: [] },
    { ...call(), allowedDirs: ['../escape'] },
    { ...call(), command: '   ' },
    { ...call(), minCases: -1 },
    { ...call(), minCases: 1.5 },
    { ...call(), lane: '' },
  ];

  for (const input of cases) {
    const result = await verify(input);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.scopeOk, false);
    assert.deepEqual(result.outside, []);
    assert.equal(result.exit, null);
    assert.equal(result.cases, 0);
    assert.equal(result.headStable, false);
    assert.match(result.reason, /^invalid_input: /);
  }
});

test('PASS: lane defaults when the caller omits it', async () => {
  const runner = createRunner();

  const result = await verify({
    pr: makePr(),
    allowedDirs: DEFAULT_DIRS,
    command: COMMAND,
    minCases: 1,
    runner,
  });

  assert.equal(result.verdict, 'PASS');
  assert.equal(runner.calls.run[0].lane, 'default');
});
