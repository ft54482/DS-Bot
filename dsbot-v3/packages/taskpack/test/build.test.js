import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTaskPack,
  TASK_PACK_SCHEMA_VERSION,
} from '../src/index.js';
import {
  BASE_COMMIT,
  assertPackError,
  baseInput,
  deepFreeze,
} from './helpers.js';

test('builds a versioned canonical pack from the six-field input', () => {
  const pack = buildTaskPack(baseInput());

  assert.equal(pack.schema_version, TASK_PACK_SCHEMA_VERSION);
  assert.equal(pack.schema_version, '1.0.0');
  assert.deepEqual(pack, {
    schema_version: '1.0.0',
    goal: 'Update the README quick start',
    constraints: [
      'do not touch other packages',
      'no new dependencies',
    ],
    acceptance: {
      auto: ['node --test packages/taskpack/test exits 0'],
      independent: [],
    },
    context_refs: ['docs/prd/16-execution-paths.md'],
    workspace: {
      path: 'packages/taskpack',
      base_commit: BASE_COMMIT,
    },
    budget: { cny_cap: 5 },
  });
  assert.equal(Object.hasOwn(pack, 'signals'), false);
});

test('normalizes camelCase aliases, string lists and optional hints', () => {
  const pack = buildTaskPack({
    goal: '  Ship the routing contract  ',
    constraints: 'no new dependencies',
    acceptance: 'tests pass',
    contextRefs: ['docs/prd/16-execution-paths.md'],
    workspace: { path: 'packages/taskpack', baseCommit: BASE_COMMIT },
    budget: { cnyCap: 10 },
    estimatedSteps: 9,
    stages: ['probe', 'implement'],
    multiFile: true,
    longRunning: false,
  });

  assert.equal(pack.goal, 'Ship the routing contract');
  assert.deepEqual(pack.constraints, ['no new dependencies']);
  assert.deepEqual(pack.acceptance, { auto: ['tests pass'], independent: [] });
  assert.equal(pack.workspace.base_commit, BASE_COMMIT);
  assert.deepEqual(pack.budget, { cny_cap: 10 });
  assert.deepEqual(pack.signals, {
    estimated_steps: 9,
    stages: ['probe', 'implement'],
    multi_file: true,
    long_running: false,
  });
});

test('keeps independent acceptance criteria from the PRD SuperAgent shape', () => {
  const pack = buildTaskPack(
    baseInput({
      acceptance: {
        auto: ['node --test exits 0'],
        independent: ['reviewer reruns the tests on the exact commit'],
      },
    }),
  );

  assert.deepEqual(pack.acceptance, {
    auto: ['node --test exits 0'],
    independent: ['reviewer reruns the tests on the exact commit'],
  });
});

test('does not mutate a frozen input object', () => {
  const input = deepFreeze(baseInput());
  const before = JSON.parse(JSON.stringify(input));

  buildTaskPack(input);

  assert.deepEqual(JSON.parse(JSON.stringify(input)), before);
});

test('deduplicates constraints and context refs without reordering', () => {
  const pack = buildTaskPack(
    baseInput({
      constraints: ['b', 'a', 'b'],
      contextRefs: ['docs/a.md', 'docs/a.md', 'docs/b.md'],
    }),
  );

  assert.deepEqual(pack.constraints, ['b', 'a']);
  assert.deepEqual(pack.context_refs, ['docs/a.md', 'docs/b.md']);
});

test('reports invalid_pack with the goal path when goal is missing', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ goal: undefined })),
    'invalid_pack',
    'goal',
  );
});

test('reports invalid_pack with the acceptance path when acceptance is empty', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ acceptance: [] })),
    'invalid_pack',
    'acceptance',
  );
});

test('reports invalid_pack with workspace.path when the workspace path is empty', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ workspace: { path: '  ' } })),
    'invalid_pack',
    'workspace.path',
  );
});

test('reports invalid_pack with budget.cny_cap when the budget cap is missing', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ budget: {} })),
    'invalid_pack',
    'budget.cny_cap',
  );
});

test('reports invalid_pack with the exact index of a malformed context ref', () => {
  assertPackError(
    () =>
      buildTaskPack(
        baseInput({
          contextRefs: ['docs/prd/16-execution-paths.md', 42],
        }),
      ),
    'invalid_pack',
    'context_refs[1]',
  );
});

test('reports budget_exceeded above the default schema ceiling', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ budget: { cny_cap: 2000 } })),
    'budget_exceeded',
    'budget.cny_cap',
  );
});

test('reports unknown acceptance fields as unknown_field', () => {
  assertPackError(
    () =>
      buildTaskPack(
        baseInput({ acceptance: { auto: ['x'], manual: ['y'] } }),
      ),
    'unknown_field',
    'acceptance.manual',
  );
});

test('reports unknown signal fields as unknown_field', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ signals: { parallelism: 4 } })),
    'unknown_field',
    'signals.parallelism',
  );
});

test('reports a malformed signal value with its field path', () => {
  assertPackError(
    () => buildTaskPack(baseInput({ signals: { estimated_steps: 0 } })),
    'invalid_pack',
    'signals.estimated_steps',
  );
});

test('rejects a non-object input with the root path', () => {
  assertPackError(
    () => buildTaskPack(null),
    'invalid_pack',
    '$',
  );
});
