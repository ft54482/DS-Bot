/**
 * Orchestration for the self-media run harness.
 *
 * One run composes the existing content chain
 *   retrieve -> snapshot -> fact_check -> write -> review -> typeset
 * with an independent review artifact, a run report, and a reviewable article
 * package whose license is always "unauthorized".
 *
 * The harness never publishes, never contacts the network in fake/offline
 * modes, and never invents sources when retrieval blocks.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  runContentPipeline,
  PACK_VERSION,
} from '../../../packages/pipelines/content/src/index.js';
import {
  ConfigError,
  EXIT_BLOCKED,
  EXIT_INTERNAL,
  EXIT_OK,
  errorMessage,
} from './errors.mjs';
import {
  createFixtureRetrieval,
  createHttpRetrieval,
  createSnapshotRetrieval,
  hostOf,
  publisherOf,
  viaOf,
} from './retrieval.mjs';
import { enrichArticleBody, selectKeyFacts } from './attribution.mjs';
import {
  buildTags,
  countWords,
  DEFAULT_REVIEWER,
  REVIEW_VERSION,
  reviewArticle,
} from './review.mjs';
import {
  bridgeTimeoutMs,
  createBridgeModelClient,
  createChatClient,
  createFakeWriter,
  createRealReviewer,
  createRealWriter,
  readBridgeSecret,
} from './model.mjs';
import {
  buildCost,
  buildModelEnvSummary,
  buildUsage,
  isoOf,
  redactSecrets,
} from './report.mjs';

export const HARNESS_VERSION = 1;
export const REQUIRED_MODEL_ENV = Object.freeze([
  'DSBOT_MODEL_BASE_URL',
  'DSBOT_MODEL_API_KEY',
  'DSBOT_MODEL_NAME',
]);

export const LICENSE_STATUS_UNAUTHORIZED = 'unauthorized';
export const LICENSE_STATUS_LABEL = '未授权';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueWarnings(warnings) {
  const seen = new Set();
  const result = [];
  for (const warning of warnings) {
    if (!warning) continue;
    const key = `${warning.code ?? 'warning'}|${warning.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function hashesOfSources(sources) {
  return asArray(sources).map((source) => ({
    url: source.url,
    sha256: source.sha256,
  }));
}

function titleMapOf(retrieval) {
  const map = new Map();
  for (const source of asArray(retrieval?.sources)) {
    if (isNonEmptyString(source.title)) map.set(source.url, source.title);
  }
  if (retrieval?.titles instanceof Map) {
    for (const [url, title] of retrieval.titles) {
      if (isNonEmptyString(title)) map.set(url, title);
    }
  }
  return map;
}

function sourceMetaOf(retrieval) {
  const map = new Map();
  for (const source of asArray(retrieval?.sources)) {
    if (isNonEmptyString(source?.url)) map.set(source.url, { ...source });
  }
  if (retrieval?.metadata instanceof Map) {
    for (const [url, meta] of retrieval.metadata) {
      if (!isNonEmptyString(url)) continue;
      map.set(url, { ...map.get(url), ...meta });
    }
  }
  return map;
}

/**
 * Attach the display metadata the writer and reviewer need: title, original
 * publisher, aggregator (`via`) and URL host. Publisher falls back to the host
 * so a source that only names the aggregator cannot look independent.
 */
function titledSources(sources, titleMap, sourceMeta) {
  return asArray(sources).map((source) => {
    const meta = sourceMeta.get(source.url) ?? {};
    return {
      ...source,
      title:
        (isNonEmptyString(source.title) ? source.title : null) ??
        (isNonEmptyString(meta.title) ? meta.title : null) ??
        titleMap.get(source.url) ??
        hostOf(source.url),
      publisher:
        (isNonEmptyString(source.publisher) ? source.publisher : null) ??
        (isNonEmptyString(meta.publisher) ? meta.publisher : null) ??
        publisherOf(source) ??
        hostOf(source.url),
      via:
        (isNonEmptyString(source.via) ? source.via : null) ??
        (isNonEmptyString(meta.via) ? meta.via : null) ??
        viaOf(source),
      host: hostOf(source.url),
    };
  });
}

