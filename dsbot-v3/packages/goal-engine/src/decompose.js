import {
  assertMutuallyExclusive,
  checkBudget,
  groupLanesByMilestone,
  normalizeBudget,
  normalizeGoal,
  normalizeLanes,
  normalizePrdIndex,
} from './normalize.js';
import { defaultTemplate, finalizeTaskBook, resolveTemplate } from './taskbook.js';

/**
 * L33 goal engine.
 *
 * Turns one goal into dispatchable task books. This is a pure function: it
 * reads only its arguments, performs no IO and uses no clock, randomness or
 * process state, so equal input always yields an equal result.
 *
 * Return shape:
 *   { milestones: [{ id, title, lanes: [{ lane, dir, taskBook }] }] }
 */
export function decompose({ goal, prdIndex, lanes, budget, template } = {}) {
  const normalizedGoal = normalizeGoal(goal);
  const normalizedLanes = normalizeLanes(lanes);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedPrd = normalizePrdIndex(prdIndex);

  assertMutuallyExclusive(normalizedLanes);
  checkBudget(normalizedLanes, normalizedBudget);

  const render = resolveTemplate(template);
  const groups = groupLanesByMilestone(normalizedGoal, normalizedLanes);

  const milestones = groups.map((group) => ({
    id: group.id,
    title: group.title,
    lanes: group.lanes.map((lane) => {
      const prd = normalizedPrd.resolve(lane.prd, lane.lane);
      const baseSha = lane.baseSha ?? normalizedGoal.baseSha;
      const context = {
        goal: {
          id: normalizedGoal.id,
          title: normalizedGoal.title,
          background: normalizedGoal.background,
          acceptance: [...normalizedGoal.acceptance],
        },
        lane,
        milestone: { id: group.id, title: group.title },
        prd,
        baseSha,
      };
      const taskBook = finalizeTaskBook(render(context), lane.lane);
      return { lane: lane.lane, dir: lane.dir, taskBook };
    }),
  }));

  return { milestones };
}

// Re-exported so consumers and tests can exercise a template without
// duplicating the default section text.
export { defaultTemplate };
