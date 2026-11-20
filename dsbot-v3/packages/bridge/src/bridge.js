/**
 * L20 bridge: the adapter between a DS Bot issue and the task runtime.
 *
 * Wire contract (one POST, local HTTP only):
 *
 *   POST {baseUrl}{dispatchPath}         (default /v1/dispatch)
 *   Idempotency-Key: <issue idempotency key>
 *   {source, issue, goal, workspace, budget_cny_cap?,
 *    env, env_allowlist, env_digest}
 * -> 2xx {accepted:true, task_id, request_id, state, replayed?}
 * -> 4xx/5xx {code, message}
 *
 * Nothing here opens a socket itself: the caller injects `fetch` and `baseUrl`,
 * so tests point the bridge at a local fake server and production wiring stays
 * explicit. Results arrive through `onResult(evt)`, which is idempotent by
 * receipt identity and refuses to apply a reused id with different content.
 */

import {
  DEFAULT_DISPATCH_PATH,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from './constants.js';
import { envDigest, normalizeAllowlist, pickAllowedEnv } from './env.js';
import { mapError } from './errors.js';
import { sha256Hex, stableJson } from './util.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeBaseUrl(raw) {
  if (!isNonEmptyString(raw)) throw new TypeError('createBridge requires baseUrl');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TypeError(`createBridge baseUrl is not a valid URL: ${String(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('createBridge baseUrl must use http or https');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

function joinUrl(base, path) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new TypeError('createBridge dispatchPath must be a path, not an absolute URL');
  }
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveTimeout(value) {
  const number = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(number)));
}

function statusClass(status) {
  return Number.isInteger(status) ? `${Math.trunc(status / 100)}xx` : null;
}

function invalidRequest(message, details = {}) {
  return {
    ok: false,
    accepted: false,
    duplicate: false,
    code: 'invalid_request',
    prd: null,
    prd_status: null,
    http_status: null,
    status_class: null,
    category: 'client',
    retryable: false,
    requires_idempotency_key: false,
    side_effects_possible: false,
    message,
    details,
  };
}

function invalidReceipt(message) {
  return {
    ok: false,
    duplicate: false,
    applied: false,
    notified: 0,
    handler_errors: [],
    code: 'invalid_receipt',
    prd: null,
    prd_status: null,
    http_status: null,
    status_class: null,
    category: 'client',
    retryable: false,
    requires_idempotency_key: false,
    side_effects_possible: false,
    message,
  };
}

function failure(mapped, overrides = {}) {
  const { input, ...rest } = mapped;
  return { ok: false, accepted: false, duplicate: false, ...rest, ...overrides };
}

function readRawId(issue) {
  for (const candidate of [issue.id, issue.number, issue.issue_number]) {
    if (isNonEmptyString(candidate)) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function readWorkspace(issue) {
  const raw = issue.workspace ?? issue.workspace_path ?? null;
  if (isNonEmptyString(raw)) return { path: raw.trim() };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const path = isNonEmptyString(raw.path) ? raw.path : raw.cwd;
    if (!isNonEmptyString(path)) return null;
    const workspace = { path: path.trim() };
    if (isNonEmptyString(raw.base_commit)) workspace.base_commit = raw.base_commit.trim();
    return workspace;
  }
  return null;
}

function readBudgetCap(issue) {
  const raw = issue.budget_cny_cap ?? issue.budget?.cny_cap ?? issue.budget?.cnyCap;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function createBridge(options = {}) {
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createBridge requires an injected fetch function');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const envAllowlist = normalizeAllowlist(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
  const sourceEnv =
    options.env === undefined
      ? process.env
      : options.env && typeof options.env === 'object' && !Array.isArray(options.env)
        ? options.env
        : {};
  const token = isNonEmptyString(options.token) ? options.token.trim() : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idempotencyPrefix = isNonEmptyString(options.idempotencyPrefix) ? options.idempotencyPrefix.trim() : 'ds-bot';
  const dispatchPath = isNonEmptyString(options.dispatchPath) ? options.dispatchPath.trim() : DEFAULT_DISPATCH_PATH;
  const endpoint = joinUrl(baseUrl, dispatchPath);

  /** Successful dispatches, keyed by idempotency key: {hash, outcome}. */
  const dispatches = new Map();
  /** Applied receipts, keyed by receipt identity: {hash, receipt}. */
  const receipts = new Map();
  const subscribers = new Set();

  function prepareIssue(issue) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      return { ok: false, message: 'issue must be an object' };
    }
    const id = readRawId(issue);
    if (id === null) return { ok: false, message: 'issue.id (or issue.number) is required' };
    const goal = [issue.goal, issue.title, issue.body].find((value) => isNonEmptyString(value));
    if (goal === undefined) return { ok: false, message: 'issue.goal, issue.title or issue.body is required' };

    const rawKey = issue.idempotency_key ?? issue.idempotencyKey;
    const key = isNonEmptyString(rawKey) ? rawKey.trim() : `${idempotencyPrefix}:${id}`;
    if (/[\r\n]/.test(key)) return { ok: false, message: 'idempotency_key must not contain CR or LF' };

    const issueEnv =
      issue.env && typeof issue.env === 'object' && !Array.isArray(issue.env) ? issue.env : sourceEnv;
    const env = pickAllowedEnv(issueEnv, envAllowlist);
    const number = Number(issue.number ?? issue.issue_number);
    const workspace = readWorkspace(issue);
    const budget = readBudgetCap(issue);

    const payload = {
      source: 'ds-bot',
      issue: {
        id,
        number: Number.isFinite(number) ? number : null,
        title: isNonEmptyString(issue.title) ? issue.title.trim() : null,
        url: isNonEmptyString(issue.url) ? issue.url.trim() : null,
      },
      goal: goal.trim(),
      workspace,
      env,
      env_allowlist: envAllowlist,
      env_digest: envDigest(env),
    };
    if (budget !== null) payload.budget_cny_cap = budget;
    return { ok: true, key, payload };
  }

  async function postDispatch(payload, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': key,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let text = '';
      try {
        text = await response.text();
      } catch {
        text = '';
      }
      let body = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { kind: 'response', response, body, text };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network', message: error?.message ?? String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatchTask(issue) {
    const prepared = prepareIssue(issue);
    if (!prepared.ok) return invalidRequest(prepared.message);

    const { key, payload } = prepared;
    const hash = sha256Hex(stableJson(payload));
    const cached = dispatches.get(key);
    if (cached) {
      if (cached.hash === hash) return { ...cached.outcome, duplicate: true, replayed: true };
      return failure(mapError('duplicate_dispatch'), {
        duplicate: true,
        message: `idempotency key ${key} was already used with a different dispatch payload`,
      });
    }

    const posted = await postDispatch(payload, key);
    if (posted.kind === 'timeout') {
      return failure(mapError({ code: 'TIMEOUT', message: `dispatch timed out after ${timeoutMs}ms` }), {
        code: 'timeout',
      });
    }
    if (posted.kind === 'network') {
      return failure(mapError({ code: 'NETWORK_ERROR', message: posted.message }), { code: 'network_error' });
    }
    if (!posted.response) {
      return failure(mapError({ code: 'BAD_RESPONSE', message: 'fetch returned no response' }), {
        code: 'bad_response',
      });
    }

    const { response, body } = posted;
    if (response.ok !== true) {
      const status = Number.isInteger(response.status) && response.status > 0 ? response.status : null;
      const errorCode = body?.error?.code ?? body?.code ?? null;
      const message =
        body?.error?.message ?? body?.message ?? `dispatch rejected with HTTP ${status ?? 'unknown'}`;
      const mapped =
        typeof errorCode === 'string' && errorCode.trim().length > 0
          ? mapError({ code: errorCode, status: status ?? undefined, message })
          : mapError({ status: status ?? 0, message });
      return failure(mapped);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure(mapError({ code: 'BAD_RESPONSE', message: 'dispatch returned a non-JSON body' }), {
        code: 'bad_response',
        http_status: response.status,
        status_class: statusClass(response.status),
      });
    }
    if (body.ok === false || body.accepted === false) {
      const errorCode = body.error?.code ?? body.code ?? null;
      const message = body.error?.message ?? body.message ?? 'dispatch was not accepted';
      if (typeof errorCode === 'string' && errorCode.trim().length > 0) {
        return failure(mapError({ code: errorCode, message }));
      }
      return failure(mapError({ code: 'BAD_RESPONSE', message }), {
        code: 'bad_response',
        http_status: response.status,
        status_class: statusClass(response.status),
      });
    }

    const taskId = body.task_id ?? body.taskId ?? body.receipt?.task_id ?? body.receipt?.taskId ?? null;
    const requestId =
      body.request_id ?? body.requestId ?? body.receipt?.request_id ?? body.receipt?.requestId ?? null;
    const accepted = body.accepted === true || (body.accepted === undefined && (taskId !== null || requestId !== null));
    if (!accepted) {
      return failure(
        mapError({ code: 'BAD_RESPONSE', message: '2xx response did not accept the dispatch' }),
        { code: 'bad_response', http_status: response.status, status_class: statusClass(response.status) },
      );
    }

    const outcome = {
      ok: true,
      accepted: true,
      duplicate: false,
      replayed: body.replayed === true,
      code: null,
      prd: null,
      prd_status: null,
      http_status: response.status,
      status_class: statusClass(response.status),
      category: 'ok',
      retryable: false,
      requires_idempotency_key: false,
      side_effects_possible: false,
      task_id: taskId === null ? null : String(taskId),
      request_id: requestId === null ? null : String(requestId),
      state: isNonEmptyString(body.state) ? body.state.trim() : null,
      env_keys: Object.keys(payload.env),
      env_digest: payload.env_digest,
      receipt: body.receipt ?? body,
    };
    dispatches.set(key, { hash, outcome });
    return { ...outcome };
  }

  /**
   * `onResult(handler)` subscribes and returns an unsubscribe function.
   * `onResult(evt)` applies one result receipt idempotently.
   */
  function onResult(evtOrHandler) {
    if (typeof evtOrHandler === 'function') {
      subscribers.add(evtOrHandler);
      return () => subscribers.delete(evtOrHandler);
    }
    const evt = evtOrHandler;
    if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return invalidReceipt('receipt must be an object');

    const rawTaskId = evt.task_id ?? evt.taskId ?? evt.issue_id ?? null;
    if (!isNonEmptyString(rawTaskId) && !(typeof rawTaskId === 'number' && Number.isFinite(rawTaskId))) {
      return invalidReceipt('receipt.task_id is required');
    }
    const taskId = String(rawTaskId).trim();
    const rawState = evt.state ?? evt.status ?? null;
    if (!isNonEmptyString(rawState)) return invalidReceipt('receipt.state is required');
    const state = rawState.trim();

    const seqRaw = evt.seq ?? evt.sequence ?? null;
    const seq = seqRaw === null || seqRaw === undefined || !Number.isFinite(Number(seqRaw)) ? null : Number(seqRaw);

    let eventId = null;
    for (const candidate of [evt.event_id, evt.eventId, evt.receipt_id, evt.receiptId, evt.id]) {
      if (candidate === null || candidate === undefined) continue;
      if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
      const value = String(candidate).trim();
      if (value.length === 0 || value === taskId) continue;
      eventId = value;
      break;
    }
    if (eventId === null && seq === null) {
      return invalidReceipt('receipt needs event_id, receipt_id or seq');
    }

    const output = evt.output ?? evt.result ?? null;
    const error = evt.error ?? null;
    const identity = eventId === null ? `seq:${taskId}:${seq}` : `id:${eventId}`;
    const hash = sha256Hex(stableJson({ task_id: taskId, state, seq, output, error }));
    const receipt = {
      event_id: eventId ?? `${taskId}:seq:${seq}`,
      task_id: taskId,
      state,
      seq,
      output,
      error,
      received_at: now(),
    };

    const existing = receipts.get(identity);
    if (existing) {
      if (existing.hash === hash) {
        return {
          ok: true,
          duplicate: true,
          applied: false,
          notified: 0,
          handler_errors: [],
          receipt: existing.receipt,
        };
      }
      const mapped = mapError('duplicate_dispatch');
      const { input, ...rest } = mapped;
      return {
        ok: false,
        duplicate: true,
        applied: false,
        notified: 0,
        handler_errors: [],
        ...rest,
        message: `receipt ${identity} was already applied with different content`,
      };
    }

    receipts.set(identity, { hash, receipt });
    const handlerErrors = [];
    let notified = 0;
    for (const handler of subscribers) {
      try {
        handler({ ...receipt });
        notified += 1;
      } catch (handlerError) {
        handlerErrors.push(handlerError?.message ?? String(handlerError));
      }
    }
    return {
      ok: true,
      duplicate: false,
      applied: true,
      notified,
      handler_errors: handlerErrors,
      receipt,
    };
  }

  return { dispatchTask, onResult, mapError };
}
