/**
 * Business bot tool surface (PRD FR-14).
 *
 * A business bot plans execution work inside its delegated scope, dispatches it
 * to an executor the scope allows, decides its own acceptance rounds, and opens
 * rework. It never delegates goals or stops other bots' trees: those are Chief
 * actions, and asking for them returns `not_allowed`.
 *
 * Dispatch is the only async tool because the runtime's executor hand-off is
 * async; every side effect still belongs to the runtime (task service, executor
 * router, acceptance service).
 */

import { buildToolset } from './toolset.js';
import { AGENT_ROLES, ROLE_TOOLS } from './constants.js';
import { checkBudget } from './budget.js';
import { summarizeTask } from './summary.js';
import { effectiveScope } from '../../authz/src/index.js';
import {
  assertFunction,
  assertRuntime,
  humanSignoffAttempt,
  readRequestedCap,
  readString,
  readSubject,
  taskAccess,
} from './util.js';
import {
  authorizationExceeded,
  guard,
  guardAsync,
  notAllowed,
  ok,
  validationError,
} from './result.js';
import {
  checkDelegationLevel,
  checkExecutor,
  checkProject,
  executorAllowList,
  readAgentScope,
} from './scope.js';

function runView(run) {
  if (!run) return null;
  return {
    id: run.id,
    taskId: run.taskId,
    state: run.state,
    kind: run.kind,
    attemptNo: run.attemptNo,
    executorKind: run.executorKind,
  };
}

function acceptanceView(decided, fallback) {
  const acceptance = decided.acceptance ?? fallback ?? null;
  if (!acceptance) return null;
  return {
    id: acceptance.id,
    taskId: acceptance.taskId,
    stage: acceptance.stage,
    state: acceptance.state,
    roundNo: acceptance.roundNo,
    verdict: decided.verdict ?? null,
  };
}

