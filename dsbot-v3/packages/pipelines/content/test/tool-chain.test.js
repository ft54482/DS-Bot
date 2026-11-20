import assert from 'node:assert/strict';
import test from 'node:test';

import { validateResult } from '../../../adapters/src/contract.js';
import { STAGES } from '../src/pipeline.js';
import { createContentToolChainAdapter } from '../src/tool-chain.js';
import {
  BODIES,
  SOURCE_A,
  SOURCE_B,
  TOPIC,
  createClock,
  createFetch,
  createSearch,
  createWriterModel,
  dispatchEnvelope,
} from './helpers/fixtures.js';

function createAdapter(overrides = {}) {
  const clock = overrides.clock ?? createClock();
  const search = overrides.search ?? createSearch();
  const fetcher = overrides.fetcher ?? createFetch();
  const model = overrides.model ?? createWriterModel();
  const adapter = createContentToolChainAdapter({
    now: clock.now,
    search: search.search,
    fetch: fetcher.fetch,
    model,
    ...overrides.adapterOptions,
  });
  return { adapter, clock, search, fetcher, model };
}

test('tool_chain: a successful dispatch produces the article-pack artifact and a valid contract run', async () => {
  const { adapter, clock } = createAdapter();

  const dispatched = await adapter.dispatch(dispatchEnvelope());
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.state, 'completed');
  assert.equal(dispatched.detail.outcome, 'ready_for_review');
  assert.deepEqual(dispatched.detail.steps, [...STAGES]);
  assert.deepEqual(dispatched.detail.artifacts, ['article-pack.json']);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'completed');
  assert.equal(status.progress.health, 'progress');
  assert.equal(status.progress.steps_completed, 6);
  assert.equal(status.progress.steps_total, 6);
  assert.equal(status.progress.current_step, 'typeset');
  assert.equal(status.progress.outcome, 'ready_for_review');

  const page = await adapter.follow('run-1', 0);
  assert.equal(page.events[0].type, 'run.started');
  assert.equal(page.events.at(-1).type, 'run.completed');
  assert.equal(page.events.filter((event) => event.type === 'step.started').length, 6);
  assert.equal(page.events.filter((event) => event.type === 'step.completed').length, 6);

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.deepEqual(artifacts.items.map((item) => item.path), ['article-pack.json']);
  assert.ok(artifacts.items[0].bytes > 0);

  const evidence = await adapter.collectEvidence('run-1');
  assert.equal(evidence.items.filter((item) => item.kind === 'step').length, 6);
  assert.equal(evidence.items.filter((item) => item.kind === 'artifact').length, 1);

  const usage = await adapter.usage('run-1');
  assert.equal(usage.source, 'model_call');
  assert.equal(usage.tokens_in, 120);
  assert.equal(usage.tokens_out, 80);
  assert.equal(usage.cost_cny, 0.02);

  const results = {
    dispatch: dispatched,
    status,
    cancel: await adapter.cancel('run-1'),
    follow: page,
    collectArtifacts: artifacts,
    collectEvidence: evidence,
    usage,
  };
  for (const [method, result] of Object.entries(results)) {
    const validation = validateResult(adapter, method, result);
    assert.deepEqual(validation.issues, [], `${method}: ${validation.issues}`);
  }

  assert.equal(results.cancel.requested, false);
  assert.equal(results.cancel.state, 'completed');
  assert.equal(results.cancel.code, 'already_finished');

  // An identical run id is rejected instead of silently overwriting the record.
  const duplicate = await adapter.dispatch(dispatchEnvelope());
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate_dispatch');
  assert.equal(duplicate.fallback, 'none');

  // The task goal doubles as the topic when inputs.topic is absent.
  const fallback = createAdapter();
  const fallbackRun = await fallback.adapter.dispatch(dispatchEnvelope({ inputs: {} }));
  assert.equal(fallbackRun.ok, true);
  assert.equal(fallbackRun.detail.outcome, 'ready_for_review');
  assert.equal(clock.now(), new Date(Date.UTC(2026, 10, 20, 15, 0, 0)).getTime());
});

test('tool_chain: a blocked factual outcome is reported without pretending to be ready', async () => {
  const clock = createClock();
  const { adapter } = createAdapter({
    clock,
    fetcher: createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED' } }),
  });

  const dispatched = await adapter.dispatch(dispatchEnvelope());
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.state, 'completed');
  assert.equal(dispatched.detail.outcome, 'blocked');
  assert.equal(dispatched.detail.blocked, true);
  assert.ok(dispatched.detail.blocked_reasons.includes('key_fact_unverified'));
  assert.deepEqual(dispatched.detail.steps, ['retrieve', 'snapshot', 'fact_check']);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'completed');
  assert.equal(status.progress.health, 'no_progress');
  assert.equal(status.progress.outcome, 'blocked');
  assert.equal(status.progress.blocked, true);
  assert.ok(status.progress.blocked_reasons.includes('key_fact_unverified'));

  const page = await adapter.follow('run-1', 0);
  assert.ok(!page.events.some((event) => event.type === 'step.started' && event.data.step === 'write'));
  const completed = page.events.find((event) => event.type === 'run.completed');
  assert.equal(completed.data.outcome, 'blocked');

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.equal(artifacts.items.length, 1);

  const usage = await adapter.usage('run-1');
  assert.equal(usage.tokens_in, 0);
  assert.equal(usage.source, 'unavailable');

  for (const [method, result] of Object.entries({
    dispatch: dispatched,
    status,
    follow: page,
    collectArtifacts: artifacts,
    usage,
  })) {
    const validation = validateResult(adapter, method, result);
    assert.deepEqual(validation.issues, [], `${method}: ${validation.issues}`);
  }
});

