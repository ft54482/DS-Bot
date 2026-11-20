import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeWorld } from './support/world.js';

function observableWorld() {
  return createFakeWorld({
    tasks: [
      { id: 'api-r1', lane: 'api', budgetCny: 30 },
      { id: 'worker-r1', lane: 'worker', budgetCny: 30 },
      { id: 'ui-r1', lane: 'ui', budgetCny: 30 },
    ],
    batchSize: 1,
    maxSlots: 3,
    budgetCny: 30,
    loopId: 'observability',
  });
}

test('observability: every round records iteration, actions and a queryable state snapshot', async (t) => {
  const world = observableWorld();
  await world.runToTerminal();

  const steps = world.store.steps();
  assert.equal(steps.length, world.log.length);
  assert.ok(steps.length > 0);
  for (const step of steps) {
    assert.equal(typeof step.iteration, 'number');
    assert.ok(step.iteration >= 1);
    assert.ok(Array.isArray(step.actions));
    assert.equal(typeof step.snapshot, 'object');
    assert.equal(step.snapshot.round, step.iteration);
    assert.equal(typeof step.state, 'string');
    assert.equal(typeof step.next, 'string');
  }

  const rounds = world.store.rounds();
  assert.deepEqual(
    rounds.map((round) => round.iteration),
    [1, 2, 3, 4],
  );

  for (const round of rounds.filter((entry) => entry.iteration <= 3)) {
    assert.deepEqual(round.states, [
      'plan',
      'dispatch',
      'collect',
      'verify',
      'merge',
      'next',
    ]);
    assert.ok(round.actions.some((action) => action.type === 'plan'));
    assert.ok(round.actions.some((action) => action.type === 'dispatch'));
    assert.ok(round.actions.some((action) => action.type === 'submission'));
    assert.ok(round.actions.some((action) => action.type === 'verify'));
    assert.equal(
      round.actions.filter((action) => action.type === 'merge').length,
      1,
    );
    assert.equal(round.actions.filter((action) => action.type === 'rework').length, 0);
    assert.equal(round.snapshots.length, 6);
    assert.ok(round.snapshots.every((snapshot) => snapshot.round === round.iteration));
    assert.ok(round.final.tasks);
  }

  const finalRound = world.store.round(4);
  assert.ok(finalRound);
  assert.deepEqual(finalRound.states, ['plan', 'next']);
  assert.ok(finalRound.actions.some((action) => action.type === 'plan'));
  assert.ok(finalRound.actions.some((action) => action.type === 'goal_done'));

  assert.equal(world.store.latest().state, 'done');
  assert.equal(world.store.status(), 'completed');
  assert.equal(world.store.round(99), null);

  t.diagnostic(
    `observability: rounds=${rounds.length}, steps=${steps.length}, saves=${world.store.saves().length}, status=${world.store.status()}`,
  );
});

test('observability: the persisted save stream is queryable by iteration and snapshot state', async () => {
  const world = observableWorld();
  await world.runToTerminal();

  const saves = world.store.saves();
  const steps = world.store.steps();
  assert.ok(saves.length >= steps.length);
  assert.ok(saves.length > 0);

  for (const save of saves) {
    assert.equal(typeof save.iteration, 'number');
    assert.equal(typeof save.state, 'string');
    assert.equal(typeof save.snapshot, 'object');
    assert.equal(save.snapshot.round, save.iteration);
    assert.equal(save.snapshot.state, save.state);
  }

  const savedStates = new Set(saves.map((save) => save.state));
  for (const state of ['plan', 'dispatch', 'collect', 'verify', 'merge', 'next', 'done']) {
    assert.ok(savedStates.has(state), `no persisted ${state} snapshot`);
  }

  const journal = world.store.journal();
  assert.equal(journal.saves.length, saves.length);
  assert.equal(journal.steps.length, steps.length);

  const roundOne = world.store.round(1);
  assert.ok(roundOne);
  assert.equal(roundOne.iteration, 1);
  assert.equal(roundOne.actions.filter((action) => action.type === 'plan').length, 1);
  assert.equal(roundOne.actions.filter((action) => action.type === 'dispatch').length, 1);
  assert.equal(roundOne.snapshots.at(-1).state, 'plan');
});