export function createBusinessTools({ runtime, scope } = {}) {
  assertRuntime(runtime);
  assertFunction(runtime.tasks, 'delegate', 'runtime.tasks.delegate');
  assertFunction(runtime.tasks, 'dispatch', 'runtime.tasks.dispatch');
  assertFunction(runtime.acceptances, 'get', 'runtime.acceptances.get');
  assertFunction(runtime.runs, 'dispatchToExecutor', 'runtime.runs.dispatchToExecutor');
  assertFunction(runtime.runs, 'list', 'runtime.runs.list');
  assertFunction(runtime.runs, 'get', 'runtime.runs.get');
  const botScope = readAgentScope(scope, 'business scope');

  function plan(input = {}) {
    return guard(() => {
      const businessId = readString(
        input.businessTaskId ?? input.parentTaskId ?? input.taskId,
        'businessTaskId',
      );
      if (!businessId.ok) return businessId.result;
      const title = readString(input.title, 'title');
      if (!title.ok) return title.result;

      const businessTask = runtime.tasks.get(businessId.value);
      if (businessTask.level !== 'business') {
        return notAllowed(
          AGENT_ROLES.BUSINESS,
          'plan',
          'a business bot plans execution tasks under one of its business tasks',
        );
      }

      const access = taskAccess(runtime, botScope, businessTask);
      if (!access.ok) return access;

      let project = access.project;
      if (input.project != null) {
        const requestedProject = readString(input.project, 'project');
        if (!requestedProject.ok) return requestedProject.result;
        if (access.project !== null && requestedProject.value !== access.project) {
          return authorizationExceeded(
            `business task ${businessTask.id} belongs to project ${access.project}; its plan cannot switch projects`,
            { businessTaskId: businessTask.id, project: access.project, requestedProject: requestedProject.value },
          );
        }
        const projectCheck = checkProject(access.scope, requestedProject.value);
        if (!projectCheck.ok) {
          return authorizationExceeded(projectCheck.message, projectCheck.details);
        }
        project = requestedProject.value;
      }

      const levelCheck = checkDelegationLevel(access.scope, 'execution');
      if (!levelCheck.ok) {
        return authorizationExceeded(levelCheck.message, levelCheck.details);
      }

      const requested = readRequestedCap(input);
      if (!requested.ok) return requested.result;

      if (requested.cap !== null) {
        const budget = checkBudget({
          runtime,
          parentTask: businessTask,
          scope: access.scope,
          requested: requested.cap,
        });
        if (!budget.ok) return budget;
      }

      const subject = readSubject(input.subject);
      if (!subject.ok) return subject.result;
      if (project !== null) subject.subject.project = project;

      const childAuthScope = effectiveScope(access.scope, {
        max_delegate_level: 'execution',
        ...(project !== null ? { projects: [project] } : {}),
      });
      if (!childAuthScope.ok) {
        return authorizationExceeded('the execution task scope exceeds the business scope', {
          businessTaskId: businessTask.id,
          violations: childAuthScope.violations,
        });
      }

      const executionTask = runtime.tasks.delegate({
        parentTaskId: businessTask.id,
        level: 'execution',
        title: title.value,
        owner: input.owner ?? null,
        subject: Object.keys(subject.subject).length > 0 ? subject.subject : null,
        budget: requested.budget,
        acceptanceProfile: input.acceptanceProfile ?? null,
        authScope: childAuthScope.scope,
      });

      return ok('plan', { task: summarizeTask(runtime, executionTask) });
    });
  }

  async function dispatch(input = {}) {
    return guardAsync(async () => {
      const taskId = readString(input.taskId, 'taskId');
      if (!taskId.ok) return taskId.result;

      const task = runtime.tasks.get(taskId.value);
      if (task.level !== 'execution') {
        return notAllowed(
          AGENT_ROLES.BUSINESS,
          'dispatch',
          'only execution tasks can be dispatched; a business bot plans them first',
        );
      }

      const access = taskAccess(runtime, botScope, task);
      if (!access.ok) return access;

      const allowed = executorAllowList(access.scope) ?? [];
      let executorKind = input.executorKind;
      if (executorKind == null) {
        if (allowed.length === 1) {
          executorKind = allowed[0];
        } else {
          return validationError('executorKind is required when the scope allows more than one executor', {
            allowed,
          });
        }
      }
      const executorString = readString(executorKind, 'executorKind');
      if (!executorString.ok) return executorString.result;
      executorKind = executorString.value;

      // The task service reuses a queued run (notably a derived rework run) and
      // keeps that run's executor_kind regardless of the dispatch argument. Gate
      // on the executor that will actually run, not the one merely requested.
      const queuedRun = runtime.runs.list({ taskId: task.id, state: 'queued' })[0] ?? null;
      const effectiveExecutorKind = queuedRun?.executorKind ?? executorKind;

      const executorCheck = checkExecutor(access.scope, effectiveExecutorKind);
      if (!executorCheck.ok) {
        return authorizationExceeded(executorCheck.message, executorCheck.details);
      }

      const parentTask =
        typeof task.parentTaskId === 'string' && task.parentTaskId !== ''
          ? runtime.tasks.get(task.parentTaskId)
          : null;

      const budget = checkBudget({
        runtime,
        task,
        parentTask,
        scope: access.scope,
        requested: input.estimatedCostCny ?? 0,
      });
      if (!budget.ok) return budget;

      const dispatched = runtime.tasks.dispatch({
        taskId: task.id,
        executorKind: effectiveExecutorKind,
        payload: input.payload ?? {},
        idempotencyKey: input.idempotencyKey,
      });

      const executorResult = await runtime.runs.dispatchToExecutor({
        runId: dispatched.run.id,
        taskPack: input.taskPack,
        workspace: input.workspace,
        budget: input.budget,
        tracking: input.tracking,
      });

      const dispatchedTask = dispatched.task ?? runtime.tasks.get(task.id);
      if (executorResult.ok === false) {
        return {
          ok: false,
          code: executorResult.code ?? 'executor_unavailable',
          message: executorResult.message ?? `executor ${executorKind} rejected the dispatch`,
          task: summarizeTask(runtime, dispatchedTask),
          run: runView(dispatched.run),
          executor: executorResult,
        };
      }

      return ok('dispatch', {
        task: summarizeTask(runtime, dispatchedTask),
        run: runView(runtime.runs.get(dispatched.run.id) ?? dispatched.run),
        executor: executorResult,
      });
    });
  }

  function accept(input = {}) {
    return guard(() => {
      const acceptanceId = readString(input.acceptanceId, 'acceptanceId');
      if (!acceptanceId.ok) return acceptanceId.result;

      const acceptance = runtime.acceptances.get(acceptanceId.value);
      const task = runtime.tasks.get(acceptance.taskId);
      if (task.level === 'goal') {
        return notAllowed(
          AGENT_ROLES.BUSINESS,
          'accept',
          'a business bot cannot decide a goal acceptance round',
        );
      }
      const access = taskAccess(runtime, botScope, task);
      if (!access.ok) return access;

      const humanItem = humanSignoffAttempt(input.itemStates);
      if (humanItem !== null) {
        return notAllowed(
          AGENT_ROLES.BUSINESS,
          'accept',
          `human sign-off item ${humanItem} must be recorded by the human, not by a bot`,
        );
      }

      const decided = runtime.acceptances.decide({
        acceptanceId: acceptance.id,
        verdict: input.verdict,
        itemStates: input.itemStates,
        reviewer: input.reviewer ?? { role: AGENT_ROLES.BUSINESS, ref: task.owner ?? 'business' },
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
      });

      return ok('accept', {
        task: summarizeTask(runtime, decided.task),
        acceptance: acceptanceView(decided, acceptance),
        verdict: decided.verdict ?? input.verdict,
        ...(decided.reworkRun ? { reworkRun: runView(decided.reworkRun) } : {}),
      });
    });
  }

  function rework(input = {}) {
    return guard(() => {
      const accessFor = (task) => taskAccess(runtime, botScope, task);

      if (input.acceptanceId != null) {
        const acceptanceId = readString(input.acceptanceId, 'acceptanceId');
        if (!acceptanceId.ok) return acceptanceId.result;

        const acceptance = runtime.acceptances.get(acceptanceId.value);
        const task = runtime.tasks.get(acceptance.taskId);
        if (task.level === 'goal') {
          return notAllowed(
            AGENT_ROLES.BUSINESS,
            'rework',
            'a business bot cannot reopen a goal acceptance round',
          );
        }
        const access = accessFor(task);
        if (!access.ok) return access;

        if (input.taskId != null && input.taskId !== task.id) {
          return validationError('taskId does not match the acceptance task', {
            taskId: input.taskId,
            acceptanceTaskId: task.id,
          });
        }

        const decided = runtime.acceptances.decide({
          acceptanceId: acceptance.id,
          verdict: 'revise',
          itemStates: input.itemStates,
          reviewer: input.reviewer ?? { role: AGENT_ROLES.BUSINESS, ref: task.owner ?? 'business' },
          reason: input.reason ?? 'rework_requested',
          idempotencyKey: input.idempotencyKey,
        });

        return ok('rework', {
          task: summarizeTask(runtime, decided.task),
          acceptance: acceptanceView(decided, acceptance),
          reworkRun: runView(decided.reworkRun),
        });
      }

      const taskId = readString(input.taskId, 'taskId');
      if (!taskId.ok) return taskId.result;
      const task = runtime.tasks.get(taskId.value);
      if (task.level === 'goal') {
        return notAllowed(AGENT_ROLES.BUSINESS, 'rework', 'a business bot cannot reopen a goal task');
      }
      const access = accessFor(task);
      if (!access.ok) return access;

      if (typeof task.openAcceptanceId === 'string' && task.openAcceptanceId !== '') {
        return rework({ ...input, acceptanceId: task.openAcceptanceId, taskId: task.id });
      }

      const queued = runtime.runs
        .list({ taskId: task.id })
        .find((run) => run.state === 'queued' && run.kind === 'rework');
      if (queued) {
        return ok('rework', {
          task: summarizeTask(runtime, task),
          acceptance: null,
          reworkRun: runView(queued),
        });
      }

      return validationError('no open acceptance or queued rework run for this task', {
        taskId: task.id,
        state: task.state,
      });
    });
  }

  return buildToolset({
    role: AGENT_ROLES.BUSINESS,
    allowed: ROLE_TOOLS.business,
    implementations: { plan, dispatch, accept, rework },
  });
}
