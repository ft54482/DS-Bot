import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuperagentAdapter } from '../src/superagent.js';
import { createExecutorRouter } from '../src/router.js';
import { validateContract, validateResult } from '../src/contract.js';
import { dispatchEnvelope, startFakeServer } from './helpers/harness.js';

const REPO = 'ft54482/superagent-lab-smoke';

function ticketFixture(overrides = {}) {
  const base = {
    id: 't1',
    state: 'working',
    source_url: `https://github.com/${REPO}/issues/42`,
    card: {
      pr: { number: 7, url: `https://github.com/${REPO}/pull/7` },
      usage: { tokens_in: 100, tokens_out: 20, tokens_cached: 5, cost_cny: 0.5 },
      artifacts: [{ path: 'out/article.md', bytes: 123 }],
      report: { summary: '实现完成，等待验收', state: 'ready' },
      review_rounds: 1,
    },
  };
  return { ...base, ...overrides, card: { ...base.card, ...(overrides.card ?? {}) } };
}

function superagentRouter(state) {
  return (request) => {
    const url = request.url;
    if (url === '/orchestrator/api/state') {
      return { json: { state: 'ok', version: 'test' } };
    }
    if (request.method === 'POST' && url === `/repos/${REPO}/issues`) {
      state.issueRequest = request;
      return {
        status: 201,
        json: { number: 42, html_url: `https://github.com/${REPO}/issues/42`, id: 1001 },
      };
    }
    if (request.method === 'GET' && url === '/orchestrator/api/tickets') {
      return { json: { tickets: state.ticket ? [state.ticket] : [] } };
    }
    if (request.method === 'GET' && url.startsWith('/orchestrator/api/tickets/')) {
      return { json: { ticket: state.ticket } };
    }
    if (request.method === 'POST' && url.endsWith('/stop')) {
      state.stopRequests.push(url);
      state.ticket = {
        ...state.ticket,
        state: state.ticketStateAfterStop,
        workspace_writes_after_stop: state.writesAfterStop,
      };
      return { json: { ok: true } };
    }
    return { status: 404, json: { ok: false, error: { code: 'not_found', message: url } } };
  };
}

async function setup(t, options = {}) {
  const state = {
    ticket: ticketFixture(),
    writesAfterStop: 0,
    ticketStateAfterStop: 'stopped',
    issueRequest: null,
    stopRequests: [],
  };
  const server = await startFakeServer(superagentRouter(state));
  t.after(() => server.close());
  const adapter = createSuperagentAdapter({
    fetch: globalThis.fetch,
    github: { apiBaseUrl: server.url, token: 'test-token' },
    orchestrator: { baseUrl: server.url },
    identity: { actor: 'ft54482', teammate: 'yuxianghan-droid' },
    now: () => 9000,
    ...options,
  });
  return { state, server, adapter };
}

function dispatchedEnvelope(runId = 'run-1') {
  return dispatchEnvelope({
    executor_kind: 'superagent',
    run_id: runId,
    workspace: { repo: REPO, base_commit: 'abc1234' },
  });
}

test('superagent: unavailable executor is blocked with no fallback', async () => {
  let fetchCalls = 0;
  const adapter = createSuperagentAdapter({
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not be called');
    },
    availability: { available: false, reason: 'G-SA-1: no local ticket API' },
  });
  assert.equal(validateContract(adapter).ok, true);

  const result = await adapter.dispatch(dispatchedEnvelope());
  assert.equal(result.ok, false);
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'executor_unavailable');
  assert.equal(result.degraded, true);
  assert.equal(result.fallback, 'none');
  assert.equal(fetchCalls, 0, 'unavailable dispatch must not create a GitHub issue');
});

