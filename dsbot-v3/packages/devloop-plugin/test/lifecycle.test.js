import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BASE_SHA } from '../src/index.js';
import {
  createHarness,
  createScriptedScheduler,
  createVerifier,
  goal,
  lane,
  startInput,
} from './support/harness.js';

async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('start decomposes the goal into one task per lane and starts the loop', async () => {
  const { manager, scheduler } = createHarness();
  const started = await manager.start(
    startInput({
      lanes: [
        lane({ lane: 'ui', dir: 'packages/ui', cost: 2 }),
        lane({ lane: 'api', dir: 'packages/api', cost: 3 }),
      ],
      budgetCny: 10,
    }),
  );

  assert.equal(typeof started.loopId, 'string');
  assert.ok(started.loopId.length > 0);
  assert.equal(started.tasks, 2);
  assert.equal(started.budgetCny, 10);
  assert.equal(started.running, true);
  assert.equal(started.iteration, 1);
  assert.equal(started.state, 'collect');
  assert.equal(scheduler.calls.dispatch, 2);

  const summary = manager.get(started.loopId);
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.goal, goal().title);
});

test('a duplicate loop_start for the same goal fails with loop_exists', async () => {
  const { manager } = createHarness();
  const first = await manager.start(startInput());

  await rejectsWithCode(manager.start(startInput()), 'loop_exists');

  const stopped = await manager.stop(first.loopId, 'done for now');
  assert.equal(stopped.state, 'stopped');
  await rejectsWithCode(manager.start(startInput()), 'loop_exists');
});

test('an over-budget plan fails with budget_exceeded before the loop starts', async () => {
  const { manager } = createHarness();

  await assert.rejects(
    manager.start(
      startInput({
        lanes: [lane({ lane: 'ui', cost: 8 }), lane({ lane: 'api', dir: 'packages/api', cost: 5 })],
        budgetCny: 10,
      }),
    ),
    (error) => {
      assert.equal(error.code, 'budget_exceeded');
      assert.equal(error.details.total, 13);
      assert.equal(error.details.limit, 10);
      return true;
    },
  );
});

test('a goal-engine budget_exceeded is surfaced with the same code', async () => {
  const goalEngine = {
    decompose() {
      const error = new Error('engine says no');
      error.code = 'budget_exceeded';
      error.details = { total: 99, limit: 10 };
      throw error;
    },
  };
  const { manager } = createHarness({ goalEngine });

  await assert.rejects(manager.start(startInput()), (error) => {
    assert.equal(error.code, 'budget_exceeded');
    assert.deepEqual(error.details, { total: 99, limit: 10 });
    return true;
  });
});

test('an unknown loopId reports not_found for status and stop', async () => {
  const { manager } = createHarness();

  assert.throws(
    () => manager.status('loop-missing'),
    (error) => {
      assert.equal(error.code, 'not_found');
      assert.equal(error.details.loopId, 'loop-missing');
      return true;
    },
  );
  await rejectsWithCode(manager.stop('loop-missing', 'nope'), 'not_found');
});

test('loop_stop records the reason and status reports stopped', async () => {
  const { manager } = createHarness();
  const started = await manager.start(startInput());

  const stopped = await manager.stop(started.loopId, 'budget froze');
  assert.equal(stopped.loopId, started.loopId);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.iteration, started.iteration);
  assert.equal(stopped.running, false);
  assert.equal(stopped.stoppedReason, 'budget froze');
  assert.equal(stopped.irreversible, true);

  assert.deepEqual(manager.status(started.loopId), {
    state: 'stopped',
    iteration: started.iteration,
    running: false,
    stoppedReason: 'budget froze',
  });
  assert.equal(manager.get(started.loopId).irreversible, true);
});

test('stopping twice is idempotent and keeps the first reason', async () => {
  const { manager } = createHarness();
  const started = await manager.start(startInput());

  await manager.stop(started.loopId, 'first reason');
  const second = await manager.stop(started.loopId, 'second reason');

  assert.equal(second.stoppedReason, 'first reason');
  assert.equal(second.state, 'stopped');
});

test('loop_start defaults to the documented placeholder base sha', async () => {
  const { manager } = createHarness();

  const viaDefault = await manager.start(startInput({ goal: { title: 'no base' } }));
  assert.equal(viaDefault.baseSha, DEFAULT_BASE_SHA);

  const viaLane = await manager.start(
    startInput({
      goal: { title: 'lane carries the base' },
      lanes: [lane({ baseSha: 'c'.repeat(40) })],
    }),
  );
  assert.equal(viaLane.baseSha, null);
  assert.equal(manager.get(viaLane.loopId).state, 'collect');
});

test('loop_start validates budget, workers, lanes and the goal', async () => {
  const { manager } = createHarness();

  await rejectsWithCode(manager.start(startInput({ budgetCny: 0 })), 'invalid_input');
  await rejectsWithCode(manager.start(startInput({ budgetCny: Number.NaN })), 'invalid_input');
  await rejectsWithCode(manager.start(startInput({ maxWorkers: 0 })), 'invalid_input');
  await rejectsWithCode(manager.start(startInput({ maxWorkers: 1.5 })), 'invalid_input');
  await rejectsWithCode(manager.start(startInput({ lanes: [] })), 'invalid_input');
  await rejectsWithCode(manager.start(startInput({ goal: '   ' })), 'empty_goal');
  await rejectsWithCode(manager.start(startInput({ lanes: [{ lane: 'x' }] })), 'invalid_input');
  await rejectsWithCode(
    manager.start(startInput({ goal: { title: 'bad base', baseSha: 'not-a-sha' } })),
    'invalid_input',
  );
});

test('advance drives a PASS loop to done', async () => {
  const { manager, scheduler, merger } = createHarness({
    scheduler: createScriptedScheduler({ collect: 'immediate' }),
  });
  const started = await manager.start(startInput());

  const finished = await manager.advance(started.loopId, { maxSteps: 24 });

  assert.equal(finished.state, 'done');
  assert.equal(finished.running, false);
  assert.ok(finished.iteration >= 2, 'a second plan round concludes the goal');
  assert.equal(scheduler.calls.dispatch, 1);
  assert.equal(merger.merges.length, 1);
  assert.equal(merger.merges[0].submission.commit, 'b'.repeat(40));
});

test('a repeatedly failing lane self-stops and maps to stopped', async () => {
  const { manager, scheduler } = createHarness({
    scheduler: createScriptedScheduler({ collect: 'immediate' }),
    verifier: createVerifier('FAIL', 'tests fail'),
  });
  const started = await manager.start(startInput());

  const finished = await manager.advance(started.loopId, { maxSteps: 48 });

  assert.equal(finished.state, 'stopped');
  assert.equal(finished.running, false);
  assert.equal(finished.stoppedReason, 'rework_exceeded');
  assert.ok(scheduler.calls.rework >= 2, 'the lane was reworked before the stop');

  const explicit = await manager.stop(started.loopId, 'ignored');
  assert.equal(explicit.stoppedReason, 'rework_exceeded', 'the stop-loss reason is preserved');
});
