import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHarness,
  goal,
  startInput,
} from './support/harness.js';

function startWithTitle(manager, title) {
  return manager.start(startInput({ goal: goal({ title }) }));
}

test('loop_status without loopId returns an empty list instead of an error', () => {
  const { manager } = createHarness();

  assert.deepEqual(manager.status(), { loops: [], count: 0 });
  assert.deepEqual(manager.status(''), { loops: [], count: 0 });
  assert.deepEqual(manager.status(null), { loops: [], count: 0 });
});

test('loop_status without loopId lists one loop with id, state, goal and startedAt', async () => {
  const { manager } = createHarness();
  const started = await startWithTitle(manager, 'one loop');

  const listed = manager.status();

  assert.equal(listed.count, 1);
  assert.equal(listed.loops.length, 1);
  const [item] = listed.loops;
  assert.equal(item.loopId, started.loopId);
  assert.equal(item.state, started.state);
  assert.equal(item.goal, 'one loop');
  assert.equal(item.running, true);
  assert.equal(item.iteration, started.iteration);
  assert.equal(typeof item.startedAt, 'number');
  assert.ok(item.startedAt > 0, 'startedAt is an epoch-millisecond timestamp');
});

test('loop_status without loopId lists every loop', async () => {
  const { manager } = createHarness();
  const first = await startWithTitle(manager, 'first loop');
  const second = await startWithTitle(manager, 'second loop');

  const listed = manager.status();

  assert.equal(listed.count, 2);
  assert.deepEqual(
    listed.loops.map((item) => item.loopId),
    [first.loopId, second.loopId],
  );
  assert.deepEqual(
    listed.loops.map((item) => item.goal),
    ['first loop', 'second loop'],
  );
});

test('an unknown loopId reports loop_not_found with up to five available ids', async () => {
  const { manager } = createHarness();
  const ids = [];
  for (let index = 1; index <= 6; index += 1) {
    const started = await startWithTitle(manager, `loop ${index}`);
    ids.push(started.loopId);
  }

  assert.throws(
    () => manager.status('loop-missing'),
    (error) => {
      assert.equal(error.code, 'loop_not_found');
      assert.equal(error.details.loopId, 'loop-missing');
      assert.deepEqual(error.details.available, ids.slice(0, 5));
      for (const id of ids.slice(0, 5)) {
        assert.match(error.message, new RegExp(id));
      }
      assert.doesNotMatch(error.message, new RegExp(ids[5]));
      assert.match(error.message, /omit loopId/i);
      return true;
    },
  );
});

test('an unknown loopId with no loops explains how to create one', () => {
  const { manager } = createHarness();

  assert.throws(
    () => manager.status('loop-missing'),
    (error) => {
      assert.equal(error.code, 'loop_not_found');
      assert.match(error.message, /no loops exist yet/);
      assert.match(error.message, /loop_start/);
      return true;
    },
  );
});

test('loop_stop without loopId stops the only running loop', async () => {
  const { manager } = createHarness();
  const started = await startWithTitle(manager, 'only loop');

  const stopped = await manager.stop(undefined, 'done by default');

  assert.equal(stopped.loopId, started.loopId);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.running, false);
  assert.equal(stopped.stoppedReason, 'done by default');
  assert.equal(stopped.irreversible, true);
  assert.equal(manager.status(started.loopId).state, 'stopped');
});

test('loop_stop without loopId refuses several running loops with ambiguous_loop', async () => {
  const { manager } = createHarness();
  const first = await startWithTitle(manager, 'first running');
  const second = await startWithTitle(manager, 'second running');

  await assert.rejects(manager.stop(), (error) => {
    assert.equal(error.code, 'ambiguous_loop');
    assert.deepEqual(error.details.candidates, [first.loopId, second.loopId]);
    assert.match(error.message, /pass loopId/);
    for (const id of [first.loopId, second.loopId]) {
      assert.match(error.message, new RegExp(id));
    }
    return true;
  });

  assert.equal(manager.status(first.loopId).running, true);
  assert.equal(manager.status(second.loopId).running, true);
});

test('loop_stop without loopId ignores loops that already stopped', async () => {
  const { manager } = createHarness();
  const stopped = await startWithTitle(manager, 'already stopped');
  const running = await startWithTitle(manager, 'still running');
  await manager.stop(stopped.loopId, 'finished');

  const result = await manager.stop();

  assert.equal(result.loopId, running.loopId);
  assert.equal(result.state, 'stopped');
  assert.equal(manager.status(stopped.loopId).stoppedReason, 'finished');
});

test('loop_stop without loopId reports no running loop and lists the loops', async () => {
  const { manager } = createHarness();
  const started = await startWithTitle(manager, 'stopped loop');
  await manager.stop(started.loopId, 'done');

  await assert.rejects(manager.stop(), (error) => {
    assert.equal(error.code, 'loop_not_found');
    assert.match(error.message, /no running loop to stop/);
    assert.match(error.message, new RegExp(started.loopId));
    assert.deepEqual(error.details.available, [started.loopId]);
    return true;
  });
});

test('a stopped loop stays in the list with its stopped reason', async () => {
  const { manager } = createHarness();
  const started = await startWithTitle(manager, 'stop then list');
  await manager.stop(started.loopId, 'manual stop');

  const item = manager.status().loops.find((loop) => loop.loopId === started.loopId);

  assert.ok(item, 'the stopped loop is still listed');
  assert.equal(item.state, 'stopped');
  assert.equal(item.running, false);
  assert.equal(item.stoppedReason, 'manual stop');
  assert.equal(item.irreversible, true);
});

test('loop_status with a loopId still returns the original detail shape', async () => {
  const { manager } = createHarness();
  const started = await startWithTitle(manager, 'detail shape');

  assert.deepEqual(manager.status(started.loopId), {
    state: 'collect',
    iteration: 1,
    running: true,
  });
});
