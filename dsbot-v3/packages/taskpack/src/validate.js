/**
 * Task pack schema validation.
 *
 * `validatePack(pack, options)` never throws on invalid data: it returns
 *
 *     {ok: true, pack}
 *   | {ok: false, errors: [{code, path, message}, ...]}
 *
 * and reports every problem in one pass. Checks:
 *
 * - `schema_version` is present and supported (`unsupported_schema_version`);
 * - required fields exist and have the right shape (`invalid_pack`, path);
 * - unknown fields at any level are rejected (`unknown_field`, path);
 * - `budget.cny_cap` is a positive finite number within the schema ceiling
 *   (`budget_exceeded` when above it).
 *
 * Pure: no IO, clock or randomness, and the pack is never mutated.
 */

import {
  ACCEPTANCE_FIELDS,
  BUDGET_FIELDS,
  DEFAULT_BUDGET_LIMITS,
  SIGNAL_FIELDS,
  SUPPORTED_SCHEMA_VERSIONS,
  TASK_PACK_FIELDS,
  WORKSPACE_FIELDS,
} from './constants.js';
import { taskPackErrorFrom } from './errors.js';
import { isNonEmptyString } from './normalize.js';
import { hasOwn, isPlainObject } from './values.js';

/**
 * Validate a task pack.
 *
 * @param {unknown} pack
 * @param {{budgetLimits?: {cny_cap?: number}}} [options]
 * @returns {{ok: true, pack: object} | {ok: false, errors: Array<{code: string, path: string, message: string}>}}
 * @throws {TypeError} when `options.budgetLimits` is malformed (programmer error)
 */
export function validatePack(pack, options = {}) {
  const limits = resolveBudgetLimits(options.budgetLimits);
  const errors = [];

  if (!isPlainObject(pack)) {
    errors.push({
      code: 'invalid_pack',
      path: '$',
      message: 'task pack must be a plain object',
    });
    return { ok: false, errors };
  }

  for (const key of Object.keys(pack)) {
    if (!TASK_PACK_FIELDS.includes(key)) {
      errors.push({
        code: 'unknown_field',
        path: key,
        message: `unknown task pack field "${key}"`,
      });
    }
  }

  validateSchemaVersion(pack, errors);
  validateGoal(pack, errors);
  validateStringArray(pack, 'constraints', errors);
  validateAcceptance(pack, errors);
  validateStringArray(pack, 'context_refs', errors);
  validateWorkspace(pack, errors);
  validateBudget(pack, errors, limits);
  validateSignals(pack, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pack };
}

/**
 * Validate and return the pack, throwing `TaskPackError` on the first failure.
 * `error.errors` keeps the complete list.
 */
export function assertValidPack(pack, options = {}) {
  const result = validatePack(pack, options);
  if (!result.ok) throw taskPackErrorFrom(result.errors);
  return result.pack;
}

function resolveBudgetLimits(overrides) {
  const limits = { ...DEFAULT_BUDGET_LIMITS };
  if (overrides === undefined) return limits;
  if (!isPlainObject(overrides)) {
    throw new TypeError('budgetLimits must be a plain object');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!BUDGET_FIELDS.includes(key)) {
      throw new TypeError(`unknown budget limit "${key}"`);
    }
    if (
      typeof value !== 'number' ||
      !(value > 0) ||
      Number.isNaN(value)
    ) {
      throw new TypeError(`budgetLimits.${key} must be a positive number`);
    }
    limits[key] = value;
  }
  return limits;
}

function validateSchemaVersion(pack, errors) {
  if (!hasOwn(pack, 'schema_version')) {
    errors.push({
      code: 'invalid_pack',
      path: 'schema_version',
      message: 'schema_version is required',
    });
    return;
  }
  if (typeof pack.schema_version !== 'string') {
    errors.push({
      code: 'invalid_pack',
      path: 'schema_version',
      message: 'schema_version must be a string',
    });
    return;
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(pack.schema_version)) {
    errors.push({
      code: 'unsupported_schema_version',
      path: 'schema_version',
      message: `unsupported schema_version "${pack.schema_version}" (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`,
    });
  }
}

function validateGoal(pack, errors) {
  if (!hasOwn(pack, 'goal')) {
    errors.push({
      code: 'invalid_pack',
      path: 'goal',
      message: 'goal is required',
    });
    return;
  }
  if (!isNonEmptyString(pack.goal)) {
    errors.push({
      code: 'invalid_pack',
      path: 'goal',
      message: 'goal must be a non-empty string',
    });
  }
}

function validateStringArray(pack, key, errors) {
  if (!hasOwn(pack, key)) {
    errors.push({
      code: 'invalid_pack',
      path: key,
      message: `${key} is required`,
    });
    return;
  }
  const value = pack[key];
  if (!Array.isArray(value)) {
    errors.push({
      code: 'invalid_pack',
      path: key,
      message: `${key} must be an array of strings`,
    });
    return;
  }
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      errors.push({
        code: 'invalid_pack',
        path: `${key}[${index}]`,
        message: `${key}[${index}] must be a non-empty string`,
      });
    }
  });
}