test('tool_chain: cancel during a stage stops the chain before the next stage and verifies the stop', async () => {
  const clock = createClock();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetcher = async (url) => {
    if (url === SOURCE_A) {
      await gate;
      return { ok: true, text: BODIES[SOURCE_A] };
    }
    return { ok: true, text: BODIES[url] };
  };
  const model = createWriterModel();
  const adapter = createContentToolChainAdapter({
    now: clock.now,
    search: createSearch().search,
    fetch: fetcher,
    model,
  });

  const pending = adapter.dispatch(dispatchEnvelope());
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = await adapter.cancel('run-1');
  assert.equal(cancelled.requested, true);
  assert.equal(cancelled.state, 'cancelling');
  assert.equal(cancelled.verified_stopped_at, null);
  assert.equal(cancelled.remote_may_still_run, false);

  release();
  const dispatched = await pending;
  assert.equal(dispatched.state, 'cancelled');
  assert.equal(dispatched.detail.outcome, null);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'cancelled');
  assert.equal(typeof status.detail.stop_verified_at, 'number');
  assert.equal(status.progress.steps_completed, 2);

  const page = await adapter.follow('run-1', 0);
  assert.ok(page.events.some((event) => event.type === 'run.cancelled'));
  assert.ok(!page.events.some((event) => event.type === 'step.started' && event.data.step === 'fact_check'));
  assert.ok(!page.events.some((event) => event.type === 'step.started' && event.data.step === 'write'));
  assert.equal(model.calls.length, 0);

  const validation = validateResult(adapter, 'cancel', cancelled);
  assert.deepEqual(validation.issues, []);
});

test('tool_chain: a failing writer ends the run as failed, not completed', async () => {
  const { adapter } = createAdapter({
    model: {
      write: async () => {
        throw new Error('writer exploded');
      },
    },
  });

  const dispatched = await adapter.dispatch(dispatchEnvelope());
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.state, 'failed');
  assert.equal(dispatched.detail.failure.code, 'pipeline_failed');
  assert.match(dispatched.detail.failure.message, /writer exploded/);

  const status = await adapter.status('run-1');
  assert.equal(status.state, 'failed');
  assert.equal(status.progress.health, 'no_progress');
  assert.equal(status.progress.failure.code, 'pipeline_failed');

  const page = await adapter.follow('run-1', 0);
  assert.ok(page.events.some((event) => event.type === 'step.failed' && event.data.step === 'write'));
  assert.ok(page.events.some((event) => event.type === 'run.failed'));

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.deepEqual(artifacts.items, []);
});

test('tool_chain: tracker, unknown runs and contract shape stay honest', async () => {
  const { adapter } = createAdapter();

  const noTracker = dispatchEnvelope();
  delete noTracker.tracking;
  const rejected = await adapter.dispatch(noTracker);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.code, 'tracker_missing');
  assert.equal(rejected.fallback, 'none');
  assert.deepEqual(validateResult(adapter, 'dispatch', rejected).issues, []);

  const unknown = await adapter.status('missing-run');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.progress.health, 'unknown');
  assert.deepEqual(validateResult(adapter, 'status', unknown).issues, []);

  const unknownCancel = await adapter.cancel('missing-run');
  assert.equal(unknownCancel.ok, true);
  assert.equal(unknownCancel.state, 'unknown');
  assert.equal(unknownCancel.code, 'unknown_run');
  assert.deepEqual(validateResult(adapter, 'cancel', unknownCancel).issues, []);

  const unknownFollow = await adapter.follow('missing-run', 3);
  assert.equal(unknownFollow.next_seq, 3);
  assert.deepEqual(validateResult(adapter, 'follow', unknownFollow).issues, []);

  const unknownArtifacts = await adapter.collectArtifacts('missing-run');
  assert.deepEqual(unknownArtifacts.items, []);
  assert.deepEqual(validateResult(adapter, 'collectArtifacts', unknownArtifacts).issues, []);

  const unknownEvidence = await adapter.collectEvidence('missing-run');
  assert.deepEqual(unknownEvidence.items, []);
  assert.deepEqual(validateResult(adapter, 'collectEvidence', unknownEvidence).issues, []);

  const unknownUsage = await adapter.usage('missing-run');
  assert.equal(unknownUsage.source, 'unavailable');
  assert.deepEqual(validateResult(adapter, 'usage', unknownUsage).issues, []);

  const invalid = await adapter.dispatch({ run: { id: '' }, taskPack: { goal: '' }, tracking: { status: true } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_request');
  assert.deepEqual(validateResult(adapter, 'dispatch', invalid).issues, []);
});

test('tool_chain: injected pipeline configuration is honored', async () => {
  const clock = createClock();
  const search = createSearch([
    { url: SOURCE_A, title: 'A', claims: [{ text: 'A single-source claim.', key: true }] },
  ]);
  const adapter = createContentToolChainAdapter({
    now: clock.now,
    search: search.search,
    fetch: createFetch().fetch,
    model: createWriterModel(),
    minTitleCandidates: 2,
  });

  const dispatched = await adapter.dispatch(
    dispatchEnvelope({ inputs: { topic: TOPIC, min_title_candidates: 2 } }),
  );
  assert.equal(dispatched.detail.outcome, 'ready_for_review');
  const status = await adapter.status('run-1');
  assert.equal(status.progress.steps_total, STAGES.length);
});
