import { startApiServer } from '../src/index.js';

async function request(url, method, path, body, headers = {}) {
  const requestHeaders = { accept: 'application/json', ...headers };
  let payload;
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${url}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  let parsed = {};
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** Start an isolated in-memory API and register cleanup on the test context. */
export async function startTestApi(t, options = {}) {
  const api = await startApiServer(options);
  t.after(async () => {
    await api.close();
  });
  return {
    ...api,
    get: (path, headers) => request(api.url, 'GET', path, undefined, headers),
    post: (path, body, key, headers = {}) =>
      request(api.url, 'POST', path, body, {
        ...(key ? { 'idempotency-key': key } : {}),
        ...headers,
      }),
  };
}

export function createExecutionTask(client, overrides = {}, key = null) {
  return client.post(
    '/v1/tasks',
    {
      level: 'execution',
      title: overrides.title ?? 'execution task',
      acceptance_profile: {
        id: 'execution.auto_v1',
        version: 1,
        items: [{ key: 'auto.checks', class: 'auto', required: true }],
      },
      ...overrides,
    },
    key,
  );
}

export function validClaim(overrides = {}) {
  return {
    commit: 'a'.repeat(40),
    dirty: false,
    manifest: [{ path: 'packages/api/src/index.js', sha256: 'b'.repeat(64) }],
    nonce: 'nonce-1',
    ...overrides,
  };
}
