/**
 * Input normalization shared by `buildTaskPack` (tolerant of camelCase and of
 * the two PRD acceptance shapes) and `choosePath` (reads a validated pack).
 *
 * Every helper is pure. Errors are collected as
 * `{code, path, message}` records so one call can report every problem.
 */

import {
  ACCEPTANCE_FIELDS,
  BUDGET_FIELDS,
  DEFAULT_BUDGET_LIMITS,
  SIGNAL_ALIASES,
  SIGNAL_FIELDS,
  WORKSPACE_FIELDS,
} from './constants.js';
import { isPlainObject } from './values.js';

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function firstText(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function pushInvalid(errors, path, message) {
  errors.push({ code: 'invalid_pack', path, message });
}

export function pushUnknown(errors, path, message) {
  errors.push({
    code: 'unknown_field',
    path,
    message: message ?? `unknown field "${path}"`,
  });
}

/**
 * Normalize a required list of non-empty strings. A bare string is accepted as
 * a one-item list; `[]` is a valid (but empty) list.
 */
export function readStringList(value, path, errors) {
  if (value === undefined || value === null) {
    pushInvalid(errors, path, `${path} is required`);
    return undefined;
  }
  const raw = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(raw)) {
    pushInvalid(errors, path, `${path} must be an array of strings`);
    return undefined;
  }
  const collected = [];
  raw.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      pushInvalid(
        errors,
        `${path}[${index}]`,
        `${path}[${index}] must be a non-empty string`,
      );
      return;
    }
    collected.push(entry.trim());
  });
  return collected;
}

/**
 * Normalize one criterion list. The path is used verbatim in error messages so
 * `acceptance.auto[1]` and `acceptance.criteria[1]` stay distinguishable.
 */
export function collectCriteria(value, path, errors) {
  const raw = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(raw)) {
    pushInvalid(errors, path, `${path} must be an array of strings`);
    return undefined;
  }
  const collected = [];
  raw.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      pushInvalid(
        errors,
        `${path}[${index}]`,
        `${path}[${index}] must be a non-empty string`,
      );
      return;
    }
    collected.push(entry.trim());
  });
  return collected;
}

/**
 * Normalize the acceptance contract. Both PRD shapes are accepted:
 *
 * - path A (ordinary session): `["criterion", ...]` / one string;
 * - path B (SuperAgent): `{auto: [...], independent: [...]}`.
 *
 * The pack always stores the object form so the router can see whether an
 * independent verification stage is required.
 */
export function readAcceptanceInput(value, errors) {
  if (value === undefined || value === null) {
    pushInvalid(errors, 'acceptance', 'acceptance is required');
    return undefined;
  }

  if (typeof value === 'string') {
    if (!isNonEmptyString(value)) {
      pushInvalid(
        errors,
        'acceptance',
        'acceptance must contain at least one criterion',
      );
      return undefined;
    }
    return { auto: [value.trim()], independent: [] };
  }

  if (Array.isArray(value)) {
    const auto = collectCriteria(value, 'acceptance', errors);
    if (auto === undefined) return undefined;
    if (auto.length === 0) {
      pushInvalid(
        errors,
        'acceptance',
        'acceptance must contain at least one criterion',
      );
      return undefined;
    }
    return { auto: uniqueStrings(auto), independent: [] };
  }

  if (!isPlainObject(value)) {
    pushInvalid(
      errors,
      'acceptance',
      'acceptance must be a string, an array of strings, or {auto, independent}',
    );
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!ACCEPTANCE_FIELDS.includes(key)) {
      pushUnknown(errors, `acceptance.${key}`);
    }
  }

  const hasAuto = value.auto !== undefined;
  const autoPath = hasAuto ? 'acceptance.auto' : 'acceptance.criteria';
  const autoSource = hasAuto ? value.auto : value.criteria;
  const auto =
    autoSource === undefined
      ? []
      : collectCriteria(autoSource, autoPath, errors);
  const independent =
    value.independent === undefined
      ? []
      : collectCriteria(
          value.independent,
          'acceptance.independent',
          errors,
        );

  if (auto === undefined || independent === undefined) return undefined;
  if (auto.length === 0 && independent.length === 0) {
    pushInvalid(
      errors,
      'acceptance',
      'acceptance must contain at least one criterion',
    );
    return undefined;
  }
  return {
    auto: uniqueStrings(auto),
    independent: uniqueStrings(independent),
  };
}

