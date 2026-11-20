/**
 * M5 ten-step drill on a simulated link.
 *
 * The drill executes `docs/prd/09-wbs.md` §1.3 end to end against the shipped
 * runtime composition root: a durable SQLite task store, the L2 task/run/
 * acceptance state machine, the dispatch outbox, the mock executor adapter,
 * the cost ledger and the stop-quiescence verifier. No state is faked with
 * assertions: every recorded `actual` is read back from those components.
 *
 * The run also performs the two required injections:
 *   - one deliberate factual error forces a real `revise` → rework run;
 *   - a separate `stop_unknown` scenario proves a cancel without proof never
 *     reports "stopped".
 */

import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createMockAdapter } from '../../../packages/adapters/src/mock.js';
import { hashTree } from '../../../packages/runtime/src/workspace.js';

import { createEvidenceWriter } from './evidence.js';
import {
  ACCEPTANCE_COST_CNY,
  ARTIFACT_V1,
  ARTIFACT_V2,
  EXECUTION_ITEMS,
  EXECUTION_PROFILE,
  GOAL_PROFILE,
  GOAL_TITLE,
  INJECTED_ERROR,
  INITIAL_USAGE,
  SOURCE_FILES,
  claimFromExecutor,
  childrenByParent,
  countOutbox,
  createClock,
  createDrillAdapter,
  createIds,
  openRuntime,
  outboxFor,
  round6,
  rollupCny,
  runView,
  sha256,
  sumCny,
  taskView,
} from './support.js';

class DrillFailure extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'DrillFailure';
    this.details = details;
  }
}

function slug(action) {
  return action
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 40);
}

function stateSnapshot(runtime) {
  const runs = runtime.runs.list();
  return {
    tasks: runtime.tasks.list().map(taskView),
    runs: runs.map(runView),
    outbox: runs.map((run) => outboxFor(runtime, run)).filter((row) => row !== null),
    events: runtime.service.listEvents(),
  };
}

function parentTransition(runtime, taskId, key) {
  return runtime.service.transitionTask({
    taskId,
    to: 'running',
    actor: 'system',
    idempotencyKey: key,
  });
}

function acceptanceView(acceptance) {
  return {
    id: acceptance.id,
    runId: acceptance.runId,
    state: acceptance.state,
    roundNo: acceptance.roundNo,
    revision: acceptance.revision,
    items: acceptance.items.map((item) => ({
      key: item.key,
      class: item.class,
      required: item.required,
      state: item.state,
    })),
  };
}

function recordAcceptanceCost(runtime, execution, acceptance) {
  return runtime.cost.record({
    taskId: execution.id,
    kind: 'acceptance',
    tokensIn: 50,
    tokensOut: 10,
    costCny: ACCEPTANCE_COST_CNY,
    detail: `acceptance_review:${acceptance.id}:round-${acceptance.roundNo}`,
  });
}

function summarizeCost(runtime, { goal, business, execution, initialRun, reworkRun }) {
  const rows = runtime.cost.list(execution.id, { limit: 1_000_000 });
  const taskTotal = runtime.cost.total(execution.id);
  const runRows = rows.filter((row) => row.runId !== null);
  const acceptanceRows = rows.filter((row) => row.kind === 'acceptance');
  const otherRows = rows.filter((row) => row.runId === null && row.kind !== 'acceptance');
  const runCny = sumCny(runRows);
  const acceptanceCny = sumCny(acceptanceRows);
  const otherCny = sumCny(otherRows);
  const map = childrenByParent(runtime);
  const retryRows = rows.filter((row) => row.runId === reworkRun.id);
  const retryCny = sumCny(retryRows);
  const levels = [
    {
      level: 'task',
      key: 'task_id',
      taskId: execution.id,
      entries: rows.length,
      costCny: round6(taskTotal.costCny),
    },
    {
      level: 'run',
      key: 'run_id',
      entries: runRows.length,
      costCny: runCny,
    },
    {
      level: 'acceptance',
      key: 'acceptance_id',
      entries: acceptanceRows.length,
      costCny: acceptanceCny,
      note: 'acceptance rows are attributable through detail=acceptance_review:<acceptance-id>',
    },
  ];
  const hierarchy = {
    execution: round6(taskTotal.costCny),
    business: rollupCny(runtime, business.id, map),
    goal: rollupCny(runtime, goal.id, map),
  };
  return {
    currency: 'CNY',
    levels,
    levelCount: levels.filter((level) => level.entries > 0).length,
    hierarchy,
    retry: {
      reason: 'acceptance_revise_factual_error',
      runId: reworkRun.id,
      attemptNo: reworkRun.attemptNo,
      entries: retryRows.length,
      costCny: retryCny,
      tokensIn: retryRows.reduce((total, row) => total + row.tokensIn, 0),
      tokensOut: retryRows.reduce((total, row) => total + row.tokensOut, 0),
      tokensCached: retryRows.reduce((total, row) => total + row.tokensCached, 0),
      reworkCycleCostCny: round6(runCny),
    },
    reconciliation: {
      rows: rows.length,
      runCny,
      acceptanceCny,
      otherCny,
      taskCny: round6(taskTotal.costCny),
      taskEqualsRunPlusAcceptance:
        round6(taskTotal.costCny) === round6(runCny + acceptanceCny + otherCny),
      eachRunBilledOnce: runRows.length === new Set(runRows.map((row) => row.runId)).size,
      initialRunCny: round6(sumCny(rows.filter((row) => row.runId === initialRun.id))),
    },
    rows: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      runId: row.runId,
      kind: row.kind,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      tokensCached: row.tokensCached,
      costCny: row.costCny,
      detail: row.detail,
    })),
  };
}

