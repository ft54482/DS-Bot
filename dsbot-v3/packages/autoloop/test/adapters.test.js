import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGitGhMerger,
  createLoop,
  createSaScheduler,
} from '../src/index.js';
import { createMemoryStore } from '../src/store.js';

function createFakeSa() {
  const entries = [];
  let seq = 0;
  return {
    entries,
    async dispatch({ ticket }) {
      seq += 1;
      const id = `sa-${seq}`;
      entries.push({ id, taskId: ticket.taskId, state: 'running' });
      return { id };
    },
    async list() {
      return entries.map((entry) => ({ ...entry }));
    },
    async rework({ id }) {
      seq += 1;
      const original = entries.find((entry) => entry.id === id);
      const nextId = `sa-${seq}`;
      entries.push({ id: nextId, taskId: original.taskId, state: 'running' });
      return { id: nextId };
    },
  };
}

test('createSaScheduler enforces slots, collects once and reworks', async () => {
  const sa = createFakeSa();
  const scheduler = createSaScheduler({ sa, maxSlots: 1 });

  assert.equal(await scheduler.freeSlots(), 1);
  const dispatched = await scheduler.dispatch({
    taskId: 'T1',
    lane: 'lane-1',
    title: 'fix',
    goal: 'fix',
    budgetCny: 30,
    round: 1,
    attempt: 1,
    reworkRound: 0,
    idempotencyKey: 'key-1',
  });
  assert.equal(dispatched.workOrderId, 'sa-1');
  assert.equal(await scheduler.freeSlots(), 0);
  assert.deepEqual(await scheduler.collect(), []);

  sa.entries[0].state = 'review';
  sa.entries[0].result = { commit: 'c1', costCny: 2.5, output: 'done' };
  const submissions = await scheduler.collect();
  assert.deepEqual(submissions, [
    {
      taskId: 'T1',
      workOrderId: 'sa-1',
      commit: 'c1',
      costCny: 2.5,
      output: 'done',
      tests: null,
    },
  ]);
  assert.deepEqual(await scheduler.collect(), []);

  const rework = await scheduler.rework({
    taskId: 'T1',
    lane: 'lane-1',
    workOrderId: 'sa-1',
    feedback: 'tests failed',
    round: 1,
    reworkRound: 1,
  });
  assert.equal(rework.workOrderId, 'sa-2');
});

test('createSaScheduler treats review as idle and re-collects in-place rework', async () => {
  const entries = [
    { id: 'sa-1', taskId: 'T1', state: 'review', result: { commit: 'c1' } },
  ];
  const sa = {
    async dispatch() {
      return { id: 'sa-2' };
    },
    async list() {
      return entries.map((entry) => ({ ...entry }));
    },
    async rework({ id }) {
      const entry = entries.find((candidate) => candidate.id === id);
      entry.state = 'review';
      entry.result = { commit: 'c2' };
      return { id };
    },
  };

  const scheduler = createSaScheduler({ sa, maxSlots: 1 });
  assert.equal(await scheduler.freeSlots(), 1);
  assert.equal((await scheduler.collect()).length, 1);
  assert.equal((await scheduler.collect()).length, 0);

  const rework = await scheduler.rework({
    taskId: 'T1',
    lane: 'lane-1',
    workOrderId: 'sa-1',
    feedback: 'again',
    round: 1,
    reworkRound: 1,
  });
  assert.equal(rework.workOrderId, 'sa-1');
  assert.equal((await scheduler.collect()).length, 1);
});

test('createGitGhMerger merges with git and opens the optional PR', async () => {
  const calls = [];
  const git = {
    async merge(request) {
      calls.push(request);
      return { merged: true, commit: request.commit };
    },
  };
  const gh = {
    async openPr(request) {
      return { url: 'https://example.invalid/pr/1', number: 1, ...request };
    },
  };

  const merger = createGitGhMerger({ git, gh });
  const result = await merger.merge({
    task: { id: 'T1', lane: 'lane-1', title: 'fix' },
    submission: { commit: 'c1' },
    round: 1,
  });

  assert.equal(result.merged, true);
  assert.equal(result.commit, 'c1');
  assert.equal(result.pr.number, 1);
  assert.equal(calls[0].lane, 'lane-1');
});

test('createGitGhMerger reports a conflict and survives a gh failure', async () => {
  const conflict = createGitGhMerger({
    git: { async merge() { return { merged: false, conflict: 'parser.js' }; } },
  });
  const failed = await conflict.merge({
    task: { id: 'T1', lane: 'lane-1' },
    submission: { commit: 'c1' },
    round: 1,
  });
  assert.equal(failed.merged, false);
  assert.equal(failed.error, 'parser.js');

  const ghBroken = createGitGhMerger({
    git: { async merge() { return { merged: true, commit: 'c1' }; } },
    gh: {
      async openPr() {
        throw new Error('gh offline');
      },
    },
  });
  const merged = await ghBroken.merge({
    task: { id: 'T1', lane: 'lane-1' },
    submission: { commit: 'c1' },
    round: 1,
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.ghError, 'gh offline');
});

test('createLoop composes injected sa/git/gh interfaces end to end', async () => {
  const sa = createFakeSa();
  const gitCalls = [];
  const prCalls = [];
  const git = {
    async merge(request) {
      gitCalls.push(request);
      return { merged: true, commit: request.commit };
    },
  };
  const gh = {
    async openPr(request) {
      prCalls.push(request);
      return { number: 11, url: 'https://example.invalid/pr/11' };
    },
  };

  const loop = createLoop({
    goalEngine: {
      plan({ round }) {
        if (round === 1) {
          return { tasks: [{ id: 'T1', lane: 'lane-1', title: 'fix' }] };
        }
        return { done: true };
      },
    },
    sa,
    git,
    gh,
    verifier: {
      async verify() {
        return '{"verdict":"PASS","feedback":"ok"}';
      },
    },
    store: createMemoryStore(),
    clock: () => 1_700_000_000_000,
    loopId: 'adapter-loop',
    maxSlots: 1,
  });

  await loop.step(); // plan
  await loop.step(); // dispatch into sa
  assert.equal(sa.entries.length, 1);

  sa.entries[0].state = 'review';
  sa.entries[0].result = { commit: 'c1', costCny: 2 };
  const collected = await loop.step(); // collect from sa
  assert.equal(collected.next, 'verify');

  await loop.step(); // verify
  const merged = await loop.step(); // merge through git/gh
  assert.equal(merged.next, 'next');
  assert.equal(gitCalls.length, 1);
  assert.equal(prCalls.length, 1);
  assert.equal(loop.snapshot().tasks.T1.state, 'merged');
});
