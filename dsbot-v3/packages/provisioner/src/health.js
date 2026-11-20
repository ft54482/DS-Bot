import http from 'node:http';
import net from 'node:net';

/**
 * Real port-availability check, used by the CLI only. It is injected into
 * `provision` as `isPortFree`, so the library itself never opens a socket.
 */
export function nodeIsPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Real health probe for a running DSH instance.
 *
 * The management API needs `x-orchestrator-request: 1` and no Origin header
 * (docs/prd/19-minimal-test-ticket.md §2.1). A 2xx response is ready; any
 * other status, timeout or connection error is not.
 */
export function createHttpProbe({
  path = '/orchestrator/api/overview',
  timeoutMs = 3000,
  headers = {},
} = {}) {
  return async ({ port, url }) => {
    const base = url ?? `http://127.0.0.1:${port}`;
    const target = `${base.replace(/\/$/, '')}${path}`;
    try {
      const response = await get(target, timeoutMs, {
        'x-orchestrator-request': '1',
        ...headers,
      });
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { ok: true, status: response.statusCode };
      }
      return {
        ok: false,
        status: response.statusCode,
        reason: `overview returned HTTP ${response.statusCode}`,
      };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  };
}

function get(target, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(target, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`health check timed out after ${timeoutMs}ms`));
    });
  });
}
