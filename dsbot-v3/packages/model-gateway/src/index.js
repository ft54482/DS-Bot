/**
 * L45 model gateway: one `complete()` contract over two backends.
 *
 *   direct_http — OpenAI-compatible HTTPS endpoint, credentials from an injected
 *                 `env` (DSBOT_MODEL_BASE_URL / DSBOT_MODEL_API_KEY / DSBOT_MODEL_NAME);
 *   dsh_bridge  — loopback MCP bridge on 127.0.0.1:17300/mcp, authenticated with
 *                 bridge.secret, so no model API key is needed.
 *
 * Everything that leaves the process is injected: `transport` (wire) and
 * `clock` (time). Tests never touch the network or a real secret file.
 */

import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ENV_NAMES,
  ERROR_CODES,
  GATEWAY_KINDS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from './constants.js';
import { normalizeClock } from './clock.js';
import { gatewayError } from './errors.js';
import { createDirectHttpBackend } from './direct_http.js';
import { createDshBridgeBackend } from './dsh_bridge.js';

function clampTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_TIMEOUT_MS) {
    throw gatewayError(ERROR_CODES.invalid_request, `timeoutMs must be a positive number, received ${String(value)}`, {
      retryable: false,
    });
  }
  return Math.min(Math.trunc(number), MAX_TIMEOUT_MS);
}

function clampRetries(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_RETRIES;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 5) {
    throw gatewayError(ERROR_CODES.invalid_request, 'maxRetries must be an integer between 0 and 5', {
      retryable: false,
    });
  }
  return number;
}

function clampBackoff(value) {
  if (value === undefined || value === null) return DEFAULT_BACKOFF_MS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw gatewayError(ERROR_CODES.invalid_request, 'backoffMs must be a non-negative number', { retryable: false });
  }
  return Math.trunc(number);
}

function readEnvironment(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw gatewayError(ERROR_CODES.invalid_request, 'env must be a plain object', { retryable: false });
  }
  return env;
}

/**
 * The bridge needs a longer default budget than a direct HTTP call: one long
 * turn is polled until it finishes. An explicit gateway-level `timeoutMs` wins,
 * then `DSBOT_BRIDGE_TIMEOUT_MS`, then 180 s; `request.timeoutMs` overrides the
 * resulting default per call. Everything is capped at 300 s.
 */
function bridgeDefaultTimeoutMs(options, env) {
  if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
    return clampTimeout(options.timeoutMs, DEFAULT_BRIDGE_TIMEOUT_MS);
  }
  const configured = Number(env[ENV_NAMES.bridgeTimeout]);
  if (Number.isFinite(configured) && configured >= MIN_TIMEOUT_MS) {
    return clampTimeout(configured, DEFAULT_BRIDGE_TIMEOUT_MS);
  }
  return DEFAULT_BRIDGE_TIMEOUT_MS;
}

function validateRequest(request, defaultTimeoutMs) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw gatewayError(ERROR_CODES.invalid_request, 'complete() requires a request object', { retryable: false });
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw gatewayError(ERROR_CODES.invalid_request, 'complete() requires a non-empty prompt string', {
      retryable: false,
    });
  }
  if (request.system !== undefined && request.system !== null && typeof request.system !== 'string') {
    throw gatewayError(ERROR_CODES.invalid_request, 'system must be a string when provided', { retryable: false });
  }
  let maxTokens = null;
  if (request.maxTokens !== undefined && request.maxTokens !== null) {
    const number = Number(request.maxTokens);
    if (!Number.isInteger(number) || number <= 0) {
      throw gatewayError(ERROR_CODES.invalid_request, 'maxTokens must be a positive integer', { retryable: false });
    }
    maxTokens = number;
  }
  return {
    prompt: request.prompt,
    system: typeof request.system === 'string' ? request.system : null,
    maxTokens,
    timeoutMs: clampTimeout(request.timeoutMs, defaultTimeoutMs),
  };
}

export function createGateway(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw gatewayError(ERROR_CODES.invalid_request, 'createGateway requires an options object', { retryable: false });
  }
  if (!GATEWAY_KINDS.includes(options.kind)) {
    throw gatewayError(
      ERROR_CODES.invalid_kind,
      `kind must be one of ${GATEWAY_KINDS.join(', ')}, received ${String(options.kind)}`,
      { retryable: false },
    );
  }
  if (typeof options.transport !== 'function') {
    throw gatewayError(
      ERROR_CODES.invalid_request,
      'createGateway requires an injected transport function (nothing connects to the network by itself)',
      { retryable: false },
    );
  }
  if (options.clock !== undefined && options.clock !== null && typeof options.clock !== 'function' && typeof options.clock !== 'object') {
    throw gatewayError(ERROR_CODES.invalid_request, 'clock must be a function or an object', { retryable: false });
  }

  const clock = normalizeClock(options.clock);
  const env = readEnvironment(options.env);
  const settings = {
    ...options,
    env,
    maxRetries: clampRetries(options.maxRetries),
    backoffMs: clampBackoff(options.backoffMs),
    timeoutMs:
      options.kind === 'dsh_bridge'
        ? bridgeDefaultTimeoutMs(options, env)
        : clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS),
  };

  const backend =
    options.kind === 'direct_http'
      ? createDirectHttpBackend({ transport: options.transport, clock, env, options: settings })
      : createDshBridgeBackend({ transport: options.transport, clock, env, options: settings });

  return Object.freeze({
    kind: options.kind,
    async complete(request) {
      return backend.complete(validateRequest(request, settings.timeoutMs));
    },
  });
}

export { ERROR_CODES, ENV_NAMES, GATEWAY_KINDS } from './constants.js';
export { GatewayError, gatewayError } from './errors.js';
export { redact, sanitize } from './sanitize.js';
export { fetchTransport } from './transport.js';
