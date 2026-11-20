/**
 * Pure in-memory cost ledger.
 *
 * One row is written per run (`taskId` + `runId` + `tokens` + `cny`); repeated
 * runs on the same task accumulate. All amounts are CNY and negative amounts
 * (refunds) are rejected. When a cap is configured, a recording that would push
 * the task over the cap is refused atomically: the failed record leaves the
 * ledger untouched.
 *
 * PRD: `docs/prd/04-reliability-ops.md` §4 (cost attribution) and
 * `docs/prd/02-api-contract.md` §4.2 (min-chain budget gate).
 */

import { COST_CODES, COST_CURRENCY } from './constants.js';
import { costError } from './errors.js';
import {
  EPSILON,
  assertPlainObject,
  readAmount,
  readCap,
  readId,
  readTokenCount,
  roundCny,
} from './values.js';

/**
 * @typedef {object} LedgerOptions
 * @property {number|null} [capCny] default per-task cap; `null`/`Infinity` means uncapped
 */

/**
 * Create an empty ledger. No IO, no clock, no shared state between instances.
 *
 * @param {LedgerOptions} [options]
 */
export function createLedger(options = {}) {
  assertPlainObject(options, 'createLedger options');

  const defaultCapCny = readCap(options.capCny, 'capCny');
  /** @type {Map<string, object[]>} */
  const rowsByTask = new Map();
  /** @type {Map<string, object>} */
  const rowByRun = new Map();
  /** @type {Map<string, number>} */
  const capsByTask = new Map();
  let nextSequence = 1;

  function rowsFor(taskId) {
    return rowsByTask.get(taskId) ?? [];
  }

  function capFor(taskId) {
    const taskCap = capsByTask.has(taskId)
      ? capsByTask.get(taskId)
      : Number.POSITIVE_INFINITY;
    return Math.min(defaultCapCny, taskCap);
  }

  /**
   * Sum tokens and CNY across every recorded run of a task.
   *
   * @param {string} taskId
   * @returns {{taskId: string, tokens: number, cny: number, runs: number}}
   */
  function totals(taskId) {
    readId(taskId, 'taskId');
    const rows = rowsFor(taskId);
    let tokens = 0;
    let cny = 0;
    for (const row of rows) {
      tokens += row.tokens;
      cny += row.cny;
    }
    return Object.freeze({ taskId, tokens, cny: roundCny(cny), runs: rows.length });
  }

  /**
   * Record one run's cost.
   *
   * @param {{taskId: string, runId: string, tokens: number, cny: number, currency?: string}} input
   * @returns {Readonly<{sequence: number, taskId: string, runId: string, tokens: number, cny: number, currency: 'CNY', totals: object}>}
   * @throws {import('./errors.js').CostError} invalid input, duplicate run or over-cap refusal
   */
  function record(input = {}) {
    assertPlainObject(input, 'record input');

    const taskId = readId(input.taskId, 'taskId');
    const runId = readId(input.runId, 'runId');
    const tokens = readTokenCount(input.tokens);
    const cny = readAmount(input.cny, 'cny');
    const currency = input.currency === undefined ? COST_CURRENCY : input.currency;

    if (currency !== COST_CURRENCY) {
      throw costError(
        COST_CODES.INVALID_CURRENCY,
        `cost ledger is CNY-only; received ${String(currency)}`,
        { currency },
      );
    }

    if (rowByRun.has(runId)) {
      throw costError(
        COST_CODES.DUPLICATE_RUN,
        `run ${runId} is already recorded; a run is billed exactly once`,
        { runId },
      );
    }

    const current = totals(taskId);
    const cap = capFor(taskId);
    const attempted = roundCny(current.cny + cny);

    if (attempted - cap > EPSILON) {
      throw costError(
        COST_CODES.BUDGET_EXCEEDED,
        `recording ${cny} CNY for ${taskId} would spend ${attempted} CNY against a ${cap} CNY cap`,
        { taskId, runId, cap, spent: current.cny, cny, attempted },
      );
    }

    const row = Object.freeze({
      sequence: nextSequence,
      taskId,
      runId,
      tokens,
      cny,
      currency: COST_CURRENCY,
    });
    nextSequence += 1;

    const rows = rowsFor(taskId);
    rows.push(row);
    rowsByTask.set(taskId, rows);
    rowByRun.set(runId, row);

    return Object.freeze({ ...row, totals: totals(taskId) });
  }

  /**
   * Total CNY spent by a task (0 for a task that has no rows yet).
   *
   * @param {string} taskId
   * @returns {number}
   */
  function spent(taskId) {
    return totals(taskId).cny;
  }

  /**
   * Remaining CNY under `cap`, clamped at zero. The ledger's own task cap also
   * applies, so the result never promises budget the ledger would refuse.
   *
   * @param {string} taskId
   * @param {number|null} [cap] cap to check; omitted means the ledger's cap
   * @returns {number} `Infinity` when uncapped
   */
  function remaining(taskId, cap) {
    readId(taskId, 'taskId');
    const requestedCap = cap === undefined ? Number.POSITIVE_INFINITY : readCap(cap, 'cap');
    const effectiveCap = Math.min(requestedCap, capFor(taskId));
    if (!Number.isFinite(effectiveCap)) return Number.POSITIVE_INFINITY;
    return Math.max(0, roundCny(effectiveCap - totals(taskId).cny));
  }

  /**
   * Lower or clear the cap for one task. The effective cap is the smaller of
   * this per-task cap and the ledger default.
   *
   * @param {string} taskId
   * @param {number|null} capCny `null` clears the task cap
   * @returns {number} effective cap after the change (`Infinity` when uncapped)
   */
  function setCap(taskId, capCny) {
    readId(taskId, 'taskId');
    if (capCny === undefined || capCny === null || capCny === Number.POSITIVE_INFINITY) {
      capsByTask.delete(taskId);
    } else {
      capsByTask.set(taskId, readCap(capCny, 'capCny'));
    }
    return capFor(taskId);
  }

  /**
   * Effective cap for a task (the smaller of its cap and the ledger default).
   *
   * @param {string} taskId
   * @returns {number}
   */
  function capOf(taskId) {
    readId(taskId, 'taskId');
    return capFor(taskId);
  }

  /**
   * Recorded rows for a task, copied so callers cannot mutate ledger state.
   *
   * @param {string} taskId
   * @returns {ReadonlyArray<Readonly<object>>}
   */
  function entries(taskId) {
    readId(taskId, 'taskId');
    return Object.freeze(rowsFor(taskId).map((row) => Object.freeze({ ...row })));
  }

  /**
   * Look up the row billed for a run, or `null`.
   *
   * @param {string} runId
   * @returns {Readonly<object>|null}
   */
  function entry(runId) {
    readId(runId, 'runId');
    const row = rowByRun.get(runId);
    return row ? Object.freeze({ ...row }) : null;
  }

  return Object.freeze({
    record,
    spent,
    remaining,
    totals,
    setCap,
    capOf,
    entries,
    entry,
  });
}
