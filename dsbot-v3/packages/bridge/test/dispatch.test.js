import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ENV_ALLOWLIST, createBridge } from '../src/index.js';
import { reply, replyRaw, startFakeServer } from './helpers/server.js';

test('bridge: createBridge exposes dispatchTask, onResult and mapError', () => {
  const bridge = createBridge({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(typeof bridge.dispatchTask, 'function');
  assert.equal(typeof bridge.onResult, 'function');
  assert.equal(typeof bridge.mapError, 'function');
  assert.equal(bridge.mapError('budget_exceeded').prd, 'budget_exceeded');
  assert.throws(() => createBridge({ baseUrl: 'http://127.0.0.1:1' }), /fetch/);
  assert.throws(() => createBridge({ fetch: async () => {} }), /baseUrl/);
});

test('dispatch: one POST with allowlisted env, idempotency key and issue metadata', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { accepted: true, task_id: 'task-101', request_id: 'req-101', state: 'queued' });
  });
  try {
    const bridge = createBridge({
      baseUrl: server.url,
      fetch,
      env: { PATH: '/bridge/bin', SECRET_TOKEN: 'bridge-secret', TZ: 'UTC' },
      envAllowlist: ['PATH', 'TZ'],
      token: 'test-token',
    });
    const outcome = await bridge.dispatchTask({
      id: 101,
      number: 45,
      title: 'Fix bug',
      url: 'https://example.test/issues/45',
      goal: 'Make the widget work',
      workspace: { path: 'C:\\work', base_commit: 'abc123' },
      budget_cny_cap: 5,
      env: { PATH: '/issue/bin', TZ: 'UTC', AWS_SECRET_ACCESS_KEY: 'issue-secret' },
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.task_id, 'task-101');
    assert.equal(outcome.request_id, 'req-101');
    assert.equal(outcome.state, 'queued');
    assert.equal(outcome.status_class, '2xx');
    assert.equal(outcome.category, 'ok');
    assert.deepEqual(outcome.env_keys, ['PATH', 'TZ']);

    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/dispatch');
    assert.equal(request.headers['idempotency-key'], 'ds-bot:101');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    assert.deepEqual(request.json.env, { PATH: '/issue/bin', TZ: 'UTC' });
    assert.deepEqual(request.json.env_allowlist, ['PATH', 'TZ']);
    assert.match(request.json.env_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(request.json.issue.id, '101');
    assert.equal(request.json.issue.number, 45);
    assert.equal(request.json.issue.title, 'Fix bug');
    assert.equal(request.json.goal, 'Make the widget work');
    assert.deepEqual(request.json.workspace, { path: 'C:\\work', base_commit: 'abc123' });
    assert.equal(request.json.budget_cny_cap, 5);
    assert.equal('SECRET_TOKEN' in request.json.env, false);
    assert.equal('AWS_SECRET_ACCESS_KEY' in request.json.env, false);
  } finally {
    await server.close();
  }
});

test('dispatch: a GitHub-shaped issue needs no translation layer', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { accepted: true, task_id: 'task-45', request_id: 'req-45', state: 'queued' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({
      number: 45,
      title: 'L20 bridge: DS Bot integration adapter',
      body: 'Implement the adapter',
      idempotency_key: 'issue-45-v1',
    });

    assert.equal(outcome.ok, true);
    const request = server.requests[0];
    assert.equal(request.headers['idempotency-key'], 'issue-45-v1');
    assert.equal(request.json.issue.id, '45');
    assert.equal(request.json.issue.number, 45);
    assert.equal(request.json.goal, 'L20 bridge: DS Bot integration adapter');
    assert.equal(request.json.workspace, null);
    assert.equal('budget_cny_cap' in request.json, false);
  } finally {
    await server.close();
  }
});

test('dispatch: the default env source is process.env, still allowlist-filtered', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { accepted: true, task_id: 'task-411', state: 'queued' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({ id: 411, title: 'Default environment' });

    assert.equal(outcome.ok, true);
    const env = server.requests[0].json.env;
    assert.ok(Object.keys(env).every((key) => DEFAULT_ENV_ALLOWLIST.includes(key)));
    if (typeof process.env.PATH === 'string') assert.equal(env.PATH, process.env.PATH);
  } finally {
    await server.close();
  }
});

