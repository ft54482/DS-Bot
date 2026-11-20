/**
 * Retrieval providers for the self-media run harness.
 *
 * Three providers share one small surface:
 *   { sources, facts, documents, warnings, search(query), fetch(url) }
 *
 * - fixture: deterministic offline material used by the default fake mode;
 * - snapshot: a local source pack (JSON) used by --offline and --sources;
 * - http: a real metadata search endpoint used by --real --search.
 *
 * Only the http provider touches the network, and only through an injected
 * fetch implementation. Fixtures and snapshots never fabricate URLs: the
 * source list is exactly the material the provider actually loaded.
 *
 * Product decision D-04: this tool uses source metadata and summaries only. It
 * must never fetch an article body. `createHttpRetrieval` therefore defaults to
 * metadata-only search; the page-fetch path exists solely behind an explicit
 * debug opt-in (`fetchPages: true`, exposed as `--allow-fulltext`) and is not
 * part of any supported project run.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RetrievalError } from './errors.mjs';

export const FIXTURE_FETCHED_AT = '2026-11-20T10:00:00.000Z';
export const DEFAULT_SNAPSHOT_FILES = Object.freeze([
  'sources.json',
  'snapshots.json',
  'source-pack.json',
]);
export const MAX_FACT_COUNT = 12;
export const MAX_HTTP_SOURCE_COUNT = 6;
export const MAX_SOURCE_TEXT_CHARS = 20000;
/** Metadata-only source text is a summary, never an article body (D-04). */
export const MAX_EXCERPT_CHARS = 300;

export function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isPrivateHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.endsWith('.invalid')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^0\./.test(host)) return true;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  return false;
}

/** Reject non-http(s), credentialed and private-network URLs before fetching. */
export function assertSafeHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RetrievalError(`invalid source URL: ${value}`, { code: 'invalid_source_url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RetrievalError(`unsupported source URL protocol: ${url.protocol}`, {
      code: 'invalid_source_url',
    });
  }
  if (url.username || url.password) {
    throw new RetrievalError('source URL must not contain credentials', {
      code: 'invalid_source_url',
    });
  }
  if (isPrivateHostname(url.hostname)) {
    throw new RetrievalError(`refusing to fetch a private or reserved host: ${url.hostname}`, {
      code: 'unsafe_source_url',
    });
  }
  return url;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    if (!isNonEmptyString(value)) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function firstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return '';
}

/* ------------------------------------------------------------------ fixtures */

/**
 * Deterministic fixture material. The claims deliberately overlap across three
 * distinct hosts so a key fact can be verified from two independent sources.
 * The numbers are fixture data, not a claim about the real world; every run
 * warns that fake mode is not real-world evidence.
 */
export function buildFixture(topic) {
  const subject = String(topic ?? '').trim() || '测试选题';
  const alpha = 'https://alpha.fixtures.selfmedia.invalid/report';
  const beta = 'https://beta.fixtures.selfmedia.invalid/brief';
  const gamma = 'https://gamma.fixtures.selfmedia.invalid/review';

  const claims = {
    async: `围绕「${subject}」的团队把重复沟通改写成异步文档后，平均每周节省 3.2 小时。`,
    template: '把写作模板固定为“结论—证据—待确认”三段后，返工率从 24% 降到 11%。',
    retention: '持续发布 12 周以上的账号，读者留存提升 9%。',
  };

  const sources = [
    {
      url: alpha,
      title: `${subject}：公开材料摘编 A`,
      published_at: '2026-11-01T08:00:00.000Z',
      fetched_at: FIXTURE_FETCHED_AT,
      text:
        `材料 A 记录了一个内容团队的复盘：他们把重复沟通改写成异步文档后，` +
        `${claims.async} 材料 A 还提到，${claims.template}`,
      claims: [
        { text: claims.async, key: true },
        { text: claims.template, key: true },
      ],
    },
    {
      url: beta,
      title: `${subject}：公开材料摘编 B`,
      published_at: '2026-10-30T08:00:00.000Z',
      fetched_at: FIXTURE_FETCHED_AT,
      text:
        `材料 B 对 12 个内容小组做了访谈：${claims.async} ` +
        `${claims.template} ${claims.retention}`,
      claims: [
        { text: claims.async, key: true },
        { text: claims.template, key: true },
        { text: claims.retention, key: true },
      ],
    },
    {
      url: gamma,
      title: `${subject}：公开材料摘编 C`,
      published_at: '2026-11-10T08:00:00.000Z',
      fetched_at: FIXTURE_FETCHED_AT,
      text:
        `材料 C 跟踪了内容账号的发布节奏。${claims.retention} ` +
        '该材料同时提醒，模板只有被真正执行才会影响返工率。',
      claims: [{ text: claims.retention, key: true }],
    },
  ];

  const facts = [
    {
      id: 'F1',
      claim: claims.async,
      key: true,
      source_refs: [alpha, beta],
    },
    {
      id: 'F2',
      claim: claims.template,
      key: true,
      source_refs: [alpha, beta],
    },
    {
      id: 'F3',
      claim: claims.retention,
      key: true,
      source_refs: [beta, gamma],
    },
  ];

  return { sources, facts };
}