/** Validate DSBOT_MODEL_* without ever echoing a value. */
export function resolveRealModelConfig(env = {}) {
  const missing = REQUIRED_MODEL_ENV.filter((name) => !isNonEmptyString(env[name]));
  if (missing.length > 0) {
    throw new ConfigError(
      `--real requires environment variable(s): ${missing.join(', ')} (values are never printed)`,
      { hint: 'set all three DSBOT_MODEL_* variables before running --real' },
    );
  }
  const baseUrl = String(env.DSBOT_MODEL_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError('DSBOT_MODEL_BASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('DSBOT_MODEL_BASE_URL must use http or https');
  }
  const timeout = Number(env.DSBOT_MODEL_TIMEOUT_MS ?? 90000);
  const maxTokens = Number(env.DSBOT_MODEL_MAX_TOKENS ?? 2000);
  return {
    baseUrl,
    apiKey: String(env.DSBOT_MODEL_API_KEY),
    model: String(env.DSBOT_MODEL_NAME).trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 90000,
    maxTokens: Number.isFinite(maxTokens) && maxTokens >= 256 ? Math.min(maxTokens, 8000) : 2000,
  };
}

function resolveInput(value, cwd) {
  return isNonEmptyString(value) ? resolve(cwd, value) : null;
}

function resolveRealRetrieval(options, env) {
  // D-04: the search provider only reads metadata and summaries. `--search`
  // selects it explicitly; source packs stay a separate, local input path.
  const useSearch = options.search === true;
  const sourceFile = useSearch
    ? null
    : options.sources ??
      (isNonEmptyString(env.DSBOT_SOURCE_PACK_FILE)
        ? resolve(options.cwd ?? process.cwd(), env.DSBOT_SOURCE_PACK_FILE.trim())
        : null);
  if (!useSearch && (sourceFile || options.snapshots)) {
    return createSnapshotRetrieval({
      file: sourceFile,
      dir: options.snapshots,
      topic: options.topic,
      now: options.now,
      mode: 'real',
    });
  }
  const searchBase = String(env.DSBOT_SEARCH_BASE_URL ?? '').trim();
  if (!searchBase) {
    throw new ConfigError(
      '--real requires retrieval input: pass --sources <file> / --snapshots <dir>, ' +
        'set DSBOT_SOURCE_PACK_FILE, or pass --search with DSBOT_SEARCH_BASE_URL. ' +
        'The harness never fabricates sources for a real run.',
    );
  }
  let searchUrl;
  try {
    searchUrl = new URL(searchBase);
  } catch {
    throw new ConfigError('DSBOT_SEARCH_BASE_URL is not a valid URL');
  }
  if (searchUrl.protocol !== 'http:' && searchUrl.protocol !== 'https:') {
    throw new ConfigError('DSBOT_SEARCH_BASE_URL must use http or https');
  }
  const timeout = Number(env.DSBOT_SEARCH_TIMEOUT_MS ?? 15000);
  return createHttpRetrieval({
    baseUrl: searchBase,
    apiKey: String(env.DSBOT_SEARCH_API_KEY ?? ''),
    queryParam: isNonEmptyString(env.DSBOT_SEARCH_QUERY_PARAM)
      ? env.DSBOT_SEARCH_QUERY_PARAM.trim()
      : 'q',
    limitParam: isNonEmptyString(env.DSBOT_SEARCH_LIMIT_PARAM)
      ? env.DSBOT_SEARCH_LIMIT_PARAM.trim()
      : 'limit',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
    now: options.now,
    fetchImpl: options.fetchImpl,
    // Only the explicit, debug-only CLI flag may reach the article body path.
    fetchPages: options.allowFulltext === true,
  });
}

async function createRetrieval(options) {
  const { mode, env } = options;
  if (mode === 'real') return resolveRealRetrieval(options, env);
  const sourceFile =
    options.sources ??
    (isNonEmptyString(env.DSBOT_SOURCE_PACK_FILE)
      ? resolve(options.cwd ?? process.cwd(), env.DSBOT_SOURCE_PACK_FILE.trim())
      : null);
  if (sourceFile || options.snapshots) {
    return createSnapshotRetrieval({
      file: sourceFile,
      dir: options.snapshots,
      topic: options.topic,
      now: options.now,
      mode,
    });
  }
  if (mode === 'offline') {
    return createSnapshotRetrieval({
      file: null,
      dir: null,
      topic: options.topic,
      now: options.now,
      mode,
    });
  }
  return createFixtureRetrieval(options.topic);
}

function writeJson(dir, name, value) {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function baseLicense() {
  return {
    status: LICENSE_STATUS_UNAUTHORIZED,
    published: false,
    allowed: false,
    authorization: null,
    reason: '发布需要单独的人工发布许可；本 harness 只产出可审阅包，不执行发布。',
  };
}

function baseArticlePack({
  topic,
  mode,
  platform,
  account,
  retrieval,
  license,
  warnings,
  blocks,
  status,
  now,
}) {
  const verdict =
    status === 'ready_for_review' ? 'passed' : status === 'needs_rework' ? 'rework' : 'blocked';
  return {
    pack_version: PACK_VERSION,
    harness_version: HARNESS_VERSION,
    ticket: 'L44',
    topic,
    mode,
    platform,
    account,
    status,
    needs_rework: status === 'needs_rework',
    title_candidates: [],
    chosen_title: '',
    body: '',
    tags: buildTags(topic, platform),
    word_count: 0,
    source_list: [],
    sources: [],
    facts: [],
    key_facts: [],
    review: { verdict, score: null, issues_count: 0 },
    layout: {
      platform,
      format: 'markdown',
      title: '',
      word_count: 0,
      paragraph_count: 0,
      headings: [],
      tags: buildTags(topic, platform),
      cover_copy: '',
    },
    license_status: LICENSE_STATUS_UNAUTHORIZED,
    license_status_label: LICENSE_STATUS_LABEL,
    license,
    publish: { executed: false, authorization: null },
    retrieval: {
      ...retrieval.description,
      stats: { ...retrieval.stats },
      source_count: 0,
      fact_count: 0,
    },
    warnings,
    blocks,
    generated_at: isoOf(now),
  };
}

function blockedReview({ topic, mode, reviewer, blocks, warnings, sourceCount, factCount, now }) {
  const issues = asArray(blocks).map((block) => ({
    code: isNonEmptyString(block?.code) ? block.code : 'blocked',
    severity: 'critical',
    message:
      (isNonEmptyString(block?.message) && block.message) ||
      (isNonEmptyString(block?.claim) && block.claim) ||
      'run blocked',
    evidence: block,
    rubric_item: 'factuality',
  }));
  return {
    review_version: REVIEW_VERSION,
    topic,
    mode,
    reviewer,
    verdict: 'blocked',
    needs_rework: false,
    score: 0,
    rubric: [],
    issues,
    evidence: {
      source_count: sourceCount,
      fact_count: factCount,
      blockers: asArray(blocks),
      warnings,
    },
    summary: '取料或事实核查未通过，未进入写作与审校；没有编造来源。',
    generated_at: isoOf(now),
  };
}

function failureReview({ topic, mode, reviewer, message, sourceCount, factCount, now }) {
  return {
    review_version: REVIEW_VERSION,
    topic,
    mode,
    reviewer,
    verdict: 'blocked',
    needs_rework: false,
    score: 0,
    rubric: [],
    issues: [
      {
        code: 'run_failed',
        severity: 'critical',
        message,
        rubric_item: null,
      },
    ],
    evidence: { source_count: sourceCount, fact_count: factCount, blockers: [] },
    summary: '运行失败，未生成可审阅稿件。',
    generated_at: isoOf(now),
  };
}

function stepCalls(name, counters, real) {
  const zero = { search: 0, fetch: 0, model: 0, fake_model: 0 };
  if (name === 'retrieve') return { ...zero, search: counters.search };
  if (name === 'snapshot') return { ...zero, fetch: counters.fetch };
  if (name === 'write') {
    return {
      ...zero,
      model: real ? counters.write : 0,
      fake_model: real ? 0 : counters.fake_write,
    };
  }
  if (name === 'review') {
    return {
      ...zero,
      model: real ? counters.review : 0,
      fake_model: real ? 0 : counters.fake_review,
    };
  }
  return zero;
}

function stepsFromPipeline(run, counters, real, startedMs) {
  return asArray(run?.steps).map((step) => ({
    name: step.name,
    status: step.status,
    started_at: isoOf(step.startedAt ?? startedMs),
    ended_at: isoOf(step.endedAt ?? step.startedAt ?? startedMs),
    duration_ms: Number.isFinite(step.duration_ms) ? step.duration_ms : 0,
    calls: stepCalls(step.name, counters, real),
  }));
}

function buildReport({
  runId,
  topic,
  mode,
  gateway,
  platform,
  account,
  status,
  exitCode,
  startedMs,
  finishedMs,
  run,
  counters,
  real,
  client,
  retrieval,
  usage,
  cost,
  env,
  warnings,
  blocks,
  injection,
  artifacts,
  artifactStep,
  error,
}) {
  const steps = stepsFromPipeline(run, counters, real, startedMs);
  if (artifactStep) steps.push(artifactStep);
  return {
    report_version: HARNESS_VERSION,
    run_id: runId,
    ticket: 'L44',
    topic,
    mode,
    gateway,
    platform,
    account,
    status,
    exit_code: exitCode,
    started_at: isoOf(startedMs),
    finished_at: isoOf(finishedMs),
    duration_ms: Math.max(0, finishedMs - startedMs),
    steps,
    calls: {
      search: counters.search,
      fetch: counters.fetch,
      network_fetch: retrieval?.stats?.network_fetch_calls ?? 0,
      model: real ? counters.write + counters.review : 0,
      fake_model: real ? 0 : counters.fake_write + counters.fake_review,
    },
    model_calls: real
      ? {
          total: client?.calls ?? 0,
          writer: counters.write,
          reviewer: counters.review,
          extractor: 0,
        }
      : { total: 0, writer: 0, reviewer: 0, extractor: 0 },
    fake_model_calls: real
      ? { total: 0, writer: 0, reviewer: 0 }
      : {
          total: counters.fake_write + counters.fake_review,
          writer: counters.fake_write,
          reviewer: counters.fake_review,
        },
    usage,
    cost,
    retrieval: {
      ...(retrieval?.description ?? {}),
      source_count:
        asArray(run?.article_pack?.sources).length || asArray(retrieval?.sources).length,
      fact_count:
        asArray(run?.article_pack?.facts).length || asArray(retrieval?.facts).length,
      stats: { ...(retrieval?.stats ?? {}) },
    },
    env: buildModelEnvSummary({ mode, env, client, gateway }),
    injection,
    warnings,
    blocks,
    artifacts,
    error: error ?? null,
  };
}

/**
 * Run one harness pass. Returns an exit code plus the three primary artifacts.
 * Configuration errors are thrown (the CLI turns them into exit code 2).
 */
export async function runHarness(options = {}) {
  const topic = String(options.topic ?? '').trim();
  const outDir = resolve(options.cwd ?? process.cwd(), String(options.out ?? ''));
  if (!topic) throw new ConfigError('--topic is required');
  if (!isNonEmptyString(options.out)) throw new ConfigError('--out is required');

  const mode = options.mode ?? 'fake';
  const gateway = options.gateway === undefined ? 'env' : options.gateway;
  if (gateway !== 'env' && gateway !== 'bridge') {
    throw new ConfigError(`--gateway must be env or bridge; got: ${String(gateway)}`);
  }
  if (gateway === 'bridge' && mode !== 'real') {
    throw new ConfigError('--gateway bridge is only valid with --real');
  }
  const cwd = options.cwd ?? process.cwd();
  const platform = isNonEmptyString(options.platform) ? options.platform.trim() : 'wechat';
  const account = isNonEmptyString(options.account) ? options.account.trim() : null;
  const injectFactError = options.injectFactError === true;
  const env = options.env ?? process.env;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  const startedMs = now();
  const runId = `selfmedia-${startedMs.toString(36)}-${randomUUID().slice(0, 8)}`;
  mkdirSync(outDir, { recursive: true });

  const bridgeModel = isNonEmptyString(env.DSBOT_BRIDGE_MODEL)
    ? env.DSBOT_BRIDGE_MODEL.trim()
    : isNonEmptyString(env.DSBOT_MODEL_NAME)
      ? env.DSBOT_MODEL_NAME.trim()
      : 'dsh-bridge';
  const reviewerInfo =
    mode === 'real'
      ? {
          ...DEFAULT_REVIEWER,
          model: gateway === 'bridge' ? bridgeModel : String(env.DSBOT_MODEL_NAME ?? 'real-model'),
        }
      : { ...DEFAULT_REVIEWER };

  let client = null;
  let realWriter = null;
  let independentReviewer = null;
  let real = false;
  let bridgeSecret = null;
  const redact = (text) => redactSecrets(text, env, bridgeSecret === null ? [] : [bridgeSecret]);
  if (mode === 'real') {
    if (gateway === 'bridge') {
      // The bridge secret comes from the file only; the gateway puts it in the
      // Authorization header and nowhere else.
      const bridge = readBridgeSecret({ env, cwd });
      bridgeSecret = bridge.secret;
      client = createBridgeModelClient({
        secret: bridge.secret,
        fetchImpl,
        bridgeUrl: env.DSBOT_BRIDGE_URL,
        cwd,
        model: bridgeModel,
        timeoutMs: bridgeTimeoutMs(env),
        bridgeModel: env.DSBOT_BRIDGE_MODEL,
        preset: env.DSBOT_BRIDGE_PRESET,
      });
    } else {
      const config = resolveRealModelConfig(env);
      client = createChatClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        fetchImpl,
      });
    }
    realWriter = createRealWriter({ chat: client.chat, injectFactError });
    independentReviewer = createRealReviewer({ chat: client.chat });
    real = true;
  }

  const retrieval = await createRetrieval({
    mode,
    env,
    topic,
    cwd,
    sources: resolveInput(options.sources, cwd),
    snapshots: resolveInput(options.snapshots, cwd),
    search: options.search === true,
    allowFulltext: options.allowFulltext === true,
    now,
    fetchImpl,
  });
  const titleMap = titleMapOf(retrieval);
  const sourceMeta = sourceMetaOf(retrieval);
  const license = baseLicense();

  const counters = {
    search: 0,
    fetch: 0,
    write: 0,
    review: 0,
    fake_write: 0,
    fake_review: 0,
  };
  const draftWarnings = [];
  let capturedDraft = null;
  let capturedReview = null;
  let injectedFact = null;
  let modelReviewError = null;

  const search = async (query) => {
    counters.search += 1;
    return retrieval.search(query);
  };
  const fetch = async (url) => {
    counters.fetch += 1;
    const result = await retrieval.fetch(url);
    if (result?.ok && isNonEmptyString(result.text)) retrieval.documents.set(url, result.text);
    return result;
  };

  const writer = realWriter ?? createFakeWriter({ injectFactError });
  const write = async (context) => {
    counters.write += 1;
    if (!real) counters.fake_write += 1;
    const sources = titledSources(context.sources, titleMap, sourceMeta);
    const keyFacts = selectKeyFacts(context.facts, sources);
    let draft = await writer({
      ...context,
      keyFacts,
      sources,
      sourceTexts: retrieval.documents,
    });
    if (draft && typeof draft.body === 'string' && draft.body.trim().length > 0) {
      // The reviewer and the delivered article must see the same evidence:
      // key facts under the title, citations on their sentences, and a source
      // section with the snapshot summary and sha256 for every source.
      draft = {
        ...draft,
        body: enrichArticleBody({ body: draft.body, keyFacts, sources }),
      };
    }
    capturedDraft = draft;
    if (isNonEmptyString(draft?.injected_fact)) injectedFact = draft.injected_fact.trim();
    if (Array.isArray(draft?.warnings)) draftWarnings.push(...draft.warnings);
    return draft;
  };

  const review = async (context) => {
    counters.review += 1;
    if (!real) counters.fake_review += 1;
    const sources = titledSources(context.sources, titleMap, sourceMeta);
    const keyFacts = selectKeyFacts(context.facts, sources);
    let modelReview = null;
    if (independentReviewer) {
      try {
        modelReview = await independentReviewer({
          ...context,
          keyFacts,
          sources,
          sourceTexts: retrieval.documents,
        });
      } catch (error) {
        modelReviewError = error;
        modelReview = { __error: redact(errorMessage(error)) };
      }
    }
    const result = reviewArticle({
      topic,
      article: context.article,
      facts: context.facts,
      keyFacts,
      sources,
      sourceTexts: retrieval.documents,
      license,
      mode,
      reviewer: reviewerInfo,
      modelReview,
      now,
    });
    capturedReview = result;
    return result;
  };

  const input = {
    topic,
    goal: `为选题「${topic}」产出一份可审阅、可核查、未发布的自媒体稿件包`,
    platform,
    tags: buildTags(topic, platform),
    facts: retrieval.facts,
    constraints: [
      '每个事实句必须有来源引用',
      '不得编造数字、机构、引语或研究结论',
      '保持未授权，不执行发布',
    ],
    acceptance: ['独立审校通过', '来源清单与快照齐全'],
    min_title_candidates: 3,
    min_independent_sources_for_key_fact: 2,
  };
  const deps = {
    now,
    search,
    fetch,
    model: { write, review },
    minTitleCandidates: 3,
    minIndependentSourcesForKeyFact: 2,
    excerptChars: 280,
  };

  let run;
  try {
    run = await runContentPipeline(input, deps);
    // The content pipeline degrades a failed reviewer into a review_failed
    // issue so an env gateway outage still leaves a draft. A bridge outage is
    // different: the run must not look like a completed review.
    if (gateway === 'bridge' && modelReviewError !== null) throw modelReviewError;
  } catch (error) {
    const message = redact(errorMessage(error));
    const finishedMs = now();
    const warnings = uniqueWarnings([...retrieval.warnings, ...draftWarnings]);
    const blocks = [{ code: 'run_failed', message }];
    const articlePack = baseArticlePack({
      topic,
      mode,
      platform,
      account,
      retrieval,
      license,
      warnings,
      blocks,
      status: 'failed',
      now: finishedMs,
    });
    articlePack.body = '# 运行失败\n\n本次运行没有产出可审阅正文。\n';
    articlePack.review = { verdict: 'blocked', score: 0, issues_count: 1 };
    const reviewArtifact = failureReview({
      topic,
      mode,
      reviewer: reviewerInfo,
      message,
      sourceCount: asArray(retrieval.sources).length,
      factCount: asArray(retrieval.facts).length,
      now: finishedMs,
    });
    const usage = buildUsage({ mode, client });
    const cost = buildCost({ usage, mode, env });
    const artifacts = {
      article_pack: 'article-pack.json',
      review: 'review.json',
      report: 'report.json',
      article_md: 'article.md',
      sources: 'sources.json',
    };
    const reportArtifact = buildReport({
      runId,
      topic,
      mode,
      gateway,
      platform,
      account,
      status: 'failed',
      exitCode: EXIT_INTERNAL,
      startedMs,
      finishedMs,
      run: null,
      counters,
      real,
      client,
      retrieval,
      usage,
      cost,
      env,
      warnings,
      blocks,
      injection: {
        enabled: injectFactError,
        caught: false,
        claim: injectedFact,
        detected_claim: null,
      },
      artifacts,
      artifactStep: null,
      error: { code: error?.code ?? 'run_failed', message },
    });
    writeJson(outDir, artifacts.article_pack, articlePack);
    writeJson(outDir, artifacts.review, reviewArtifact);
    writeJson(outDir, artifacts.sources, {
      topic,
      mode,
      license_status: LICENSE_STATUS_UNAUTHORIZED,
      sources: [],
    });
    writeFileSync(join(outDir, artifacts.article_md), articlePack.body, 'utf8');
    writeJson(outDir, artifacts.report, reportArtifact);
    return {
      exitCode: EXIT_INTERNAL,
      status: 'failed',
      outDir,
      artifacts,
      articlePack,
      review: reviewArtifact,
      report: reportArtifact,
    };
  }

  const pack = run.article_pack;
  const blocks = [...asArray(run.blockers)];
  if (retrieval.loadError && !blocks.some((block) => block?.code === retrieval.loadError.code)) {
    blocks.unshift({
      code: retrieval.loadError.code,
      message: retrieval.loadError.message,
      source: 'retrieval',
    });
  }
  const warnings = uniqueWarnings([...retrieval.warnings, ...asArray(run.warnings), ...draftWarnings]);
  const finishedMs = now();

  const tags = buildTags(topic, platform);
  const wordCount = Number.isFinite(pack?.layout?.word_count)
    ? pack.layout.word_count
    : countWords(pack?.body);
  const sourceList = asArray(pack?.sources).map((source, index) => {
    const meta = sourceMeta.get(source.url) ?? {};
    return {
      index: index + 1,
      url: source.url,
      title:
        (isNonEmptyString(meta.title) ? meta.title : null) ??
        (isNonEmptyString(source.title) ? source.title : null) ??
        hostOf(source.url),
      publisher:
        (isNonEmptyString(meta.publisher) ? meta.publisher : null) ??
        (isNonEmptyString(source.publisher) ? source.publisher : null) ??
        publisherOf(source),
      via:
        (isNonEmptyString(meta.via) ? meta.via : null) ??
        (isNonEmptyString(source.via) ? source.via : null) ??
        null,
      host: hostOf(source.url),
      fetched_at: source.fetched_at,
      sha256: source.sha256,
      excerpt: source.excerpt,
    };
  });
  const keyFacts = selectKeyFacts(asArray(pack?.facts), sourceList);
  const keyClaims = new Set(keyFacts.map((fact) => fact.claim));

  const detectedClaims = asArray(capturedReview?.evidence?.unsupported_claims);
  const injection = {
    enabled: injectFactError,
    caught:
      injectFactError &&
      Boolean(capturedReview) &&
      capturedReview.verdict === 'rework' &&
      detectedClaims.length > 0,
    claim: injectedFact,
    detected_claim: detectedClaims[0]?.claim ?? null,
  };

  const articlePack = {
    ...baseArticlePack({
      topic,
      mode,
      platform,
      account,
      retrieval,
      license,
      warnings,
      blocks,
      status: run.status,
      now: finishedMs,
    }),
    status: run.status,
    needs_rework: run.status === 'needs_rework',
    title_candidates: [...asArray(pack?.title_candidates)],
    chosen_title: asArray(pack?.title_candidates)[0] ?? '',
    body: String(pack?.body ?? ''),
    tags,
    word_count: wordCount,
    source_list: sourceList,
    sources: sourceList.map(({ index: _index, ...source }) => source),
    facts: asArray(pack?.facts).map((fact, index) => ({
      id: isNonEmptyString(fact.id) ? fact.id : `F${index + 1}`,
      ...fact,
      key: fact.key === true || keyClaims.has(fact.claim),
    })),
    key_facts: keyFacts,
    review: {
      verdict:
        capturedReview?.verdict ??
        (run.status === 'blocked' ? 'blocked' : run.status === 'needs_rework' ? 'rework' : 'passed'),
      score: capturedReview?.score ?? pack?.review?.score ?? null,
      issues_count: asArray(capturedReview?.issues ?? pack?.review?.issues).length,
    },
    layout: {
      ...(pack?.layout ?? {}),
      platform,
      format: 'markdown',
      title: asArray(pack?.title_candidates)[0] ?? '',
      word_count: wordCount,
      tags,
    },
    license_status: LICENSE_STATUS_UNAUTHORIZED,
    license_status_label: LICENSE_STATUS_LABEL,
    license,
    publish: { executed: false, authorization: null },
    retrieval: {
      ...retrieval.description,
      stats: { ...retrieval.stats },
      source_count: sourceList.length,
      fact_count: asArray(pack?.facts).length,
      source_hashes: hashesOfSources(pack?.sources),
    },
    warnings,
    blocks,
    injection,
    generated_at: isoOf(finishedMs),
  };

  const reviewArtifact =
    capturedReview ??
    blockedReview({
      topic,
      mode,
      reviewer: reviewerInfo,
      blocks,
      warnings,
      sourceCount: sourceList.length,
      factCount: asArray(pack?.facts).length,
      now: finishedMs,
    });
  reviewArtifact.topic = topic;
  reviewArtifact.mode = mode;
  if (!reviewArtifact.generated_at) reviewArtifact.generated_at = isoOf(finishedMs);

  const exitCode = run.status === 'blocked' ? EXIT_BLOCKED : EXIT_OK;
  const artifacts = {
    article_pack: 'article-pack.json',
    review: 'review.json',
    report: 'report.json',
    article_md: 'article.md',
    sources: 'sources.json',
  };

  // Write the non-report artifacts first so the report can carry their timing.
  const artifactStart = now();
  writeJson(outDir, artifacts.article_pack, articlePack);
  writeJson(outDir, artifacts.review, reviewArtifact);
  writeJson(outDir, artifacts.sources, {
    topic,
    mode,
    license_status: LICENSE_STATUS_UNAUTHORIZED,
    source_count: sourceList.length,
    sources: sourceList,
  });
  writeFileSync(
    join(outDir, artifacts.article_md),
    articlePack.body || '# 未产出正文\n\n取料或核查未通过，未生成正文。\n',
    'utf8',
  );
  const artifactDuration = Math.max(0, now() - artifactStart);
  const artifactStep = {
    name: 'write_artifacts',
    status: 'completed',
    started_at: isoOf(artifactStart),
    ended_at: isoOf(artifactStart + artifactDuration),
    duration_ms: artifactDuration,
    calls: { search: 0, fetch: 0, model: 0, fake_model: 0 },
  };

  const usage = buildUsage({ mode, client });
  const cost = buildCost({ usage, mode, env });
  const reportArtifact = buildReport({
    runId,
    topic,
    mode,
    gateway,
    platform,
    account,
    status: run.status,
    exitCode,
    startedMs,
    finishedMs,
    run,
    counters,
    real,
    client,
    retrieval,
    usage,
    cost,
    env,
    warnings,
    blocks,
    injection,
    artifacts,
    artifactStep,
    error: null,
  });
  writeJson(outDir, artifacts.report, reportArtifact);

  return {
    exitCode,
    status: run.status,
    outDir,
    artifacts,
    articlePack,
    review: reviewArtifact,
    report: reportArtifact,
  };
}
