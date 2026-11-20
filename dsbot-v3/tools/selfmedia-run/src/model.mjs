/**
 * Model surfaces for the self-media run harness.
 *
 * - fake writer: deterministic local prose built from checked facts;
 * - real writer/reviewer: OpenAI-compatible chat completions through an
 *   injected fetch implementation.
 *
 * The API key is captured in a closure. It is never included in a returned
 * object, a log line or an error message, and error text is redacted before it
 * leaves this module.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { createGateway, fetchTransport } from '../../../packages/model-gateway/src/index.js';

import { ConfigError, ModelError } from './errors.mjs';
import { renderSourceLines } from './attribution.mjs';
import { publisherOf, viaOf } from './retrieval.mjs';
import { RUBRIC_ITEMS } from './review.mjs';

export const DEFAULT_WRITER_MODEL = 'deterministic-fake-writer';
export const DEFAULT_REVIEWER_MODEL = 'deterministic-reviewer';
export const DEFAULT_BRIDGE_TIMEOUT_MS = 180_000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Pull the first JSON object out of a model response (code fences allowed). */
export function extractJsonObject(text) {
  if (!isNonEmptyString(text)) return null;
  let value = String(text).replace(/^\uFEFF/, '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fence) value = fence[1].trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse a reviewer response. Real models often wrap the requested JSON in a
 * Markdown code fence or add prose, so three strategies are tried in order and
 * a total failure is reported instead of thrown:
 *   1. JSON.parse of the whole response;
 *   2. JSON.parse of each fenced block (```json ... ``` or ``` ... ```);
 *   3. JSON.parse of the first "{" through the last "}" slice.
 *
 * Returns { ok: true, value, strategy } or { ok: false, reason }.
 */
export function parseReview(text) {
  if (!isNonEmptyString(text)) return { ok: false, reason: 'empty_input' };
  const source = String(text).replace(/^\uFEFF/, '').trim();
  if (!source) return { ok: false, reason: 'empty_input' };

  const attempt = (candidate, strategy) => {
    try {
      return { ok: true, value: JSON.parse(candidate), strategy };
    } catch {
      return null;
    }
  };

  // (a) The response is already bare JSON.
  const direct = attempt(source, 'direct');
  if (direct) return direct;

  // (b) The JSON is inside a Markdown code fence, with or without a language tag.
  const fenceRe = /```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  for (const match of source.matchAll(fenceRe)) {
    const fenced = String(match[1] ?? '').trim();
    if (!fenced) continue;
    const parsed = attempt(fenced, 'fence');
    if (parsed) return parsed;
  }

  // (c) The JSON object is surrounded by explanation text.
  const start = source.indexOf('{');
  if (start < 0) return { ok: false, reason: 'no_json_object' };
  const end = source.lastIndexOf('}');
  if (end <= start) return { ok: false, reason: 'unclosed_json_object' };
  return attempt(source.slice(start, end + 1), 'brace_slice') ?? { ok: false, reason: 'invalid_json' };
}

export function defaultTitles(topic) {
  return [
    `${topic}：三条可核查的事实`,
    `把「${topic}」写清楚：证据、做法与待确认`,
    `${topic} 的实践复盘：先核对再动笔`,
  ];
}

function citationFor(fact, sources) {
  const refs = asArray(fact?.source_refs);
  const indexes = refs
    .map((url) => sources.findIndex((source) => source.url === url))
    .filter((index) => index >= 0)
    .map((index) => `[${index + 1}]`);
  return [...new Set(indexes)].join('');
}

/**
 * Deterministic fake writer. All prose comes from the checked facts passed by
 * the content chain; with `injectFactError` it appends exactly one unsupported
 * claim so the independent reviewer can prove it catches a planted error.
 */
export function fakeWrite(context, { injectFactError = false } = {}) {
  const topic = isNonEmptyString(context?.topic) ? context.topic.trim() : '测试选题';
  const facts = asArray(context?.facts).filter((fact) => isNonEmptyString(fact?.claim));
  const sources = asArray(context?.sources);

  const paragraphs = facts.map((fact) => {
    const citations = citationFor(fact, sources);
    return citations ? `${fact.claim} ${citations}` : fact.claim;
  });

  const injectedFact = injectFactError
    ? `行业数据显示，围绕「${topic}」的项目中位成本为 37.5 万元，较上一年下降 18%。${sources.length > 0 ? '[1]' : ''}`
    : null;

  const body = [
    `# ${topic}`,
    '',
    `围绕「${topic}」，下面这些结论都能在公开材料中找到出处。本文只做事实梳理，不替代发布前的编辑判断。`,
    '',
    '## 事实与引用',
    '',
    ...(paragraphs.length > 0
      ? paragraphs.flatMap((paragraph) => [paragraph, ''])
      : ['本次取料没有可核查的事实，不能据此写稿。', '']),
    ...(injectedFact ? [injectedFact, ''] : []),
    '## 可以怎么做',
    '',
    '- 先统一术语，再把重复沟通改写成可检索的异步文档。',
    '- 把写作模板固定为“结论—证据—待确认”三段，并在发布前逐条核对出处。',
    '- 对没有来源支持的数字和归属句，宁可删掉，也不要补写。',
    '',
    '## 待确认',
    '',
    '- 来源样本是否覆盖目标读者所在的平台与账号阶段。',
    '- 发布前是否需要补充人工事实复核与配图授权。',
    '',
    '## 来源',
    '',
    ...renderSourceLines(sources),
    '',
  ].join('\n');

  return {
    title_candidates: defaultTitles(topic),
    body,
    injected_fact: injectedFact,
    usage: null,
  };
}

export function createFakeWriter({ injectFactError = false } = {}) {
  return async (context) => fakeWrite(context, { injectFactError });
}

/* -------------------------------------------------------------- chat client */

function sanitize(text, secret) {
  const value = String(text ?? '');
  if (!isNonEmptyString(secret)) return value;
  return value.split(secret).join('[redacted]');
}

function joinChatUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function contentOf(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * Minimal OpenAI-compatible chat client. `fetchImpl` is injectable so tests can
 * verify the request shape and redaction without touching the network.
 */
export function createChatClient({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90000,
  maxTokens = 2000,
  temperature = 0.3,
} = {}) {
  if (!isNonEmptyString(baseUrl)) throw new ModelError('model base URL is required');
  if (!isNonEmptyString(apiKey)) throw new ModelError('model API key is required');
  if (!isNonEmptyString(model)) throw new ModelError('model name is required');
  if (typeof fetchImpl !== 'function') {
    throw new ModelError('model client requires a fetch implementation');
  }

  const endpoint = joinChatUrl(baseUrl);
  const state = {
    calls: 0,
    usage: { tokens_in: 0, tokens_out: 0, tokens_cached: 0 },
  };

  async function chat(messages, { temperature: overrideTemperature = temperature } = {}) {
    state.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: overrideTemperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
    } catch (error) {
      throw new ModelError(
        sanitize(`model request failed: ${error.message}`, apiKey),
        { code: 'model_network_error', cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response || response.ok === false) {
      const status = response?.status ?? 'network_error';
      let detail = '';
      try {
        detail = typeof response?.text === 'function' ? await response.text() : '';
      } catch {
        detail = '';
      }
      throw new ModelError(
        sanitize(`model request failed with HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, apiKey),
        { code: 'model_http_error', status },
      );
    }

    let payload;
    try {
      payload = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
    } catch (error) {
      throw new ModelError('model response is not valid JSON', { code: 'model_bad_json', cause: error });
    }
    const content = contentOf(payload);
    if (!isNonEmptyString(content)) {
      throw new ModelError('model response contained no message content', {
        code: 'model_empty_content',
      });
    }
    const usage = payload?.usage ?? {};
    const tokensIn = Number(usage.prompt_tokens ?? 0);
    const tokensOut = Number(usage.completion_tokens ?? 0);
    const tokensCached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
    if (Number.isFinite(tokensIn)) state.usage.tokens_in += tokensIn;
    if (Number.isFinite(tokensOut)) state.usage.tokens_out += tokensOut;
    if (Number.isFinite(tokensCached)) state.usage.tokens_cached += tokensCached;

    return { content, usage, raw: payload };
  }

  return {
    model,
    endpointHost: (() => {
      try {
        return new URL(endpoint).host;
      } catch {
        return null;
      }
    })(),
    chat,
    get calls() {
      return state.calls;
    },
    getUsage() {
      return { ...state.usage };
    },
  };
}

/* ------------------------------------------------------------ bridge client */

/**
 * The bridge secret is read from a file only. It is never taken from the
 * environment (the file is the single source), never logged, and only the
 * gateway puts it into the `Authorization: Bearer` header.
 */
export function resolveBridgeSecretFile({ env = {}, cwd = process.cwd() } = {}) {
  const configured = typeof env.DSBOT_BRIDGE_SECRET_FILE === 'string' ? env.DSBOT_BRIDGE_SECRET_FILE.trim() : '';
  return configured ? resolve(cwd, configured) : join(homedir(), '.dsh', 'bridge.secret');
}

export function readBridgeSecret({ env = {}, cwd = process.cwd() } = {}) {
  const file = resolveBridgeSecretFile({ env, cwd });
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `--real --gateway bridge requires a bridge secret file; it is missing or unreadable (${file})`,
      {
        hint:
          'create the file with the bridge secret, or point DSBOT_BRIDGE_SECRET_FILE at it; ' +
          'the harness never prints the file contents and never falls back to an API key',
      },
    );
  }
  const secret = raw.trim();
  if (secret.length === 0) {
    throw new ConfigError(`the bridge secret file is empty (${file})`, {
      hint: 'write the bridge secret into the file; the contents are never printed',
    });
  }
  return { secret, file };
}

function hostOfUrl(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}

export function bridgeTimeoutMs(env = {}) {
  const value = Number(env.DSBOT_BRIDGE_TIMEOUT_MS ?? DEFAULT_BRIDGE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), 300_000) : DEFAULT_BRIDGE_TIMEOUT_MS;
}

/**
 * A `chat()`-shaped adapter over `packages/model-gateway`'s `dsh_bridge`
 * backend. One gateway instance (and therefore one DSH session) is reused for
 * every call in the run.
 */
export function createBridgeChatClient({ gateway, model, timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS, endpointHost = null } = {}) {
  if (!gateway || typeof gateway.complete !== 'function') {
    throw new ModelError('bridge client requires a model gateway');
  }
  if (!isNonEmptyString(model)) throw new ModelError('bridge model name is required');
  const state = {
    calls: 0,
    usage: { tokens_in: 0, tokens_out: 0, tokens_cached: 0 },
  };

  async function chat(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const system = list
      .filter((message) => message?.role === 'system')
      .map((message) => String(message.content ?? ''))
      .filter((text) => text.length > 0)
      .join('\n\n');
    const prompt = list
      .filter((message) => message?.role !== 'system')
      .map((message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')))
      .join('\n\n');
    if (!isNonEmptyString(prompt)) throw new ModelError('bridge prompt is empty');

    state.calls += 1;
    const result = await gateway.complete({
      prompt,
      ...(system.length > 0 ? { system } : {}),
      timeoutMs,
    });
    const input = Number(result?.usage?.inputTokens ?? 0);
    const output = Number(result?.usage?.outputTokens ?? 0);
    const cached = Number(result?.usage?.cachedTokens ?? 0);
    if (Number.isFinite(input)) state.usage.tokens_in += input;
    if (Number.isFinite(output)) state.usage.tokens_out += output;
    if (Number.isFinite(cached)) state.usage.tokens_cached += cached;
    return {
      content: result.text,
      usage: { prompt_tokens: input, completion_tokens: output },
      raw: result,
    };
  }

  return {
    model,
    endpointHost,
    chat,
    get calls() {
      return state.calls;
    },
    getUsage() {
      return { ...state.usage };
    },
  };
}

/**
 * Wire the bridge backend without an API key. `fetchImpl` is injected so tests
 * can use a fake MCP transport and never touch the network or a real secret.
 */
export function createBridgeModelClient({
  secret,
  fetchImpl = globalThis.fetch,
  bridgeUrl,
  cwd = process.cwd(),
  model,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
  bridgeModel,
  preset,
} = {}) {
  if (!isNonEmptyString(secret)) throw new ConfigError('bridge secret is required');
  if (typeof fetchImpl !== 'function') throw new ModelError('bridge client requires a fetch implementation');
  const gateway = createGateway({
    kind: 'dsh_bridge',
    transport: fetchTransport(fetchImpl),
    env: {},
    bridgeSecret: secret,
    ...(isNonEmptyString(bridgeUrl) ? { bridgeUrl } : {}),
    cwd,
    timeoutMs,
    ...(isNonEmptyString(bridgeModel) ? { bridgeModel } : {}),
    ...(isNonEmptyString(preset) ? { preset } : {}),
    reuseSession: true,
  });
  return createBridgeChatClient({
    gateway,
    model,
    timeoutMs,
    endpointHost: hostOfUrl(bridgeUrl ?? 'http://127.0.0.1:17300/mcp'),
  });
}

/* ------------------------------------------------------------- real prompts */

function sourceBlock(sources, sourceTexts, limit = 3000) {
  return asArray(sources)
    .map((source, index) => {
      const text = sourceTexts?.get?.(source.url) ?? source.excerpt ?? '';
      const publisher = publisherOf(source) || '未知来源';
      const via = viaOf(source);
      const attribution = via && via !== publisher ? `${publisher}（via ${via}）` : publisher;
      return (
        `[${index + 1}] ${source.url}\n标题：${source.title ?? ''}\n出版方：${attribution}\n` +
        `原文摘录：${String(text).slice(0, limit)}`
      );
    })
    .join('\n\n');
}

function factBlock(facts) {
  return asArray(facts)
    .map(
      (fact, index) =>
        `${index + 1}. ${fact.claim}\n   关键事实：${fact.key === true ? '是' : '否'}\n   来源：${asArray(fact.source_refs).join(', ')}`,
    )
    .join('\n');
}

function keyFactBlock(keyFacts, sources) {
  return asArray(keyFacts)
    .map((fact, index) => {
      const indexes = asArray(fact.source_refs)
        .map((ref) => sources.findIndex((source) => source.url === ref))
        .filter((sourceIndex) => sourceIndex >= 0)
        .map((sourceIndex) => `[${sourceIndex + 1}]`);
      return `${index + 1}. ${fact.claim} 来源：${[...new Set(indexes)].join('') || '（无）'}`;
    })
    .join('\n');
}

/**
 * Real writer: one chat completion, JSON output. A non-JSON response is still
 * usable prose (with default titles) but is reported as a warning, never as a
 * silently passing structured result.
 */
export function createRealWriter({ chat, injectFactError = false } = {}) {
  if (typeof chat !== 'function') throw new ModelError('real writer requires chat()');
  return async (context) => {
    const topic = isNonEmptyString(context?.topic) ? context.topic.trim() : '测试选题';
    const warnings = [];
    const injectionInstruction = injectFactError
      ? '\n审校演练：请在正文中故意加入一条没有来源支持的事实错误（含一个具体数字），并在 JSON 的 injected_fact 字段原样返回该句。'
      : '';
    const messages = [
      {
        role: 'system',
        content:
          '你是中文自媒体编辑。只使用用户给出的来源中的事实；每个事实句后面用 [n] 标注来源序号；' +
          '不得编造数字、机构、引语或研究结论。输出一个 JSON 对象，字段为 ' +
          '{"title_candidates":["至少3个标题"],"body":"markdown 正文"}，不要输出 JSON 以外的内容。' +
          injectionInstruction,
      },
      {
        role: 'user',
        content:
          `选题：${topic}\n平台：${context?.platform ?? 'wechat'}\n\n` +
          `已核查事实：\n${factBlock(context?.facts) || '（无）'}\n\n` +
          `重点事实（正文必须逐条覆盖，句末标 [n]）：\n` +
          `${keyFactBlock(context?.keyFacts, asArray(context?.sources)) || '（无）'}\n\n` +
          `来源：\n${sourceBlock(context?.sources, context?.sourceTexts) || '（无）'}\n\n` +
          '正文要求：以 # 标题开头；包含「## 事实与引用」「## 可以怎么做」「## 待确认」「## 来源」小节；' +
          '每个事实句后标 [n]；来源小节先写 [n] URL 即可，快照摘要与哈希由 harness 补齐；不要写发布许可结论。',
      },
    ];
    const result = await chat(messages, { temperature: 0.4 });
    const parsed = extractJsonObject(result.content);
    if (parsed && Array.isArray(parsed.title_candidates) && typeof parsed.body === 'string') {
      const titles = parsed.title_candidates.filter(isNonEmptyString).map((title) => title.trim());
      return {
        title_candidates: titles.length >= 3 ? titles : [...titles, ...defaultTitles(topic)].slice(0, 3),
        body: parsed.body,
        injected_fact: isNonEmptyString(parsed.injected_fact) ? parsed.injected_fact.trim() : null,
        usage: result.usage ?? null,
        warnings,
      };
    }
    warnings.push({
      code: 'writer_non_json',
      message: 'model did not return the requested JSON; treated the response as prose with default titles',
    });
    return {
      title_candidates: defaultTitles(topic),
      body: result.content.trim(),
      injected_fact: null,
      usage: result.usage ?? null,
      warnings,
    };
  };
}

/* ------------------------------------------------------- reviewer prompting */

/** Numbered rubric checklist handed to the model, one line per dimension. */
export const REVIEW_RUBRIC_CHECKLIST = Object.freeze(
  RUBRIC_ITEMS.map(
    (item, index) => `${index + 1}. ${item.id}（${item.label}）：${item.description}`,
  ),
);

const CHECKLIST_TEXT = REVIEW_RUBRIC_CHECKLIST.join('\n');
const RUBRIC_IDS = RUBRIC_ITEMS.map((item) => item.id);

/**
 * Strict output schema. The field names and the six rubric/check ids are fixed;
 * values are illustrative. This is embedded in the reviewer prompt so a model
 * that follows instructions cannot choose a different shape.
 */
export const REVIEW_JSON_SCHEMA = `{
  "rubric": {
${RUBRIC_IDS.map(
  (id) => `    "${id}": {"score": 90, "evidence": ["针对 ${id} 的具体依据"]}`,
).join(',\n')}
  },
  "checks": [
${RUBRIC_IDS.map(
  (id) => `    {"item": "${id}", "status": "pass", "evidence": "针对 ${id} 的具体依据"}`,
).join(',\n')}
  ],
  "issues": [
    {"code": "unsupported_number", "severity": "critical", "message": "正文中的数字没有来源支持", "evidence": {"claim": "原文句子"}}
  ],
  "verdict": "passed"
}`;

export const REVIEW_SYSTEM_PROMPT = [
  '你是独立审校，与写作者不共享上下文。只依据给定的文章、已核查事实和来源原文评分，不要改写文章。',
  '',
  '严格输出要求：',
  '- 只输出一个 JSON 对象，从 { 开始、到 } 结束；不要 markdown、不要输出代码围栏、不要解释、不要输出 JSON 以外的任何文字。',
  '- 顶层字段名固定为 rubric、checks、issues、verdict；不得改名、增删或嵌套到其他字段。',
  '- rubric 必须覆盖全部六个维度，每项格式为 {"score": 0-100 的整数, "evidence": ["至少一条具体证据"]}。',
  '- checks 必须按下面的编号逐项返回 {"item": 维度 id, "status": "pass|warn|fail", "evidence": "具体依据"}，六项都要有。',
  '- issues 只放确实需要返修的问题；建议、润色偏好和可选优化放进 evidence，不要放进 issues。',
  '',
  '评分维度（逐项检查）：',
  CHECKLIST_TEXT,
  '',
  '事实核查口径：只有陈述事实的句子（含数字、归属、研究结论）才算事实断言；祈使、建议、观点和比较评价句不是事实断言。',
  '以“要/应该/建议/别/不要/值得/可以”开头，或含“而不是/优于/比…更好”等比较评价的句子，不要据此报 unsupported_claim。',
  '但带数字的事实陈述仍必须核对来源。',
  '',
  '输出 schema（字段名与层级固定，取值仅示意）：',
  REVIEW_JSON_SCHEMA,
  '',
  '只输出上面这个 JSON 对象。',
].join('\n');

/** Appended to the reviewer prompt for each repair attempt. */
const REVIEW_FORMAT_REMINDER =
  '上一次输出无法解析为 JSON。请只输出 JSON，不要解释，不要输出 JSON 以外的任何文字。';

const REVIEW_REPAIR_INSTRUCTION =
  '只把上面的评审改写为 JSON，不要新增内容，也不要删除或改动任何评审结论。';

const REVIEW_FINAL_REPAIR_INSTRUCTION =
  '格式修复：只输出一个合法 JSON 对象，不要 markdown 代码围栏，不要解释。' +
  '字段名固定为 rubric、checks、issues、verdict；rubric 和 checks 都必须按编号覆盖六个维度。';

/** Reviewer conversation budget: one normal call plus at most two repairs. */
const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Real independent reviewer: a separate chat completion with a different
 * system prompt. Deterministic checks are still applied by reviewArticle().
 *
 * JSON reliability is a three-tier fallback:
 *   1. the normal review call, parsed by parseReview();
 *   2. one repair call that feeds the previous output back and asks the model
 *      to rewrite only that review as JSON (no new content);
 *   3. a final strict format-repair call with the fixed schema.
 * If all three responses are unparseable the result becomes __parse_error,
 * which reviewArticle() turns into a critical review_invalid_json issue. The
 * reviewer never invents a passing review to avoid that outcome.
 */
export function createRealReviewer({ chat } = {}) {
  if (typeof chat !== 'function') throw new ModelError('real reviewer requires chat()');
  return async (context) => {
    const messages = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `选题：${context?.topic ?? ''}\n\n文章标题候选：\n${asArray(context?.article?.title_candidates)
            .map((title, index) => `${index + 1}. ${title}`)
            .join('\n')}\n\n正文：\n${context?.article?.body ?? ''}\n\n` +
          `已核查事实：\n${factBlock(context?.facts) || '（无）'}\n\n` +
          `重点事实（正文应在对应句后标 [n]）：\n` +
          `${keyFactBlock(context?.keyFacts, asArray(context?.sources)) || '（无）'}\n\n` +
          `来源（publisher 才能证明独立，via 只是聚合方）：\n` +
          `${sourceBlock(context?.sources, context?.sourceTexts, 2000) || '（无）'}\n\n` +
          '请按六个编号维度逐项检查，并在 checks 中逐项返回 {item, status, evidence}；' +
          '只输出一个 JSON 对象，事实核查不要误报建议/观点句。',
      },
    ];

    let conversation = messages;
    let lastContent = '';
    let lastReason = null;
    let lastUsage = null;

    for (let repairAttempt = 0; repairAttempt <= MAX_REPAIR_ATTEMPTS; repairAttempt += 1) {
      const result = await chat(conversation, { temperature: 0 });
      lastContent = String(result?.content ?? '');
      lastUsage = result?.usage ?? lastUsage;
      const parsed = parseReview(lastContent);
      if (parsed.ok && isPlainObject(parsed.value)) {
        return {
          ...parsed.value,
          usage: result.usage ?? null,
          retry_count: repairAttempt,
          repair_attempts: repairAttempt,
          parse_strategy: parsed.strategy,
        };
      }

      lastReason = parsed.ok ? 'not_an_object' : parsed.reason;
      if (repairAttempt === MAX_REPAIR_ATTEMPTS) break;

      const instruction =
        repairAttempt === 0
          ? `${REVIEW_FORMAT_REMINDER}\n${REVIEW_REPAIR_INSTRUCTION}\n上一次的解析错误：${lastReason}。`
          : `${REVIEW_FORMAT_REMINDER}\n${REVIEW_FINAL_REPAIR_INSTRUCTION}\n` +
            `上一次的解析错误：${lastReason}。\n严格按以下 schema 输出：\n${REVIEW_JSON_SCHEMA}`;
      conversation = [
        ...conversation,
        { role: 'assistant', content: lastContent },
        { role: 'user', content: instruction },
      ];
    }

    return {
      __parse_error: true,
      reason: lastReason ?? 'no_json_object',
      raw: lastContent.slice(0, 500),
      usage: lastUsage,
      retry_count: MAX_REPAIR_ATTEMPTS,
      repair_attempts: MAX_REPAIR_ATTEMPTS,
    };
  };
}