function createLocalProvider({ label, description, sources, facts, warnings }) {
  const documents = new Map(sources.map((source) => [source.url, source.text]));
  const factsByUrl = new Map();
  for (const fact of facts) {
    for (const ref of fact.source_refs) {
      if (!factsByUrl.has(ref)) factsByUrl.set(ref, []);
      factsByUrl.get(ref).push({ text: fact.claim, key: fact.key === true });
    }
  }

  let searchCalls = 0;
  let fetchCalls = 0;

  const provider = {
    label,
    description,
    sources: sources.map(({ text, ...rest }) => ({ ...rest })),
    facts,
    documents,
    warnings: [...warnings],
    loadError: null,
    stats: {
      search_calls: 0,
      fetch_calls: 0,
      network_fetch_calls: 0,
      loaded_sources: sources.length,
      loaded_facts: facts.length,
    },
    async search(query) {
      searchCalls += 1;
      provider.stats.search_calls = searchCalls;
      if (!isNonEmptyString(query?.topic)) {
        throw new RetrievalError('retrieval search requires a non-empty topic', {
          code: 'invalid_query',
        });
      }
      return sources.map((source) => ({
        url: source.url,
        title: source.title,
        claims: asArray(factsByUrl.get(source.url)),
        fetched_at: source.fetched_at,
      }));
    },
    async fetch(url) {
      fetchCalls += 1;
      provider.stats.fetch_calls = fetchCalls;
      const text = documents.get(url);
      if (!isNonEmptyString(text)) {
        return { ok: false, error: `no local snapshot for ${url}` };
      }
      const source = sources.find((entry) => entry.url === url);
      return { ok: true, text, fetched_at: source?.fetched_at ?? FIXTURE_FETCHED_AT };
    },
  };

  return provider;
}

export function createFixtureRetrieval(topic) {
  const { sources, facts } = buildFixture(topic);
  return createLocalProvider({
    label: 'fixture',
    description: {
      mode: 'fake',
      provider: 'fixture',
      note: 'deterministic offline fixture material; not real-world evidence',
    },
    sources,
    facts,
    warnings: [
      {
        code: 'fixture_sources',
        message:
          'fake mode uses deterministic fixture sources; the article is a harness exercise, not real-world evidence',
      },
    ],
  });
}

/* ------------------------------------------------------------- source packs */

function normalizeClaim(raw) {
  if (typeof raw === 'string' && isNonEmptyString(raw)) {
    return { text: raw.trim(), key: false };
  }
  if (!isPlainObject(raw)) return null;
  const text = firstString(raw.text, raw.claim);
  if (!text) return null;
  return { text, key: raw.key === true };
}

