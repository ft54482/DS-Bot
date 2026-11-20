import assert from 'node:assert/strict';
import test from 'node:test';

import { BRIDGE_TOOLS, createDshSessionAdapter } from '../src/dsh_session.js';
import { sha256, validateResult } from '../src/contract.js';
import { dispatchEnvelope, startFakeServer } from './helpers/harness.js';

function bridgeRouter(state) {
  return (request) => {
    const tool = request.url.replace('/tools/', '');
    const body = request.body ?? {};
    switch (tool) {
      case 'dsh_create_session':
        return { json: { ok: true, result: { sessionId: state.sessionId, cwd: body.cwd } } };
      case 'dsh_list_sessions':
        return { json: { ok: true, result: { count: 0, items: [] } } };
      case 'dsh_prompt':
        return { json: { ok: true, result: { requestId: 'req-1', sessionId: body.sessionId, accepted: true } } };
      case 'dsh_steer':
        return { json: { ok: true, result: { sessionId: body.sessionId, accepted: true } } };
      case 'dsh_update_queue':
        return { json: { ok: true, result: { sessionId: body.sessionId, itemId: body.itemId, accepted: true } } };
      case 'dsh_cancel':
        return { json: { ok: true, result: { sessionId: body.sessionId, accepted: state.cancelAccepted } } };
      case 'dsh_get_status':
        return {
          json: {
            ok: true,
            result: { sessionId: body.sessionId, running: state.running, queueLength: state.queueLength, cursor: 5 },
          },
        };
      case 'dsh_get_projections':
        return {
          json: {
            ok: true,
            result: {
              sessionId: body.sessionId,
              present: state.usagePresent,
              values: { usage: { tokens_in: 120, tokens_out: 30, tokens_cached: 10 }, cost: { cny: 0.3 } },
            },
          },
        };
      case 'dsh_follow':
        return {
          json: {
            ok: true,
            result: {
              sessionId: body.sessionId,
              cursor: 8,
              hasMore: false,
              timedOut: false,
              records: state.records.filter((record) => record.seq > (body.sinceSeq ?? 0)),
            },
          },
        };
      case 'dsh_read_workspace_file':
        return { json: { ok: true, result: { path: body.path, content: 'hello', bytes: 5, size: 5 } } };
      case 'dsh_list_artifacts':
        return { json: { ok: true, result: { items: [{ path: 'RESULT.md', size: 5, mtimeMs: 1 }] } } };
      case 'dsh_list_workspaces':
        return { json: { ok: true, result: { count: 0, items: [] } } };
      default:
        return { status: 404, json: { ok: false, error: { code: 'unknown_tool' } } };
    }
  };
}

function camelCase(tool) {
  return tool.replace(/^dsh_/, '').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

async function setup(t, overrides = {}) {
  const state = {
    sessionId: 'session-1',
    running: false,
    queueLength: 0,
    cancelAccepted: true,
    usagePresent: true,
    records: [],
  };
  const server = await startFakeServer(bridgeRouter(state));
  const adapter = createDshSessionAdapter({
    fetch: globalThis.fetch,
    bridgeUrl: server.url,
    now: () => 5000,
    sleep: async () => {},
    verifyStop: async () => ({ children: 0, stableForMs: 5000 }),
    ...overrides,
  });
  t.after(() => server.close());
  return { state, server, adapter };
}

test('dsh_session: all 12 bridge tools are wrapped and hit their endpoint', async (t) => {
  const { server, adapter } = await setup(t);
  assert.equal(BRIDGE_TOOLS.length, 12);
  for (const tool of BRIDGE_TOOLS) {
    const method = camelCase(tool);
    assert.equal(typeof adapter.tools[method], 'function', method);
    const result = await adapter.tools[method]({
      sessionId: 'session-1',
      cwd: '/workspace/demo',
      path: 'RESULT.md',
      text: 'hi',
      itemId: 'item-1',
      action: { kind: 'edit' },
    });
    assert.equal(result.ok, true, `${tool}: ${result.message}`);
  }
  assert.deepEqual(
    server.requests.map((request) => request.url),
    BRIDGE_TOOLS.map((tool) => `/tools/${tool}`),
  );
});

test('dsh_session: requires an injected fetch (no implicit network client)', () => {
  assert.throws(() => createDshSessionAdapter({ bridgeUrl: 'http://127.0.0.1:1' }), /injected fetch/);
});

test('dsh_session: dispatch creates a session, prompts, and refuses dispatch without a tracker', async (t) => {
  const { server, adapter } = await setup(t);
  const dispatched = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.session_id, 'session-1');
  assert.equal(dispatched.state, 'dispatched');
  assert.deepEqual(server.requests.map((request) => request.url), ['/tools/dsh_create_session', '/tools/dsh_prompt']);
  const prompt = server.requests[1].body;
  assert.equal(prompt.sessionId, 'session-1');
  assert.equal(prompt.delivery, 'queue');
  assert.match(prompt.text, /写一篇关于 AI 的文章/);
  assert.match(prompt.text, /不联网/);
  assert.match(prompt.text, /run-1/);

  const noTracker = dispatchEnvelope({ executor_kind: 'dsh_session', run_id: 'run-2' });
  delete noTracker.tracking;
  const rejected = await adapter.dispatch(noTracker);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'tracker_missing');
  assert.equal(server.requests.length, 2, 'a rejected dispatch must not call the bridge');
});

test('dsh_session: an existing session is reused instead of creating a new one', async (t) => {
  const { server, adapter } = await setup(t);
  const dispatched = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session', session_id: 'session-existing' }));
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.session_id, 'session-existing');
  assert.deepEqual(server.requests.map((request) => request.url), ['/tools/dsh_get_status', '/tools/dsh_prompt']);
  assert.equal(server.requests[1].body.sessionId, 'session-existing');
});

