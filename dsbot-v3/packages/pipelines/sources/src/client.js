/**
 * Self-media source client (L43).
 *
 * A *topic pack* is the minimum a later stage needs to decide whether a story
 * is worth writing: id, title, summary, source, publication time and a hash of
 * that summary. The client deliberately never fetches the article body (D-04);
 * `contentHash` is sha256 of the summary exactly as the source returned it.
 *
 * Both external capabilities are injected, so the module itself is offline by
 * construction:
 *
 *   http(url, { signal, timeoutMs }) -> { status, body }
 *     - `body` may be a JSON value or a JSON string;
 *     - response-like objects with `json()` / `text()` are also accepted;
 *     - the client never imports a filesystem or HTTP module, and never calls
 *       global fetch.
 *
 *   clock.sleep(ms) -> Promise<void>
 *     - used only for retry backoff, so tests can make it deterministic.
 *
 * The default endpoints use the reserved `.invalid` TLD: a caller that injects
 * a real transport but forgets to configure `endpoints` fails during DNS
 * resolution instead of quietly hitting a real host.
 */

import { createHash } from 'node:crypto';

import { SourceError } from './errors.js';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_BACKOFF_MS = 100;

export const SOURCE_ITEM_KEYS = Object.freeze([
  'id',
  'title',
  'summary',
  'sourceName',
  'sourceUrl',
  'publishedAt',
  'contentHash',
]);

export const DEFAULT_ENDPOINTS = Object.freeze({
  hot: 'https://selfmedia.invalid/hot',
  item: 'https://selfmedia.invalid/items/{id}',
});

/** Fields the source body must supply; `contentHash` is always local. */
const REQUIRED_ITEM_FIELDS = Object.freeze([
  'id',
  'title',
  'summary',
  'sourceName',
  'sourceUrl',
  'publishedAt',
]);

const SNAKE_FIELD = new Map(
  REQUIRED_ITEM_FIELDS.map((field) => [
    field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
    field,
  ]),
);

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function realSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeHttp(http) {
  if (typeof http === 'function') return http;
  if (http && typeof http.get === 'function') return (url, options) => http.get(url, options);
  throw new TypeError(
    'createSourceClient requires an injected http function: http(url, { signal, timeoutMs })',
  );
}

function normalizeClock(clock) {
  if (clock && typeof clock.sleep === 'function') {
    return { sleep: clock.sleep.bind(clock) };
  }
  return { sleep: realSleep };
}

function normalizeRetries(value) {
  if (value === undefined) return DEFAULT_RETRIES;
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new TypeError('createSourceClient retries must be an integer between 0 and 10');
  }
  return value;
}

function normalizeBackoff(value) {
  if (value === undefined) return DEFAULT_BACKOFF_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('createSourceClient backoffMs must be a non-negative number');
  }
  return value;
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('createSourceClient timeoutMs must be a positive number');
  }
  return value;
}

function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('listHot limit must be a positive integer');
  }
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Endpoints are either a template string (`{id}` / `{limit}` are encoded) or a
 * function receiving the same parameters. A function is useful when a source
 * needs a different URL shape than the default.
 */
function resolveEndpoint(spec, params) {
  if (typeof spec === 'function') {
    const url = spec(params);
    if (!isNonEmptyString(url)) {
      throw new TypeError('endpoint function must return a non-empty URL string');
    }
    return url;
  }
  if (!isNonEmptyString(spec)) {
    throw new TypeError('endpoint must be a non-empty URL template or a function');
  }
  return spec.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? encodeURIComponent(String(params[key])) : match,
  );
}

function isUsableBody(body) {
  return typeof body === 'string' || isPlainObject(body) || Array.isArray(body);
}

