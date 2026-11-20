/**
 * Receipt auditing helpers.
 *
 * Every action is audited in the reply as `action name + parameter summary`.
 * The summary is a bounded, key-sorted projection with obvious secret material
 * redacted, so a chat log never carries a token, password or API key.
 */

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_KEYS = 40;
const MAX_DEPTH = 4;

const SENSITIVE_KEY = /(secret|token|password|passwd|api[-_]?key|credential|authorization|cookie)/i;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_SHAPE = /\b(?:sk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/g;
const KEY_VALUE = /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s"',;]+["']?/gi;

function truncate(text) {
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING - 3)}...` : text;
}

/** Redact credential-looking values from free text, then bound its length. */
export function sanitizeText(value) {
  let text = String(value ?? '');
  text = text.replace(BEARER, 'Bearer [redacted]');
  text = text.replace(TOKEN_SHAPE, '[redacted]');
  text = text.replace(KEY_VALUE, '$1=[redacted]');
  return truncate(text);
}

function summarizeValue(value, depth, key, seen) {
  if (key != null && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value == null) return value;

  const type = typeof value;
  if (type === 'string') return sanitizeText(value);
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint' || type === 'symbol') return String(value);
  if (type === 'function') return '[function]';

  if (value instanceof Error) return sanitizeText(value.message);
  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[array]' : '[object]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => summarizeValue(entry, depth + 1, null, seen));
  }

  if (type === 'object') {
    const result = {};
    for (const name of Object.keys(value).sort().slice(0, MAX_KEYS)) {
      const summarized = summarizeValue(value[name], depth + 1, name, seen);
      if (summarized !== undefined) result[name] = summarized;
    }
    return result;
  }

  return sanitizeText(value);
}

/** Bounded, key-sorted, secret-free projection of an audit payload. */
export function summarize(value) {
  return summarizeValue(value, 0, null, new WeakSet());
}

export function stableJson(value) {
  return JSON.stringify(summarize(value));
}

export function formatAuditLine(action) {
  const name = action?.name ?? 'unknown';
  const state = action?.executed === false ? '未执行' : '已执行';
  return `行动：${name}（${state}）· 参数：${stableJson(action?.args ?? {})}`;
}