test('dispatch: the same issue is replayed locally without a second request', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { accepted: true, task_id: 'task-202', request_id: 'req-202', state: 'dispatched' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const first = await bridge.dispatchTask({ id: 202, title: 'Repeat me' });
    const second = await bridge.dispatchTask({ id: 202, title: 'Repeat me' });

    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.task_id, first.task_id);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('dispatch: reusing an idempotency key with different content is duplicate_dispatch', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { accepted: true, task_id: 'task-303', state: 'queued' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const first = await bridge.dispatchTask({ id: 303, title: 'Version one' });
    const second = await bridge.dispatchTask({ id: 303, title: 'Version two' });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.code, 'duplicate_dispatch');
    assert.equal(second.prd, 'duplicate_dispatch');
    assert.equal(second.prd_status, 409);
    assert.equal(second.http_status, 409);
    assert.equal(second.status_class, '4xx');
    assert.equal(second.retryable, false);
    assert.equal(second.side_effects_possible, false);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('dispatch: a 403 bridge code converts to scope_denied without retry', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 403, { code: 'FORBIDDEN_WORKSPACE', message: 'workspace outside allowlist' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({ id: 404, title: 'Outside workspace' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.prd, 'scope_denied');
    assert.equal(outcome.code, 'FORBIDDEN_WORKSPACE');
    assert.equal(outcome.http_status, 403);
    assert.equal(outcome.status_class, '4xx');
    assert.equal(outcome.category, 'authorization');
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.side_effects_possible, false);
  } finally {
    await server.close();
  }
});

test('dispatch: a 500 without a body maps to executor_unavailable and flags side effects', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 500, { message: 'host exploded' });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({ id: 405, title: 'Host failure' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.prd, 'executor_unavailable');
    assert.equal(outcome.code, 'http_500');
    assert.equal(outcome.http_status, 500);
    assert.equal(outcome.status_class, '5xx');
    assert.equal(outcome.category, 'unavailable');
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.side_effects_possible, true);
    assert.equal(outcome.requires_idempotency_key, true);
  } finally {
    await server.close();
  }
});

test('dispatch: a 200 body rejection still converts to its PRD error', async () => {
  const server = await startFakeServer((req, res) => {
    reply(res, 200, { ok: false, error: { code: 'budget_exceeded', message: 'cap is 5' } });
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({ id: 406, title: 'Too expensive' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.prd, 'budget_exceeded');
    assert.equal(outcome.prd_status, 402);
    assert.equal(outcome.status_class, '4xx');
    assert.equal(outcome.category, 'budget');
    assert.equal(outcome.retryable, false);
  } finally {
    await server.close();
  }
});

test('dispatch: a hanging server becomes a timeout, not a silent success', async () => {
  const server = await startFakeServer(() => {
    // Deliberately never reply; the client must abort.
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch, timeoutMs: 40 });
    const started = Date.now();
    const outcome = await bridge.dispatchTask({ id: 407, title: 'Slow task' });
    const elapsed = Date.now() - started;

    assert.equal(outcome.ok, false);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.code, 'timeout');
    assert.equal(outcome.prd, 'executor_unavailable');
    assert.equal(outcome.http_status, 504);
    assert.equal(outcome.status_class, '5xx');
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.side_effects_possible, true);
    assert.equal(outcome.requires_idempotency_key, true);
    assert.ok(elapsed < 2000, `timeout took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test('dispatch: a transport failure maps to executor_unavailable with side effects possible', async () => {
  const bridge = createBridge({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const outcome = await bridge.dispatchTask({ id: 408, title: 'No network' });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'network_error');
  assert.equal(outcome.prd, 'executor_unavailable');
  assert.equal(outcome.category, 'transient');
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.side_effects_possible, true);
});

test('dispatch: a malformed 2xx body is rejected as bad_response', async () => {
  const server = await startFakeServer((req, res) => {
    replyRaw(res, 200, '<html>not json</html>');
  });
  try {
    const bridge = createBridge({ baseUrl: server.url, fetch });
    const outcome = await bridge.dispatchTask({ id: 409, title: 'Bad body' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'bad_response');
    assert.equal(outcome.prd, 'executor_unavailable');
    assert.equal(outcome.http_status, 200);
    assert.equal(outcome.status_class, '2xx');
    assert.equal(outcome.category, 'unknown');
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.side_effects_possible, true);
  } finally {
    await server.close();
  }
});

test('dispatch: invalid issues are rejected locally before any request', async () => {
  let called = false;
  const bridge = createBridge({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      called = true;
      throw new Error('must not be called');
    },
  });

  const noId = await bridge.dispatchTask({ title: 'No id' });
  assert.equal(noId.ok, false);
  assert.equal(noId.code, 'invalid_request');
  assert.equal(noId.prd, null);
  assert.equal(noId.side_effects_possible, false);

  const noGoal = await bridge.dispatchTask({ id: 410 });
  assert.equal(noGoal.ok, false);
  assert.equal(noGoal.code, 'invalid_request');

  assert.equal(called, false);
});
