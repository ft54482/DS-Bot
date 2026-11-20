/**
 * L21 agent tool surface.
 *
 * Thin, authorized wrappers over the L9 runtime:
 *
 *   createChiefTools({ runtime, scope })     delegate / status / accept / stop / cost
 *   createBusinessTools({ runtime, scope })  plan / dispatch / accept / rework
 *
 * No task, run, acceptance, stop or cost logic is reimplemented here. The
 * runtime facade owns those; `packages/authz` owns scope containment and the
 * budget min-chain. This package only decides whether a role may call a runtime
 * operation and returns a structured denial when it may not.
 *
 * PRD: `docs/prd/02-api-contract.md` §5, `docs/prd/00-PRD.md` FR-14.
 */

export { createChiefTools } from './chief.js';
export { createBusinessTools } from './business.js';
export { AGENT_CODES, AGENT_ROLES, ROLE_TOOLS } from './constants.js';
export { readAgentScope, resolveProject, resolveTaskScope } from './scope.js';
export { budgetCap, checkBudget, subtreeSpend } from './budget.js';
export { summarizeTask } from './summary.js';