function normalizePackSource(raw, index) {
  if (!isPlainObject(raw)) {
    throw new RetrievalError(`source pack source[${index}] must be an object`, {
      code: 'invalid_source_pack',
    });
  }
  const url = firstString(raw.url, raw.link, raw.source_url, raw.sourceUrl);
  if (!url) {
    throw new RetrievalError(`source pack source[${index}] is missing url`, {
      code: 'invalid_source_pack',
    });
  }
  try {
    new URL(url);
  } catch {
    throw new RetrievalError(`source pack source[${index}] has an invalid url: ${url}`, {
      code: 'invalid_source_pack',
    });
  }
  const text = firstString(raw.text, raw.body, raw.content, raw.summary, raw.snippet);
  if (!text) {
    throw new RetrievalError(`source pack source[${index}] is missing text/body/content`, {
      code: 'invalid_source_pack',
    });
  }
  const title = firstString(raw.title, raw.name) || hostOf(url) || url;
  const publisher = firstString(raw.publisher, raw.sourceName, raw.source_name) || hostOf(url);
  const fetchedAt = firstString(raw.fetched_at, raw.fetchedAt, raw.published_at, raw.publishedAt) || null;
  const claims = asArray(raw.claims).map(normalizeClaim).filter(Boolean);
  return {
    url,
    title,
    publisher,
    text,
    published_at: firstString(raw.published_at, raw.publishedAt) || null,
    fetched_at: fetchedAt,
    claims,
  };
}

function sentencesOf(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8);
}

const ATTRIBUTION_RE = /(数据显示|研究表明|研究显示|调查显示|报告显示|统计显示|据统计|专家表示|材料\s*[A-Za-z0-9一二三四五六七八九十]+|据.{0,12}报道)/;

/** Extract checkable sentences from loaded source text (no model, no network). */
export function deriveFactsFromSources(sources, { limit = MAX_FACT_COUNT } = {}) {
  const facts = [];
  const seen = new Set();
  for (const source of sources) {
    for (const sentence of sentencesOf(source.text)) {
      if (!/\d/.test(sentence) && !ATTRIBUTION_RE.test(sentence)) continue;
      if (sentence.length > 180) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      const refs = uniqueStrings(
        sources
          .filter((candidate) => String(candidate.text).includes(sentence))
          .map((candidate) => candidate.url),
      );
      const hosts = new Set(refs.map(hostOf).filter(Boolean));
      facts.push({
        id: `F${facts.length + 1}`,
        claim: sentence,
        key: hosts.size >= 2,
        source_refs: refs,
      });
      if (facts.length >= limit) return facts;
    }
  }
  return facts;
}

function normalizePackFact(raw, index, sourceByUrl) {
  if (!isPlainObject(raw)) return null;
  const claim = firstString(raw.claim, raw.text, raw.statement);
  if (!claim) return null;
  const refs = uniqueStrings(
    asArray(raw.source_refs ?? raw.refs ?? raw.sources)
      .map((ref) => (typeof ref === 'string' ? ref : firstString(ref?.url, ref?.source_url)))
      .filter((ref) => sourceByUrl.has(ref)),
  );
  let finalRefs = refs;
  if (finalRefs.length === 0) {
    finalRefs = uniqueStrings(
      [...sourceByUrl.values()]
        .filter((source) => String(source.text).includes(claim))
        .map((source) => source.url),
    );
  }
  const hosts = new Set(finalRefs.map(hostOf).filter(Boolean));
  return {
    id: firstString(raw.id) || `F${index + 1}`,
    claim,
    key: typeof raw.key === 'boolean' ? raw.key : hosts.size >= 2,
    source_refs: finalRefs,
  };
}

/** Turn source-level claims into facts when the pack omits an explicit list. */
function factsFromSourceClaims(sources) {
  const byClaim = new Map();
  for (const source of sources) {
    for (const claim of asArray(source.claims)) {
      if (!isNonEmptyString(claim?.text)) continue;
      let entry = byClaim.get(claim.text);
      if (!entry) {
        entry = { claim: claim.text, key: false, refs: new Set() };
        byClaim.set(claim.text, entry);
      }
      entry.refs.add(source.url);
      entry.key = entry.key || claim.key === true;
    }
  }
  return [...byClaim.values()].map((entry, index) => {
    const refs = [...entry.refs];
    const hosts = new Set(refs.map(hostOf).filter(Boolean));
    return {
      id: `F${index + 1}`,
      claim: entry.claim,
      key: entry.key || hosts.size >= 2,
      source_refs: refs,
    };
  });
}

/**
 * Load a local source pack. Accepted shapes:
 *   [{ url, title, text, claims? }, ...]
 *   { sources: [...], facts?: [...], topic?: string }
 *   { items: [...] } / { results: [...] }
 */
