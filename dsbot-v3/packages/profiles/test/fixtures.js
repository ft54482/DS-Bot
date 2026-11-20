import { selfMediaProfileV1 } from '../src/index.js';

export const NOW = Date.parse('2026-11-20T12:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

const HASH_ALPHABET = '0123456789abcdef';

/** Deterministic 64-hex snapshot hash for a source label. */
export function hashFor(label) {
  let state = 0;
  for (const char of String(label)) state = (state * 31 + char.charCodeAt(0)) >>> 0;
  let out = '';
  for (let index = 0; index < 64; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out += HASH_ALPHABET[state % 16];
  }
  return out;
}

export function makeSnapshot(label, overrides = {}) {
  return {
    sha256: hashFor(label),
    captured_at: '2026-10-02T00:00:00.000Z',
    excerpt: `snapshot excerpt for ${label}`,
    ...overrides,
  };
}

export function makeSource(host, overrides = {}) {
  const snapshot = overrides.snapshot === undefined ? makeSnapshot(host) : overrides.snapshot;
  return {
    url: `https://${host}/research/2026/10/ai-attention`,
    publisher: host,
    published_at: '2026-10-01T00:00:00.000Z',
    fetched_at: '2026-10-02T00:00:00.000Z',
    ...overrides,
    snapshot,
  };
}

export function makeFact(id, overrides = {}) {
  return {
    id,
    key: true,
    statement: `load-bearing claim ${id} needs independent corroboration`,
    sources: [makeSource('alpha.example'), makeSource('beta.example')],
    ...overrides,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

/**
 * A complete, passing article pack. Tests override only what the case under
 * test changes; the returned object is a fresh deep-ish copy each call.
 */
export function makePack(overrides = {}) {
  const pack = {
    schema_version: 1,
    article: {
      title: '为什么跟 AI 聊得越久，做事反而越乱？',
      body: 'A complete article body with a hook, a main line, evidence and a close.',
      author: { id: 'content-bot', context_id: 'ctx-writer-1' },
    },
    facts: [makeFact('F1'), makeFact('F2')],
    quality: {
      reviewer: {
        id: 'reviewer-1',
        context_id: 'ctx-review-1',
        independent: true,
        model: 'deepseek-v4.1-flash',
      },
      rubric: {
        structure: { score: 86, issues: [] },
        readability: { score: 82, issues: [] },
        style: { score: 84, issues: [] },
      },
    },
    layout: {
      titles: ['跟 AI 聊得越久越乱？', 'AI 对话的注意力陷阱', '为什么越聊越不会做事'],
      tags: ['AI', '认知', '效率'],
      cover_copy: '聊得越久，做事越乱',
      platform: 'wechat',
      account: '翔解',
    },
    citations: { total_chars: 2000, quoted_chars: 120 },
    compliance: { risks: [] },
  };
  return merge(pack, overrides);
}

export function makeProfile(overrides = {}) {
  return merge(structuredClone(selfMediaProfileV1), overrides);
}

export function itemById(result, id) {
  return result.items.find((item) => item.id === id);
}

export function itemResults(result) {
  return Object.fromEntries(result.items.map((item) => [item.id, item.result]));
}
