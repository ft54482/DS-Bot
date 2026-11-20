/**
 * L45 model-gateway constants.
 *
 * Two backends:
 *   - `direct_http`: OpenAI-compatible `/chat/completions` over HTTPS, credentials
 *     from an injected `env` only (never written to disk by this package);
 *   - `dsh_bridge`:  the loopback MCP bridge (`127.0.0.1:17300/mcp`), authenticated
 *     with `bridge.secret`, which needs no model API key.
 */

export const GATEWAY_KINDS = Object.freeze(['direct_http', 'dsh_bridge']);

export const ERROR_CODES = Object.freeze({
  invalid_kind: 'invalid_kind',
  invalid_request: 'invalid_request',
  missing_credentials: 'missing_credentials',
  auth_failed: 'auth_failed',
  rate_limited: 'rate_limited',
  upstream_error: 'upstream_error',
  timeout: 'timeout',
  empty_completion: 'empty_completion',
  bad_response: 'bad_response',
  bridge_error: 'bridge_error',
});

/** Environment variable names (the gateway never reads the ambient environment itself). */
export const ENV_NAMES = Object.freeze({
  baseUrl: 'DSBOT_MODEL_BASE_URL',
  apiKey: 'DSBOT_MODEL_API_KEY',
  model: 'DSBOT_MODEL_NAME',
  bridgeUrl: 'DSBOT_BRIDGE_URL',
  bridgeSecret: 'DSH_BRIDGE_SECRET',
  bridgeSecretAlias: 'DSBOT_BRIDGE_SECRET',
  bridgeCwd: 'DSBOT_BRIDGE_CWD',
  bridgeTimeout: 'DSBOT_BRIDGE_TIMEOUT_MS',
});

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:17300/mcp';
export const DEFAULT_CHAT_PATH = '/chat/completions';

export const DEFAULT_TIMEOUT_MS = 60_000;
/** Bridge turns routinely outlive one `dsh_follow`; follow long turns in slices. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 180_000;
export const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 1_000;
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 300_000;

export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 5_000;

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = Object.freeze({
  name: 'dsbot-model-gateway',
  version: '0.1.0',
});

/** Bridge limits (README of @dsops/dsh-agent-bridge): follow <= 30 s / <= 200 events. */
export const MAX_FOLLOW_TIMEOUT_MS = 30_000;
export const MAX_FOLLOW_EVENTS = 200;
/** Never ask the bridge for less than this, even when the budget is nearly spent. */
export const MIN_FOLLOW_TIMEOUT_MS = 500;
/**
 * The bridge returns `timedOut: true` only when its own follow slice ends, so the
 * client deadline must be strictly later; otherwise it aborts in the same
 * millisecond the bridge would have answered and the whole run fails.
 */
export const FOLLOW_CLIENT_GRACE_MS = 5_000;
export const DEFAULT_BRIDGE_SOURCE = 'dsbot-model-gateway';
