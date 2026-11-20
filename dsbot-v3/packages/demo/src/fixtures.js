/**
 * Deterministic, offline doubles for the L29 self-media demo.
 *
 * The demo represents every external dependency as an injected stub:
 *   - `search` returns two independent sources for the same key claim;
 *   - `fetch` returns a local body for those two URLs and rejects anything else;
 *   - `model.write` / `model.review` return a passing draft and independent
 *     review rubric.
 *
 * Nothing here reads the network or the filesystem. The call counters are part
 * of the report so the demo can prove it only used the injected doubles.
 */

export const DEMO_TICKET = 'L29';
export const DEMO_TOPIC = 'Why long AI chats make work messier';
export const DEMO_PROJECT = 'self-media';
export const DEMO_PLATFORM = 'wechat';
export const DEMO_ACCOUNT = '翔解';
export const DEMO_FETCHED_AT = '2026-11-20T10:00:00.000Z';

export const SOURCE_ALPHA = 'https://alpha.example/ai-attention';
export const SOURCE_BETA = 'https://beta.example/field-report';

export const KEY_CLAIM = 'Long AI chat sessions increase context switching.';
export const SUPPORTING_CLAIM = 'Teams report more rework after long chat sessions.';

export const SOURCE_BODIES = Object.freeze({
  [SOURCE_ALPHA]:
    'A controlled study of knowledge workers found that long AI chat sessions increase context switching and raise the cost of returning to the original task.',
  [SOURCE_BETA]:
    'Interviews with twelve teams describe how long AI chat sessions increase context switching. The report also notes more rework when a conversation grows past an hour.',
});

export const SEARCH_RESULTS = Object.freeze([
  Object.freeze({
    url: SOURCE_ALPHA,
    title: 'Alpha context-switching study',
    claims: Object.freeze([
      Object.freeze({ text: KEY_CLAIM, key: true }),
      Object.freeze({ text: SUPPORTING_CLAIM }),
    ]),
  }),
  Object.freeze({
    url: SOURCE_BETA,
    title: 'Beta field report',
    claims: Object.freeze([Object.freeze({ text: KEY_CLAIM, key: true })]),
  }),
]);

function cloneSearchResults() {
  return SEARCH_RESULTS.map((source) => ({
    url: source.url,
    title: source.title,
    claims: source.claims.map((claim) => ({ ...claim })),
  }));
}

function buildBody(context) {
  const facts = Array.isArray(context?.facts) ? context.facts : [];
  const sources = Array.isArray(context?.sources) ? context.sources : [];
  const paragraphs = facts.map((fact) => fact.claim).filter((claim) => typeof claim === 'string');
  const referenceLines = sources.map((source, index) => `[${index + 1}] ${source.url}`);
  return [
    `# ${context?.topic ?? DEMO_TOPIC}`,
    '',
    'The evidence points to one conclusion.',
    '',
    ...(paragraphs.length > 0 ? paragraphs.flatMap((line) => [line, '']) : []),
    '## Sources',
    '',
    ...referenceLines,
    '',
  ].join('\n');
}

/**
 * Create the three stub surfaces the pilot expects plus call counters.
 *
 * @returns {{
 *   search: (query: object) => Promise<object[]>,
 *   fetch: (url: string, context?: object) => Promise<object>,
 *   model: { write: Function, review: Function },
 *   calls: { search: number, fetch: number, write: number, review: number },
 *   fetchedUrls: string[],
 *   unexpectedUrls: string[]
 * }}
 */
export function createStubs() {
  const calls = { search: 0, fetch: 0, write: 0, review: 0 };
  const fetchedUrls = [];
  const unexpectedUrls = [];
  const knownUrls = new Set(Object.keys(SOURCE_BODIES));

  const search = async (query) => {
    calls.search += 1;
    if (!query || typeof query.topic !== 'string' || query.topic.trim() === '') {
      throw new Error('demo search stub requires a query.topic');
    }
    return cloneSearchResults();
  };

  const fetch = async (url) => {
    calls.fetch += 1;
    fetchedUrls.push(url);
    if (!knownUrls.has(url)) {
      unexpectedUrls.push(url);
      throw new Error(`demo fetch stub has no offline body for ${url}`);
    }
    return { ok: true, text: SOURCE_BODIES[url], fetched_at: DEMO_FETCHED_AT };
  };

  const model = {
    async write(context) {
      calls.write += 1;
      const topic = context?.topic ?? DEMO_TOPIC;
      return {
        title_candidates: [
          topic,
          `${topic}: what the evidence shows`,
          `A practical guide to ${topic}`,
        ],
        body: buildBody(context),
        usage: { tokens_in: 900, tokens_out: 420, tokens_cached: 0, cost_cny: 0.02 },
      };
    },

    async review(context) {
      calls.review += 1;
      const body = context?.article?.body ?? '';
      return {
        score: 88,
        issues: [],
        rubric: {
          structure: { score: 86, issues: [] },
          readability: { score: 83, issues: [] },
          style: { score: 84, issues: [] },
        },
        reviewer: {
          id: 'demo-reviewer',
          context_id: 'ctx-demo-reviewer',
          independent: true,
        },
        citations: {
          total_chars: Math.max(body.length, 1),
          quoted_chars: 0,
        },
        risks: [],
        cover_copy: 'Long AI chats, one task at a time',
        usage: { tokens_in: 600, tokens_out: 120, tokens_cached: 0, cost_cny: 0.01 },
      };
    },
  };

  return { search, fetch, model, calls, fetchedUrls, unexpectedUrls };
}