async function parseResponse(response, url) {
  if (response === null || typeof response !== 'object') {
    throw new SourceError('invalid_response', `http response is not an object: ${url}`, {
      url,
    });
  }

  const { status } = response;
  if (typeof status === 'number') {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new SourceError('invalid_response', `http response has an invalid status: ${status}`, {
        url,
      });
    }
    if (status < 200 || status >= 300) {
      throw new SourceError('http_error', `HTTP ${status} for ${url}`, {
        retryable: true,
        status,
        url,
      });
    }
  } else if (response.ok === false) {
    throw new SourceError('http_error', `HTTP request failed for ${url}`, {
      retryable: true,
      url,
    });
  }

  let body = response.body;
  if (!isUsableBody(body)) {
    if (typeof response.json === 'function') {
      try {
        body = await response.json();
      } catch (cause) {
        throw new SourceError('invalid_response', `response.json() failed for ${url}`, {
          url,
          cause,
        });
      }
    } else if (typeof response.text === 'function') {
      try {
        body = await response.text();
      } catch (cause) {
        throw new SourceError('invalid_response', `response.text() failed for ${url}`, {
          url,
          cause,
        });
      }
    }
  }
  if (body === undefined) {
    throw new SourceError('invalid_response', `http response has no body: ${url}`, { url });
  }

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (cause) {
      throw new SourceError('invalid_response', `response body is not JSON: ${url}`, {
        url,
        cause,
      });
    }
  }
  if (!isPlainObject(body) && !Array.isArray(body)) {
    throw new SourceError(
      'invalid_response',
      `response body must be a JSON object or array: ${url}`,
      { url },
    );
  }
  return body;
}

async function requestJson(url, config) {
  const controller = new AbortController();
  const request = Promise.resolve().then(() =>
    config.http(url, { signal: controller.signal, timeoutMs: config.timeoutMs }),
  );
  // A losing request may reject after the timeout won the race; mark it handled
  // so it cannot surface as an unhandled rejection.
  request.catch(() => {});

  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new SourceError('timeout', `request timed out after ${config.timeoutMs}ms: ${url}`, {
          retryable: true,
          url,
        }),
      );
    }, config.timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([request, timeout]);
  } catch (cause) {
    if (cause instanceof SourceError) throw cause;
    if (timedOut || cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR') {
      throw new SourceError('timeout', `request timed out after ${config.timeoutMs}ms: ${url}`, {
        retryable: true,
        url,
        cause,
      });
    }
    throw new SourceError(
      'network_error',
      `request failed for ${url}: ${cause?.message ?? String(cause)}`,
      { retryable: true, url, cause },
    );
  } finally {
    clearTimeout(timer);
  }

  return parseResponse(response, url);
}

async function withRetries(operation, config) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof SourceError && error.retryable === true;
      if (!retryable || attempt > config.retries) {
        if (error instanceof SourceError) error.attempts = attempt;
        throw error;
      }
      if (config.backoffMs > 0) await config.clock.sleep(config.backoffMs * attempt);
    }
  }
}

function readField(raw, field) {
  if (Object.hasOwn(raw, field)) return raw[field];
  for (const [snake, canonical] of SNAKE_FIELD) {
    if (canonical === field && Object.hasOwn(raw, snake)) return raw[snake];
  }
  return undefined;
}

function invalidItem(missing, invalid, context) {
  const parts = [
    ...missing.map((field) => `missing:${field}`),
    ...invalid,
  ];
  const where = context?.index === undefined ? '' : ` at hot index ${context.index}`;
  return new SourceError('invalid_item', `invalid item (${parts.join(', ')})${where}`, {
    retryable: false,
    ...context,
    missing,
    invalid,
  });
}

/**
 * Validate and normalize one source item.
 *
 * `summary` is kept byte-for-byte because `contentHash` must hash the summary
 * text as received. Titles and source names are trimmed for display; a
 * published time is normalized to an ISO instant so two sources can be
 * compared reliably.
 */
