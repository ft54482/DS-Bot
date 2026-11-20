import { COST_KINDS } from '../../store/src/index.js';
import { serviceError } from '../../service/src/errors.js';

/**
 * Cost accounting for the runtime.
 *
 * The durable ledger is the L1 store's append-only `cost_ledger`; this module
 * only projects executor `usage` reports into it and exposes a small query
 * surface. It never invents a cost: an adapter that cannot report usage is
 * recorded as `usage_unavailable` instead of zero-filled.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const round6 = (value) => Number(value.toFixed(6));

function nonNegativeNumber(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw serviceError('validation_error', `cost ${field} must be a non-negative finite number`, {
      field,
      value,
    });
  }
  return number;
}

function nonNegativeInteger(value, field) {
  return Math.trunc(nonNegativeNumber(value, field));
}

function toPublicRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    costCny: row.cost_cny,
    at: row.at,
    detail: row.detail,
  };
}

function usageFields(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const pick = (snake, camel) => usage[snake] ?? usage[camel];
  return {
    tokensIn: pick('tokens_in', 'tokensIn'),
    tokensOut: pick('tokens_out', 'tokensOut'),
    tokensCached: usage.tokens_cached ?? usage.tokensCached,
    costCny: pick('cost_cny', 'costCny'),
  };
}

/**
 * @param {object} options
 * @param {object} options.store opened `packages/store` Store (owns cost_ledger)
 * @param {() => number} [options.clock]
 * @param {(runId: string) => object} [options.resolveRun] service lookup used by capture
 * @param {(kind: string) => object|null} [options.resolveAdapter] adapter registry lookup
 */
export function createCostLedger({
  store,
  clock = () => Date.now(),
  resolveRun = null,
  resolveAdapter = null,
} = {}) {
  if (!store) throw new TypeError('createCostLedger requires an opened store');

  function record({
    id,
    taskId,
    runId = null,
    kind = 'llm',
    tokensIn,
    tokensOut,
    tokensCached,
    costCny,
    usage = null,
    detail = null,
    at = null,
  } = {}) {
    if (typeof taskId !== 'string' || taskId === '') {
      throw serviceError('validation_error', 'cost.record requires taskId');
    }
    if (!COST_KINDS.includes(kind)) {
      throw serviceError('validation_error', `unknown cost kind: ${kind}`, {
        kind,
        allowed: COST_KINDS,
      });
    }
    const fromUsage = usageFields(usage);
    const row = store.recordCost({
      id,
      task_id: taskId,
      run_id: runId ?? null,
      kind,
      tokens_in: nonNegativeInteger(tokensIn ?? fromUsage.tokensIn, 'tokensIn'),
      tokens_out: nonNegativeInteger(tokensOut ?? fromUsage.tokensOut, 'tokensOut'),
      tokens_cached: nonNegativeInteger(tokensCached ?? fromUsage.tokensCached, 'tokensCached'),
      cost_cny: nonNegativeNumber(costCny ?? fromUsage.costCny, 'costCny'),
      at: at ?? clock(),
      detail: detail ?? null,
    });
    return toPublicRow(row);
  }

  function list(taskId, { limit = 100 } = {}) {
    if (typeof taskId !== 'string' || taskId === '') {
      throw serviceError('validation_error', 'cost.list requires taskId');
    }
    return store.listCosts(taskId, { limit }).map(toPublicRow);
  }

  function total(taskId) {
    const rows = list(taskId, { limit: 1_000_000 });
    const total = rows.reduce(
      (accumulator, row) => ({
        tokensIn: accumulator.tokensIn + row.tokensIn,
        tokensOut: accumulator.tokensOut + row.tokensOut,
        tokensCached: accumulator.tokensCached + row.tokensCached,
        costCny: accumulator.costCny + row.costCny,
      }),
      { tokensIn: 0, tokensOut: 0, tokensCached: 0, costCny: 0 },
    );
    return {
      taskId,
      entries: rows.length,
      tokensIn: total.tokensIn,
      tokensOut: total.tokensOut,
      tokensCached: total.tokensCached,
      costCny: round6(total.costCny),
    };
  }

  function forRun(runId) {
    if (!resolveRun) throw new TypeError('cost.forRun requires a run resolver');
    const run = resolveRun(runId);
    return list(run.taskId, { limit: 1_000_000 }).filter((row) => row.runId === runId);
  }

  /**
   * Capture the usage an executor adapter reports for one run.
   *
   * The ledger row id is derived from the run id, so a repeated capture (for
   * example after a restart, or when the claim response is retried) returns
   * the existing row instead of double-billing the run.
   */
  async function captureRunUsage(runId, { kind = 'llm', detail = null } = {}) {
    if (!resolveRun) throw new TypeError('cost.captureRunUsage requires a run resolver');
    const run = resolveRun(runId);
    const adapter = resolveAdapter ? resolveAdapter(run.executorKind) : null;
    if (!adapter || typeof adapter.usage !== 'function') {
      return { recorded: false, reason: 'executor_unavailable', runId, cost: null };
    }
    const usage = await adapter.usage({ run_id: runId });
    if (!usage || usage.ok === false || usage.source === 'unavailable') {
      return {
        recorded: false,
        reason: 'usage_unavailable',
        runId,
        usage: usage ? clone(usage) : null,
        cost: null,
      };
    }
    const id = `cost-${runId}`;
    const existing = list(run.taskId, { limit: 1_000_000 }).find((row) => row.id === id) ?? null;
    if (existing) {
      return { recorded: false, reason: 'already_recorded', runId, cost: existing };
    }
    const cost = record({
      id,
      taskId: run.taskId,
      runId,
      kind,
      usage,
      detail: detail ?? `executor_usage:${usage.source ?? adapter.kind ?? 'unknown'}`,
    });
    return { recorded: true, reason: null, runId, cost, usage: clone(usage) };
  }

  return { record, list, total, forRun, captureRunUsage };
}
