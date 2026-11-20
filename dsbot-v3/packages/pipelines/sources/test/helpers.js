/**
 * Deterministic doubles for the source-client tests. No network, no timers.
 */

import { createSourceClient, sha256Hex } from '../src/index.js';

export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

export const SUMMARIES = {
  1: 'Researchers measured how long readers stay with a story when the lede names the stake.',
  2: 'A second outlet reports the same finding from a different sample of readers.',
  3: 'A third summary that exists only to exercise a bounded hot list.',
};

export const STORIES = {
  1: { title: 'Story one', name: 'Source one', url: 'https://source1.example/story/1' },
  2: { title: 'Story two', name: 'Source two', url: 'https://source2.example/story/2' },
  3: { title: 'Story three', name: 'Source three', url: 'https://source3.example/story/3' },
};

/**
 * Raw source payload in snake_case, exactly as a feed may return it. Tests
 * override single fields to exercise invalid-item paths.
 */
export function rawItem(n = 1, overrides = {}) {
  const story = STORIES[n];
  return {
    id: `hot-${n}`,
    title: story.title,
    summary: SUMMARIES[n],
    source_name: story.name,
    source_url: story.url,
    published_at: `2026-11-20T1${n}:00:00.000Z`,
    ...overrides,
  };
}

export function expectedItem(n = 1) {
  const story = STORIES[n];
  return {
    id: `hot-${n}`,
    title: story.title,
    summary: SUMMARIES[n],
    sourceName: story.name,
    sourceUrl: story.url,
    publishedAt: `2026-11-20T1${n}:00:00.000Z`,
    contentHash: sha256Hex(SUMMARIES[n]),
  };
}

export function createClock() {
  const sleeps = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

/**
 * `handler({ url, options, call })` returns a response object, a promise, or
 * throws. `calls` records every attempt so retry policy is observable.
 */
export function createHttp(handler) {
  const calls = [];
  const http = async (url, options) => {
    calls.push({ url, options });
    return handler({ url, options, call: calls.length });
  };
  return { http, calls };
}

export function createTestClient(http, overrides = {}) {
  return createSourceClient({
    http,
    clock: createClock(),
    retries: 0,
    ...overrides,
  });
}
