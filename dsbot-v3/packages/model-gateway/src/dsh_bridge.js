import {
  DEFAULT_BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_BRIDGE_SOURCE,
  DEFAULT_BRIDGE_URL,
  ENV_NAMES,
  ERROR_CODES,
  FOLLOW_CLIENT_GRACE_MS,
  MAX_FOLLOW_EVENTS,
  MAX_FOLLOW_TIMEOUT_MS,
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  MIN_FOLLOW_TIMEOUT_MS,
} from './constants.js';
import { errorFromStatus, gatewayError, asGatewayError } from './errors.js';
import { withTimeout } from './clock.js';
import { firstNumber, firstString, mcpUrl, parseJson, parseRetryAfterMs, readTransportResponse } from './transport.js';
import { redact } from './sanitize.js';
import { retryOperation } from './retry.js';

const TURN_END_TYPES = new Set(['turn/end', 'turn.end']);

function missingBridgeCredentials() {
  const error = gatewayError(
    ERROR_CODES.missing_credentials,
    'dsh_bridge is missing the bridge secret: pass `bridgeSecret` or set DSH_BRIDGE_SECRET (the gateway never reads bridge.secret from disk)',
    { retryable: false },
  );
  error.missing = ['DSH_BRIDGE_SECRET'];
  return error;
}

