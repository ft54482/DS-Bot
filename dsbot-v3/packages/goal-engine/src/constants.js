/**
 * Stable constants for the L33 goal engine.
 *
 * Error codes are part of the public contract: callers branch on `error.code`
 * and never parse a message. Section keys are the six mandatory parts of a
 * task book; a template that omits one of them is rejected.
 */

export const ERROR_CODES = Object.freeze({
  invalidInput: 'invalid_input',
  emptyGoal: 'empty_goal',
  invalidLane: 'invalid_lane',
  duplicateLane: 'duplicate_lane',
  laneDirConflict: 'lane_dir_conflict',
  invalidBudget: 'invalid_budget',
  budgetExceeded: 'budget_exceeded',
  unknownPrd: 'unknown_prd',
  unknownMilestone: 'unknown_milestone',
  invalidTaskBook: 'invalid_task_book',
});

/** The six sections every task book must contain, in render order. */
export const SECTION_KEYS = Object.freeze([
  'background',
  'allowedPaths',
  'workBase',
  'forbidden',
  'acceptanceCommands',
  'minCases',
]);

/** Chinese section titles used by the default renderer. */
export const SECTION_TITLES = Object.freeze({
  background: '背景',
  allowedPaths: '允许路径',
  workBase: '工作位置（base sha）',
  forbidden: '禁止',
  acceptanceCommands: '验收命令',
  minCases: '最少用例数',
});

/** Default number of cases a generated task book asks for. */
export const DEFAULT_MIN_CASES = 1;

/** Default forbidden actions shared by every lane. */
export const DEFAULT_FORBIDDEN = Object.freeze([
  '白名单外写入或删除文件',
  '删除分支、git reset --hard、force push',
  '伪造测试输出或验收证据',
  '修改 CI 配置、仓库设置或他人文件',
  '添加依赖（任务书明确允许的除外）',
]);
