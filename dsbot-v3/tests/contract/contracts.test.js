/**
 * L15 cross-package contracts.
 *
 * These tests do not re-test one package in isolation (the per-package suites
 * already do that). Each contract composes the merged layers through the L9
 * runtime root and asserts the PRD semantic that must survive the combination:
 *
 *   CONTRACT-01  API state names === service state names (task/run/acceptance)
 *   CONTRACT-02  an author claim never completes a task, and never changes a
 *                completed task
 *   CONTRACT-03  the API refuses completion with 422 while acceptance has no
 *                passed items (and the raw completion guard maps to 422)
 *   CONTRACT-04  a repeated Idempotency-Key returns the first result, one row
 *   CONTRACT-05  an unverified stop stays stop_unknown, never cancelled
 *   CONTRACT-06  CLI cost totals and API/runtime cost totals use one measure
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACCEPTANCE_STATES,
  RUN_STATES,
  TASK_STATES,
} from '../../packages/service/src/states.js';
import { passedItemStates } from '../e2e/support/harness.js';
import {
  expectDeepEqual,
  expectEqual,
  expectRejects,
  expectTrue,
  contractTest,
  requestJson,
} from './support/contract.js';
import {
  EXECUTION_ITEMS,
  EXECUTION_PROFILE,
  createClock,
  createContractRuntime,
  createExecutor,
  createIds,
  createTree,
  fetchAcceptance,
  fetchRun,
  fetchTask,
  makeClaim,
  relabel,
  runCliCost,
  startRun,
} from './support/harness.js';

function stripReplayed(value) {
  const { replayed: _replayed, ...rest } = value ?? {};
  return rest;
}

function assertDeclared(id, label, state, allowed) {
  expectTrue(
    id,
    `${label}: state name is declared by packages/service`,
    allowed.includes(state),
    { expected: `one of ${allowed.join(', ')}`, actual: state },
  );
}

// ---------------------------------------------------------------------------
// CONTRACT-01
// ---------------------------------------------------------------------------
contractTest('CONTRACT-01', 'API 与 service 的状态名一致（task/run/acceptance）', async (t) => {
  const id = 'CONTRACT-01';
  const clock = createClock();
  const ctx = createContractRuntime(t, { clock: clock.now, idFactory: createIds().next });
  const { runtime } = ctx;
  const url = await ctx.apiUrl();
  const { execution } = createTree(runtime);

  async function assertTaskState(label, expected) {
    const serviceTask = runtime.service.getTask(execution.id);
    expectEqual(id, `${label}: service task.state`, serviceTask.state, expected);
    assertDeclared(id, `${label}: service task.state`, serviceTask.state, TASK_STATES);

    const response = await fetchTask(url, execution.id);
    expectEqual(id, `${label}: GET /v1/tasks/{id} status`, response.status, 200);
    expectEqual(id, `${label}: API task.state`, response.body.state, serviceTask.state);
    expectEqual(
      id,
      `${label}: API envelope task.state`,
      response.body.task.state,
      serviceTask.state,
    );
    t.diagnostic(`${id} ${label}: task.state=${serviceTask.state}`);
  }

  async function assertRunState(label, runId, expected) {
    const serviceRun = runtime.service.getRun(runId);
    expectEqual(id, `${label}: service run.state`, serviceRun.state, expected);
    assertDeclared(id, `${label}: service run.state`, serviceRun.state, RUN_STATES);

    const response = await fetchRun(url, runId);
    expectEqual(id, `${label}: GET /v1/runs/{id} status`, response.status, 200);
    expectEqual(id, `${label}: API run.state`, response.body.state, serviceRun.state);
    expectEqual(id, `${label}: API envelope run.state`, response.body.run.state, serviceRun.state);
    t.diagnostic(`${id} ${label}: run.state=${serviceRun.state}`);
  }

  async function assertAcceptanceState(label, acceptanceId, expected) {
    const serviceAcceptance = runtime.service.getAcceptance(acceptanceId);
    expectEqual(id, `${label}: service acceptance.state`, serviceAcceptance.state, expected);
    assertDeclared(
      id,
      `${label}: service acceptance.state`,
      serviceAcceptance.state,
      ACCEPTANCE_STATES,
    );

    const response = await fetchAcceptance(url, acceptanceId);
    expectEqual(id, `${label}: GET /v1/acceptances/{id} status`, response.status, 200);
    expectEqual(id, `${label}: API acceptance.state`, response.body.state, serviceAcceptance.state);
    expectEqual(
      id,
      `${label}: API envelope acceptance.state`,
      response.body.acceptance.state,
      serviceAcceptance.state,
    );
    t.diagnostic(`${id} ${label}: acceptance.state=${serviceAcceptance.state}`);
  }

  await assertTaskState('created', 'planned');

  const dispatched = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });
  await assertTaskState('after dispatch', 'queued');
  await assertRunState('after dispatch', dispatched.run.id, 'dispatched');

  await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
  await runtime.runs.ack({ runId: dispatched.run.id });
  await assertTaskState('after executor ack', 'running');
  await assertRunState('after executor ack', dispatched.run.id, 'running');

  const claimed = await runtime.runs.claim({
    runId: dispatched.run.id,
    claim: makeClaim({ nonce: 'contract-01-claim' }),
    acceptanceItems: EXECUTION_ITEMS,
  });
  await assertTaskState('after claim', 'accepting');
  await assertRunState('after claim', dispatched.run.id, 'reported');
  await assertAcceptanceState('after claim', claimed.acceptance.id, 'open');

  const revised = runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'fail' },
    reason: 'contract-01 fixture revise',
  });
  await assertTaskState('after revise', 'reworking');
  await assertRunState('after revise', dispatched.run.id, 'rejected');
  await assertAcceptanceState('after revise', claimed.acceptance.id, 'revise');
  await assertRunState('rework run after revise', revised.reworkRun.id, 'queued');
});

// ---------------------------------------------------------------------------
// CONTRACT-02
// ---------------------------------------------------------------------------
contractTest('CONTRACT-02', 'claim 不改 completed（作者自报永远不是完成）', async (t) => {
  const id = 'CONTRACT-02';
  const clock = createClock();
  const executor = createExecutor();
  const ctx = createContractRuntime(t, {
    adapters: { mock: executor.adapter },
    clock: clock.now,
    idFactory: createIds().next,
  });
  const { runtime } = ctx;
  const url = await ctx.apiUrl();
  const { execution } = createTree(runtime);
  const { run } = await startRun(runtime, execution);

  const firstClaim = await requestJson(url, `/v1/runs/${run.id}/claim`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-02-claim-initial' },
    body: {
      claim: makeClaim({ nonce: 'contract-02-initial' }),
      acceptance_items: EXECUTION_ITEMS,
    },
  });
  expectEqual(id, 'first claim: HTTP status', firstClaim.status, 200);
  expectEqual(id, 'first claim: task state', firstClaim.body.task.state, 'accepting');
  expectEqual(id, 'first claim: run state', firstClaim.body.run.state, 'reported');
  expectEqual(id, 'first claim: acceptance state', firstClaim.body.acceptance.state, 'open');
  expectTrue(
    id,
    'first claim: task is not completed',
    firstClaim.body.task.state !== 'completed',
    { expected: 'any state except completed', actual: firstClaim.body.task.state },
  );
  expectEqual(
    id,
    'first claim: service still sees accepting',
    runtime.service.getTask(execution.id).state,
    'accepting',
  );
  expectEqual(
    id,
    'first claim: no task.completed event exists',
    runtime.service.listEvents({ type: 'task.completed' }).length,
    0,
  );

  // Only the acceptance pass may complete the task.
  const acceptanceId = firstClaim.body.acceptance.id;
  const itemStates = passedItemStates(firstClaim.body.acceptance);
  const verdict = await requestJson(url, `/v1/acceptances/${acceptanceId}/verdict`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-02-pass' },
    body: { verdict: 'pass', item_states: itemStates },
  });
  expectEqual(id, 'acceptance pass: HTTP status', verdict.status, 200);
  expectEqual(id, 'acceptance pass: task state', verdict.body.task.state, 'completed');
  expectEqual(id, 'acceptance pass: acceptance state', verdict.body.acceptance.state, 'passed');
  expectEqual(id, 'acceptance pass: run state', runtime.service.getRun(run.id).state, 'accepted');
  const acceptedRun = await fetchRun(url, run.id);
  expectEqual(id, 'acceptance pass: API run state', acceptedRun.body.state, 'accepted');

  // A late claim with a fresh key is rejected and cannot move the completed task.
  const lateClaim = await requestJson(url, `/v1/runs/${run.id}/claim`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-02-claim-late' },
    body: {
      claim: makeClaim({ nonce: 'contract-02-late' }),
      acceptance_items: EXECUTION_ITEMS,
    },
  });
  expectEqual(id, 'late claim on completed task: HTTP status', lateClaim.status, 409);
  expectEqual(
    id,
    'late claim on completed task: error code',
    lateClaim.body.code,
    'invalid_state_transition',
  );
  expectEqual(
    id,
    'late claim: service task stays completed',
    runtime.service.getTask(execution.id).state,
    'completed',
  );
  const after = await fetchTask(url, execution.id);
  expectEqual(id, 'late claim: API task stays completed', after.body.state, 'completed');
  expectEqual(id, 'late claim: exactly one task.completed event', runtime.service.listEvents({ type: 'task.completed' }).length, 1);
});

// ---------------------------------------------------------------------------
// CONTRACT-03
// ---------------------------------------------------------------------------
contractTest('CONTRACT-03', '无验收 pass 时 API 返回 422', async (t) => {
  const id = 'CONTRACT-03';
  const clock = createClock();
  const executor = createExecutor();
  const ctx = createContractRuntime(t, {
    adapters: { mock: executor.adapter },
    clock: clock.now,
    idFactory: createIds().next,
  });
  const { runtime } = ctx;
  const url = await ctx.apiUrl();
  const { execution } = createTree(runtime);
  const { run } = await startRun(runtime, execution);

  const claimed = await runtime.runs.claim({
    runId: run.id,
    claim: makeClaim({ nonce: 'contract-03-claim' }),
    acceptanceItems: EXECUTION_ITEMS,
  });
  expectEqual(id, 'setup: task accepting', claimed.task.state, 'accepting');

  // Asking the API for a passing verdict while required items are still pending
  // must be refused with 422, not silently complete the task.
  const refused = await requestJson(
    url,
    `/v1/acceptances/${claimed.acceptance.id}/verdict`,
    {
      method: 'POST',
      headers: { 'idempotency-key': 'contract-03-pass-without-items' },
      body: { verdict: 'pass' },
    },
  );
  expectEqual(id, 'pass without item evidence: HTTP status', refused.status, 422);
  expectEqual(
    id,
    'pass without item evidence: error code',
    refused.body.code,
    'acceptance_incomplete',
  );
  expectEqual(
    id,
    'pass without item evidence: service task untouched',
    runtime.service.getTask(execution.id).state,
    'accepting',
  );
  expectEqual(
    id,
    'pass without item evidence: no task.completed event',
    runtime.service.listEvents({ type: 'task.completed' }).length,
    0,
  );

  // The raw completion guard is the same semantic, mapped to the PRD's 422.
  const error = await expectRejects(
    id,
    'service.completeTask without a passed acceptance',
    () => runtime.service.completeTask({ taskId: execution.id }),
    { code: 'missing_acceptance', status: 422 },
  );
  expectEqual(id, 'missing_acceptance HTTP mapping', error.status, 422);
  expectEqual(
    id,
    'completion guard: task remains accepting',
    runtime.service.getTask(execution.id).state,
    'accepting',
  );
});

// ---------------------------------------------------------------------------
// CONTRACT-04
// ---------------------------------------------------------------------------
contractTest('CONTRACT-04', '重复 Idempotency-Key 返回同一结果，只落一次', async (t) => {
  const id = 'CONTRACT-04';
  const clock = createClock();
  const ctx = createContractRuntime(t, { clock: clock.now, idFactory: createIds().next });
  const { runtime } = ctx;
  const url = await ctx.apiUrl();

  const createBody = {
    level: 'goal',
    title: 'contract-04 idempotent goal',
    acceptance: [{ key: 'auto.contract', class: 'auto' }],
  };
  const firstCreate = await requestJson(url, '/v1/tasks', {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-04-create' },
    body: createBody,
  });
  expectEqual(id, 'first create: HTTP status', firstCreate.status, 201);
  const goalId = firstCreate.body.id;
  expectTrue(id, 'first create: task id exists', typeof goalId === 'string' && goalId !== '');

  const secondCreate = await requestJson(url, '/v1/tasks', {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-04-create' },
    body: createBody,
  });
  expectEqual(id, 'replayed create: HTTP status', secondCreate.status, 201);
  expectEqual(id, 'replayed create: replayed flag', secondCreate.body.replayed, true);
  expectEqual(
    id,
    'replayed create: idempotency-replayed header',
    secondCreate.headers.get('idempotency-replayed'),
    'true',
  );
  expectDeepEqual(
    id,
    'replayed create: same result body',
    stripReplayed(secondCreate.body),
    stripReplayed(firstCreate.body),
  );
  expectEqual(
    id,
    'replayed create: only one task row',
    runtime.service.store.listTasks().filter((task) => task.level === 'goal').length,
    1,
  );

  // Same contract on the dispatch write path, where a duplicate must not create
  // a second run.
  const business = runtime.tasks.delegate({
    parentTaskId: goalId,
    title: 'contract-04 business',
  });
  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: 'contract-04 execution',
    acceptanceProfile: EXECUTION_PROFILE,
  });
  const dispatchBody = { executor_kind: 'manual', actor: 'scheduler' };

  const firstDispatch = await requestJson(url, `/v1/tasks/${execution.id}/dispatch`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-04-dispatch' },
    body: dispatchBody,
  });
  expectEqual(id, 'first dispatch: HTTP status', firstDispatch.status, 200);
  expectEqual(id, 'first dispatch: run state', firstDispatch.body.run.state, 'dispatched');

  const secondDispatch = await requestJson(url, `/v1/tasks/${execution.id}/dispatch`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-04-dispatch' },
    body: dispatchBody,
  });
  expectEqual(id, 'replayed dispatch: HTTP status', secondDispatch.status, 200);
  expectEqual(id, 'replayed dispatch: replayed flag', secondDispatch.body.replayed, true);
  expectEqual(
    id,
    'replayed dispatch: same run id',
    secondDispatch.body.run_id,
    firstDispatch.body.run_id,
  );
  expectDeepEqual(
    id,
    'replayed dispatch: same result body',
    stripReplayed(secondDispatch.body),
    stripReplayed(firstDispatch.body),
  );
  expectEqual(
    id,
    'replayed dispatch: only one run row',
    runtime.service.listRuns({ taskId: execution.id }).length,
    1,
  );

  // Same key with a different payload is a conflict, not a replay.
  const conflicting = await requestJson(url, `/v1/tasks/${execution.id}/dispatch`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-04-dispatch' },
    body: { executor_kind: 'manual', actor: 'other-scheduler' },
  });
  expectEqual(id, 'same key different payload: HTTP status', conflicting.status, 409);
  expectEqual(
    id,
    'same key different payload: error code',
    conflicting.body.code,
    'duplicate_dispatch',
  );
  expectEqual(
    id,
    'same key different payload: still one run row',
    runtime.service.listRuns({ taskId: execution.id }).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// CONTRACT-05
// ---------------------------------------------------------------------------
contractTest('CONTRACT-05', 'stop 未核实返回 stop_unknown，不冒充 cancelled', async (t) => {
  const id = 'CONTRACT-05';
  const clock = createClock();
  const executor = createExecutor({ cancelVerification: 'unverified', completeAt: 60_000 });
  const ctx = createContractRuntime(t, {
    adapters: { mock: executor.adapter },
    clock: clock.now,
    idFactory: createIds().next,
    quiescenceMs: 5000,
  });
  const { runtime, dir } = ctx;
  const url = await ctx.apiUrl();
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'article.md'), '# still running\n', 'utf8');

  const { goal, execution } = createTree(runtime);
  const { run } = await startRun(runtime, execution);
  expectEqual(id, 'setup: run is active', runtime.service.getRun(run.id).state, 'running');

  const stopped = await runtime.stop.stop({
    taskId: goal.id,
    workspacePath: workspace,
    requestedBy: 'human',
    reason: 'user_stop',
  });
  expectEqual(id, 'runtime stop: cancelled flag', stopped.cancelled, false);
  expectEqual(id, 'runtime stop: stop_state', stopped.stopState, 'stop_unknown');
  expectTrue(
    id,
    'runtime stop: blocker names the still-alive process',
    stopped.blockers.some(
      (blocker) => blocker.runId === run.id && blocker.reasons.includes('process_still_alive'),
    ),
    { expected: `blocker for ${run.id} with process_still_alive`, actual: stopped.blockers },
  );
  expectEqual(id, 'runtime stop: task stays stopping', runtime.tasks.get(goal.id).state, 'stopping');
  expectEqual(id, 'runtime stop: task.stopUnknown', runtime.tasks.get(goal.id).stopUnknown, true);
  expectEqual(id, 'runtime stop: run still running', runtime.service.getRun(run.id).state, 'running');

  // The same fail-closed verdict survives the HTTP API when no verification
  // evidence is supplied.
  const httpStop = await requestJson(url, `/v1/tasks/${goal.id}/stop`, {
    method: 'POST',
    headers: { 'idempotency-key': 'contract-05-http-stop' },
    body: { verifications: [] },
  });
  expectEqual(id, 'HTTP stop: status', httpStop.status, 202);
  expectEqual(id, 'HTTP stop: stop_state', httpStop.body.stop_state, 'stop_unknown');
  expectEqual(id, 'HTTP stop: verified flag', httpStop.body.verified, false);
  expectEqual(id, 'HTTP stop: task state', httpStop.body.task.state, 'stopping');
  expectEqual(id, 'HTTP stop: task.stopUnknown', httpStop.body.task.stopUnknown, true);

  const after = await fetchTask(url, goal.id);
  expectEqual(id, 'HTTP stop: API task state', after.body.state, 'stopping');
  expectEqual(id, 'HTTP stop: API task.stop_state', after.body.stopState, 'stop_unknown');
  expectEqual(id, 'HTTP stop: API task.stopUnknown', after.body.stopUnknown, true);
  expectEqual(
    id,
    'HTTP stop: no task.cancelled event',
    runtime.service.listEvents({ type: 'task.cancelled' }).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// CONTRACT-06
// ---------------------------------------------------------------------------
contractTest('CONTRACT-06', 'CLI 与 API/runtime 的 cost 口径一致', async (t) => {
  const id = 'CONTRACT-06';
  const clock = createClock();
  const initialUsage = { tokens_in: 1200, tokens_out: 800, tokens_cached: 200, cost_cny: 0.12 };
  const reworkUsage = { tokens_in: 900, tokens_out: 700, tokens_cached: 100, cost_cny: 0.18 };
  const initial = createExecutor({ usage: initialUsage });
  const rework = createExecutor({ usage: reworkUsage });

  const ctx = createContractRuntime(t, {
    adapters: {
      mock: initial.adapter,
      dsh_session: relabel(rework.adapter, 'dsh_session'),
    },
    clock: clock.now,
    idFactory: createIds().next,
  });
  const { runtime, dbPath } = ctx;
  const { execution } = createTree(runtime);

  const first = await startRun(runtime, execution);
  const claimedInitial = await runtime.runs.claim({
    runId: first.run.id,
    claim: makeClaim({ nonce: 'contract-06-initial' }),
    acceptanceItems: EXECUTION_ITEMS,
  });
  expectEqual(id, 'initial run: usage captured', claimedInitial.cost.recorded, true);
  expectEqual(id, 'initial run: cost_cny', claimedInitial.cost.cost.costCny, initialUsage.cost_cny);

  const revised = runtime.acceptances.decide({
    acceptanceId: claimedInitial.acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'fail' },
    reason: 'contract-06 fixture revise',
  });
  const reworkRunId = revised.reworkRun.id;
  expectEqual(id, 'rework run: queued', runtime.service.getRun(reworkRunId).state, 'queued');

  const dispatchedRework = runtime.tasks.dispatch({ taskId: execution.id });
  expectEqual(id, 'rework dispatch: same derived run', dispatchedRework.run.id, reworkRunId);
  const acceptedRework = await runtime.runs.dispatchToExecutor({ runId: reworkRunId });
  expectEqual(id, 'rework adapter accepted', acceptedRework.accepted, true);
  runtime.runs.ack({ runId: reworkRunId });
  const claimedRework = await runtime.runs.claim({
    runId: reworkRunId,
    claim: makeClaim({ nonce: 'contract-06-rework' }),
    acceptanceItems: EXECUTION_ITEMS,
  });
  expectEqual(id, 'rework run: usage captured', claimedRework.cost.recorded, true);
  expectEqual(id, 'rework run: cost_cny', claimedRework.cost.cost.costCny, reworkUsage.cost_cny);

  const expected = {
    taskId: execution.id,
    entries: 2,
    tokensIn: initialUsage.tokens_in + reworkUsage.tokens_in,
    tokensOut: initialUsage.tokens_out + reworkUsage.tokens_out,
    tokensCached: initialUsage.tokens_cached + reworkUsage.tokens_cached,
    costCny: Number((initialUsage.cost_cny + reworkUsage.cost_cny).toFixed(6)),
  };
  const apiTotal = runtime.cost.total(execution.id);
  expectDeepEqual(id, 'API/runtime cost.total task total', apiTotal, expected);

  const rows = runtime.cost.list(execution.id);
  expectEqual(id, 'cost ledger row count', rows.length, expected.entries);
  const rowSum = rows.reduce(
    (total, row) => ({
      tokensIn: total.tokensIn + row.tokensIn,
      tokensOut: total.tokensOut + row.tokensOut,
      tokensCached: total.tokensCached + row.tokensCached,
      costCny: total.costCny + row.costCny,
    }),
    { tokensIn: 0, tokensOut: 0, tokensCached: 0, costCny: 0 },
  );
  expectDeepEqual(
    id,
    'cost.total equals the sum of ledger rows (no double billing)',
    {
      tokensIn: rowSum.tokensIn,
      tokensOut: rowSum.tokensOut,
      tokensCached: rowSum.tokensCached,
      costCny: Number(rowSum.costCny.toFixed(6)),
    },
    {
      tokensIn: expected.tokensIn,
      tokensOut: expected.tokensOut,
      tokensCached: expected.tokensCached,
      costCny: expected.costCny,
    },
  );

  const cli = runCliCost(dbPath, execution.id);
  if (cli.status !== 0) {
    throw new Error(
      `[${id}] CLI cost exited ${cli.status} (signal=${cli.signal})\n  stderr: ${cli.stderr}\n  stdout: ${cli.stdout}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(cli.stdout);
  } catch {
    throw new Error(`[${id}] CLI cost did not emit JSON\n  actual: ${cli.stdout}`);
  }
  expectEqual(id, 'CLI cost: ok flag', payload.ok, true);
  expectEqual(id, 'CLI cost: command', payload.command, 'cost');
  const data = payload.data;
  expectEqual(id, 'CLI cost: task_id', data.task_id, execution.id);
  expectEqual(id, 'CLI cost: tokens_in', data.tokens_in, apiTotal.tokensIn);
  expectEqual(id, 'CLI cost: tokens_out', data.tokens_out, apiTotal.tokensOut);
  expectEqual(id, 'CLI cost: tokens_cached', data.tokens_cached, apiTotal.tokensCached);
  expectEqual(id, 'CLI cost: cost_cny', data.cost_cny, apiTotal.costCny);
  expectEqual(id, 'CLI cost: entry_count', data.entry_count, apiTotal.entries);
  t.diagnostic(
    `${id} CLI cost=${data.cost_cny} CNY entries=${data.entry_count} matches runtime.cost.total`,
  );
});
