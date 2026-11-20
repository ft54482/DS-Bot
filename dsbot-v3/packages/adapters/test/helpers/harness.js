import http from 'node:http';

/** Local fake HTTP server: every request is recorded and answered by `handler`. */
export async function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(entry);
    let reply;
    try {
      reply = await handler(entry);
    } catch (error) {
      reply = { status: 500, json: { ok: false, error: { message: error?.message ?? String(error) } } };
    }
    res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply?.json ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    reset() {
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Deterministic clock for the mock adapter. */
export function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

export function dispatchEnvelope({
  executor_kind = 'mock',
  run_id = 'run-1',
  goal = '写一篇关于 AI 的文章',
  constraints = ['不联网'],
  acceptance = ['有来源'],
  workspace = { path: '/workspace/demo', repo: 'ft54482/superagent-lab-smoke' },
  tracking = { status: true, follow: true },
  session_id,
} = {}) {
  return {
    run: { id: run_id, executor_kind, session_id: session_id ?? null },
    taskPack: { goal, constraints, acceptance, context_refs: [] },
    workspace,
    budget: { cny_cap: 5 },
    tracking,
  };
}
