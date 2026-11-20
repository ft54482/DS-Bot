/**
 * L1 store projection used by the e2e's cost step.
 *
 * `packages/store` owns the durable `cost_ledger`; the L6 API layer that will
 * project the L2 service state into it is not part of this ticket. The e2e
 * therefore records the usage reported by the executor against the same
 * task/run ids that the service is using, then queries the L1 ledger. No cost
 * or state-machine logic is reimplemented here.
 */

import { openStore } from '../../../packages/store/src/index.js';

const OWNER_BY_LEVEL = {
  goal: { delegator_kind: 'human', delegator_ref: 'human:e2e-owner', owner_ref: 'bot:chief' },
  business: { delegator_kind: 'chief', delegator_ref: 'bot:chief', owner_ref: 'bot:content-bot' },
  execution: { delegator_kind: 'bot', delegator_ref: 'bot:content-bot', owner_ref: 'pool:execution' },
};

// L1's run.executor_kind enum covers real executors only; the mock adapter is a
// test double, so its runs are projected as the local/manual path.
const EXECUTOR_KINDS = new Set(['tool_chain', 'dsh_session', 'superagent', 'manual']);

export function createCostLedger({ path = ':memory:' } = {}) {
  const store = openStore({ path });

  function projectTask(task) {
    const owner = OWNER_BY_LEVEL[task.level];
    if (!owner) throw new TypeError(`unsupported task level: ${task.level}`);
    return store.createTask({
      id: task.id,
      level: task.level,
      title: task.title,
      goal: task.title,
      project: 'superagent-lab-smoke',
      parent_task_id: task.parentTaskId ?? null,
      ...owner,
      acceptance_profile: task.acceptanceProfile?.id ?? null,
    });
  }

  return {
    store,
    projectTree({ goal, business, execution }) {
      projectTask(goal);
      projectTask(business);
      projectTask(execution);
    },
    projectRun(run) {
      return store.createRun({
        id: run.id,
        task_id: run.taskId,
        executor_kind: EXECUTOR_KINDS.has(run.executorKind) ? run.executorKind : 'manual',
        idempotency_key: run.idempotencyKey ?? `${run.id}:attempt-${run.attemptNo}`,
        state: run.state,
        attempt: run.attemptNo,
      });
    },
    recordUsage({ taskId, runId, usage, detail = 'mock executor usage' }) {
      return store.recordCost({
        task_id: taskId,
        run_id: runId,
        kind: 'llm',
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        tokens_cached: usage.tokens_cached,
        cost_cny: usage.cost_cny,
        detail: `${detail}:${usage.source}`,
      });
    },
    listForTask(taskId) {
      return store.listCosts(taskId);
    },
    totalForTask(taskId) {
      const total = store.listCosts(taskId).reduce(
        (accumulator, row) => ({
          tokens_in: accumulator.tokens_in + row.tokens_in,
          tokens_out: accumulator.tokens_out + row.tokens_out,
          tokens_cached: accumulator.tokens_cached + row.tokens_cached,
          cost_cny: accumulator.cost_cny + row.cost_cny,
        }),
        { tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_cny: 0 },
      );
      return { ...total, cost_cny: Number(total.cost_cny.toFixed(6)) };
    },
    close() {
      store.close();
    },
  };
}
