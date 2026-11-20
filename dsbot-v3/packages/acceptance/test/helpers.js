import { sha256Hex } from '../src/index.js';

export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const TEST_OUTPUT = 'ok 1 - acceptance\n# tests 3\n# pass 3\n# fail 0\n';

export function commitEvidence(overrides = {}) {
  return { id: 'evd-commit', kind: 'commit', content: COMMIT, ...overrides };
}

export function testEvidence(overrides = {}) {
  return {
    id: 'evd-tests',
    kind: 'test_output',
    content: TEST_OUTPUT,
    exitCode: 0,
    ...overrides,
  };
}

export function domainRubric(items, overrides = {}) {
  return {
    id: 'business.product_v1',
    stage: 'business',
    items,
    ...overrides,
  };
}

export function goalRubric(items, overrides = {}) {
  return {
    id: 'goal.objective_v1',
    stage: 'goal',
    evaluator: 'goal',
    items,
    ...overrides,
  };
}

export function passItem(id, overrides = {}) {
  return { id, verdict: 'pass', ...overrides };
}

export function itemById(evaluation, id) {
  const item = evaluation.items.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`no acceptance item "${id}" in ${evaluation.items.map((candidate) => candidate.id).join(', ')}`);
  }
  return item;
}

export function signedTestOutput(content = TEST_OUTPUT) {
  return testEvidence({ content, sha256: sha256Hex(content) });
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