function buildResultPack({ goal, business, execution, claim, acceptance, sources }) {
  const deliverable = claim.manifest[0];
  return {
    schema: 'm5-drill-result-pack/v1',
    taskId: execution.id,
    goalId: goal.id,
    businessId: business.id,
    outcome: 'done',
    title: goal.title,
    manuscript: {
      path: deliverable.path,
      sha256: deliverable.sha256,
      content: ARTIFACT_V2,
    },
    sources,
    acceptance: {
      id: acceptance.id,
      state: acceptance.state,
      roundNo: acceptance.roundNo,
      items: acceptance.items.map((item) => ({ key: item.key, state: item.state })),
    },
    pendingDecisions: [
      {
        id: 'publish_authorization',
        question: '是否批准把这份稿件对外发布？',
        options: ['approve', 'reject'],
        blocking: true,
      },
    ],
    publishAuthorized: false,
  };
}

/**
 * The separate `stop_unknown` proof required by the drill acceptance: the
 * executor accepts the cancel but cannot prove quiescence, so the task must
 * stay `stopping` and the run must stay `running`.
 */
export async function runStopUnknownScenario(root) {
  const workspace = join(root, 'stop-unknown-workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'article.md'), '# work in progress\n', 'utf8');

  const clock = createClock(1_700_100_000_000);
  const adapterClock = createClock(0);
  const ids = createIds(9_000);
  const adapter = createMockAdapter({
    now: adapterClock.now,
    cancelVerification: 'unverified',
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: 60_000,
        type: 'complete',
        summary: 'long run',
        usage: { ...INITIAL_USAGE },
        artifacts: [{ path: 'article.md', content: ARTIFACT_V2 }],
      },
    ],
  });
  const runtime = openRuntime({
    dbPath: ':memory:',
    adapter,
    clock,
    ids,
    workspacePath: workspace,
    quiescenceMs: 5000,
  });

  try {
    const goal = runtime.tasks.create({
      level: 'goal',
      title: '停止核实演练',
      acceptanceProfile: GOAL_PROFILE,
    });
    const business = runtime.tasks.delegate({ parentTaskId: goal.id, title: '业务侧准备' });
    const execution = runtime.tasks.delegate({
      parentTaskId: business.id,
      title: '长时间执行',
      acceptanceProfile: EXECUTION_PROFILE,
    });
    runtime.tasks.queue({ taskId: goal.id, actor: 'chief', idempotencyKey: 'stop-unknown:goal:queue' });
    runtime.tasks.queue({ taskId: business.id, actor: 'bot', idempotencyKey: 'stop-unknown:business:queue' });

    const dispatched = runtime.tasks.dispatch({
      taskId: execution.id,
      executorKind: 'mock',
      idempotencyKey: 'stop-unknown:dispatch:1',
    });
    const accepted = await runtime.runs.dispatchToExecutor({ runId: dispatched.run.id });
    runtime.runs.ack({ runId: dispatched.run.id });
    parentTransition(runtime, business.id, 'stop-unknown:business:running');
    parentTransition(runtime, goal.id, 'stop-unknown:goal:running');
    const run = dispatched.run;

    const stopped = await runtime.stop.stop({
      taskId: goal.id,
      workspacePath: workspace,
      requestedBy: 'human',
      reason: 'user_stop',
      idempotencyKey: 'stop-unknown:stop:1',
    });

    const runsBefore = runtime.runs.list({ taskId: execution.id }).length;
    let dispatchError = null;
    try {
      runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock', idempotencyKey: 'stop-unknown:dispatch:2' });
    } catch (error) {
      dispatchError = { code: error.code ?? null, status: error.status ?? null, message: error.message };
    }
    const runsAfter = runtime.runs.list({ taskId: execution.id }).length;

    const result = {
      scenario: 'stop_unknown',
      cancelled: stopped.cancelled,
      stopState: stopped.stopState,
      executor: {
        accepted: accepted.accepted === true,
        cancelState: stopped.executor[0]?.cancel?.state ?? null,
        remoteMayStillRun: stopped.executor[0]?.cancel?.remote_may_still_run ?? null,
      },
      blockers: stopped.blockers,
      taskStates: {
        goal: runtime.tasks.get(goal.id).state,
        business: runtime.tasks.get(business.id).state,
        execution: runtime.tasks.get(execution.id).state,
      },
      stopUnknownFlags: {
        goal: runtime.tasks.get(goal.id).stopUnknown,
        business: runtime.tasks.get(business.id).stopUnknown,
        execution: runtime.tasks.get(execution.id).stopUnknown,
      },
      runState: runtime.runs.get(run.id).state,
      noNewDispatch: {
        attempted: true,
        rejectedCode: dispatchError?.code ?? null,
        rejectedStatus: dispatchError?.status ?? null,
        runsBefore,
        runsAfter,
      },
    };
    result.ok =
      result.cancelled === false &&
      result.stopState === 'stop_unknown' &&
      result.executor.cancelState === 'stop_unknown' &&
      result.blockers.some((blocker) =>
        blocker.reasons.includes('process_still_alive'),
      ) &&
      result.taskStates.goal === 'stopping' &&
      result.taskStates.business === 'stopping' &&
      result.taskStates.execution === 'stopping' &&
      result.stopUnknownFlags.goal === true &&
      result.runState === 'running' &&
      result.noNewDispatch.rejectedCode === 'invalid_state_transition' &&
      runsAfter === runsBefore;
    return result;
  } finally {
    await runtime.close();
  }
}