export async function loadSourcePack({ file = null, topic = '', now = Date.now } = {}) {
  const target = resolve(file);
  if (!existsSync(target)) {
    throw new RetrievalError(`source pack not found: ${target}`, {
      code: 'source_pack_missing',
    });
  }
  let rawText;
  try {
    rawText = await readFile(target, 'utf8');
  } catch (error) {
    throw new RetrievalError(`source pack cannot be read: ${target}: ${error.message}`, {
      code: 'source_pack_unreadable',
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new RetrievalError(`source pack is not valid JSON: ${target}`, {
      code: 'source_pack_invalid_json',
      cause: error,
    });
  }

  const rawSources = Array.isArray(parsed)
    ? parsed
    : asArray(parsed?.sources ?? parsed?.items ?? parsed?.results);
  if (rawSources.length === 0) {
    throw new RetrievalError(`source pack contains no sources: ${target}`, {
      code: 'source_pack_empty',
    });
  }

  const sources = rawSources.map((entry, index) => normalizePackSource(entry, index));
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const declaredFacts = !Array.isArray(parsed) && Array.isArray(parsed.facts)
    ? parsed.facts.map((fact, index) => normalizePackFact(fact, index, sourceByUrl)).filter(Boolean)
    : [];
  const claimedFacts = factsFromSourceClaims(sources);
  const facts =
    declaredFacts.length > 0
      ? declaredFacts
      : claimedFacts.length > 0
        ? claimedFacts
        : deriveFactsFromSources(sources);
  const fetchedAt = new Date(now()).toISOString();

  return {
    file: target,
    topic: firstString(parsed?.topic) || topic,
    sources: sources.map((source) => ({
      ...source,
      fetched_at: source.fetched_at ?? fetchedAt,
    })),
    facts,
  };
}

export async function createSnapshotRetrieval({
  file = null,
  dir = null,
  topic = '',
  now = Date.now,
  mode = 'offline',
} = {}) {
  let target = file;
  if (!target && dir) {
    const base = resolve(dir);
    target = DEFAULT_SNAPSHOT_FILES.map((name) => join(base, name)).find((candidate) => existsSync(candidate)) ?? null;
    if (!target) {
      const error = new RetrievalError(
        `no snapshot file in ${base} (looked for ${DEFAULT_SNAPSHOT_FILES.join(', ')})`,
        { code: 'snapshot_missing' },
      );
      return emptyRetrieval({ mode, label: 'snapshot', error });
    }
  }
  if (!target) {
    const error = new RetrievalError(
      'offline mode requires --snapshots <dir>, --sources <file> or DSBOT_SOURCE_PACK_FILE; refusing to fabricate sources',
      { code: 'snapshot_missing' },
    );
    return emptyRetrieval({ mode, label: 'snapshot', error });
  }

  try {
    const pack = await loadSourcePack({ file: target, topic, now });
    const warnings = [];
    if (pack.topic && topic && pack.topic.trim() !== topic.trim()) {
      warnings.push({
        code: 'snapshot_topic_mismatch',
        message: `source pack topic "${pack.topic}" does not match requested topic "${topic}"`,
      });
    }
    return createLocalProvider({
      label: 'snapshot',
      description: {
        mode,
        provider: 'snapshot',
        source_pack: target,
        note: 'material loaded from a local source pack; no network was used',
      },
      sources: pack.sources,
      facts: pack.facts,
      warnings,
    });
  } catch (error) {
    return emptyRetrieval({
      mode,
      label: 'snapshot',
      error: error instanceof RetrievalError
        ? error
        : new RetrievalError(`cannot load source pack: ${error.message}`, { code: 'source_pack_failed' }),
    });
  }
}

function emptyRetrieval({ mode, label, error }) {
  const provider = createLocalProvider({
    label,
    description: {
      mode,
      provider: label,
      note: 'retrieval blocked; no sources were fabricated',
    },
    sources: [],
    facts: [],
    warnings: [],
  });
  provider.loadError = {
    code: error?.code ?? 'retrieval_error',
    message: error?.message ?? String(error),
  };
  provider.warnings.push({
    code: provider.loadError.code,
    message: provider.loadError.message,
  });
  provider.search = async () => {
    provider.stats.search_calls += 1;
    return [];
  };
  provider.fetch = async () => ({ ok: false, error: provider.loadError.message });
  return provider;
}

/* ---------------------------------------------------------------- http mode */

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

/** Turn an HTML page into readable text without a DOM dependency. */
export function htmlToText(html) {
  // D-04 warning: this helper parses article bodies and is used only by the
  // debug-only `fetchPages` opt-in behind `--allow-fulltext`. It is not part of
  // the default metadata/summary path and must not be reintroduced into it.
  let body = String(html ?? '');
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body);
  const source = article?.[1] ?? main?.[1] ?? body;
  const withBreaks = source
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_SOURCE_TEXT_CHARS);
}

