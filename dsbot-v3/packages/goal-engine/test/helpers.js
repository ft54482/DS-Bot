import assert from 'node:assert/strict';

export const BASE_SHA = '7d576a98471bd39c90baed2d37a91980ff16cbe3';
export const OTHER_SHA = 'a'.repeat(40);

export const PRD_INDEX = [
  { id: '03', title: '验收规范', path: 'docs/prd/03-acceptance-spec.md' },
  { id: '06', title: '测试矩阵', path: 'docs/prd/06-test-matrix.md' },
];

export function goal(overrides = {}) {
  return {
    id: 'goal-l33',
    title: '交付目标引擎',
    background: '把定目标到拆任务书自动化',
    baseSha: BASE_SHA,
    milestones: [
      { id: 'm1', title: '核心引擎' },
      { id: 'm2', title: '验证' },
    ],
    ...overrides,
  };
}

export function lane(overrides = {}) {
  return {
    lane: 'engine',
    dir: 'packages/goal-engine',
    milestone: 'm1',
    prd: ['03'],
    acceptance: ['node --test packages/goal-engine/test'],
    minCases: 12,
    cost: 2,
    ...overrides,
  };
}

export function lanes() {
  return [
    lane(),
    lane({
      lane: 'docs',
      dir: 'docs/prd',
      milestone: 'm2',
      prd: ['06'],
      acceptance: ['node tools/verify/verify.mjs'],
      minCases: 3,
      cost: 1,
    }),
  ];
}

export function input(overrides = {}) {
  return {
    goal: goal(),
    prdIndex: PRD_INDEX,
    lanes: lanes(),
    budget: { limit: 10, unit: 'points' },
    ...overrides,
  };
}

export function validBook(overrides = {}) {
  return {
    background: '目标：交付目标引擎\n负责 lane：engine',
    allowedPaths: ['packages/goal-engine/**'],
    workBase: { sha: BASE_SHA, ref: 'origin/main' },
    forbidden: ['白名单外写入或删除文件'],
    acceptanceCommands: ['node --test packages/goal-engine/test'],
    minCases: 12,
    ...overrides,
  };
}

export function expectCode(fn, code, message) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error.name, 'GoalEngineError', message);
      assert.equal(error.code, code, message);
      return true;
    },
    message,
  );
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
