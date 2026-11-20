/**
 * Task projections returned by tools.
 *
 * A summary deliberately excludes run rows, executor events and acceptance
 * item detail: the PRD gives the Chief aggregate status, not execution logs
 * (`docs/prd/04-reliability-ops.md` §7). Evidence stays behind a future
 * drill-down tool with its own audit trail.
 */

import { resolveProject } from './scope.js';

export function summarizeTask(runtime, task, { project } = {}) {
  return {
    id: task.id,
    level: task.level,
    parentTaskId: task.parentTaskId,
    title: task.title,
    owner: task.owner,
    state: task.state,
    revision: task.revision,
    cycleNo: task.cycleNo,
    project: project ?? resolveProject(runtime, task),
    budget: task.budget,
    currentRunId: task.currentRunId,
    openAcceptanceId: task.openAcceptanceId,
    blockedReason: task.blockedReason,
    stopState: task.stopState ?? null,
    stopUnknown: task.stopUnknown === true,
    updatedAt: task.updatedAt,
  };
}

export function countByState(tasks) {
  const counts = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}
