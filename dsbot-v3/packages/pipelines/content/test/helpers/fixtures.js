/**
 * Deterministic doubles for the content chain tests. No network, no timers.
 */

export const TOPIC = 'Why long AI chats make work messier';
export const KEY_CLAIM = 'Long AI chat sessions increase context switching.';
export const MINOR_CLAIM = 'Teams report more rework after long chat sessions.';

export const SOURCE_A = 'https://example.test/source-a';
export const SOURCE_B = 'https://example.test/source-b';
export const SOURCE_C = 'https://example.test/source-c';

export const BODIES = {
  [SOURCE_A]:
    'A controlled study of knowledge workers found that long AI chat sessions increase context switching and raise the cost of returning to the original task. The effect persisted after a short break.',
  [SOURCE_B]:
    'Interviews with twelve teams describe how long AI chat sessions increase context switching. The report also notes more rework when the conversation grows past an hour.',
  [SOURCE_C]:
    'A single team blog post claims that long AI chat sessions increase context switching, but the post offers no data and no second source.',
};

export const SEARCH_RESULTS = [
  {
    url: SOURCE_A,
    title: 'Context switching study',
    claims: [{ text: KEY_CLAIM, key: true }, { text: MINOR_CLAIM }],
  },
  {
    url: SOURCE_B,
    title: 'Field report',
    claims: [{ text: KEY_CLAIM, key: true }],
  },
];

export function createClock(start = Date.UTC(2026, 10, 20, 15, 0, 0)) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

export function createSearch(results = SEARCH_RESULTS) {
  const calls = [];
  const search = async (query) => {
    calls.push(query);
    return results;
  };
  return { search, calls };
}

/**
 * `bodies` is a URL -> text map. `failing` is a URL -> error message map; a
 * failing URL throws, which is the harshest unreachable case.
 */
export function createFetch({ bodies = BODIES, failing = {} } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (Object.prototype.hasOwnProperty.call(failing, url)) {
      throw new Error(failing[url] ?? `unreachable: ${url}`);
    }
    if (Object.prototype.hasOwnProperty.call(bodies, url)) {
      return { ok: true, text: bodies[url] };
    }
    return { ok: false, error: `not found: ${url}` };
  };
  return { fetch, calls };
}

export function createSnapshotStore(entries = {}) {
  const store = new Map(Object.entries(entries));
  return store;
}

export function createWriterModel({ usage = { tokens_in: 120, tokens_out: 80, tokens_cached: 0, cost_cny: 0.02 } } = {}) {
  const calls = [];
  const write = async ({ topic, facts }) => {
    calls.push({ topic, facts });
    const evidence = facts.map((fact) => fact.claim).join('\n\n');
    return {
      title_candidates: [
        topic,
        `${topic}: a closer look`,
        `Three things to know about ${topic}`,
      ],
      body: `# ${topic}\n\n${evidence}\n\n## Sources\n\n[1] ${SOURCE_A}\n[2] ${SOURCE_B}\n`,
      usage,
    };
  };
  return { write, calls };
}

export function createReviewModel(review, { usage = { tokens_in: 40, tokens_out: 20, tokens_cached: 0, cost_cny: 0.01 } } = {}) {
  const calls = [];
  const reviewer = async (payload) => {
    calls.push(payload);
    return typeof review === 'function' ? review(payload) : { ...review, usage };
  };
  return { review: reviewer, calls };
}

export function dispatchEnvelope({
  run_id = 'run-1',
  goal = TOPIC,
  inputs = { topic: TOPIC },
  constraints = ['no_network'],
  acceptance = ['article_pack'],
  tracking = { status: true, follow: true },
} = {}) {
  return {
    run: { id: run_id, executor_kind: 'tool_chain', session_id: null },
    taskPack: { goal, constraints, acceptance, inputs },
    workspace: { path: '/workspace/content', repo: 'ft54482/superagent-lab-smoke' },
    budget: { cny_cap: 5 },
    tracking,
  };
}
