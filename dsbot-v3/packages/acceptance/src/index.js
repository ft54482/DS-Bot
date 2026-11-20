/**
 * L31 three-stage acceptance engine.
 *
 * One pure entry point, `evaluate({stage, task, evidence, rubric})`, decides
 * exactly one acceptance stage and never promotes a child stage result into
 * its parent. Read `./README.md` for the contract and run
 * `node --test packages/acceptance/test` for the acceptance evidence.
 */
export { evaluate } from './evaluate.js';
export { sha256Hex } from './canonical.js';
export { STAGES, RESULTS, RESULT_RANK } from './constants.js';