function validateAcceptance(pack, errors) {
  if (!hasOwn(pack, 'acceptance')) {
    errors.push({
      code: 'invalid_pack',
      path: 'acceptance',
      message: 'acceptance is required',
    });
    return;
  }

  const value = pack.acceptance;

  if (typeof value === 'string') {
    if (!isNonEmptyString(value)) {
      errors.push({
        code: 'invalid_pack',
        path: 'acceptance',
        message: 'acceptance must contain at least one criterion',
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    validateCriterionArray(value, 'acceptance', errors);
    if (value.length === 0) {
      errors.push({
        code: 'invalid_pack',
        path: 'acceptance',
        message: 'acceptance must contain at least one criterion',
      });
    }
    return;
  }

  if (!isPlainObject(value)) {
    errors.push({
      code: 'invalid_pack',
      path: 'acceptance',
      message:
        'acceptance must be a string, an array of strings, or {auto, independent}',
    });
    return;
  }

  for (const key of Object.keys(value)) {
    if (!ACCEPTANCE_FIELDS.includes(key)) {
      errors.push({
        code: 'unknown_field',
        path: `acceptance.${key}`,
        message: `unknown field "acceptance.${key}"`,
      });
    }
  }

  let total = 0;
  for (const key of ['auto', 'independent', 'criteria']) {
    if (!hasOwn(value, key)) continue;
    const list = value[key];
    if (!Array.isArray(list)) {
      errors.push({
        code: 'invalid_pack',
        path: `acceptance.${key}`,
        message: `acceptance.${key} must be an array of strings`,
      });
      continue;
    }
    validateCriterionArray(list, `acceptance.${key}`, errors);
    if (key !== 'criteria' || value.auto === undefined) total += list.length;
  }

  if (total === 0) {
    errors.push({
      code: 'invalid_pack',
      path: 'acceptance',
      message: 'acceptance must contain at least one criterion',
    });
  }
}

function validateCriterionArray(list, path, errors) {
  list.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      errors.push({
        code: 'invalid_pack',
        path: `${path}[${index}]`,
        message: `${path}[${index}] must be a non-empty string`,
      });
    }
  });
}

function validateWorkspace(pack, errors) {
  if (!hasOwn(pack, 'workspace')) {
    errors.push({
      code: 'invalid_pack',
      path: 'workspace',
      message: 'workspace is required',
    });
    return;
  }
  const value = pack.workspace;
  if (!isPlainObject(value)) {
    errors.push({
      code: 'invalid_pack',
      path: 'workspace',
      message: 'workspace must be an object',
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!WORKSPACE_FIELDS.includes(key)) {
      errors.push({
        code: 'unknown_field',
        path: `workspace.${key}`,
        message: `unknown field "workspace.${key}"`,
      });
    }
  }
  if (!isNonEmptyString(value.path)) {
    errors.push({
      code: 'invalid_pack',
      path: 'workspace.path',
      message: 'workspace.path is required',
    });
  }
  if (
    hasOwn(value, 'base_commit') &&
    !isNonEmptyString(value.base_commit)
  ) {
    errors.push({
      code: 'invalid_pack',
      path: 'workspace.base_commit',
      message: 'workspace.base_commit must be a non-empty string when present',
    });
  }
}

function validateBudget(pack, errors, limits) {
  if (!hasOwn(pack, 'budget')) {
    errors.push({
      code: 'invalid_pack',
      path: 'budget',
      message: 'budget is required',
    });
    return;
  }
  const value = pack.budget;
  if (!isPlainObject(value)) {
    errors.push({
      code: 'invalid_pack',
      path: 'budget',
      message: 'budget must be an object',
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BUDGET_FIELDS.includes(key)) {
      errors.push({
        code: 'unknown_field',
        path: `budget.${key}`,
        message: `unknown field "budget.${key}"`,
      });
    }
  }
  if (!hasOwn(value, 'cny_cap')) {
    errors.push({
      code: 'invalid_pack',
      path: 'budget.cny_cap',
      message: 'budget.cny_cap is required',
    });
    return;
  }
  const cap = value.cny_cap;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    errors.push({
      code: 'invalid_pack',
      path: 'budget.cny_cap',
      message: 'budget.cny_cap must be a positive finite number',
    });
    return;
  }
  if (cap > limits.cny_cap) {
    errors.push({
      code: 'budget_exceeded',
      path: 'budget.cny_cap',
      message: `budget.cny_cap ${cap} exceeds the schema limit ${limits.cny_cap}`,
    });
  }
}

function validateSignals(pack, errors) {
  if (!hasOwn(pack, 'signals')) return;
  const value = pack.signals;
  if (!isPlainObject(value)) {
    errors.push({
      code: 'invalid_pack',
      path: 'signals',
      message: 'signals must be an object',
    });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!SIGNAL_FIELDS.includes(key)) {
      errors.push({
        code: 'unknown_field',
        path: `signals.${key}`,
        message: `unknown field "signals.${key}"`,
      });
    }
  }
  if (hasOwn(value, 'estimated_steps')) {
    const steps = value.estimated_steps;
    if (!Number.isInteger(steps) || steps < 1) {
      errors.push({
        code: 'invalid_pack',
        path: 'signals.estimated_steps',
        message: 'signals.estimated_steps must be a positive integer',
      });
    }
  }
  if (hasOwn(value, 'stages')) {
    if (!Array.isArray(value.stages)) {
      errors.push({
        code: 'invalid_pack',
        path: 'signals.stages',
        message: 'signals.stages must be an array of strings',
      });
    } else {
      validateCriterionArray(value.stages, 'signals.stages', errors);
    }
  }
  for (const field of [
    'multi_file',
    'multiple_rounds',
    'isolated_worktree',
    'long_running',
  ]) {
    if (hasOwn(value, field) && typeof value[field] !== 'boolean') {
      errors.push({
        code: 'invalid_pack',
        path: `signals.${field}`,
        message: `signals.${field} must be a boolean`,
      });
    }
  }
}
