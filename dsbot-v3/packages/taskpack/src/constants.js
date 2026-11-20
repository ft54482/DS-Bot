/**
 * L47 task pack contract constants.
 *
 * PRD: `docs/prd/16-execution-paths.md` §2/§3 (the task pack is shared by the
 * `dsh_session` and `superagent` executor paths) and §4 (routing rules).
 */

/** Current task pack schema version. Bump on any breaking shape change. */
export const TASK_PACK_SCHEMA_VERSION = '1.0.0';

/** Versions `validatePack` accepts. Older readers reject newer packs. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([
  TASK_PACK_SCHEMA_VERSION,
]);

/** The two executor paths the router may pick (PRD 16 §1.2). */
export const EXECUTOR_KINDS = Object.freeze(['dsh_session', 'superagent']);

/**
 * Routing rule from PRD 16 §4: a task estimated at five steps or fewer tends
 * to the ordinary session, more than five steps to a SuperAgent.
 */
export const MAX_SESSION_STEPS = 5;

/**
 * Schema guard for `budget.cny_cap`. The PRD examples are 5 CNY for a session
 * and 30 CNY for a SuperAgent; anything above this hard schema ceiling is
 * almost certainly a unit mistake and is reported as `budget_exceeded`.
 */
export const DEFAULT_BUDGET_LIMITS = Object.freeze({ cny_cap: 1000 });

/** Every field a task pack may contain (top level). */
export const TASK_PACK_FIELDS = Object.freeze([
  'schema_version',
  'goal',
  'constraints',
  'acceptance',
  'context_refs',
  'workspace',
  'budget',
  'signals',
]);

export const WORKSPACE_FIELDS = Object.freeze(['path', 'base_commit']);

export const BUDGET_FIELDS = Object.freeze(['cny_cap']);

export const ACCEPTANCE_FIELDS = Object.freeze([
  'auto',
  'independent',
  'criteria',
]);

/** Optional complexity hints that drive `choosePath` (PRD 16 §4). */
export const SIGNAL_FIELDS = Object.freeze([
  'estimated_steps',
  'stages',
  'multi_file',
  'multiple_rounds',
  'isolated_worktree',
  'long_running',
]);

/** Input aliases accepted by `buildTaskPack`; the pack always uses snake_case. */
export const SIGNAL_ALIASES = Object.freeze({
  estimatedSteps: 'estimated_steps',
  multiFile: 'multi_file',
  multipleRounds: 'multiple_rounds',
  isolatedWorktree: 'isolated_worktree',
  longRunning: 'long_running',
});