function toolValue(result) {
  if (result === null || typeof result !== 'object') return {};
  if (result.structuredContent !== null && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const textPart = Array.isArray(result.content) ? result.content.find((part) => part?.type === 'text') : null;
  const text = typeof textPart?.text === 'string' ? textPart.text : null;
  const parsed = parseJson(text);
  if (parsed !== null) return parsed;
  return text === null ? {} : { text };
}

const TOOL_ERROR_NAMES = Object.freeze({
  RATE_LIMITED: { code: ERROR_CODES.rate_limited, retryable: true },
  HOST_ERROR: { code: ERROR_CODES.upstream_error, retryable: true },
  TIMEOUT: { code: ERROR_CODES.upstream_error, retryable: true },
  UNAVAILABLE: { code: ERROR_CODES.upstream_error, retryable: true },
  FORBIDDEN: { code: ERROR_CODES.auth_failed, retryable: false },
  UNAUTHORIZED: { code: ERROR_CODES.auth_failed, retryable: false },
  BAD_REQUEST: { code: ERROR_CODES.invalid_request, retryable: false },
});

function toolError(result, secrets) {
  const textPart = Array.isArray(result?.content) ? result.content.find((part) => part?.type === 'text') : null;
  const raw = typeof textPart?.text === 'string' ? textPart.text : 'bridge tool failed';
  const match = /^ERROR\s+([A-Z0-9_]+)\s*:\s*([\s\S]*)$/.exec(raw.trim());
  const name = match?.[1] ?? '';
  const message = redact(match?.[2] ?? raw, secrets);
  const mapped = TOOL_ERROR_NAMES[name];
  return gatewayError(mapped?.code ?? ERROR_CODES.bridge_error, `dsh_bridge ${name || 'tool'} failed: ${message}`, {
    retryable: mapped?.retryable ?? false,
  });
}

function textOf(value) {
  for (const key of ['text', 'output', 'completion']) {
    if (typeof value?.[key] === 'string' && value[key].trim().length > 0) return value[key];
  }
  if (typeof value?.message?.content === 'string' && value.message.content.trim().length > 0) {
    return value.message.content;
  }
  return null;
}

/**
 * `dsh_follow` carries the session projection snapshot as well as records.
 * `projections.values.turnOutline` is the whole-session turn outline: an array
 * of `{turn, seq, prompt, response}` entries (older bridges may wrap it in
 * `{turns, draft}`). Its `response`/`draft` is a bounded preview, so it is only
 * a fallback for records that carry no assistant text.
 */
function outlineText(outline) {
  if (outline === null || outline === undefined) return null;
  const turns = Array.isArray(outline)
    ? outline
    : Array.isArray(outline.turns)
      ? outline.turns
      : null;
  if (turns !== null) {
    // Only the newest turn belongs to the prompt this follow is waiting on.
    // Scanning backwards would return the previous turn's answer on a reused
    // session whose current turn has not produced text.
    const newest = turns.length > 0 ? turns[turns.length - 1] : null;
    const response = newest?.response;
    if (typeof response === 'string' && response.trim().length > 0) return response;
    const draft = outline?.draft;
    if (typeof draft === 'string' && draft.trim().length > 0) return draft;
    return null;
  }
  for (const key of ['response', 'draft', 'text']) {
    const value = outline[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function usageOf(value) {
  const usage = value?.usage ?? {};
  const input = firstNumber(usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const output = firstNumber(usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const result = {};
  if (input !== null) result.inputTokens = input;
  if (output !== null) result.outputTokens = output;
  return result;
}

function eventText(data) {
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.content === 'string') return data.content;
  if (Array.isArray(data?.content)) {
    const joined = data.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    if (joined.length > 0) return joined;
  }
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.message?.content === 'string') return data.message.content;
  if (Array.isArray(data?.message?.content)) {
    const joined = data.message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    if (joined.length > 0) return joined;
  }
  return null;
}

/** Only assistant output counts as completion text; tool/user events are ignored. */
function isAssistantEvent(type, data) {
  const role = typeof data?.role === 'string' ? data.role : typeof data?.message?.role === 'string' ? data.message.role : null;
  if (role !== null) return role === 'assistant';
  if (/user|input|tool/.test(type)) return false;
  return /assistant|message|reply|answer|output/.test(type);
}

function parseFollow(sinceSeq, follow) {
  let lastSeq = sinceSeq;
  let collected = '';
  let delta = '';
  let outline = null;
  let done = false;

  const projections = follow?.projections?.values;
  if (projections && projections.turnOutline !== undefined) {
    outline = projections.turnOutline;
  }

  const records = Array.isArray(follow?.records) ? follow.records : [];
  for (const record of records) {
    const seq = Number(record?.seq);
    if (Number.isFinite(seq) && seq > lastSeq) lastSeq = seq;
    const type = String(record?.type ?? '');
    if (TURN_END_TYPES.has(type)) done = true;
    const text = eventText(record?.data);
    if (text === null) continue;
    if (/delta|chunk/.test(type)) {
      if (isAssistantEvent(type, record?.data)) delta += text;
    } else if (isAssistantEvent(type, record?.data)) {
      collected = text;
    }
  }

  // The bridge returns its own cursor; advance with it even when the records
  // array was empty so a later follow on a reused session does not replay
  // prior turns.
  const cursor = Number(follow?.cursor?.lastSeq ?? follow?.cursor?.seq ?? follow?.asOfSeq);
  if (Number.isFinite(cursor) && cursor > lastSeq) lastSeq = cursor;

  const outlineValue = outlineText(outline);
  return {
    messageText: collected || null,
    deltaText: delta,
    outlineText: outlineValue,
    done,
    lastSeq,
    timedOut: follow?.timedOut === true,
  };
}

export function createDshBridgeBackend({ transport, clock, env, options }) {
  const secret = firstString(options.bridgeSecret, env[ENV_NAMES.bridgeSecret], env[ENV_NAMES.bridgeSecretAlias]);
  const bridgeUrl = mcpUrl(firstString(options.bridgeUrl, env[ENV_NAMES.bridgeUrl]) ?? DEFAULT_BRIDGE_URL);
  const cwd = firstString(options.cwd, env[ENV_NAMES.bridgeCwd]) ?? process.cwd();
  const source = firstString(options.source, DEFAULT_BRIDGE_SOURCE).slice(0, 64);
  const title = String(options.title ?? 'model-gateway completion');
  const follow = options.follow !== false;
  const reuseSession = options.reuseSession === true;
  const secrets = [secret];

  let nextId = 0;
  /** Reused across complete() calls when `reuseSession` is on. */
  let session = null;

  async function rpc(method, params, requestOptions = {}) {
    const notification = requestOptions.notification === true;
    const timeoutMs = requestOptions.timeoutMs;
    const envelope = {
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      ...(notification ? {} : { id: ++nextId }),
    };

    let response;
    try {
      response = await withTimeout(
        Promise.resolve(
          transport({
            url: bridgeUrl,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify(envelope),
            timeoutMs,
          }),
        ),
        timeoutMs,
        clock,
        () => gatewayError(ERROR_CODES.timeout, `dsh_bridge ${method} timed out after ${timeoutMs} ms`, { retryable: false }),
      );
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw gatewayError(ERROR_CODES.timeout, `dsh_bridge ${method} timed out after ${timeoutMs} ms`, {
          retryable: false,
        });
      }
      const normalized = asGatewayError(error, ERROR_CODES.upstream_error);
      if (normalized.code === ERROR_CODES.timeout) throw normalized;
      throw gatewayError(
        ERROR_CODES.upstream_error,
        `dsh_bridge ${method} transport failed: ${redact(normalized.message, secrets)}`,
        { retryable: true },
      );
    }

    let parsedResponse;
    try {
      parsedResponse = await readTransportResponse(response);
    } catch (error) {
      throw gatewayError(
        ERROR_CODES.bad_response,
        `dsh_bridge ${method} returned an unusable response: ${redact(asGatewayError(error).message, secrets)}`,
        { retryable: true },
      );
    }

    const { status, headers, body } = parsedResponse;
    if (status < 200 || status >= 300) {
      const error = errorFromStatus(status, 'dsh_bridge');
      const retryAfterMs = status === 429 ? parseRetryAfterMs(headers) : null;
      if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
      throw error;
    }
    if (notification) return null;

    const json = parseJson(body);
    if (json === null) {
      throw gatewayError(ERROR_CODES.bad_response, `dsh_bridge ${method} returned a non-JSON body`, {
        status,
        retryable: true,
      });
    }
    if (json.error !== undefined && json.error !== null) {
      const code = Number(json.error.code);
      throw gatewayError(
        ERROR_CODES.bridge_error,
        `dsh_bridge ${method} failed: ${redact(String(json.error.message ?? 'JSON-RPC error'), secrets)}`,
        { retryable: code === -32603 },
      );
    }
    if (json.result?.isError === true) throw toolError(json.result, secrets);
    return json.result;
  }

  async function callTool(name, args, requestOptions = {}) {
    const result = await rpc('tools/call', { name, arguments: args }, requestOptions);
    return toolValue(result);
  }

  function sessionArguments() {
    const args = { cwd, source, title };
    if (options.bridgeModel !== undefined && options.bridgeModel !== null) args.model = options.bridgeModel;
    if (options.preset !== undefined && options.preset !== null) args.preset = options.preset;
    return args;
  }

  function promptText(request) {
    if (typeof request.system === 'string' && request.system.length > 0) {
      return `${request.system}\n\n${request.prompt}`;
    }
    return request.prompt;
  }

  function pollInterval() {
    const value = Number(options.pollIntervalMs);
    return Number.isFinite(value) && value > 0
      ? Math.max(50, Math.trunc(value))
      : DEFAULT_BRIDGE_POLL_INTERVAL_MS;
  }

  /**
   * A long generation cannot be awaited with one `dsh_follow`: the bridge caps
   * each follow at 30 s and answers `timedOut: true` when its slice ends. Follow
   * in slices, and let the client rpc deadline outlive the server slice
   * (`slice + FOLLOW_CLIENT_GRACE_MS`); a client-side wait timeout is not fatal,
   * it only means there is no progress yet and the next slice should be read.
   */
  async function followText(sessionId, sinceSeq, timeoutMs) {
    const interval = pollInterval();
    const deadline = clock.now() + timeoutMs;
    // A frozen fake clock must not spin forever: bound the number of follows.
    const maxFollows = Math.max(2, Math.ceil(timeoutMs / Math.max(interval, 1)) + 2);
    let cursor = sinceSeq;
    let messageText = '';
    let deltaText = '';

    for (let follows = 1; follows <= maxFollows; follows += 1) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      const slice = Math.max(MIN_FOLLOW_TIMEOUT_MS, Math.min(MAX_FOLLOW_TIMEOUT_MS, remaining));

      let parsed = null;
      try {
        const follow = await callTool(
          'dsh_follow',
          { sessionId, sinceSeq: cursor, maxEvents: MAX_FOLLOW_EVENTS, timeoutMs: slice },
          { timeoutMs: slice + FOLLOW_CLIENT_GRACE_MS },
        );
        parsed = parseFollow(cursor, follow);
      } catch (error) {
        const normalized = asGatewayError(error);
        // Waiting out a slice is normal; keep following until the budget ends.
        if (normalized.code !== ERROR_CODES.timeout) throw normalized;
      }

      if (parsed !== null) {
        if (parsed.messageText !== null) messageText = parsed.messageText;
        if (parsed.deltaText.length > 0) deltaText += parsed.deltaText;
        if (parsed.lastSeq > cursor) cursor = parsed.lastSeq;
        // Assistant records end the turn; the outline preview is only trusted
        // once turn/end confirms it, so a mid-turn draft cannot be returned.
        const text = messageText || deltaText || (parsed.done ? parsed.outlineText : null);
        if (text !== null && text.trim().length > 0) {
          return { text, done: parsed.done, lastSeq: cursor };
        }
        if (parsed.done) return { text: null, done: true, lastSeq: cursor };
      }

      if (clock.now() >= deadline) break;
      await clock.sleep(interval);
    }

    throw gatewayError(ERROR_CODES.timeout, `dsh_bridge did not finish the turn within ${timeoutMs} ms`, {
      retryable: false,
    });
  }

  async function attempt(request, timeoutMs) {
    let promptAccepted = false;
    try {
      await rpc(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO },
        { timeoutMs },
      );
      await rpc('notifications/initialized', {}, { notification: true, timeoutMs });

      // Session reuse: create one DSH session per backend instance and keep
      // prompting it. A failed prompt before acceptance may retry, but the
      // already-created session is reused instead of creating a second one.
      let active = reuseSession ? session : null;
      if (active === null) {
        const created = await callTool('dsh_create_session', sessionArguments(), { timeoutMs });
        const sessionId = firstString(created.sessionId, created.session_id);
        if (sessionId === null) {
          throw gatewayError(ERROR_CODES.bad_response, 'dsh_create_session returned no sessionId', {
            retryable: false,
          });
        }
        active = { sessionId, cursor: 0 };
        if (reuseSession) session = active;
      }
      const sessionId = active.sessionId;

      const prompted = await callTool(
        'dsh_prompt',
        { sessionId, text: promptText(request), delivery: 'queue' },
        { timeoutMs },
      );
      if (prompted.accepted !== true) {
        throw gatewayError(ERROR_CODES.bridge_error, 'dsh_prompt was not accepted', { retryable: false });
      }
      promptAccepted = true;

      let text = textOf(prompted);
      const promptedCursor = Number(prompted.cursor?.lastSeq ?? prompted.lastSeq);
      if (Number.isFinite(promptedCursor) && promptedCursor > active.cursor) {
        active.cursor = promptedCursor;
      }
      if (text === null && follow) {
        const followed = await followText(sessionId, reuseSession ? active.cursor : 0, timeoutMs);
        text = followed.text;
        active.cursor = followed.lastSeq;
      }
      if (text === null || text.trim().length === 0) {
        throw gatewayError(ERROR_CODES.empty_completion, 'dsh_bridge returned an empty completion', {
          retryable: false,
        });
      }
      return { text, usage: usageOf(prompted) };
    } catch (error) {
      const normalized = asGatewayError(error);
      if (promptAccepted && normalized.retryable) {
        // A retry after the bridge accepted the prompt would run the task twice.
        normalized.retryable = false;
      }
      throw normalized;
    }
  }

  return {
    async complete(request) {
      if (secret === null) throw missingBridgeCredentials();
      const startedAt = clock.now();
      const timeoutMs = request.timeoutMs;
      const result = await retryOperation(() => attempt(request, timeoutMs), {
        clock,
        maxRetries: options.maxRetries,
        backoffMs: options.backoffMs,
      });
      return {
        text: redact(result.text, secrets),
        usage: result.usage,
        backend: 'dsh_bridge',
        latencyMs: Math.max(0, clock.now() - startedAt),
      };
    },
  };
}
