import http from 'node:http';

function safeParse(text) {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * In-process fake HTTP server bound to `127.0.0.1:0`.
 *
 * Never 17300/3086/DS Bot: the port is allocated by the OS and the URL is only
 * handed to the bridge under test. `requests` keeps the raw records so a test
 * can prove exactly which headers/body crossed the boundary.
 */
export async function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: safeParse(body),
      };
      requests.push(record);
      Promise.resolve(handler(req, res, record)).catch((error) => {
        if (!res.headersSent && !res.destroyed) {
          reply(res, 500, { code: 'test_handler_error', message: error?.message ?? String(error) });
        }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function reply(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function replyRaw(res, status, text) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
