import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createDevloopManager } from '../src/index.js';
import {
  BASE_SHA,
  SUBMISSION_SHA,
  createClock,
  createFakeFs,
  createFakeGh,
  createFakeGit,
  createFakeRunner,
  createFakeSa,
  createMerger,
  createScriptedScheduler,
  createVerifier,
  goal,
  lane,
  startInput,
} from './support/harness.js';

function idFactory() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `loop-compose-${sequence}`;
  };
}

test('composes the sa scheduler and the git/gh merger end to end', async () => {
  const sa = createFakeSa();
  const git = createFakeGit();
  const gh = createFakeGh();
  const manager = createDevloopManager({
    sa,
    git,
    gh,
    verifier: createVerifier('PASS'),
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(startInput());
  const finished = await manager.advance(started.loopId, { maxSteps: 24 });

  assert.equal(finished.state, 'done');
  assert.equal(sa.orders.length, 1);
  assert.match(sa.orders[0].idempotencyKey, /^autoloop:loop-compose-1:m1:ui:/);
  assert.equal(git.merges.length, 1);
  assert.equal(git.merges[0].commit, SUBMISSION_SHA);
  assert.equal(gh.pullRequests.length, 1);
  assert.match(gh.pullRequests[0].title, /ui/);
});

test('the verifier port runs verifier-agent with the injected runner', async () => {
  const runner = createFakeRunner();
  const manager = createDevloopManager({
    scheduler: createScriptedScheduler({ collect: 'immediate' }),
    merger: createMerger(),
    runner,
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(
    startInput({ lanes: [lane({ acceptanceCommands: ['node --test packages/ui/test'] })] }),
  );
  const finished = await manager.advance(started.loopId, { maxSteps: 24 });

  assert.equal(finished.state, 'done');
  assert.deepEqual(
    runner.calls.filter((call) => call.step === 'run'),
    [{ step: 'run', command: 'node --test packages/ui/test' }],
  );
  const prepare = runner.calls.find((call) => call.step === 'prepare');
  assert.deepEqual(prepare.options, { expectedHead: SUBMISSION_SHA, fresh: false });
});

test('without a runner the verifier port fails closed and the loop stops', async () => {
  const manager = createDevloopManager({
    scheduler: createScriptedScheduler({ collect: 'immediate' }),
    merger: createMerger(),
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(startInput());
  const finished = await manager.advance(started.loopId, { maxSteps: 48 });

  assert.equal(finished.state, 'stopped');
  assert.equal(finished.running, false);
});

test('provisioning uses only the injected fs adapter', async () => {
  const fs = createFakeFs();
  const manager = createDevloopManager({
    scheduler: createScriptedScheduler(),
    merger: createMerger(),
    verifier: createVerifier(),
    fs,
    provision: {
      repo: 'ft54482/superagent-lab-smoke',
      workRoot: path.join(fs.homedir(), 'work'),
      model: 'test/model',
    },
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(startInput());

  assert.ok(started.instance, 'the loop reports its provisioned instance');
  assert.ok(started.instance.profileDir.startsWith(fs.homedir()));
  const patchPath = path.join(started.instance.profileDir, 'cordis.patch.yml');
  assert.ok(fs.exists(patchPath), 'the profile patch was written to the fake fs');
  assert.match(fs.readFile(patchPath), /webserver:/);
  assert.equal(manager.get(started.loopId).instance.port, started.instance.port);
});

test('provisioning stays off unless the config enables it', async () => {
  const fs = createFakeFs();
  let calls = 0;
  const manager = createDevloopManager({
    scheduler: createScriptedScheduler(),
    merger: createMerger(),
    verifier: createVerifier(),
    fs,
    provisioner: { provision: async () => { calls += 1; return {}; } },
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(startInput());

  assert.equal(calls, 0);
  assert.equal(manager.get(started.loopId).instance, null);
});

test('missing sa/git seams report missing_dependency', async () => {
  const manager = createDevloopManager({
    verifier: createVerifier(),
    clock: createClock(),
    idFactory: idFactory(),
  });

  await assert.rejects(manager.start(startInput()), (error) => {
    assert.equal(error.code, 'missing_dependency');
    return true;
  });
});

test('maxWorkers caps the sa scheduler slots', async () => {
  const sa = createFakeSa();
  const manager = createDevloopManager({
    sa,
    git: createFakeGit(),
    verifier: createVerifier('PASS'),
    clock: createClock(),
    idFactory: idFactory(),
  });

  await manager.start(
    startInput({
      maxWorkers: 1,
      lanes: [lane({ lane: 'ui' }), lane({ lane: 'api', dir: 'packages/api' })],
    }),
  );

  assert.equal(sa.orders.length, 1, 'only one work order fits the single slot');
  assert.equal(manager.get('loop-compose-1').maxWorkers, 1);
});

test('the plan port reports done only when every task merged', async () => {
  const scheduler = createScriptedScheduler({ collect: 'immediate' });
  const manager = createDevloopManager({
    scheduler,
    merger: createMerger(),
    verifier: createVerifier('PASS'),
    clock: createClock(),
    idFactory: idFactory(),
  });

  const started = await manager.start(
    startInput({ goal: { title: 'two lanes', baseSha: BASE_SHA }, lanes: [lane({ lane: 'ui' }), lane({ lane: 'api', dir: 'packages/api' })] }),
  );
  const finished = await manager.advance(started.loopId, { maxSteps: 32 });

  assert.equal(finished.state, 'done');
  assert.equal(scheduler.calls.dispatch, 2);
  assert.equal(goal().title, 'Ship the export button');
});
