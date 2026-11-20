import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256, validateResult } from '../src/contract.js';
import { defaultContentSteps, createToolChainAdapter } from '../src/tool_chain.js';
import { createClock, dispatchEnvelope } from './helpers/harness.js';

test('tool_chain: default content chain runs synchronously to completion', async () => {
  const clock = createClock();
  const adapter = createToolChainAdapter({ now: clock.now });
  const dispatched = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'tool_chain' }));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.state, 'completed');
  assert.deepEqual(dispatched.detail.steps, ['retrieve', 'snapshot', 'fact_check', 'write', 'review', 'typeset']);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'completed');
  assert.equal(status.progress.steps_completed, 6);
  assert.equal(status.progress.steps_total, 6);

  const page = await adapter.follow('run-1', 0);
  const types = page.events.map((event) => event.type);
  assert.equal(types[0], 'run.started');
  assert.equal(types.at(-1), 'run.completed');
  assert.equal(types.filter((type) => type === 'step.completed').length, 6);
  assert.equal(page.next_seq, page.events.at(-1).seq);

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.deepEqual(artifacts.items.map((item) => item.path), ['article-pack.json']);
  assert.equal(artifacts.items[0].sha256, sha256(JSON.stringify({ goal: '写一篇关于 AI 的文章', placeholder: true })));
  assert.ok(artifacts.items[0].bytes > 0);

  const evidence = await adapter.collectEvidence('run-1');
  assert.deepEqual(evidence.items.map((item) => item.kind), ['dispatch', ...Array(6).fill('step')]);

  const usage = await adapter.usage('run-1');
  assert.equal(usage.tokens_in, 0);
  assert.equal(usage.source, 'tool_chain_placeholder');
});

test('tool_chain: cancel while a step is running stops the chain before the next step', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let secondStepRan = false;
  const adapter = createToolChainAdapter({
    steps: [
      { name: 'retrieve', run: async () => { await gate; return { output: { sources: [] } }; } },
      { name: 'write', run: () => { secondStepRan = true; return { output: { manuscript: '' } }; } },
    ],
  });
  const dispatched = adapter.dispatch(dispatchEnvelope({ executor_kind: 'tool_chain' }));

  const cancel = await adapter.cancel({ run_id: 'run-1' });
  assert.equal(cancel.requested, true);
  assert.equal(cancel.state, 'cancelling');
  assert.equal(cancel.verified_stopped_at, null);

  release();
  const result = await dispatched;
  assert.equal(result.state, 'cancelled');
  assert.equal(secondStepRan, false);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'cancelled');
  assert.equal(typeof status.detail.stop_verified_at, 'number');
  const page = await adapter.follow('run-1', 0);
  assert.ok(page.events.some((event) => event.type === 'run.cancelled'));
  assert.ok(!page.events.some((event) => event.type === 'step.completed' && event.data.step === 'write'));
});

test('tool_chain: a step may cancel itself through ctx.cancel()', async () => {
  const adapter = createToolChainAdapter({
    steps: [
      { name: 'retrieve', run: (ctx) => { ctx.cancel('no_sources'); return { output: {} }; } },
      { name: 'write', run: () => ({ output: {} }) },
    ],
  });
  const result = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'tool_chain' }));
  assert.equal(result.state, 'cancelled');
  const page = await adapter.follow('run-1', 0);
  assert.ok(page.events.some((event) => event.type === 'run.cancelled' && event.data.reason === 'no_sources'));
});

test('tool_chain: a failing step ends the run as failed, not completed', async () => {
  const adapter = createToolChainAdapter({
    steps: [
      { name: 'snapshot', run: () => { throw new Error('snapshot store full'); } },
      { name: 'write', run: () => ({ output: {} }) },
    ],
  });
  const result = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'tool_chain' }));
  assert.equal(result.state, 'failed');
  const status = await adapter.status('run-1');
  assert.equal(status.state, 'failed');
  assert.equal(status.progress.health, 'no_progress');
  assert.equal(status.progress.failure.step, 'snapshot');
});

test('tool_chain: tracker is mandatory and unknown runs degrade to health=unknown', async () => {
  const adapter = createToolChainAdapter({});
  const noTracker = dispatchEnvelope({ executor_kind: 'tool_chain' });
  delete noTracker.tracking;
  const rejected = await adapter.dispatch(noTracker);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'tracker_missing');

  const unknown = await adapter.status('missing-run');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.progress.health, 'unknown');
});

test('tool_chain: results keep the shared contract shape', async () => {
  const adapter = createToolChainAdapter({ steps: defaultContentSteps() });
  const dispatched = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'tool_chain' }));
  const results = {
    dispatch: dispatched,
    status: await adapter.status('run-1'),
    cancel: await adapter.cancel('run-1'),
    follow: await adapter.follow('run-1', 0),
    collectArtifacts: await adapter.collectArtifacts('run-1'),
    collectEvidence: await adapter.collectEvidence('run-1'),
    usage: await adapter.usage('run-1'),
  };
  for (const [method, result] of Object.entries(results)) {
    const validation = validateResult(adapter, method, result);
    assert.deepEqual(validation.issues, [], `${method}: ${validation.issues}`);
  }
});
