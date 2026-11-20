import { ProvisionError } from './errors.js';

export const DEFAULT_MAX_WORKERS = 4;
export const MAX_WORKERS_LIMIT = 64;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PORT_PATTERN = /^\d+$/;

function invalid(message, details = {}) {
  throw new ProvisionError('invalid_input', message, details);
}

/** Profile names are also directory names, so they may not traverse paths. */
export function assertName(value) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    invalid('name must be 1-64 chars of lower-case letters, digits or dashes', {
      field: 'name',
      value,
    });
  }
  return value;
}

/** Repository must be a plain `owner/name` slug, not a URL. */
export function assertRepo(value) {
  if (typeof value !== 'string' || !REPO_PATTERN.test(value)) {
    invalid('repo must look like `owner/name`', { field: 'repo', value });
  }
  return value;
}

/** The GitHub account trusted by the generated policy whitelist. */
export function assertAccount(value) {
  if (typeof value !== 'string' || !ACCOUNT_PATTERN.test(value)) {
    invalid('account must be a GitHub login', { field: 'account', value });
  }
  return value;
}

export function assertModel(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('model must be a non-empty string', { field: 'model', value });
  }
  return value.trim();
}

/** `port` may be an integer or the literal string `auto`. */
export function normalizePort(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') {
    return 'auto';
  }
  const numeric = typeof value === 'string' && PORT_PATTERN.test(value) ? Number(value) : value;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    invalid('port must be `auto` or an integer between 1 and 65535', {
      field: 'port',
      value,
    });
  }
  return numeric;
}

export function normalizeMaxWorkers(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_WORKERS;
  const numeric = typeof value === 'string' && PORT_PATTERN.test(value) ? Number(value) : value;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_WORKERS_LIMIT) {
    invalid(`maxWorkers must be an integer between 1 and ${MAX_WORKERS_LIMIT}`, {
      field: 'maxWorkers',
      value,
    });
  }
  return numeric;
}

/**
 * Blocked commands are passed through to the executor settings as an array.
 * A string is split on whitespace, which matches the DSH environment variable
 * convention (`DSH_SUPERAGENT_BLOCKED_COMMANDS`).
 */
export function normalizeBlockedCommands(value) {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(list)) {
    invalid('blockedCommands must be an array of strings or a whitespace-separated string', {
      field: 'blockedCommands',
      value,
    });
  }
  return list.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      invalid('blockedCommands entries must be non-empty strings', {
        field: 'blockedCommands',
        value: item,
      });
    }
    return item.trim();
  });
}

export function normalizeDshHome(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('dshHome must be a non-empty path', { field: 'dshHome', value });
  }
  return value;
}

export function normalizeWorkRoot(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('workRoot must be a non-empty path', { field: 'workRoot', value });
  }
  return value;
}

export function normalizeNow(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const stamp = typeof value === 'function' ? value() : value;
  if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp))) {
    invalid('now must be an ISO timestamp string or a function returning one', {
      field: 'now',
      value: stamp,
    });
  }
  return stamp;
}

export function normalizeProbe(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') {
    invalid('probe must be a function when provided', { field: 'probe' });
  }
  return value;
}

export function normalizeIsPortFree(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'function') {
    invalid('isPortFree must be a function when provided', { field: 'isPortFree' });
  }
  return value;
}

const FS_METHODS = ['homedir', 'exists', 'readFile', 'writeFile', 'mkdir', 'remove', 'list'];

/** Every file/process interaction is supplied by the caller, never imported. */
export function assertFs(value) {
  if (!value || typeof value !== 'object') {
    invalid('fs adapter is required', { field: 'fs' });
  }
  const missing = FS_METHODS.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    invalid(`fs adapter is missing: ${missing.join(', ')}`, {
      field: 'fs',
      missing,
    });
  }
  return value;
}
