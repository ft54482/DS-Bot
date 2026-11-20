/**
 * Chief tool surface (PRD FR-14).
 *
 * The Chief coordinates the goal tree and its business delegations. It owns no
 * execution dispatch: `dispatch` is not part of this surface, and every other
 * tool checks the goal/business hierarchy before touching the runtime. All
 * implementation work stays in the L9 runtime facade (task service, acceptance
 * service, stop controls, cost ledger); this module only authorizes and calls.
 */

import { effectiveScope } from '../../authz/src/index.js';
import { LEVEL_RANK } from '../../authz/src/constants.js';
import { buildToolset } from './toolset.js';
import { AGENT_ROLES, ROLE_TOOLS } from './constants.js';
import { checkBudget } from './budget.js';
import { summarizeTask, countByState } from './summary.js';
import {
  assertFunction,
  assertRuntime,
  humanSignoffAttempt,
  readRequestedCap,
  readString,
  readSubject,
  summarizeTasks,
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
import { checkDelegationLevel, checkProject, readAgentScope } from './scope.js';

function ownerRef(input) {
  if (typeof input.owner === 'string' && input.owner !== '') return input.owner;
  if (typeof input.toBot === 'string' && input.toBot !== '') {
    return input.toBot.startsWith('bot:') ? input.toBot : `bot:${input.toBot}`;
  }
  return null;
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

function capOf(task) {
  if (task?.budget == null) return null;
  for (const key of ['capCny', 'cny_cap', 'cap_cny']) {
    const value = task.budget[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function createChiefTools({ runtime, scope } = {}) {
  assertRuntime(runtime);
  assertFunction(runtime.tasks, 'delegate', 'runtime.tasks.delegate');
  assertFunction(runtime.acceptances, 'get', 'runtime.acceptances.get');
  assertFunction(runtime.stop, 'stop', 'runtime.stop.stop');
  const botScope = readAgentScope(scope, 'chief scope');

  function delegate(input = {}) {
    return guard(() => {
      const goalId = readString(input.goalTaskId ?? input.parentTaskId ?? input.taskId, 'goalTaskId');
      if (!goalId.ok) return goalId.result;
      const title = readString(input.title, 'title');
      if (!title.ok) return title.result;

      const goal = runtime.tasks.get(goalId.value);
      if (goal.level !== 'goal') {
        return notAllowed(
          AGENT_ROLES.CHIEF,
          'delegate',
          'the Chief delegates business tasks under a goal; execution work is owned by a business bot',
        );
      }

      const access = taskAccess(runtime, botScope, goal);
      if (!access.ok) return access;

      let project = access.project;
      if (input.project != null) {
        const requestedProject = readString(input.project, 'project');
        if (!requestedProject.ok) return requestedProject.result;
        if (access.project !== null && requestedProject.value !== access.project) {
          return authorizationExceeded(
            `goal ${goal.id} belongs to project ${access.project}; a delegation cannot switch projects`,
            { goalId: goal.id, goalProject: access.project, requestedProject: requestedProject.value },
          );
        }
        const projectCheck = checkProject(access.scope, requestedProject.value);
        if (!projectCheck.ok) {
          return authorizationExceeded(projectCheck.message, projectCheck.details);
        }
        project = requestedProject.value;
      }

      const levelCheck = checkDelegationLevel(access.scope, 'business');
      if (!levelCheck.ok) {
        return authorizationExceeded(levelCheck.message, levelCheck.details);
      }

      const requestedScope = input.scope ?? input.authScope ?? {};
      if (typeof requestedScope !== 'object' || Array.isArray(requestedScope) || requestedScope === null) {
        return validationError('scope must be a plain object', { field: 'scope' });
      }
      // A business delegation may delegate execution work at most; a wider
      // requested ceiling is clamped so the child scope stays usable.
      const requestedCeiling = requestedScope.max_delegate_level;
      if (
        requestedCeiling != null &&
        !Object.prototype.hasOwnProperty.call(LEVEL_RANK, requestedCeiling)
      ) {
        return validationError(
          `scope.max_delegate_level must be one of ${Object.keys(LEVEL_RANK).join(', ')}`,
          { max_delegate_level: requestedCeiling },
        );
      }
      const childCeiling =
        requestedCeiling != null && LEVEL_RANK[requestedCeiling] < LEVEL_RANK.business
          ? requestedCeiling
          : 'business';
      const containment = effectiveScope(access.scope, {
        ...requestedScope,
        max_delegate_level: childCeiling,
      });
      if (!containment.ok) {
        return authorizationExceeded('the delegated scope exceeds the Chief scope', {
          goalId: goal.id,
          violations: containment.violations,
        });
      }

      const requested = readRequestedCap(input);
      if (!requested.ok) return requested.result;

      if (requested.cap !== null) {
        const budget = checkBudget({
          runtime,
          parentTask: goal,
          scope: access.scope,
          requested: requested.cap,
        });
        if (!budget.ok) return budget;
      }

      const subject = readSubject(input.subject);
      if (!subject.ok) return subject.result;
      if (project !== null) subject.subject.project = project;

      const child = runtime.tasks.delegate({
        parentTaskId: goal.id,
        level: 'business',
        title: title.value,
        owner: ownerRef(input),
        subject: Object.keys(subject.subject).length > 0 ? subject.subject : null,
        budget: requested.budget,
        acceptanceProfile: input.acceptanceProfile ?? null,
        authScope: containment.scope,
      });

      return ok('delegate', { task: summarizeTask(runtime, child) });
    });
  }

  function status(input = {}) {
    return guard(() => {
      if (input.taskId != null) {
        const taskId = readString(input.taskId, 'taskId');
        if (!taskId.ok) return taskId.result;
        const task = runtime.tasks.get(taskId.value);
        const access = taskAccess(runtime, botScope, task);
        if (!access.ok) return access;

        const children = runtime.tasks.list({ parentTaskId: task.id });
        return ok('status', {
          task: summarizeTask(runtime, task, { project: access.project }),
          children: children.map((child) => summarizeTask(runtime, child)),
          counts: countByState(children),
        });
      }

      const tasks = runtime.tasks.list().filter((task) => taskAccess(runtime, botScope, task).ok);
      return ok('status', {
        tasks: summarizeTasks(runtime, tasks),
        counts: countByState(tasks),
      });
    });
  }

  function accept(input = {}) {
    return guard(() => {
      const acceptanceId = readString(input.acceptanceId, 'acceptanceId');
      if (!acceptanceId.ok) return acceptanceId.result;

      const acceptance = runtime.acceptances.get(acceptanceId.value);
      const task = runtime.tasks.get(acceptance.taskId);
      const access = taskAccess(runtime, botScope, task);
      if (!access.ok) return access;

      if (task.level !== 'goal') {
        return notAllowed(
          AGENT_ROLES.CHIEF,
          'accept',
          'the Chief decides the goal round only; business/execution acceptance belongs to the business bot',
        );
      }

      const humanItem = humanSignoffAttempt(input.itemStates);
      if (humanItem !== null) {
        return notAllowed(
          AGENT_ROLES.CHIEF,
          'accept',
          `human sign-off item ${humanItem} must be recorded by the human, not by the Chief`,
        );
      }

      const decided = runtime.acceptances.decide({
        acceptanceId: acceptance.id,
        verdict: input.verdict,
        itemStates: input.itemStates,
        reviewer: input.reviewer ?? { role: AGENT_ROLES.CHIEF, ref: 'chief' },
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
      });

      return ok('accept', {
        task: summarizeTask(runtime, decided.task),
        acceptance: acceptanceView(decided, acceptance),
        verdict: decided.verdict ?? input.verdict,
        ...(decided.reworkRun
          ? { reworkRun: { id: decided.reworkRun.id, state: decided.reworkRun.state } }
          : {}),
      });
    });
  }

  async function stop(input = {}) {
    return guardAsync(async () => {
      const taskId = readString(input.taskId, 'taskId');
      if (!taskId.ok) return taskId.result;
      const task = runtime.tasks.get(taskId.value);
      const access = taskAccess(runtime, botScope, task);
      if (!access.ok) return access;

      const result = await runtime.stop.stop({
        taskId: task.id,
        workspacePath: input.workspacePath ?? undefined,
        requestedBy: input.requestedBy ?? 'chief',
        reason: input.reason ?? 'chief_stop',
        idempotencyKey: input.idempotencyKey,
        minQuiescenceMs: input.minQuiescenceMs,
        force: input.force === true,
        decisionToken: input.decisionToken ?? null,
        deadlinePassed: input.deadlinePassed === true,
      });

      const stoppedTask = runtime.tasks.get(task.id);
      return ok('stop', {
        task: summarizeTask(runtime, stoppedTask),
        cancelled: result.cancelled === true,
        stopState: result.stopState ?? null,
        blockers: result.blockers ?? [],
        workspace: result.workspace ?? null,
      });
    });
  }

  function cost(input = {}) {
    return guard(() => {
      if (input.taskId != null) {
        const taskId = readString(input.taskId, 'taskId');
        if (!taskId.ok) return taskId.result;
        const task = runtime.tasks.get(taskId.value);
        const access = taskAccess(runtime, botScope, task);
        if (!access.ok) return access;

        const total = runtime.cost.total(task.id);
        const cap = capOf(task);
        return ok('cost', {
          taskId: task.id,
          total,
          cap,
          remaining: cap === null ? null : Math.max(0, cap - total.costCny),
        });
      }

      const tasks = runtime.tasks.list().filter((task) => taskAccess(runtime, botScope, task).ok);
      const rows = tasks.map((task) => runtime.cost.total(task.id));
      const total = rows.reduce(
        (accumulator, row) => ({
          entries: accumulator.entries + row.entries,
          tokensIn: accumulator.tokensIn + row.tokensIn,
          tokensOut: accumulator.tokensOut + row.tokensOut,
          tokensCached: accumulator.tokensCached + row.tokensCached,
          costCny: Number((accumulator.costCny + row.costCny).toFixed(6)),
        }),
        { entries: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costCny: 0 },
      );
      return ok('cost', { total, tasks: rows });
    });
  }

  return buildToolset({
    role: AGENT_ROLES.CHIEF,
    allowed: ROLE_TOOLS.chief,
    implementations: { delegate, status, accept, stop, cost },
  });
}
