/**
 * Deterministic doubles for the self-media pilot tests. No network, no timers.
 */

export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const FETCHED_AT = '2026-11-20T10:00:00.000Z';

export const TOPIC = 'Why long AI chats make work messier';
export const KEY_CLAIM = 'Long AI chat sessions increase context switching.';
export const MINOR_CLAIM = 'Teams report more rework after long chat sessions.';

export const SOURCE_A = 'https://alpha.example/ai-attention';
export const SOURCE_B = 'https://beta.example/field-report';

export const BODIES = {
  [SOURCE_A]:
    'A controlled study of knowledge workers found that long AI chat sessions increase context switching and raise the cost of returning to the original task. The effect persisted after a short break.',
  [SOURCE_B]:
    'Interviews with twelve teams describe how long AI chat sessions increase context switching. The report also notes more rework when a conversation grows past an hour.',
};

export const SEARCH_RESULTS = [
  {
    url: SOURCE_A,
    title: 'Alpha context-switching study',
    claims: [{ text: KEY_CLAIM, key: true }, { text: MINOR_CLAIM }],
  },
  {
    url: SOURCE_B,
    title: 'Beta field report',
    claims: [{ text: KEY_CLAIM, key: true }],
  },
];

export const DEFAULT_TITLES = [
  TOPIC,
  `${TOPIC}: what the evidence shows`,
  `A practical guide to ${TOPIC}`,
];

export const DEFAULT_BODY = `# ${TOPIC}\n\nThe evidence points to one conclusion.\n`;

export function createSearch(results = SEARCH_RESULTS) {
  const calls = [];
  const search = async (query) => {
    calls.push(query);
    return typeof results === 'function' ? results(query, calls.length) : results;
  };
  return { search, calls };
}

/**
 * `bodies` is a URL -> text map; `failing` is a URL -> error message map. A
 * failing URL throws, the harshest unreachable case.
 */
export function createFetch({ bodies = BODIES, failing = {} } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (Object.hasOwn(failing, url)) {
      throw new Error(failing[url] ?? `unreachable: ${url}`);
    }
    if (Object.hasOwn(bodies, url)) {
      return { ok: true, text: bodies[url], fetched_at: FETCHED_AT };
    }
    return { ok: false, error: `not found: ${url}` };
  };
  return { fetch, calls };
}

export function createWriter({ titles = DEFAULT_TITLES, body = DEFAULT_BODY, calls } = {}) {
  const write = async (context) => {
    calls?.push(context);
    return {
      title_candidates: [...titles],
      body,
      usage: { tokens_in: 100, tokens_out: 200, tokens_cached: 0, cost_cny: 0.01 },
    };
  };
  return write;
}

export function passReview(overrides = {}) {
  return {
    score: 88,
    issues: [],
    rubric: {
      structure: { score: 86, issues: [] },
      readability: { score: 82, issues: [] },
      style: { score: 84, issues: [] },
    },
    reviewer: { id: 'reviewer-1', context_id: 'ctx-review-1', independent: true },
    citations: { total_chars: 2000, quoted_chars: 120 },
    risks: [],
    ...overrides,
  };
}

export function createReview(handler = () => passReview()) {
  const calls = [];
  const review = async (context) => {
    calls.push(context);
    return handler(context, calls.length);
  };
  return { review, calls };
}

/** Default happy-path harness: two reachable sources, clean writer and review. */
export function makeHarness(overrides = {}) {
  const search = createSearch();
  const fetch = createFetch();
  const writeCalls = [];
  const write = createWriter({ calls: writeCalls });
  const review = createReview();

  const deps = {
    now: () => NOW,
    search: search.search,
    fetch: fetch.fetch,
    model: { write, review: review.review },
    tags: ['AI', '注意力', '效率'],
    platform: 'wechat',
    account: '翔解',
    ...overrides,
  };

  return {
    deps,
    searchCalls: search.calls,
    fetchCalls: fetch.calls,
    writeCalls,
    reviewCalls: review.calls,
  };
}