test('superagent: the router never degrades to dsh_session', async () => {
  let dshDispatchCalls = 0;
  const dshSpy = {
    kind: 'dsh_session',
    dispatch: async () => {
      dshDispatchCalls += 1;
      return { ok: true, accepted: true, kind: 'dsh_session', method: 'dispatch', run_id: 'run-1', state: 'dispatched', session_id: 's1', tracking: { modes: ['status'] } };
    },
    status: async () => ({ ok: true }),
  };
  const unavailable = createSuperagentAdapter({
    fetch: async () => {
      throw new Error('must not be called');
    },
    availability: { available: false, reason: 'orchestrator down' },
  });
  const router = createExecutorRouter({ adapters: { superagent: unavailable, dsh_session: dshSpy } });
  const result = await router.dispatch(dispatchedEnvelope());
  assert.equal(result.ok, false);
  assert.equal(result.state, 'blocked');
  assert.equal(result.degraded, true);
  assert.equal(result.fallback, 'none');
  assert.equal(result.routing.path, 'superagent');
  assert.equal(dshDispatchCalls, 0, 'dsh_session must not be used as a fallback');
});

test('superagent: dispatch creates a GitHub issue whose body ends with the bot mention', async (t) => {
  const { state, server, adapter } = await setup(t);
  const dispatched = await adapter.dispatch(dispatchedEnvelope());

  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(dispatched.ticket_id, null);
  assert.equal(dispatched.ticket_id_pending, true);
  assert.equal(dispatched.issue.number, 42);
  assert.deepEqual(dispatched.tracking.modes, ['status', 'follow']);

  assert.equal(state.issueRequest.url, `/repos/${REPO}/issues`);
  assert.equal(state.issueRequest.headers.authorization, 'Bearer test-token');
  assert.equal(state.issueRequest.headers.origin, undefined, 'no Origin header is allowed');
  const body = state.issueRequest.body;
  assert.match(body.title, /写一篇关于 AI 的文章/);
  const lines = body.body.split('\n');
  assert.equal(lines.at(-1), '@yuxianghan-droid', 'mention must be the final standalone line');
  assert.match(body.body, /abc1234/);
  assert.ok(server.requests.length >= 1);
});

test('superagent: dispatch without a tracker is rejected without creating an issue', async (t) => {
  const { state, adapter } = await setup(t);
  const noTracker = dispatchedEnvelope();
  delete noTracker.tracking;
  const rejected = await adapter.dispatch(noTracker);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'tracker_missing');
  assert.equal(state.issueRequest, null);
});

test('superagent: probe uses the orchestrator management header and never sends Origin', async (t) => {
  const { server, adapter } = await setup(t);
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
  const request = server.requests.at(-1);
  assert.equal(request.url, '/orchestrator/api/state');
  assert.equal(request.headers['x-orchestrator-request'], '1');
  assert.equal(request.headers.origin, undefined);

  const unconfigured = createSuperagentAdapter({ fetch: globalThis.fetch });
  const missing = await unconfigured.probe();
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'not_configured');
});

test('superagent: status resolves the ticket, maps state and reports usage', async (t) => {
  const { state, adapter } = await setup(t);
  await adapter.dispatch(dispatchedEnvelope());

  let status = await adapter.status('run-1');
  assert.equal(status.ok, true);
  assert.equal(status.state, 'running');
  assert.equal(status.progress.health, 'progress');
  assert.equal(status.progress.ticket_id, 't1');
  assert.equal(status.progress.pr_url, `https://github.com/${REPO}/pull/7`);
  assert.equal(status.usage.tokens_in, 100);
  assert.equal(status.usage.cost_cny, 0.5);
  assert.equal(status.usage.source, 'ticket_card');

  state.ticket = { ...state.ticket, state: 'review' };
  status = await adapter.status('run-1');
  assert.equal(status.state, 'running');
  assert.equal(status.progress.ticket_state, 'review');

  state.ticket = { ...state.ticket, state: 'done' };
  status = await adapter.status('run-1');
  assert.equal(status.state, 'completed');

  state.ticket = { ...state.ticket, state: 'blocked' };
  status = await adapter.status('run-1');
  assert.equal(status.state, 'blocked');
  assert.equal(status.progress.health, 'no_progress');
});

test('superagent: follow synthesises ticket.state events from polling', async (t) => {
  const { state, adapter } = await setup(t);
  await adapter.dispatch(dispatchedEnvelope());
  await adapter.status('run-1');

  state.ticket = { ...state.ticket, state: 'review' };
  await adapter.status('run-1');

  const page = await adapter.follow('run-1', 0);
  assert.equal(page.events.length, 2);
  assert.deepEqual(page.events.map((event) => event.data.state), ['working', 'review']);
  assert.equal(page.next_seq, 2);

  const tail = await adapter.follow('run-1', 2);
  assert.deepEqual(tail.events, []);
  assert.equal(tail.next_seq, 2);
});

