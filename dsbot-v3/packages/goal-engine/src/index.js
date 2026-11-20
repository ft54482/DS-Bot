/**
 * L33 goal engine.
 *
 * One pure entry point, `decompose({goal, prdIndex, lanes, budget, template})`,
 * turns a goal into milestones whose lanes each carry a task book with the six
 * mandatory sections. Read `./README.md` for the contract and run
 * `node --test packages/goal-engine/test` for the acceptance evidence.
 */
export { decompose, defaultTemplate } from './decompose.js';
export { renderTaskBook, resolveTemplate, validateTaskBook } from './taskbook.js';
export {
  DEFAULT_FORBIDDEN,
  DEFAULT_MIN_CASES,
  ERROR_CODES,
  SECTION_KEYS,
  SECTION_TITLES,
} from './constants.js';
export { GoalEngineError } from './errors.js';
