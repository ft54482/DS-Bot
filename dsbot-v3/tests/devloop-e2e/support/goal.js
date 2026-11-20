/**
 * Scenario A's goal decomposition uses the shipped L33 goal engine, not a
 * hand-written lane list. The result is still a fake task book in the sense
 * that its `workBase.sha` is a fixed test value and no real lane runs; what is
 * real is the decomposition contract: one goal, three lanes, one task book per
 * lane, and a budget that covers all three.
 */

import { decompose } from '../../../packages/goal-engine/src/index.js';

export const FAKE_BASE_SHA = '0'.repeat(40);
export const GOAL_ID = 'goal-l41-devloop-e2e';

/**
 * @param {{
 *   title: string,
 *   lanes: Array<{ lane: string, dir: string, cost?: number }>,
 *   budget?: number,
 * }} input
 */
export function decomposeGoalIntoLanes({ title, lanes, budget = 30 }) {
  const laneInputs = lanes.map((lane) => ({
    lane: lane.lane,
    dir: lane.dir,
    prd: ['03'],
    acceptance: [`node --test ${lane.dir}/test`],
    minCases: 1,
    cost: lane.cost ?? 2,
  }));

  const result = decompose({
    goal: {
      id: GOAL_ID,
      title,
      background: 'L41 dev-loop e2e fake world',
      baseSha: FAKE_BASE_SHA,
    },
    prdIndex: [
      {
        id: '03',
        title: '验收规范',
        path: 'docs/prd/03-acceptance-spec.md',
      },
    ],
    lanes: laneInputs,
    budget: { limit: budget, unit: 'CNY' },
  });

  const milestone = result.milestones[0];
  return milestone.lanes.map((lane, index) => ({
    id: lane.lane,
    lane: lane.lane,
    title: lane.lane,
    goal: lane.taskBook.background,
    budgetCny: laneInputs[index].cost,
    taskBook: lane.taskBook,
  }));
}
