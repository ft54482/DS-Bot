/**
 * `buildTaskPack(input)` turns a BOT's task definition into the versioned task
 * pack shared by the `dsh_session` and `superagent` executor paths
 * (`docs/prd/16-execution-paths.md` §2/§3).
 *
 * Canonical output:
 *
 *     {
 *       schema_version: "1.0.0",
 *       goal: "…",
 *       constraints: ["…"],
 *       acceptance: { auto: ["…"], independent: ["…"] },
 *       context_refs: ["…"],
 *       workspace: { path: "…", base_commit?: "…" },
 *       budget: { cny_cap: 5 },
 *       signals?: { … }        // optional routing hints
 *     }
 *
 * Input aliases (`contextRefs`, `baseCommit`, camelCase signal names…) are
 * normalized. Missing or malformed fields raise `TaskPackError` with the first
 * failure's `code`/`path` and the complete `errors` list; the function never
 * returns a partial pack. Pure: no IO, clock, randomness or input mutation.
 */

import {
  SIGNAL_FIELDS,
  TASK_PACK_SCHEMA_VERSION,
} from './constants.js';
import { TaskPackError, taskPackErrorFrom } from './errors.js';
import {
  readAcceptanceInput,
  readBudgetInput,
  readSignalsInput,
  readStringList,
  readWorkspaceInput,
  uniqueStrings,
} from './normalize.js';
import { assertValidPack } from './validate.js';
import { isPlainObject } from './values.js';

/**
 * @param {object} input
 * @param {string} input.goal
 * @param {string[]} [input.constraints]
 * @param {string[]|string|{auto?: string[], independent?: string[]}} input.acceptance
 * @param {string[]} [input.contextRefs] / input.context_refs
 * @param {{path: string, base_commit?: string}} input.workspace
 * @param {{cny_cap: number}} input.budget
 * @param {object} [input.signals] optional routing hints
 * @returns {object} a validated, versioned task pack
 * @throws {TaskPackError} with `code`, `path` and `errors`
 */
export function buildTaskPack(input) {
  if (!isPlainObject(input)) {
    throw new TaskPackError(
      'invalid_pack',
      '$',
      'task pack input must be a plain object',
    );
  }

  const errors = [];

  const goal = readGoal(input.goal, errors);
  const constraints = readStringList(
    input.constraints,
    'constraints',
    errors,
  );
  const acceptance = readAcceptanceInput(input.acceptance, errors);
  const contextRefs = readStringList(
    input.contextRefs ?? input.context_refs,
    'context_refs',
    errors,
  );
  const workspace = readWorkspaceInput(input.workspace, errors);
  const budget = readBudgetInput(input.budget, errors);
  const signals = readSignalsInput(input, errors);

  if (errors.length > 0) throw taskPackErrorFrom(errors);

  const pack = {
    schema_version: TASK_PACK_SCHEMA_VERSION,
    goal,
    constraints: uniqueStrings(constraints),
    acceptance: {
      auto: acceptance.auto,
      independent: acceptance.independent,
    },
    context_refs: uniqueStrings(contextRefs),
    workspace,
    budget,
  };

  if (signals !== undefined) {
    // Rebuild in the documented order so JSON output is stable regardless of
    // the order hints were supplied in.
    const ordered = {};
    for (const field of SIGNAL_FIELDS) {
      if (signals[field] !== undefined) ordered[field] = signals[field];
    }
    pack.signals = ordered;
  }

  return assertValidPack(pack);
}

function readGoal(value, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({
      code: 'invalid_pack',
      path: 'goal',
      message: 'goal is required and must be a non-empty string',
    });
    return undefined;
  }
  return value.trim();
}