test('dsh_session: status maps bridge liveness to state/health and usage', async (t) => {
  const { state, adapter } = await setup(t);
  await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));

  state.running = true;
  let status = await adapter.status('run-1');
  assert.equal(status.state, 'running');
  assert.equal(status.progress.health, 'progress');
  assert.equal(status.usage.tokens_in, 120);
  assert.equal(status.usage.tokens_out, 30);
  assert.equal(status.usage.cost_cny, 0.3);
  assert.equal(status.usage.source, 'projections');

  state.running = false;
  state.queueLength = 2;
  status = await adapter.status('run-1');
  assert.equal(status.state, 'queued');
  assert.equal(status.progress.health, 'progress');

  state.queueLength = 0;
  status = await adapter.status('run-1');
  assert.equal(status.state, 'idle');
  assert.equal(status.progress.health, 'no_progress');

  state.usagePresent = false;
  const usage = await adapter.usage('run-1');
  assert.equal(usage.tokens_in, 0);
  assert.equal(usage.source, 'unavailable');
});

test('dsh_session: follow advances sinceSeq and respects bridge limits', async (t) => {
  const { state, server, adapter } = await setup(t);
  await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));
  state.records = [
    { seq: 6, type: 'turn/end', time: 6000, data: { reason: { kind: 'ok' } } },
    { seq: 7, type: 'step/end', time: 6100, data: { step: 'write' } },
  ];

  const page = await adapter.follow('run-1', 5);
  assert.deepEqual(page.events.map((event) => event.seq), [6, 7]);
  assert.equal(page.next_seq, 7);
  const followRequest = server.requests.filter((request) => request.url === '/tools/dsh_follow').at(-1);
  assert.equal(followRequest.body.sinceSeq, 5);
  assert.equal(followRequest.body.maxEvents, 200);
  assert.equal(followRequest.body.timeoutMs, 30000);

  const tail = await adapter.follow('run-1', 7);
  assert.deepEqual(tail.events, []);
  assert.equal(tail.next_seq, 7);
});

test('dsh_session: verified cancel is cancelled; unverified stop is stop_unknown', async (t) => {
  const { state, server, adapter } = await setup(t);
  await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));

  const verified = await adapter.cancel('run-1');
  assert.equal(verified.requested, true);
  assert.equal(verified.state, 'cancelled');
  assert.equal(typeof verified.verified_stopped_at, 'number');

  const unverifiedAdapter = createDshSessionAdapter({
    fetch: globalThis.fetch,
    bridgeUrl: server.url,
    now: () => 5000,
    sleep: async () => {},
    verifyStop: async () => ({ children: 2, stableForMs: 0 }),
  });
  state.running = true;
  await unverifiedAdapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session', run_id: 'run-3' }));
  const unverified = await unverifiedAdapter.cancel('run-3');
  assert.equal(unverified.requested, true);
  assert.equal(unverified.state, 'stop_unknown');
  assert.equal(unverified.verified_stopped_at, null);
  assert.equal(unverified.remote_may_still_run, true);
  assert.ok(unverified.reasons.includes('process_children_remaining'));
  assert.ok(unverified.reasons.includes('workspace_writes_unstable'));
});

test('dsh_session: a refused cancel is stop_unknown, not cancelled', async (t) => {
  const { state, adapter } = await setup(t);
  state.cancelAccepted = false;
  await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));
  const cancel = await adapter.cancel('run-1');
  assert.equal(cancel.requested, false);
  assert.equal(cancel.state, 'stop_unknown');
  assert.equal(cancel.remote_may_still_run, true);
  assert.ok(cancel.reasons.includes('cancel_not_accepted'));
});

test('dsh_session: an unreachable bridge degrades to health=unknown and rejects dispatch', async (t) => {
  const { server } = await setup(t);
  await server.close();
  const adapter = createDshSessionAdapter({
    fetch: globalThis.fetch,
    bridgeUrl: server.url,
    now: () => 5000,
    sleep: async () => {},
    verifyStop: async () => ({ children: 0, stableForMs: 5000 }),
  });
  const rejected = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'bridge_unreachable');

  const status = await adapter.status('run-1');
  assert.equal(status.ok, false);
  assert.equal(status.state, 'unknown');
  assert.equal(status.progress.health, 'unknown');
});

test('dsh_session: artifacts, evidence and usage keep the shared shape', async (t) => {
  const { state, adapter } = await setup(t);
  await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session' }));
  state.records = [{ seq: 3, type: 'step/end', time: 1, data: { step: 'write' } }];

  const artifacts = await adapter.collectArtifacts('run-1');
  assert.deepEqual(artifacts.items, [{ path: 'RESULT.md', sha256: sha256('hello'), bytes: 5 }]);

  const evidence = await adapter.collectEvidence('run-1');
  assert.equal(evidence.items[0].kind, 'dispatch');
  assert.ok(evidence.items.some((item) => item.kind === 'event'));
  assert.ok(evidence.items.some((item) => item.kind === 'artifact'));

  const usage = await adapter.usage('run-1');
  assert.equal(usage.tokens_in, 120);

  const dispatched = await adapter.dispatch(dispatchEnvelope({ executor_kind: 'dsh_session', run_id: 'run-2' }));
  const results = {
    dispatch: dispatched,
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

test('dsh_session: probe reports availability and the fake server stays off reserved ports', async (t) => {
  const { server, adapter } = await setup(t);
  assert.ok(![3082, 3084, 3086].includes(server.port));
  const probe = await adapter.probe();
  assert.equal(probe.available, true);
});
