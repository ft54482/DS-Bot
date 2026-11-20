import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_USAGE, createClock, createExecutor, openAcceptingRun } from './support/harness.js';

test('cost: claim projects executor usage into the ledger and totals it', async (t) => {
  const { runtime, tree, run, claimed } = await openAcceptingRun(t);

  assert.equal(claimed.cost.recorded, true);
  assert.equal(claimed.cost.cost.runId, run.id);
  assert.equal(claimed.cost.cost.kind, 'llm');
  assert.equal(claimed.cost.cost.tokensIn, TEST_USAGE.tokens_in);
  assert.equal(claimed.cost.cost.tokensOut, TEST_USAGE.tokens_out);
  assert.equal(claimed.cost.cost.tokensCached, TEST_USAGE.tokens_cached);
  assert.equal(claimed.cost.cost.costCny, TEST_USAGE.cost_cny);

  const rows = runtime.cost.list(tree.execution.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, `cost-${run.id}`);
  assert.deepEqual(runtime.cost.forRun(run.id), rows);
  assert.deepEqual(runtime.cost.total(tree.execution.id), {
    taskId: tree.execution.id,
    entries: 1,
    tokensIn: TEST_USAGE.tokens_in,
    tokensOut: TEST_USAGE.tokens_out,
    tokensCached: TEST_USAGE.tokens_cached,
    costCny: TEST_USAGE.cost_cny,
  });

  // Non-executor costs (for example an independent review) aggregate too.
  const reviewCost = runtime.cost.record({
    taskId: tree.execution.id,
    kind: 'acceptance',
    tokensIn: 50,
    costCny: 0.03,
    detail: 'independent review',
  });
  assert.equal(reviewCost.kind, 'acceptance');
  assert.equal(reviewCost.runId, null);
  assert.deepEqual(runtime.cost.total(tree.execution.id), {
    taskId: tree.execution.id,
    entries: 2,
    tokensIn: TEST_USAGE.tokens_in + 50,
    tokensOut: TEST_USAGE.tokens_out,
    tokensCached: TEST_USAGE.tokens_cached,
    costCny: 0.15,
  });
});

test('cost: recapturing an already billed run does not double-bill', async (t) => {
  const { runtime, tree, run } = await openAcceptingRun(t);

  const recaptured = await runtime.cost.captureRunUsage(run.id);

  assert.equal(recaptured.recorded, false);
  assert.equal(recaptured.reason, 'already_recorded');
  assert.equal(recaptured.cost.id, `cost-${run.id}`);
  assert.equal(runtime.cost.list(tree.execution.id).length, 1);
  assert.equal(runtime.cost.total(tree.execution.id).entries, 1);
});

test('cost: an unavailable usage report is never invented as zero cost', async (t) => {
  const clock = createClock();
  const { adapter } = createExecutor({ clock });
  const unavailable = {
    ...adapter,
    usage: async ({ run_id }) => ({ ok: false, source: 'unavailable', run_id }),
  };
  const context = await openAcceptingRun(t, { clock, adapter: unavailable });

  assert.equal(context.claimed.cost.recorded, false);
  assert.equal(context.claimed.cost.reason, 'usage_unavailable');
  assert.equal(context.claimed.cost.cost, null);
  // The state transition still completed; cost capture never blocks a claim.
  assert.equal(context.claimed.run.state, 'reported');
  assert.equal(context.claimed.task.state, 'accepting');
  assert.equal(context.runtime.cost.list(context.tree.execution.id).length, 0);
});