/** Normalize `{path, base_commit}`. The path is mandatory on both paths. */
export function readWorkspaceInput(value, errors) {
  if (!isPlainObject(value)) {
    pushInvalid(errors, 'workspace', 'workspace must be an object');
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!WORKSPACE_FIELDS.includes(key) && key !== 'baseCommit') {
      pushUnknown(errors, `workspace.${key}`);
    }
  }

  if (!isNonEmptyString(value.path)) {
    pushInvalid(errors, 'workspace.path', 'workspace.path is required');
  }

  const baseSource = value.base_commit ?? value.baseCommit;
  let baseCommit;
  if (baseSource !== undefined) {
    if (!isNonEmptyString(baseSource)) {
      pushInvalid(
        errors,
        'workspace.base_commit',
        'workspace.base_commit must be a non-empty string when present',
      );
    } else {
      baseCommit = baseSource.trim();
    }
  }

  const workspace = { path: isNonEmptyString(value.path) ? value.path.trim() : undefined };
  if (baseCommit !== undefined) workspace.base_commit = baseCommit;
  return workspace;
}

/** Normalize `{cny_cap}` and enforce the schema budget ceiling. */
export function readBudgetInput(value, errors, limits = DEFAULT_BUDGET_LIMITS) {
  if (!isPlainObject(value)) {
    pushInvalid(errors, 'budget', 'budget must be an object');
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!BUDGET_FIELDS.includes(key) && key !== 'cnyCap') {
      pushUnknown(errors, `budget.${key}`);
    }
  }

  const source = value.cny_cap ?? value.cnyCap;
  if (source === undefined) {
    pushInvalid(errors, 'budget.cny_cap', 'budget.cny_cap is required');
    return undefined;
  }
  if (
    typeof source !== 'number' ||
    !Number.isFinite(source) ||
    source <= 0
  ) {
    pushInvalid(
      errors,
      'budget.cny_cap',
      'budget.cny_cap must be a positive finite number',
    );
    return undefined;
  }
  if (source > limits.cny_cap) {
    errors.push({
      code: 'budget_exceeded',
      path: 'budget.cny_cap',
      message: `budget.cny_cap ${source} exceeds the schema limit ${limits.cny_cap}`,
    });
    return undefined;
  }
  return { cny_cap: source };
}

/**
 * Normalize optional routing hints. Hints may be supplied as a `signals`
 * object or as top-level camelCase/snake_case keys; the `signals` object wins.
 * A hint is only copied when its type is valid; invalid values are errors.
 */
export function readSignalsInput(input, errors) {
  const raw = {};

  for (const [alias, canonical] of Object.entries(SIGNAL_ALIASES)) {
    if (input[alias] !== undefined) raw[canonical] = input[alias];
  }
  for (const canonical of SIGNAL_FIELDS) {
    if (input[canonical] !== undefined) raw[canonical] = input[canonical];
  }

  if (input.signals !== undefined) {
    if (!isPlainObject(input.signals)) {
      pushInvalid(errors, 'signals', 'signals must be an object');
    } else {
      for (const [key, value] of Object.entries(input.signals)) {
        const canonical = SIGNAL_ALIASES[key] ?? key;
        if (!SIGNAL_FIELDS.includes(canonical)) {
          pushUnknown(errors, `signals.${key}`);
          continue;
        }
        raw[canonical] = value;
      }
    }
  }

  const signals = {};

  if (raw.estimated_steps !== undefined) {
    if (
      !Number.isInteger(raw.estimated_steps) ||
      raw.estimated_steps < 1
    ) {
      pushInvalid(
        errors,
        'signals.estimated_steps',
        'signals.estimated_steps must be a positive integer',
      );
    } else {
      signals.estimated_steps = raw.estimated_steps;
    }
  }

  if (raw.stages !== undefined) {
    const stages = readStringList(raw.stages, 'signals.stages', errors);
    if (stages !== undefined) signals.stages = uniqueStrings(stages);
  }

  for (const field of [
    'multi_file',
    'multiple_rounds',
    'isolated_worktree',
    'long_running',
  ]) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== 'boolean') {
      pushInvalid(
        errors,
        `signals.${field}`,
        `signals.${field} must be a boolean`,
      );
      continue;
    }
    signals[field] = raw[field];
  }

  return Object.keys(signals).length > 0 ? signals : undefined;
}

/**
 * Criteria list from a pack `acceptance` value, accepting both PRD shapes.
 * Used by the router, which does not mutate or renormalize the pack.
 */
export function acceptanceIndependent(acceptance) {
  if (isPlainObject(acceptance) && Array.isArray(acceptance.independent)) {
    return acceptance.independent;
  }
  return [];
}

/** All acceptance criteria regardless of the shape (for auditing/tests). */
export function acceptanceCriteria(acceptance) {
  if (typeof acceptance === 'string') return [acceptance];
  if (Array.isArray(acceptance)) return acceptance.slice();
  if (isPlainObject(acceptance)) {
    const auto = Array.isArray(acceptance.auto)
      ? acceptance.auto
      : Array.isArray(acceptance.criteria)
        ? acceptance.criteria
        : [];
    const independent = Array.isArray(acceptance.independent)
      ? acceptance.independent
      : [];
    return [...auto, ...independent];
  }
  return [];
}
