import test from 'node:test';

import {
  expectDeepEqual,
  expectEqual,
  expectFalse,
  expectTrue,
} from './support/conformance.js';
import { openRuntime } from './support/harness.js';

/**
 * Load the L12 authorization gate when the repository has it.
 *
 * The gate is a separate package (`packages/authz`, PRD 02 §4.1/§4.2). It is
 * not part of the base revision this suite was written on, so the rule checks
 * below are marked TODO instead of silently passing when it is absent. When the
 * package is present the assertions run for real against the same runtime
 * task records, and the TODO disappears.
 */
async function loadAuthzGate() {
  try {
    return await import('../../packages/authz/src/index.js');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('authz')) {
      return null;
    }
    throw error;
  }
}

test('[PRD 02 §4.1 / 03 §5.1.2 G27] a child auth_scope may only narrow the parent grant', async (t) => {
  const { runtime } = openRuntime(t);

  const parentScope = Object.freeze({
    projects: ['ai-video'],
    paths: ['src/'],
    tools: ['read', 'write'],
    spend_cny_cap: 50,
  });
  const childScope = Object.freeze({
    projects: ['ai-video'],
    paths: ['src/app/'],
    tools: ['read'],
    spend_cny_cap: 20,
  });

  const parent = runtime.tasks.create({ level: 'goal', title: '父目标', authScope: parentScope });
  const child = runtime.tasks.create({
    level: 'business',
    parentTaskId: parent.id,
    title: '子任务',
    authScope: childScope,
  });

  // The data path the gate needs must exist even when the gate is not wired.
  expectDeepEqual('02 §4.1', 'the runtime keeps the parent grant', parent.authScope, parentScope);
  expectDeepEqual('02 §4.1', 'the runtime keeps the child grant', child.authScope, childScope);

  const authz = await loadAuthzGate();
  if (!authz) {
    t.todo(
      'packages/authz (L12 gate) is absent from the base revision; this subset assertion runs once that package lands',
    );
    return;
  }

  const narrowed = authz.effectiveScope(parent.authScope, child.authScope);
  expectTrue('02 §4.1', 'a narrowing child is accepted', narrowed.ok);
  expectDeepEqual('02 §4.1', 'the effective scope is the child grant', narrowed.scope, childScope);

  const widened = authz.effectiveScope(parent.authScope, {
    ...childScope,
    projects: ['ai-video', 'gd-customer-service'],
  });
  expectFalse('02 §4.1', 'a child that adds a project is rejected', widened.ok);
  expectEqual('02 §4.1', 'the denial code is authorization_exceeded', widened.code, 'authorization_exceeded');
});

test('[PRD 02 §4.2 / 04 §1.6] the effective budget is the minimum of the chain', async (t) => {
  const { runtime } = openRuntime(t);

  const parent = runtime.tasks.create({
    level: 'goal',
    title: '父目标',
    budget: { capCny: 100 },
  });
  const child = runtime.tasks.create({
    level: 'business',
    parentTaskId: parent.id,
    title: '子任务',
    budget: { capCny: 25 },
  });

  expectEqual('02 §4.2', 'the runtime keeps the parent cap', parent.budget.capCny, 100);
  expectEqual('02 §4.2', 'the runtime keeps the child cap', child.budget.capCny, 25);

  const authz = await loadAuthzGate();
  if (!authz) {
    t.todo(
      'packages/authz (L12 gate) is absent from the base revision; the min-chain assertion runs once that package lands',
    );
    return;
  }

  // The child cap is the smallest link: 25 < parent remaining 40 < bot cap 80.
  const effective = authz.effectiveBudget({
    taskCap: child.budget.capCny,
    parentRemaining: 40,
    botCap: 80,
  });
  expectTrue('02 §4.2', 'the chain budget is accepted', effective.ok);
  expectEqual('02 §4.2', 'the effective cap is the smallest link', effective.cap, 25);

  const over = authz.effectiveBudget({
    taskCap: child.budget.capCny,
    parentRemaining: 40,
    botCap: 80,
    requested: 26,
  });
  expectFalse('04 §1.6', 'a commitment above the chain cap is rejected', over.ok);
  expectEqual('04 §1.6', 'the denial code is budget_exceeded', over.code, 'budget_exceeded');
});