function responseSourceList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return [];
  for (const key of ['results', 'items', 'data']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isPlainObject(value)) {
      for (const nested of ['results', 'items']) {
        if (Array.isArray(value[nested])) return value[nested];
      }
    }
  }
  return [];
}

function normalizeSearchResult(raw, { allowFulltext = false } = {}) {
  if (!isPlainObject(raw)) return null;
  const url = firstString(raw.url, raw.link, raw.href);
  if (!url) return null;
  // D-04: a search endpoint's title/summary/snippet is metadata. Fields that
  // commonly carry the article body (`text`/`content`/`body`) are accepted only
  // when the explicit debug-only full-text opt-in is active.
  const summary = allowFulltext
    ? firstString(raw.snippet, raw.summary, raw.description, raw.text, raw.content, raw.body)
    : firstString(raw.snippet, raw.summary, raw.description);
  return {
    url,
    title: firstString(raw.title, raw.name) || hostOf(url) || url,
    snippet: summary,
    published_at: firstString(raw.published_at, raw.publishedAt, raw.date, raw.published) || null,
  };
}

async function withTimeout(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a real retrieval provider.
 *
 * D-04 default: `fetchPages` is false, so only the metadata search endpoint is
 * requested. Each result's title and summary/snippet become the source text;
 * article body URLs are never contacted. `fetchPages: true` is a debug-only
 * escape hatch (CLI `--allow-fulltext`) that must not be used for project runs.
 *
 * Search contract: GET <base>?<queryParam>=<topic>&<limitParam>=<n> with
 * `Authorization: Bearer <key>` when a key is configured. The response may be
 * an array or { results } / { items } / { data: [...] }. Each item accepts
 * url/link, title/name, snippet/summary/description, published_at/date.
 */
export function createHttpRetrieval({
  baseUrl,
  apiKey = '',
  queryParam = 'q',
  limitParam = 'limit',
  limit = MAX_HTTP_SOURCE_COUNT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  now = Date.now,
  fetchPages = false,
  maxSourceChars = MAX_SOURCE_TEXT_CHARS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new RetrievalError('http retrieval requires a fetch implementation', {
      code: 'fetch_unavailable',
    });
  }
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new RetrievalError('DSBOT_SEARCH_BASE_URL is not a valid URL', {
      code: 'invalid_search_url',
    });
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new RetrievalError('DSBOT_SEARCH_BASE_URL must use http or https', {
      code: 'invalid_search_url',
    });
  }

  const documents = new Map();
  const titles = new Map();
  const warnings = [];
  const stats = {
    search_calls: 0,
    fetch_calls: 0,
    network_fetch_calls: 0,
    loaded_sources: 0,
    loaded_facts: 0,
  };

  const headers = { accept: 'application/json' };
  if (isNonEmptyString(apiKey)) headers.authorization = `Bearer ${apiKey}`;

  async function fetchPage(url) {
    assertSafeHttpUrl(url);
    stats.network_fetch_calls += 1;
    const response = await withTimeout(timeoutMs, (signal) =>
      fetchImpl(url, {
        signal,
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'user-agent': 'selfmedia-run/1.0 (+article run harness)',
        },
      }),
    );
    if (!response || response.ok === false) {
      const status = response?.status ?? 'network_error';
      throw new RetrievalError(`page fetch failed (${status}): ${url}`, {
        code: 'page_fetch_failed',
      });
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (isPrivateHostname(finalUrl.hostname)) {
        throw new RetrievalError('page redirected to a private or reserved host', {
          code: 'unsafe_redirect',
        });
      }
    }
    const raw = typeof response.text === 'function' ? await response.text() : String(response.body ?? '');
    const text = htmlToText(raw);
    if (!isNonEmptyString(text)) {
      throw new RetrievalError(`page returned no readable text: ${url}`, {
        code: 'page_empty',
      });
    }
    return text.slice(0, maxSourceChars);
  }

  async function search(query) {
    stats.search_calls += 1;
    const topic = firstString(query?.topic);
    if (!topic) {
      throw new RetrievalError('retrieval search requires a non-empty topic', {
        code: 'invalid_query',
      });
    }
    const url = new URL(endpoint.toString());
    url.searchParams.set(queryParam, topic);
    url.searchParams.set(limitParam, String(limit));

    let response;
    try {
      response = await withTimeout(timeoutMs, (signal) =>
        fetchImpl(url.toString(), { signal, headers, redirect: 'follow' }),
      );
    } catch (error) {
      throw new RetrievalError(`search request failed: ${error.message}`, {
        code: 'search_failed',
        cause: error,
      });
    }
    if (!response || response.ok === false) {
      throw new RetrievalError(`search request failed with HTTP ${response?.status ?? 'error'}`, {
        code: 'search_failed',
      });
    }
    let payload;
    try {
      payload = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
    } catch (error) {
      throw new RetrievalError('search response is not valid JSON', {
        code: 'search_bad_json',
        cause: error,
      });
    }

    const seen = new Set();
    const sources = [];
    for (const root of responseSourceList(payload)) {
      const item = normalizeSearchResult(root, { allowFulltext: fetchPages });
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      let text = item.snippet;
      let origin = 'snippet';
      if (fetchPages) {
        try {
          text = await fetchPage(item.url);
          origin = 'page';
        } catch (error) {
          warnings.push({
            code: 'page_fetch_fallback',
            url: item.url,
            message: `page fetch failed; used the search snippet instead (${error.message})`,
          });
        }
      } else {
        // Keep only a bounded summary; never carry a body-like search payload.
        text = text.slice(0, MAX_EXCERPT_CHARS);
      }
      if (!isNonEmptyString(text) || text.trim().length < 20) {
        warnings.push({
          code: 'source_skipped',
          url: item.url,
          message: 'source had no usable text (page and snippet were empty or too short)',
        });
        continue;
      }
      sources.push({
        url: item.url,
        title: item.title,
        text: text.slice(0, maxSourceChars),
        published_at: item.published_at,
        fetched_at: new Date(now()).toISOString(),
        origin,
      });
      documents.set(item.url, text.slice(0, maxSourceChars));
      titles.set(item.url, item.title);
      if (sources.length >= limit) break;
    }

    const facts = deriveFactsFromSources(sources);
    stats.loaded_sources = sources.length;
    stats.loaded_facts = facts.length;
    if (sources.length === 0) {
      warnings.push({
        code: 'no_sources',
        message: 'real retrieval returned no usable sources; the run will block rather than invent material',
      });
    }
    return sources.map((source) => ({
      url: source.url,
      title: source.title,
      claims: facts
        .filter((fact) => fact.source_refs.includes(source.url))
        .map((fact) => ({ text: fact.claim, key: fact.key })),
      fetched_at: source.fetched_at,
    }));
  }

  async function fetch(url) {
    stats.fetch_calls += 1;
    let text = documents.get(url);
    // D-04: with the default metadata-only provider the summary cached during
    // search is returned. The network fallback exists only behind the explicit
    // debug opt-in.
    if (!isNonEmptyString(text) && fetchPages) {
      text = await fetchPage(url);
      documents.set(url, text);
    }
    if (!isNonEmptyString(text)) {
      return { ok: false, error: `no metadata or summary for ${url}` };
    }
    return { ok: true, text, fetched_at: new Date(now()).toISOString() };
  }

  return {
    label: 'http',
    description: {
      mode: 'real',
      provider: 'http-search',
      endpoint_host: endpoint.hostname,
      page_fetch: fetchPages,
      fulltext_policy: fetchPages ? 'explicit_allow_fulltext_debug' : 'metadata_and_summary_only',
    },
    sources: [],
    facts: [],
    documents,
    warnings,
    loadError: null,
    stats,
    search,
    fetch,
    titles,
  };
}

/** A blocked retrieval provider with a clear reason and no invented sources. */
export function createBlockedRetrieval({ mode = 'real', reason, code = 'retrieval_unavailable' }) {
  return emptyRetrieval({
    mode,
    label: 'blocked',
    error: new RetrievalError(reason, { code }),
  });
}
