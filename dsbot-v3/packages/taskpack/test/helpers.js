import assert from 'node:assert/strict';

import { buildTaskPack, TaskPackError } from '../src/index.js';

export const BASE_COMMIT = '0864d0b75c86f1d4d574b751ecccafb370ef8df9';

/** A simple, single-step task definition that satisfies every required field. */
export function baseInput(overrides = {}) {
  return {
    goal: 'Update the README quick start',
    constraints: ['do not touch other packages', 'no new dependencies'],
    acceptance: ['node --test packages/taskpack/test exits 0'],
    contextRefs: ['docs/prd/16-execution-paths.md'],
    workspace: { path: 'packages/taskpack', baseCommit: BASE_COMMIT },
    budget: { cny_cap: 5 },
    ...overrides,
  };
}

export function basePack(overrides = {}) {
  return buildTaskPack(baseInput(overrides));
}

export const FULL_CAPABILITY = Object.freeze({
  dsh_session: Object.freeze({ available: true }),
  superagent: Object.freeze({ available: true }),
});

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Assert a thrown `TaskPackError` with the given code and field path. */
export function assertPackError(fn, code, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TaskPackError, 'expected TaskPackError');
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}
