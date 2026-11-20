import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePack } from '../src/index.js';
import { BASE_COMMIT, basePack } from './helpers.js';

function errorPaths(result) {
  assert.equal(result.ok, false);
  return result.errors.map((error) => `${error.code}@${error.path}`);
}

test('accepts a pack produced by buildTaskPack', () => {
  const pack = basePack();
  const result = validatePack(pack);

  assert.equal(result.ok, true);
  assert.equal(result.pack, pack);
});

test('reports invalid_pack when schema_version is missing', () => {
  const { schema_version: _ignored, ...pack } = basePack();
  assert.deepEqual(errorPaths(validatePack(pack)), [
    'invalid_pack@schema_version',
  ]);
});

test('reports unsupported_schema_version for a newer schema', () => {
  const result = validatePack({ ...basePack(), schema_version: '9.9.9' });
  assert.deepEqual(errorPaths(result), [
    'unsupported_schema_version@schema_version',
  ]);
});

test('reports unknown top-level fields as unknown_field', () => {
  const result = validatePack({ ...basePack(), owner: 'bot:content' });
  assert.deepEqual(errorPaths(result), ['unknown_field@owner']);
});

test('reports unknown nested fields with their full field path', () => {
  const pack = basePack();
  pack.workspace.owner = 'bot:content';
  pack.signals = { parallelism: 4 };
  pack.budget.usd_cap = 1;

  assert.deepEqual(errorPaths(validatePack(pack)), [
    'unknown_field@workspace.owner',
    'unknown_field@budget.usd_cap',
    'unknown_field@signals.parallelism',
  ]);
});

test('reports budget_exceeded above the default limit and honours an override', () => {
  const pack = { ...basePack(), budget: { cny_cap: 2000 } };

  assert.deepEqual(errorPaths(validatePack(pack)), [
    'budget_exceeded@budget.cny_cap',
  ]);
  assert.equal(
    validatePack(pack, { budgetLimits: { cny_cap: 3000 } }).ok,
    true,
  );
});

test('reports every problem in one pass', () => {
  const pack = {
    ...basePack(),
    goal: '',
    extra: true,
    budget: { cny_cap: 0 },
  };

  assert.deepEqual(errorPaths(validatePack(pack)), [
    'unknown_field@extra',
    'invalid_pack@goal',
    'invalid_pack@budget.cny_cap',
  ]);
});

test('reports invalid_pack at $ for a non-object pack', () => {
  assert.deepEqual(errorPaths(validatePack([])), ['invalid_pack@$']);
});

test('accepts the PRD list form of acceptance', () => {
  const pack = { ...basePack(), acceptance: ['node --test exits 0'] };
  assert.equal(validatePack(pack).ok, true);
});

test('reports each missing required field', () => {
  const { constraints, context_refs, workspace, budget, ...pack } = basePack();
  const paths = errorPaths(validatePack(pack));

  assert.ok(paths.includes('invalid_pack@constraints'));
  assert.ok(paths.includes('invalid_pack@context_refs'));
  assert.ok(paths.includes('invalid_pack@workspace'));
  assert.ok(paths.includes('invalid_pack@budget'));
});

test('reports a bad workspace base_commit with its field path', () => {
  const pack = {
    ...basePack(),
    workspace: { path: 'packages/taskpack', base_commit: 7 },
  };
  assert.deepEqual(errorPaths(validatePack(pack)), [
    'invalid_pack@workspace.base_commit',
  ]);
});

test('reports malformed signal values with their field path', () => {
  const pack = { ...basePack(), signals: { estimated_steps: 0 } };
  assert.deepEqual(errorPaths(validatePack(pack)), [
    'invalid_pack@signals.estimated_steps',
  ]);
});

test('does not throw on invalid data', () => {
  assert.doesNotThrow(() => validatePack(undefined));
  assert.doesNotThrow(() => validatePack({ goal: 1 }));
  assert.equal(validatePack({ goal: 1 }).ok, false);
});

test('a valid pack keeps the base commit in canonical snake_case', () => {
  const pack = basePack();
  assert.equal(pack.workspace.base_commit, BASE_COMMIT);
  assert.equal(Object.hasOwn(pack.workspace, 'baseCommit'), false);
});
