import { HARD_CAPS, LEVELS } from './constants.js';
import { isRecord } from './normalize.js';

/**
 * Deterministic, dependency-free token estimate: one token per four UTF-8
 * bytes, rounded up. This is deliberately labelled an estimate. Callers that
 * need an exact count pass their own `countTokens` function; every budget
 * decision in this package uses whichever counter is injected.
 */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return Math.ceil(bytes / 4);
}

export function resolveTokenCounter(countTokens) {
  if (countTokens === undefined || countTokens === null) return estimateTokens;
  if (typeof countTokens !== 'function') {
    throw new TypeError('`countTokens` must be a function when provided');
  }
  return countTokens;
}

/**
 * Measure a whole pack with the injected counter. The pack is serialized with
 * JSON.stringify exactly once per measurement, so the number a caller can
 * reproduce is the number the assembler used for trimming.
 */
export function measurePack(pack, countTokens = estimateTokens) {
  const counter = resolveTokenCounter(countTokens);
  const serialized = JSON.stringify(pack);
  if (serialized === undefined) {
    throw new TypeError('context pack must be JSON-serializable');
  }
  const counted = Number(counter(serialized));
  if (!Number.isFinite(counted) || counted < 0) {
    throw new TypeError('`countTokens` must return a non-negative finite number');
  }
  return Math.ceil(counted);
}

function numericBudget(value, label) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number of tokens`);
  }
  return Math.floor(value);
}

/**
 * Resolve the effective token budget for one layer.
 *
 * `budgets` may be a positive number (applies to the requested layer) or an
 * object keyed by layer (`goal`, `business`, `execution`; `executor` is
 * accepted as an execution alias). PRD hard caps are ceilings: configuring a
 * larger goal/business budget is clamped, never honoured beyond the PRD.
 * Execution has no PRD cap, so its budget is required.
 */
export function resolveBudget(level, budgets) {
  if (!LEVELS.includes(level)) {
    throw new TypeError(`\`level\` must be one of ${LEVELS.join(', ')}`);
  }

  let configured;
  if (typeof budgets === 'number' || typeof budgets === 'string') {
    configured = budgets;
  } else if (budgets === undefined || budgets === null) {
    configured = undefined;
  } else if (isRecord(budgets)) {
    configured = budgets[level];
    if (
      level === 'execution' &&
      (configured === undefined || configured === null)
    ) {
      configured = budgets.executor;
    }
  } else {
    throw new TypeError('`budgets` must be a number or an object keyed by level');
  }

  if (configured === undefined || configured === null) {
    const fallback = HARD_CAPS[level];
    if (fallback === undefined) {
      throw new TypeError(
        'execution contexts have no PRD-wide cap: pass budgets.execution',
      );
    }
    configured = fallback;
  }

  const requested = numericBudget(configured, `budgets.${level}`);
  const cap = HARD_CAPS[level];
  const limit = cap === undefined ? requested : Math.min(requested, cap);

  return {
    level,
    limit,
    requested,
    capped: cap !== undefined && requested > cap,
  };
}