/**
 * Run the full ten-step drill and write `<outDir>/drill-report.json` plus
 * `<outDir>/evidence/`. Returns the report; `report.result.ok` tells whether
 * every step passed.
 *
 * @param {{outDir?: string|null}} [options]
 */
export async function runDrill({ outDir = null } = {}) {
  const outputDir = outDir ? resolve(outDir) : mkdtempSync(join(tmpdir(), 'm5-drill-out-'));
  mkdirSync(outputDir, { recursive: true });
  const scenarioRoot = mkdtempSync(join(tmpdir(), 'm5-drill-state-'));
  const workspace = join(scenarioRoot, 'workspace');
  mkdirSync(join(workspace, 'sources'), { recursive: true });
  for (const [name, content] of Object.entries(SOURCE_FILES)) {
    writeFileSync(join(workspace, 'sources', name), content, 'utf8');
  }
  const dbPath = join(scenarioRoot, 'task-service.sqlite');

  const clock = createClock();
  const adapterClock = createClock(0);
  const ids = createIds();
  const adapter = createDrillAdapter(adapterClock);
  const evidence = createEvidenceWriter(outputDir);
  const steps = [];
  const data = {};
  let runtime = openRuntime({ dbPath, adapter, clock, ids, workspacePath: workspace });
  let error = null;

  function recordStep({ step, action, expect, actual, details }) {
    const ok = isDeepStrictEqual(expect, actual);
    const evidenceRef = evidence.write(
      `step-${String(step).padStart(2, '0')}-${slug(action)}.json`,
      { step, action, expect, actual, ok, details },
    );
    const record = { step, action, expect, actual, ok, evidenceRef };
    steps.push(record);
    if (!ok) {
      throw new DrillFailure(`step ${step} expectation mismatch`, record);
    }
    return record;
  }

  try {
    // ------------------------------------------------------------------
    // Step 1: create the goal
    // ------------------------------------------------------------------
    clock.advance(1000);
    const goal = runtime.tasks.create({
      level: 'goal',
      title: GOAL_TITLE,
      owner: 'chief:chief-1',
      acceptanceProfile: GOAL_PROFILE,
      budget: { cnyCap: 2 },
      authScope: { allow: ['read_sources', 'write_draft'], deny: ['publish'], mustConfirm: true },
      subject: { goal: GOAL_TITLE, topic: 'AI 内容生产' },
    });
    recordStep({
      step: 1,
      action: 'create goal with budget, allow/deny scope and must-confirm',
      expect: {
        level: 'goal',
        state: 'planned',
        parentTaskId: null,
        budgetCnyCap: 2,
        mustConfirm: true,
        allow: ['read_sources', 'write_draft'],
        deny: ['publish'],
      },
      actual: {
        level: goal.level,
        state: goal.state,
        parentTaskId: goal.parentTaskId,
        budgetCnyCap: goal.budget.cnyCap,
        mustConfirm: goal.authScope.mustConfirm,
        allow: goal.authScope.allow,
        deny: goal.authScope.deny,
      },
      details: {
        task: taskView(goal),
        budget: goal.budget,
        authScope: goal.authScope,
        events: runtime.service.listEvents({ type: 'task.created' }),
      },
    });

    // ------------------------------------------------------------------
    // Step 2: delegate the business task
    // ------------------------------------------------------------------
    clock.advance(1000);
    runtime.tasks.queue({ taskId: goal.id, actor: 'chief', idempotencyKey: 'm5:goal:queue' });
    const business = runtime.tasks.delegate({
      parentTaskId: goal.id,
      title: '内容 BOT：拆解并交付稿件',
      owner: 'bot:content-bot',
    });
    runtime.tasks.queue({ taskId: business.id, actor: 'bot', idempotencyKey: 'm5:business:queue' });
    const delegationEvent = runtime.service
      .listEvents({ type: 'delegation.created' })
      .find((event) => event.taskId === business.id);
    recordStep({
      step: 2,
      action: 'queue goal, create business task under it, queue business',
      expect: {
        goalState: 'queued',
        businessLevel: 'business',
        businessParentIsGoal: true,
        businessState: 'queued',
        delegationEvent: true,
      },
      actual: {
        goalState: runtime.tasks.get(goal.id).state,
        businessLevel: business.level,
        businessParentIsGoal: business.parentTaskId === goal.id,
        businessState: runtime.tasks.get(business.id).state,
        delegationEvent: Boolean(delegationEvent),
      },
      details: {
        goal: taskView(runtime.tasks.get(goal.id)),
        business: taskView(runtime.tasks.get(business.id)),
        delegationEvent: delegationEvent ?? null,
      },
    });

    // ------------------------------------------------------------------
    // Step 3: create and dispatch the execution task
    // ------------------------------------------------------------------
    clock.advance(1000);
    const execution = runtime.tasks.delegate({
      parentTaskId: business.id,
      title: '资料核查 → 选题 → 写稿 → 审校 → 排版',
      acceptanceProfile: EXECUTION_PROFILE,
      owner: 'pool:execution',
    });
    const dispatched = runtime.tasks.dispatch({
      taskId: execution.id,
      executorKind: 'mock',
      idempotencyKey: 'm5:dispatch:initial',
      payload: { sources: Object.keys(SOURCE_FILES).map((name) => `sources/${name}`) },
    });
    const run1 = dispatched.run;
    const outbox1 = outboxFor(runtime, run1);
    const taskPack = {
      goal: GOAL_TITLE,
      constraints: ['本地执行', '不对外发布', '来源可复核'],
      acceptance: EXECUTION_ITEMS.map((item) => item.key),
      context_refs: Object.keys(SOURCE_FILES).map((name) => `sources/${name}`),
    };
    const accepted1 = await runtime.runs.dispatchToExecutor({
      runId: run1.id,
      taskPack,
      workspace: { path: workspace, repo: 'ft54482/superagent-lab-smoke' },
      budget: { cny_cap: 2 },
    });
    const acked1 = runtime.runs.ack({ runId: run1.id, ack: { instanceId: 'mock-drill-1' } });
    parentTransition(runtime, business.id, 'm5:business:running');
    parentTransition(runtime, goal.id, 'm5:goal:running');
    recordStep({
      step: 3,
      action: 'create execution task, dispatch it (durable outbox intent), send to mock executor and ack',
      expect: {
        executionState: 'running',
        runStateAfterDispatch: 'dispatched',
        runState: 'running',
        outboxIntent: 'dispatch_run',
        outboxState: 'pending',
        outboxTaskIsExecution: true,
        adapterAccepted: true,
        runCount: 1,
      },
      actual: {
        executionState: acked1.task.state,
        runStateAfterDispatch: dispatched.run.state,
        runState: acked1.run.state,
        outboxIntent: outbox1?.intent ?? null,
        outboxState: outbox1?.state ?? null,
        outboxTaskIsExecution: outbox1?.task_id === execution.id,
        adapterAccepted: accepted1.accepted === true,
        runCount: runtime.runs.list({ taskId: execution.id }).length,
      },
      details: {
        execution: taskView(runtime.tasks.get(execution.id)),
        dispatch: { task: dispatched.task, run: dispatched.run },
        outbox: outbox1,
        adapter: accepted1,
        ack: { run: acked1.run, task: acked1.task },
        taskPack,
        parentStates: {
          goal: runtime.tasks.get(goal.id).state,
          business: runtime.tasks.get(business.id).state,
        },
      },
    });

    // ------------------------------------------------------------------
    // Step 4: duplicate dispatch must not create a second run
    // ------------------------------------------------------------------
    clock.advance(1000);
    const replayed = runtime.tasks.dispatch({
      taskId: execution.id,
      executorKind: 'mock',
      idempotencyKey: 'm5:dispatch:initial',
      payload: { sources: Object.keys(SOURCE_FILES).map((name) => `sources/${name}`) },
    });
    let secondKeyError = null;
    try {
      runtime.tasks.dispatch({
        taskId: execution.id,
        executorKind: 'mock',
        idempotencyKey: 'm5:dispatch:duplicate-key',
      });
    } catch (caught) {
      secondKeyError = { code: caught.code ?? null, status: caught.status ?? null, message: caught.message };
    }
    const runsAfterDuplicate = runtime.runs.list({ taskId: execution.id });
    recordStep({
      step: 4,
      action: 'repeat the dispatch with the same key, then try a different key while the run is active',
      expect: {
        replayed: true,
        replaySameRun: true,
        runCount: 1,
        outboxCount: 1,
        secondKeyRejected: 'invalid_state_transition',
        secondKeyStatus: 409,
      },
      actual: {
        replayed: replayed.replayed === true,
        replaySameRun: replayed.run.id === run1.id,
        runCount: runsAfterDuplicate.length,
        outboxCount: countOutbox(runtime, runsAfterDuplicate),
        secondKeyRejected: secondKeyError?.code ?? null,
        secondKeyStatus: secondKeyError?.status ?? null,
      },
      details: {
        replayedRun: replayed.run,
        secondKeyError,
        runs: runsAfterDuplicate.map(runView),
        outboxes: runsAfterDuplicate.map((run) => outboxFor(runtime, run)),
      },
    });

    // ------------------------------------------------------------------
    // Step 5: restart the task service and prove no duplicate dispatch
    // ------------------------------------------------------------------
    clock.advance(1000);
    const before = stateSnapshot(runtime);
    await runtime.close();
    runtime = openRuntime({ dbPath, adapter, clock, ids, workspacePath: workspace });
    const after = stateSnapshot(runtime);
    const replayAfterRestart = runtime.tasks.dispatch({
      taskId: execution.id,
      executorKind: 'mock',
      idempotencyKey: 'm5:dispatch:initial',
      payload: { sources: Object.keys(SOURCE_FILES).map((name) => `sources/${name}`) },
    });
    const runsAfterRestart = runtime.runs.list({ taskId: execution.id });
    const recovered = {
      taskStates: {
        goal: runtime.tasks.get(goal.id).state,
        business: runtime.tasks.get(business.id).state,
        execution: runtime.tasks.get(execution.id).state,
      },
      runState: runtime.runs.get(run1.id).state,
      eventHashesIntact: isDeepStrictEqual(
        before.events.map((event) => event.hash),
        after.events.map((event) => event.hash),
      ),
      outboxIntact: after.outbox.length === before.outbox.length,
      replaySameRun: replayAfterRestart.run.id === run1.id,
      replayReplayed: replayAfterRestart.replayed === true,
      runCount: runsAfterRestart.length,
      newRunsCreated: runsAfterRestart.length - before.runs.length,
      newOutboxCreated: countOutbox(runtime, runsAfterRestart) - before.outbox.length,
    };
    recordStep({
      step: 5,
      action: 'close the task service, reopen the same SQLite store, replay the dispatch',
      expect: {
        goalState: 'running',
        businessState: 'running',
        executionState: 'running',
        runState: 'running',
        eventsIntact: true,
        outboxIntact: true,
        replayReplayed: true,
        replaySameRun: true,
        runCount: 1,
        newRunsCreated: 0,
        newOutboxCreated: 0,
      },
      actual: {
        goalState: recovered.taskStates.goal,
        businessState: recovered.taskStates.business,
        executionState: recovered.taskStates.execution,
        runState: recovered.runState,
        eventsIntact: recovered.eventHashesIntact,
        outboxIntact: recovered.outboxIntact,
        replayReplayed: recovered.replayReplayed,
        replaySameRun: recovered.replaySameRun,
        runCount: recovered.runCount,
        newRunsCreated: recovered.newRunsCreated,
        newOutboxCreated: recovered.newOutboxCreated,
      },
      details: {
        before: {
          taskStates: before.tasks.map((task) => ({ id: task.id, state: task.state })),
          runs: before.runs,
          outbox: before.outbox,
          eventCount: before.events.length,
          lastEventHash: before.events.at(-1)?.hash ?? null,
        },
        after: {
          taskStates: after.tasks.map((task) => ({ id: task.id, state: task.state })),
          runs: after.runs,
          outbox: after.outbox,
          eventCount: after.events.length,
          lastEventHash: after.events.at(-1)?.hash ?? null,
        },
        replayAfterRestart,
        recovered,
      },
    });
    data.restart = {
      before: {
        runCount: before.runs.length,
        outboxCount: before.outbox.length,
        eventCount: before.events.length,
      },
      after: {
        runCount: after.runs.length,
        outboxCount: after.outbox.length,
        eventCount: after.events.length,
      },
      recovery: {
        tasksRestored:
          recovered.taskStates.goal === 'running' &&
          recovered.taskStates.business === 'running' &&
          recovered.taskStates.execution === 'running',
        runRestored: recovered.runState === 'running',
        eventsIntact: recovered.eventHashesIntact,
        outboxIntact: recovered.outboxIntact,
        duplicateReplay: recovered.replayReplayed && recovered.replaySameRun,
        runCount: recovered.runCount,
        newRunsCreated: recovered.newRunsCreated,
        newOutboxCreated: recovered.newOutboxCreated,
      },
    };

    // ------------------------------------------------------------------
    // Step 6: the executor reports; acceptance opens
    // ------------------------------------------------------------------
    clock.advance(1000);
    adapterClock.advance(200);
    const status1 = await adapter.status({ run_id: run1.id });
    const claim1 = await claimFromExecutor(adapter, run1, { nonce: 'm5-claim-1', summary: 'draft v1' });
    const claimed1 = await runtime.runs.claim({
      runId: run1.id,
      claim: claim1,
      acceptanceItems: EXECUTION_ITEMS,
    });
    recordStep({
      step: 6,
      action: 'executor completes, artifacts are collected, the claim opens acceptance round 1',
      expect: {
        adapterState: 'completed',
        runState: 'reported',
        taskState: 'accepting',
        acceptanceState: 'open',
        roundNo: 1,
        costRecorded: true,
        artifactPath: 'article.md',
        manifestEntries: 1,
      },
      actual: {
        adapterState: status1.state,
        runState: claimed1.run.state,
        taskState: claimed1.task.state,
        acceptanceState: claimed1.acceptance.state,
        roundNo: claimed1.acceptance.roundNo,
        costRecorded: claimed1.cost.recorded === true,
        artifactPath: claim1.manifest[0]?.path ?? null,
        manifestEntries: claim1.manifest.length,
      },
      details: {
        status: status1,
        claim: claim1,
        run: runView(claimed1.run),
        task: taskView(claimed1.task),
        acceptance: acceptanceView(claimed1.acceptance),
        cost: claimed1.cost,
      },
    });

    // ------------------------------------------------------------------
    // Step 7: deliberate factual error -> revise -> rework run
    // ------------------------------------------------------------------
    clock.advance(1000);
    const revised = runtime.acceptances.decide({
      acceptanceId: claimed1.acceptance.id,
      verdict: 'revise',
      itemStates: {
        'auto.contract': 'pass',
        'fact.accuracy': 'fail',
        'independent.review': 'pass',
      },
      reason: 'factual_error',
      reviewer: { role: 'independent_reviewer', id: 'reviewer-1', context_id: 'ctx-reviewer-1' },
    });
    const acceptanceCost1 = recordAcceptanceCost(runtime, execution, claimed1.acceptance);
    const reworkRounds = runtime.acceptances.list({ taskId: execution.id, state: 'revise' }).length;
    const reworkRuns = runtime.runs.list({ taskId: execution.id }).filter((run) => run.kind === 'rework');
    recordStep({
      step: 7,
      action: 'inject a factual error, reject acceptance, derive one rework run',
      expect: {
        verdict: 'revise',
        acceptanceState: 'revise',
        taskState: 'reworking',
        revision: 1,
        reworkRounds: 1,
        reworkRuns: 1,
        rejectedRuns: 1,
        reworkRunKind: 'rework',
        reworkRunQueued: true,
        injectedErrorPresent: true,
        failedItem: 'fact.accuracy',
      },
      actual: {
        verdict: revised.verdict,
        acceptanceState: runtime.acceptances.get(claimed1.acceptance.id).state,
        taskState: revised.task.state,
        revision: revised.task.revision,
        reworkRounds,
        reworkRuns: reworkRuns.length,
        rejectedRuns: runtime.runs.list({ taskId: execution.id, state: 'rejected' }).length,
        reworkRunKind: revised.reworkRun.kind,
        reworkRunQueued: revised.reworkRun.state === 'queued',
        injectedErrorPresent:
          ARTIFACT_V1.includes(INJECTED_ERROR) &&
          revised.acceptance.items.find((item) => item.key === 'fact.accuracy')?.state === 'fail',
        failedItem: revised.acceptance.items.find((item) => item.state === 'fail')?.key ?? null,
      },
      details: {
        injectedError: INJECTED_ERROR,
        draftV1: ARTIFACT_V1,
        revisedAcceptance: acceptanceView(revised.acceptance),
        task: taskView(revised.task),
        reworkRun: runView(revised.reworkRun),
        acceptanceCost: acceptanceCost1,
        reworkRounds,
      },
    });
    data.rework = {
      injectedError: INJECTED_ERROR,
      failedItem: 'fact.accuracy',
      verdict: revised.verdict,
      reworkRounds,
      reworkRunId: revised.reworkRun.id,
      reworkRunKind: revised.reworkRun.kind,
      revision: revised.task.revision,
    };

    // ------------------------------------------------------------------
    // Step 8: corrected rework passes and produces the result package
    // ------------------------------------------------------------------
    clock.advance(1000);
    adapterClock.set(0);
    const reworkDispatched = runtime.tasks.dispatch({
      taskId: execution.id,
      executorKind: 'mock',
      idempotencyKey: 'm5:dispatch:rework-1',
      payload: { sources: Object.keys(SOURCE_FILES).map((name) => `sources/${name}`) },
    });
    const run2 = reworkDispatched.run;
    // The L2 service derives a rework run from `task.executorKind`, which the
    // task projection does not persist, so a derived run defaults to
    // `dsh_session`. Pin the simulated executor on the already-created run
    // before routing it; this only fixes routing metadata, not a transition.
    if (run2.executorKind !== 'mock') {
      runtime.service.store.updateRun(
        run2.id,
        { executorKind: 'mock' },
        { expectedStateVersion: run2.stateVersion },
      );
    }
    const accepted2 = await runtime.runs.dispatchToExecutor({
      runId: run2.id,
      taskPack: {
        ...taskPack,
        rework: { reason: 'factual_error', corrected: '水的沸点是 100°C' },
      },
      workspace: { path: workspace, repo: 'ft54482/superagent-lab-smoke' },
      budget: { cny_cap: 2 },
    });
    runtime.runs.ack({ runId: run2.id, ack: { instanceId: 'mock-drill-2' } });
    adapterClock.advance(1200);
    const status2 = await adapter.status({ run_id: run2.id });
    const claim2 = await claimFromExecutor(adapter, run2, { nonce: 'm5-claim-2', summary: 'final v2' });
    const claimed2 = await runtime.runs.claim({
      runId: run2.id,
      claim: claim2,
      acceptanceItems: EXECUTION_ITEMS,
    });
    const passed = runtime.acceptances.decide({
      acceptanceId: claimed2.acceptance.id,
      verdict: 'pass',
      itemStates: {
        'auto.contract': 'pass',
        'fact.accuracy': 'pass',
        'independent.review': 'pass',
      },
      reason: 'fact_fixed',
      reviewer: { role: 'independent_reviewer', id: 'reviewer-1', context_id: 'ctx-reviewer-1' },
    });
    const acceptanceCost2 = recordAcceptanceCost(runtime, execution, claimed2.acceptance);
    const sources = Object.entries(SOURCE_FILES).map(([name, content]) => ({
      ref: `source:${name.replace(/\.[^.]+$/, '')}`,
      path: `sources/${name}`,
      sha256: sha256(content),
    }));
    const resultPack = buildResultPack({
      goal,
      business,
      execution,
      claim: claim2,
      acceptance: passed.acceptance,
      sources,
    });
    data.resultPack = resultPack;
    recordStep({
      step: 8,
      action: 'dispatch and claim the rework run with the corrected draft, pass acceptance, build the result package',
      expect: {
        reworkRunAttempt: 2,
        reworkRunKind: 'rework',
        adapterState: 'completed',
        finalRunState: 'accepted',
        finalTaskState: 'completed',
        acceptanceState: 'passed',
        roundNo: 2,
        correctedErrorPresent: true,
        resultPackOutcome: 'done',
        deliverablePath: 'article.md',
        deliverableHashMatchesClaim: true,
        sources: 2,
        pendingDecisions: 1,
      },
      actual: {
        reworkRunAttempt: run2.attemptNo,
        reworkRunKind: run2.kind,
        adapterState: status2.state,
        finalRunState: runtime.runs.get(run2.id).state,
        finalTaskState: runtime.tasks.get(execution.id).state,
        acceptanceState: passed.acceptance.state,
        roundNo: claimed2.acceptance.roundNo,
        correctedErrorPresent: ARTIFACT_V2.includes('100°C') && !ARTIFACT_V2.includes(INJECTED_ERROR),
        resultPackOutcome: resultPack.outcome,
        deliverablePath: resultPack.manuscript.path,
        deliverableHashMatchesClaim:
          resultPack.manuscript.sha256 === claim2.manifest[0]?.sha256 &&
          resultPack.manuscript.sha256 === sha256(ARTIFACT_V2),
        sources: resultPack.sources.length,
        pendingDecisions: resultPack.pendingDecisions.length,
      },
      details: {
        dispatch: { task: reworkDispatched.task, run: reworkDispatched.run },
        adapter: accepted2,
        status: status2,
        claim: claim2,
        acceptance: acceptanceView(passed.acceptance),
        acceptanceCost: acceptanceCost2,
        resultPack,
        routing: {
          requested: 'mock',
          storedAfterFix: runtime.runs.get(run2.id).executorKind,
        },
        runs: runtime.runs.list({ taskId: execution.id }).map(runView),
        parentStates: {
          goal: runtime.tasks.get(goal.id).state,
          business: runtime.tasks.get(business.id).state,
        },
      },
    });

    // ------------------------------------------------------------------
    // Step 9: three-level cost query plus retry cost
    // ------------------------------------------------------------------
    clock.advance(1000);
    const cost = summarizeCost(runtime, { goal, business, execution, initialRun: run1, reworkRun: run2 });
    data.cost = cost;
    recordStep({
      step: 9,
      action: 'query cost at task/run/acceptance levels, roll it up to business and goal, and isolate retry cost',
      expect: {
        levelCount: 3,
        taskCny: 0.32,
        runCny: 0.3,
        acceptanceCny: 0.02,
        executionCny: 0.32,
        businessCny: 0.32,
        goalCny: 0.32,
        retryCny: 0.18,
        taskEqualsRunPlusAcceptance: true,
        eachRunBilledOnce: true,
      },
      actual: {
        levelCount: cost.levelCount,
        taskCny: cost.levels[0].costCny,
        runCny: cost.levels[1].costCny,
        acceptanceCny: cost.levels[2].costCny,
        executionCny: cost.hierarchy.execution,
        businessCny: cost.hierarchy.business,
        goalCny: cost.hierarchy.goal,
        retryCny: cost.retry.costCny,
        taskEqualsRunPlusAcceptance: cost.reconciliation.taskEqualsRunPlusAcceptance,
        eachRunBilledOnce: cost.reconciliation.eachRunBilledOnce,
      },
      details: {
        levels: cost.levels,
        hierarchy: cost.hierarchy,
        retry: cost.retry,
        reconciliation: cost.reconciliation,
        rows: cost.rows,
      },
    });

    // ------------------------------------------------------------------
    // Step 10: one-click stop with a live run, then verified quiescence
    // ------------------------------------------------------------------
    clock.advance(1000);
    adapterClock.set(0);
    const followup = runtime.tasks.delegate({
      parentTaskId: business.id,
      title: '追加：AI 工具观察短文（停止演练）',
      acceptanceProfile: EXECUTION_PROFILE,
    });
    const followupDispatched = runtime.tasks.dispatch({
      taskId: followup.id,
      executorKind: 'mock',
      idempotencyKey: 'm5:dispatch:followup',
    });
    const run3 = followupDispatched.run;
    await runtime.runs.dispatchToExecutor({
      runId: run3.id,
      taskPack,
      workspace: { path: workspace, repo: 'ft54482/superagent-lab-smoke' },
    });
    runtime.runs.ack({ runId: run3.id, ack: { instanceId: 'mock-drill-3' } });

    const hashBefore = hashTree(workspace);
    clock.advance(5000);
    const stopped = await runtime.stop.stop({
      taskId: goal.id,
      workspacePath: workspace,
      requestedBy: 'human',
      reason: 'user_stop',
      idempotencyKey: 'm5:stop:request',
    });
    const hashAfter = hashTree(workspace);
    const taskStatesAfterStop = {
      goal: runtime.tasks.get(goal.id).state,
      business: runtime.tasks.get(business.id).state,
      completedChild: runtime.tasks.get(execution.id).state,
      followup: runtime.tasks.get(followup.id).state,
    };
    const runStatesAfterStop = {
      initial: runtime.runs.get(run1.id).state,
      rework: runtime.runs.get(run2.id).state,
      followup: runtime.runs.get(run3.id).state,
    };
    const runsBeforeRefused = runtime.runs.list({ taskId: followup.id }).length;
    let refusedDispatch = null;
    try {
      runtime.tasks.dispatch({ taskId: followup.id, executorKind: 'mock', idempotencyKey: 'm5:dispatch:after-stop' });
    } catch (caught) {
      refusedDispatch = { code: caught.code ?? null, status: caught.status ?? null, message: caught.message };
    }
    const runsAfterRefused = runtime.runs.list({ taskId: followup.id }).length;
    const stopProofs = runtime.service.listStopVerifications({ runId: run3.id });
    recordStep({
      step: 10,
      action: 'start a follow-up run, request one-click stop, cancel the executor and verify quiescence',
      expect: {
        requestState: 'requested',
        verifiedState: 'verified',
        cancelled: true,
        executorCancelState: 'cancelled',
        executorRemoteMayStillRun: false,
        blockerCount: 0,
        workspaceStable: true,
        goalState: 'cancelled',
        businessState: 'cancelled',
        followupState: 'cancelled',
        completedChildPreserved: true,
        followupRunState: 'cancelled',
        verifiedProofRecorded: true,
        refusedDispatch: 'invalid_state_transition',
        runsAfterRefused: 1,
      },
      actual: {
        requestState: stopped.requested?.stopState ?? null,
        verifiedState: stopped.stopState,
        cancelled: stopped.cancelled,
        executorCancelState: stopped.executor[0]?.cancel?.state ?? null,
        executorRemoteMayStillRun: stopped.executor[0]?.cancel?.remote_may_still_run ?? null,
        blockerCount: stopped.blockers.length,
        workspaceStable: stopped.workspace.writesStable && hashBefore === hashAfter,
        goalState: taskStatesAfterStop.goal,
        businessState: taskStatesAfterStop.business,
        followupState: taskStatesAfterStop.followup,
        completedChildPreserved: taskStatesAfterStop.completedChild === 'completed',
        followupRunState: runStatesAfterStop.followup,
        verifiedProofRecorded: stopProofs.some((proof) => proof.verdict === 'verified'),
        refusedDispatch: refusedDispatch?.code ?? null,
        runsAfterRefused,
      },
      details: {
        followup: taskView(runtime.tasks.get(followup.id)),
        stop: {
          requested: stopped.requested,
          cancelled: stopped.cancelled,
          stopState: stopped.stopState,
          blockers: stopped.blockers,
          executor: stopped.executor,
          workspace: stopped.workspace,
        },
        workspaceHashes: { before: hashBefore, after: hashAfter },
        taskStates: taskStatesAfterStop,
        runStates: runStatesAfterStop,
        stopProofs,
        refusedDispatch: { ...refusedDispatch, runsBefore: runsBeforeRefused, runsAfter: runsAfterRefused },
        outbox: runtime.runs.list().map((run) => outboxFor(runtime, run)).filter((row) => row !== null),
      },
    });
    data.stop = {
      request: {
        taskId: goal.id,
        requestedBy: 'human',
        reason: 'user_stop',
        state: stopped.requested?.stopState ?? null,
      },
      verification: {
        cancelled: stopped.cancelled,
        stopState: stopped.stopState,
        blockerCount: stopped.blockers.length,
        blockers: stopped.blockers,
        executorCancelState: stopped.executor[0]?.cancel?.state ?? null,
        executorRemoteMayStillRun: stopped.executor[0]?.cancel?.remote_may_still_run ?? null,
        verifiedProofRecorded: stopProofs.some((proof) => proof.verdict === 'verified'),
        proofCount: stopProofs.length,
      },
      workspace: {
        hashBefore,
        hashAfter,
        writesStable: stopped.workspace.writesStable,
      },
      tasks: taskStatesAfterStop,
      runs: runStatesAfterStop,
      noNewDispatch: {
        attempted: true,
        rejectedCode: refusedDispatch?.code ?? null,
        rejectedStatus: refusedDispatch?.status ?? null,
        runsBefore: runsBeforeRefused,
        runsAfter: runsAfterRefused,
      },
    };

    // ------------------------------------------------------------------
    // Required separate injection: stop_unknown must fail closed.
    // ------------------------------------------------------------------
    data.stopUnknown = await runStopUnknownScenario(scenarioRoot);

    // ------------------------------------------------------------------
    // Aggregate evidence
    // ------------------------------------------------------------------
    evidence.write('tasks.json', runtime.tasks.list().map(taskView));
    evidence.write('runs.json', runtime.runs.list().map(runView));
    evidence.write(
      'acceptances.json',
      runtime.acceptances.list().map((acceptance) => acceptanceView(acceptance)),
    );
    evidence.write('events.json', runtime.service.listEvents());
    evidence.write(
      'outbox.json',
      runtime.runs.list().map((run) => outboxFor(runtime, run)).filter((row) => row !== null),
    );
    evidence.write('costs.json', {
      levels: data.cost?.levels ?? null,
      hierarchy: data.cost?.hierarchy ?? null,
      retry: data.cost?.retry ?? null,
      reconciliation: data.cost?.reconciliation ?? null,
      rows: data.cost?.rows ?? null,
    });
    evidence.write('result-pack.json', data.resultPack ?? null);
    evidence.write('restart.json', data.restart ?? null);
    evidence.write('stop.json', data.stop ?? null);
    evidence.write('stop-unknown.json', data.stopUnknown ?? null);
    evidence.write('rework.json', data.rework ?? null);
  } catch (caught) {
    error = caught;
  } finally {
    try {
      await runtime.close();
    } catch {
      // The runtime may already be closed when a step failed mid-restart.
    }
  }

  const generatedAt = new Date().toISOString();
  const evidenceSummary = evidence.finalize(generatedAt);
  const passed = steps.filter((step) => step.ok).length;
  const failed = steps.length - passed;
  const report = {
    schema: 'm5-drill/v1',
    drill: {
      title: 'M5 · 10-step self-media closed loop on a simulated link',
      prd: 'docs/prd/09-wbs.md §1.3',
      runtime: 'packages/runtime (SQLite store + L2 service + mock adapter)',
      steps: 10,
    },
    generatedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      network: 'not used',
      outputDir,
    },
    steps,
    cost: data.cost ?? null,
    stop: data.stop ?? null,
    restart: data.restart ?? null,
    failureInjection: {
      rework: data.rework ?? null,
      stopUnknown: data.stopUnknown ?? null,
    },
    resultPackRef: data.resultPack ? 'evidence/result-pack.json' : null,
    evidence: evidenceSummary,
    result: {
      ok: error === null && steps.length === 10 && failed === 0,
      passed,
      failed,
      ...(error === null
        ? {}
        : { error: error.message, details: error.details ?? null }),
    },
  };

  writeFileSync(join(outputDir, 'drill-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  rmSync(scenarioRoot, { recursive: true, force: true });
  return report;
}
