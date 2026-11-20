/**
 * Test doubles for the DS Bot command adapter.
 *
 * The adapter only parses and composes, so the suite uses a fake Chief and a
 * fake runtime. No real goal, acceptance, budget or stop implementation is
 * exercised here; that belongs to the packages this adapter calls.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createFakeChief({ results = {}, throws = {} } = {}) {
  const calls = {
    openGoal: [],
    status: [],
    delegate: [],
    deliver: [],
  };
  const configured = { ...results };
  const failures = { ...throws };

  function defaultResult(method, input) {
    switch (method) {
      case 'openGoal':
        return {
          ok: true,
          tool: 'openGoal',
          goalId: 'goal-1',
          goal: {
            id: 'goal-1',
            title: input.title,
            state: 'planned',
            budget: input.budgetCny == null ? null : { capCny: input.budgetCny },
          },
          task: { id: 'goal-1', title: input.title, level: 'goal' },
        };
      case 'status':
        return {
          ok: true,
          tool: 'status',
          goalId: input.goalId,
          goal: { id: input.goalId, title: '目标一', state: 'running' },
          businesses: [{ id: 'business-1', state: 'running' }],
          counts: { running: 1 },
          acceptance: { total: 1, passed: 1, rework: 0, blocked: 0, pending: 0, missing: 0 },
          cost: { cny: 2.5, capCny: 100, remainingCny: 97.5, entries: 3, runs: 1 },
          blockers: [],
        };
      case 'delegate':
        return {
          ok: true,
          tool: 'delegate',
          goalId: input.goalId,
          bot: input.bot,
          task: { id: 'business-1', title: input.brief, level: 'business' },
          businessTask: { id: 'business-1', title: input.brief, level: 'business' },
        };
      case 'deliver':
        return {
          ok: true,
          tool: 'deliver',
          goalId: input.goalId,
          title: '目标一',
          outcome: 'done',
          summary: '1 business delegation(s) passed acceptance for goal "目标一".',
          deliverables: [{ name: 'article', path: 'article.md' }],
          acceptance: { stage: 'business', result: 'passed', businesses: [{ task_id: 'business-1' }] },
          cost: { cny: 2.5, capCny: 100, remainingCny: 97.5 },
          risks: [],
          needs_decision: [],
        };
      default:
        throw new Error(`unknown fake chief method: ${method}`);
    }
  }

  function call(method, input) {
    calls[method].push(clone(input));
    if (failures[method]) throw failures[method];
    const configuredResult = configured[method];
    if (typeof configuredResult === 'function') return configuredResult(input);
    if (configuredResult !== undefined) return clone(configuredResult);
    return clone(defaultResult(method, input));
  }

  return {
    role: 'chief',
    calls,
    setResult(method, result) {
      configured[method] = result;
    },
    setThrow(method, error) {
      failures[method] = error;
    },
    openGoal(input = {}) {
      return call('openGoal', input);
    },
    status(input = {}) {
      return call('status', input);
    },
    delegate(input = {}) {
      return call('delegate', input);
    },
    deliver(input = {}) {
      return call('deliver', input);
    },
  };
}

export function createFakeRuntime({ withStop = true, result = null, error = null } = {}) {
  const calls = { stopRequest: [] };
  const runtime = { calls };

  if (withStop) {
    runtime.stop = {
      request(input = {}) {
        calls.stopRequest.push(clone(input));
        if (error) throw error;
        if (result !== null) return clone(result);
        return {
          requested: { id: input.taskId, state: 'stopping', stopState: 'requested' },
          tasks: [{ id: input.taskId, state: 'stopping' }],
          stopState: 'requested',
          blockers: [],
        };
      },
    };
  }

  return runtime;
}