test('superagent: a pending ticket is not reported as completed', async (t) => {
  const { state, adapter } = await setup(t);
  state.ticket = null;
  await adapter.dispatch(dispatchedEnvelope());
  const status = await adapter.status('run-1');
  assert.equal(status.ok, true);
  assert.equal(status.state, 'dispatched');
  assert.equal(status.progress.ticket_pending, true);
  assert.equal(status.progress.health, 'no_progress');
  assert.equal(status.usage.source, 'unavailable');
});

test('superagent: verified stop is cancelled; writes after stop stay stop_unknown', async (t) => {
  const { state, adapter } = await setup(t);
  await adapter.dispatch(dispatchedEnvelope());
  await adapter.status('run-1');

  const verified = await adapter.cancel('run-1');
  assert.equal(verified.requested, true);
  assert.equal(verified.state, 'cancelled');
  assert.equal(typeof verified.verified_stopped_at, 'number');
  assert.deepEqual(state.stopRequests, ['/orchestrator/api/tickets/t1/stop']);

  const unverifiedSetup = await setup(t);
  await unverifiedSetup.adapter.dispatch(dispatchedEnvelope('run-2'));
  unverifiedSetup.state.writesAfterStop = 1;
  const unverified = await unverifiedSetup.adapter.cancel('run-2');
  assert.equal(unverified.requested, true);
  assert.equal(unverified.state, 'stop_unknown');
  assert.equal(unverified.verified_stopped_at, null);
  assert.equal(unverified.remote_may_still_run, true);
  assert.ok(unverified.reasons.includes('workspace_writes_after_stop'));
});

test('superagent: unknown ticket cannot be reported as stopped', async (t) => {
  const { state, adapter } = await setup(t);
  state.ticket = null;
  await adapter.dispatch(dispatchedEnvelope());
  const cancel = await adapter.cancel('run-1');
  assert.equal(cancel.requested, false);
  assert.equal(cancel.state, 'stop_unknown');
  assert.equal(cancel.remote_may_still_run, true);
  assert.ok(cancel.reasons.includes('ticket_not_found'));
});

test('superagent: orchestrator becoming unreachable makes the tracker unknown', async (t) => {
  let available = true;
  const { adapter } = await setup(t, {
    availability: () => ({ available, kind: 'superagent' }),
  });
  await adapter.dispatch(dispatchedEnvelope());
  available = false;
  const status = await adapter.status('run-1');
  assert.equal(status.ok, false);
  assert.equal(status.state, 'unknown');
  assert.equal(status.progress.health, 'unknown');
});

test('superagent: artifacts, evidence and usage keep the shared shape', async (t) => {
  const { adapter } = await setup(t);
  await adapter.dispatch(dispatchedEnvelope());
  await adapter.status('run-1');

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.deepEqual(
    artifacts.items.map((item) => item.path),
    [`github:${REPO}#issues/42`, `github:${REPO}#pull/7`, `out/article.md`],
  );

  const evidence = await adapter.collectEvidence('run-1');
  assert.deepEqual(evidence.items.map((item) => item.kind), ['issue', 'ticket', 'report']);

  const usage = await adapter.usage('run-1');
  assert.equal(usage.tokens_in, 100);

  const results = {
    dispatch: await adapter.dispatch(dispatchedEnvelope('run-2')),
    status: await adapter.status('run-2'),
    cancel: await adapter.cancel('run-2'),
    follow: await adapter.follow('run-2', 0),
    collectArtifacts: await adapter.collectArtifacts('run-2'),
    collectEvidence: await adapter.collectEvidence('run-2'),
    usage: await adapter.usage('run-2'),
  };
  for (const [method, result] of Object.entries(results)) {
    const validation = validateResult(adapter, method, result);
    assert.deepEqual(validation.issues, [], `${method}: ${validation.issues}`);
  }
});
