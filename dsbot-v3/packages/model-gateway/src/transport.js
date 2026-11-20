/**
 * Transport boundary.
 *
 * The gateway never opens a socket itself. `transport(request)` receives
 * `{ url, method, headers, body, timeoutMs }` and resolves to either:
 *   - a `Response` (anything with `status` and `text()`), e.g. `fetch`; or
 *   - `{ status, headers, body }` with `body` a string or JSON value.
 *
 * Tests inject a fake; production wiring uses `fetchTransport(fetch)`.
 */

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function plainHeaders(headers) {
  const output = {};
  if (headers === null || headers === undefined) return output;
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((value, key) => {
      output[String(key).toLowerCase()] = String(value);
    });
    return output;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

/** Normalize a transport result to `{ status, headers, body }` without throwing. */
export async function readTransportResponse(response) {
  if (response === null || typeof response !== 'object') {
    throw new TypeError('transport must resolve to a Response or { status, headers, body }');
  }
  const status = Number(response.status);
  if (!Number.isFinite(status)) {
    throw new TypeError('transport result has no numeric status');
  }
  const headers = plainHeaders(response.headers);
  let body = '';
  if (typeof response.text === 'function') {
    body = await response.text();
  } else if (typeof response.body === 'string') {
    body = response.body;
  } else if (response.body !== undefined) {
    body = typeof response.body === 'number' || typeof response.body === 'boolean'
      ? String(response.body)
      : JSON.stringify(response.body);
  }
  return { status, headers, body: typeof body === 'string' ? body : String(body) };
}

export function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 5000);
  return null;
}

/** Append `/chat/completions` unless the base URL already names the endpoint. */
export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/** Bridge URL must keep its MCP path; a bare origin gets `/mcp` appended. */
export function mcpUrl(bridgeUrl) {
  const text = String(bridgeUrl).trim();
  try {
    const parsed = new URL(text);
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/mcp';
    return parsed.toString();
  } catch {
    return text;
  }
}

/**
 * A real transport backed by an injected `fetch`. The gateway still owns
 * timeout/retry/redaction; this adapter only adds an abort signal.
 */
export function fetchTransport(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchTransport requires a fetch function');
  }
  return async function transport(request) {
    const signal =
      Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(request.timeoutMs)
        : undefined;
    return fetchImpl(request.url, {
      method: request.method ?? 'POST',
      headers: request.headers,
      body: request.body,
      ...(signal === undefined ? {} : { signal }),
    });
  };
}
