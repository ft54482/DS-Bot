/**
 * Environment mapping for a dispatched task.
 *
 * The runtime receives a picked environment, the allowlist it was picked from,
 * and a digest of the picked values so a receipt can be re-checked later
 * (`docs/prd/03-acceptance-spec.md` §4.4.1 uses `env_allowlist`/`env_digest`
 * for exactly this purpose). Keys outside the allowlist are never forwarded.
 */

import { DEFAULT_ENV_ALLOWLIST } from './constants.js';
import { sha256Hex, stableJson } from './util.js';

export function normalizeAllowlist(list = DEFAULT_ENV_ALLOWLIST) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalized.push(key);
  }
  return normalized;
}

/**
 * Pick allowlisted keys from `sourceEnv`.
 *
 * Matching is case-insensitive because Windows exposes `Path` while the PRD
 * names `PATH`; the emitted object always uses the allowlist's spelling. This
 * only affects which *allowed* key is found, never whether a key is allowed.
 */
export function pickAllowedEnv(sourceEnv = {}, allowlist = DEFAULT_ENV_ALLOWLIST) {
  const picked = {};
  if (!sourceEnv || typeof sourceEnv !== 'object') return picked;
  const actualByLower = new Map();
  for (const key of Object.keys(sourceEnv)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const lower = key.toLowerCase();
    if (!actualByLower.has(lower)) actualByLower.set(lower, key);
  }
  for (const key of normalizeAllowlist(allowlist)) {
    const actual = Object.hasOwn(sourceEnv, key) ? key : actualByLower.get(key.toLowerCase());
    if (actual === undefined) continue;
    const value = sourceEnv[actual];
    if (value === undefined || value === null) continue;
    picked[key] = String(value);
  }
  return picked;
}

/** `sha256:<hex>` over the picked environment, independent of key order. */
export function envDigest(env = {}) {
  const values = {};
  if (env && typeof env === 'object') {
    for (const key of Object.keys(env).sort()) {
      if (env[key] === undefined || env[key] === null) continue;
      values[key] = String(env[key]);
    }
  }
  return `sha256:${sha256Hex(stableJson(values))}`;
}
