/**
 * Small building blocks shared by the M5 drill and its test suite.
 *
 * Nothing here reimplements task state: every transition goes through
 * `packages/runtime` -> `packages/service`, and the executor is the shipped
 * `mock` adapter. These helpers only supply deterministic clocks/ids, the
 * drill's scripted content, and two read-only projections (claim manifest and
 * cost roll-up).
 */

import { createHash } from 'node:crypto';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { createRuntime } from '../../../packages/runtime/src/index.js';

export const GOAL_TITLE = '写一篇关于 AI 的文章';

/** Required acceptance items for one execution round. */
export const EXECUTION_ITEMS = Object.freeze([
  { key: 'auto.contract', class: 'auto', required: true },
  { key: 'fact.accuracy', class: 'independent', required: true },
  { key: 'independent.review', class: 'independent', required: true },
]);

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.objective_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.auto_v1',
  version: 1,
  items: [...EXECUTION_ITEMS],
});

export const INITIAL_USAGE = Object.freeze({
  tokens_in: 1200,
  tokens_out: 800,
  tokens_cached: 200,
  cost_cny: 0.12,
});

export const REWORK_USAGE = Object.freeze({
  tokens_in: 900,
  tokens_out: 700,
  tokens_cached: 100,
  cost_cny: 0.18,
});

/** The acceptance-review cost is recorded by step 7/8, one row per round. */
export const ACCEPTANCE_COST_CNY = 0.01;

/**
 * The first draft contains a deliberate factual error so step 7's revise is
 * earned by data, not by an assertion string. The rework draft corrects it.
 */
export const INJECTED_ERROR = '水的沸点是 50°C';
export const ARTIFACT_V1 = [
  '# AI 如何改变内容生产（草稿 v1）',
  '',
  `事实错误（演练注入）：${INJECTED_ERROR}。`,
  '',
  '来源：sources/ai-basics.md、sources/model-notes.md',
  '',
].join('\n');

export const ARTIFACT_V2 = [
  '# AI 如何改变内容生产（终稿 v2）',
  '',
  '更正：标准大气压下水的沸点是 100°C。',
  '',
  '来源：sources/ai-basics.md、sources/model-notes.md',
  '',
].join('\n');

export const SOURCE_FILES = Object.freeze({
  'ai-basics.md': '# 来源 A：AI 基础\n\nAI 指由机器执行的学习、推理与生成任务。\n',
  'model-notes.md': '# 来源 B：模型观察\n\n内容生产链路包含检索、写作与审校。\n',
});

/** Deterministic manually advanced clock (no timers, no sleeps). */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
      return current;
    },
  };
}

/** Deterministic ids; the same factory survives the simulated restart. */
export function createIds(start = 0) {
  let counter = start;
  return {
    next: (prefix) => `${prefix}-${++counter}`,
    count: () => counter,
  };
}

/**
 * One mock adapter serves the whole drill. Two completion entries let the same
 * adapter report different usage for the first attempt and the rework attempt:
 * the drill resets the adapter clock before each attempt, so an attempt sees
 * only the completion that belongs to its elapsed time.
 */
export function createDrillAdapter(adapterClock, { cancelVerification = 'verified' } = {}) {
  return createMockAdapter({
    now: adapterClock.now,
    cancelVerification,
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: 100,
        type: 'complete',
        summary: 'draft v1',
        usage: { ...INITIAL_USAGE },
        artifacts: [{ path: 'article.md', content: ARTIFACT_V1 }],
      },
      {
        at: 1000,
        type: 'complete',
        summary: 'final v2',
        usage: { ...REWORK_USAGE },
        artifacts: [{ path: 'article.md', content: ARTIFACT_V2 }],
      },
    ],
  });
}

export function openRuntime({ dbPath, adapter, clock, ids, workspacePath, quiescenceMs = 5000 }) {
  return createRuntime({
    dbPath,
    adapters: { mock: adapter },
    clock: clock.now,
    idFactory: ids.next,
    workspacePath,
    quiescenceMs,
  });
}

/** Build a claim from what the executor actually produced. */
export async function claimFromExecutor(adapter, run, { nonce, summary = 'delivered' } = {}) {
  if (!nonce) throw new TypeError('claimFromExecutor requires a nonce');
  const artifacts = await adapter.collectArtifacts({ run_id: run.id });
  const manifest = artifacts.items.map((artifact) => ({
    path: artifact.path,
    sha256: artifact.sha256,
  }));
  return {
    commit: createHash('sha256').update(`${run.id}:${nonce}`).digest('hex').slice(0, 40),
    dirty: false,
    manifest,
    nonce,
    summary,
  };
}

/** The dispatch outbox row the runtime writes for a run, or null. */
export function outboxFor(runtime, run) {
  return runtime.store.getOutbox(`outbox-${run.id}`);
}

export function countOutbox(runtime, runs) {
  return runs.filter((run) => outboxFor(runtime, run) !== null).length;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function round6(value) {
  return Number(Number(value).toFixed(6));
}

export function sumCny(rows) {
  return round6(rows.reduce((total, row) => total + row.costCny, 0));
}

/** Cost of one task plus every descendant task (goal/business roll-up). */
export function rollupCny(runtime, taskId, childrenByParent) {
  let total = runtime.cost.total(taskId).costCny;
  for (const child of childrenByParent.get(taskId) ?? []) {
    total += rollupCny(runtime, child.id, childrenByParent);
  }
  return round6(total);
}

export function childrenByParent(runtime) {
  const map = new Map();
  for (const task of runtime.tasks.list()) {
    if (!task.parentTaskId) continue;
    const list = map.get(task.parentTaskId) ?? [];
    list.push(task);
    map.set(task.parentTaskId, list);
  }
  return map;
}

/** Compact task/run projections used in step evidence and the report. */
export function taskView(task) {
  return {
    id: task.id,
    level: task.level,
    parentTaskId: task.parentTaskId,
    state: task.state,
    revision: task.revision,
    stopState: task.stopState,
    stopUnknown: task.stopUnknown,
    currentRunId: task.currentRunId,
  };
}

export function runView(run) {
  return {
    id: run.id,
    taskId: run.taskId,
    state: run.state,
    kind: run.kind,
    attemptNo: run.attemptNo,
    executorKind: run.executorKind,
    cancelRequestedAt: run.cancelRequestedAt,
  };
}
