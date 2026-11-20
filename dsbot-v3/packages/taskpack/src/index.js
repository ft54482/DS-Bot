/**
 * L47 task pack contract: build, validate and route one task definition over
 * the two DSH executor paths (`docs/prd/16-execution-paths.md`, PRD FR-19).
 */

export { buildTaskPack } from './build.js';
export { validatePack, assertValidPack } from './validate.js';
export {
  choosePath,
  classifyTaskPack,
  readCapability,
} from './route.js';
export { TaskPackError, taskPackErrorFrom } from './errors.js';
export {
  ACCEPTANCE_FIELDS,
  BUDGET_FIELDS,
  DEFAULT_BUDGET_LIMITS,
  EXECUTOR_KINDS,
  MAX_SESSION_STEPS,
  SIGNAL_FIELDS,
  SUPPORTED_SCHEMA_VERSIONS,
  TASK_PACK_FIELDS,
  TASK_PACK_SCHEMA_VERSION,
  WORKSPACE_FIELDS,
} from './constants.js';