function normalizeItem(raw, context = {}) {
  if (!isPlainObject(raw)) {
    throw invalidItem(REQUIRED_ITEM_FIELDS, ['item:not_an_object'], context);
  }

  const missing = [];
  const invalid = [];
  const values = {};

  for (const field of REQUIRED_ITEM_FIELDS) {
    const value = readField(raw, field);
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    if (typeof value === 'number' && field === 'publishedAt') {
      const date = new Date(value);
      if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
        invalid.push('publishedAt:format');
      } else {
        values.publishedAt = date.toISOString();
      }
      continue;
    }
    if (typeof value !== 'string') {
      invalid.push(field);
      continue;
    }
    values[field] = value;
  }

  if (missing.length > 0) throw invalidItem(missing, invalid, context);

  for (const field of ['id', 'title', 'summary', 'sourceName', 'sourceUrl']) {
    if (field in values && values[field].trim().length === 0) invalid.push(`${field}:empty`);
  }

  if ('sourceUrl' in values && values.sourceUrl.trim().length > 0) {
    try {
      const parsed = new URL(values.sourceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        invalid.push('sourceUrl:protocol');
      }
    } catch {
      invalid.push('sourceUrl:format');
    }
  }

  if ('publishedAt' in values) {
    const ms = Date.parse(values.publishedAt);
    if (Number.isNaN(ms)) invalid.push('publishedAt:format');
    else values.publishedAt = new Date(ms).toISOString();
  }

  if (invalid.length > 0) throw invalidItem(missing, invalid, context);

  const summary = values.summary;
  return {
    id: values.id.trim(),
    title: values.title.trim(),
    summary,
    sourceName: values.sourceName.trim(),
    sourceUrl: values.sourceUrl.trim(),
    publishedAt: values.publishedAt,
    contentHash: sha256Hex(summary),
  };
}

function extractItem(payload) {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isPlainObject(current)) break;
    if (Object.hasOwn(current, 'id')) return current;
    const wrapper = ['item', 'data', 'result'].find((key) => isPlainObject(current[key]));
    if (!wrapper) break;
    current = current[wrapper];
  }
  throw new SourceError(
    'invalid_response',
    'response body does not contain an item object',
    {},
  );
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return null;
  for (const key of ['items', 'results', 'data']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isPlainObject(value)) {
      for (const inner of ['items', 'results']) {
        if (Array.isArray(value[inner])) return value[inner];
      }
    }
  }
  return null;
}

function normalizeConfig(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('createSourceClient requires an options object: { http, clock }');
  }
  const endpoints = isPlainObject(options.endpoints)
    ? { ...DEFAULT_ENDPOINTS, ...options.endpoints }
    : { ...DEFAULT_ENDPOINTS };
  return {
    http: normalizeHttp(options.http),
    clock: normalizeClock(options.clock),
    retries: normalizeRetries(options.retries),
    backoffMs: normalizeBackoff(options.backoffMs),
    timeoutMs: normalizeTimeout(options.timeoutMs),
    endpoints,
  };
}

/**
 * Create the injected source client.
 *
 * `listHot({ limit })` returns an item array in source order (at most `limit`,
 * default 10, hard maximum 50); `fetchItem({ id })` returns one item. Both
 * results have exactly `SOURCE_ITEM_KEYS`; the response-provided body and any
 * response-provided hash are ignored.
 */
export function createSourceClient(options) {
  const config = normalizeConfig(options);

  async function listHot(input) {
    const params = input === undefined ? {} : input;
    if (!isPlainObject(params)) {
      throw new TypeError('listHot input must be an object: { limit? }');
    }
    const limit = normalizeLimit(params.limit);
    const url = resolveEndpoint(config.endpoints.hot, { limit });
    const payload = await withRetries(() => requestJson(url, config), config);
    const rawItems = extractList(payload);
    if (rawItems === null) {
      throw new SourceError(
        'invalid_response',
        `hot list response has no items array: ${url}`,
        { url },
      );
    }
    return rawItems
      .slice(0, limit)
      .map((raw, index) => normalizeItem(raw, { url, index }));
  }

  async function fetchItem(input) {
    if (!isPlainObject(input)) {
      throw new TypeError('fetchItem input must be an object: { id }');
    }
    if (!isNonEmptyString(input.id)) {
      throw new TypeError('fetchItem requires a non-empty string id');
    }
    const id = input.id.trim();
    const url = resolveEndpoint(config.endpoints.item, { id });
    const payload = await withRetries(() => requestJson(url, config), config);
    const item = normalizeItem(extractItem(payload), { url, id });
    if (item.id !== id) {
      throw invalidItem([], ['id:mismatch'], { url, id });
    }
    return item;
  }

  return { listHot, fetchItem };
}
