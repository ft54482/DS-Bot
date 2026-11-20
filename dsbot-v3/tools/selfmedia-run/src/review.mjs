/**
 * Independent review for the self-media run harness.
 *
 * The reviewer is deliberately separate from the writer: it gets a distinct
 * reviewer id/context, the finished article, the checked facts and the source
 * text, and it never sees the writer's prompt or chain of thought.
 *
 * In fake mode the rubric is deterministic local code. In real mode a separate
 * model call contributes scores/evidence, but deterministic checks still run and
 * can only lower a score -- a model that says "passed" cannot waive an
 * unsupported number or an unauthorized publish state.
 */

import { distinctPublisherLabels } from './attribution.mjs';
import { hostOf } from './retrieval.mjs';

export const REVIEW_VERSION = 1;

export const DEFAULT_REVIEWER = Object.freeze({
  id: 'independent-reviewer-v1',
  context_id: 'ctx-selfmedia-review',
  independent: true,
  model: 'deterministic-v1',
});

export const RUBRIC_ITEMS = Object.freeze([
  {
    id: 'factuality',
    label: '事实与证据',
    weight: 0.3,
    threshold: 80,
    description: '正文中的数字和归属句必须能在已核查事实或来源原文中找到支持。',
  },
  {
    id: 'sourcing',
    label: '来源与快照',
    weight: 0.2,
    threshold: 80,
    description: '关键事实至少由两个独立主机来源支持，来源带快照摘要与哈希。',
  },
  {
    id: 'structure',
    label: '结构完整',
    weight: 0.15,
    threshold: 70,
    description: '标题候选、正文标题、段落和来源清单齐全。',
  },
  {
    id: 'readability',
    label: '可读性',
    weight: 0.15,
    threshold: 70,
    description: '段落和句子长度适中，避免难以阅读的长段。',
  },
  {
    id: 'style',
    label: '文风',
    weight: 0.1,
    threshold: 70,
    description: '避免营销腔、绝对化承诺和过多感叹号。',
  },
  {
    id: 'compliance',
    label: '合规与许可',
    weight: 0.1,
    threshold: 80,
    description: '保持未授权状态，不执行发布，引文比例受控。',
  },
]);

const ATTRIBUTION_RE =
  /(数据显示|研究表明|研究显示|调查显示|报告显示|统计显示|据统计|专家表示|据.{0,12}报道|(材料|报告|文章|来源)[A-Za-z0-9一二三四五六七八九十]*\s*(显示|表明|表示|指出|称|提到|强调|记录|认为))/;

const FORBIDDEN_STYLE = [
  '颠覆',
  '史上最强',
  '震惊',
  '必看',
  '绝对',
  '100%',
  'guaranteed',
  'unbelievable',
  '一夜暴富',
  '稳赚不赔',
];

const ABSOLUTE_PROMISE_RE = /(保证收益|稳赚|零风险|百分百有效|绝对安全)/;

/**
 * Advice/opinion leads. These mark a sentence as a recommendation rather than a
 * factual assertion. `要` and `可以` are ambiguous in Chinese ("要闻",
 * "可以看到"), so they only count when followed by a recommendation verb.
 */
const ADVICE_LEAD_RE =
  /^(?:建议|应该|应当|务必|请|别|不要|值得|不妨|最好|宜|推荐|切记|记住|尽量|要(?!求|点|闻|是|么)|需要(?:先|再|把|用|通过|从|在|按|考虑|尝试|参考|选择|优先|补充|核对|复核|确认|注意|保持|统一|拆|删|改)|可以(?:先|再|把|用|通过|从|在|按|考虑|尝试|参考|选择|优先|删|拆|统一|固定|保留))/;

/** Explicit comparison/evaluation phrasing from the ticket. */
const EVALUATIVE_RE =
  /(而不是|优于|劣于|好于|不如|与其|比[^。！？；，]{0,16}(?:更|还)(?:好|差|重要|划算|值得|合适|稳妥)|更好|更差|更划算|更重要|更值得|没必要|不值得|胜于)/;

/**
 * Markdown ordered-list markers ("4. ", "4、", "(4) ") are structure, not
 * facts. Bullet markers are already removed while buffering paragraphs.
 */
const LIST_MARKER_RE = /^(?:[-*+]\s+|\d{1,3}[.)、]\s*|\(\d{1,3}\)\s*|（\d{1,3}）\s*)/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reviewer evidence is requested as an array but a single string is usable. */
function reviewEvidenceList(value) {
  if (isNonEmptyString(value)) return [value.trim()];
  return asArray(value).filter(isNonEmptyString).map((entry) => entry.trim());
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

/** Count Chinese characters and Latin/number words, matching the content chain. */
export function countWords(text) {
  return (String(text ?? '').match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) ?? []).length;
}

/** Build at least three reviewable tags from the topic and platform. */
export function buildTags(topic, platform = 'wechat') {
  const words = String(topic ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .slice(0, 3);
  const tags = [];
  const seen = new Set();
  for (const value of [...words, platform, '自媒体', '待发布', 'self-media']) {
    if (!isNonEmptyString(value)) continue;
    const tag = value.trim();
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

function textMapOf(sourceTexts) {
  if (sourceTexts instanceof Map) return sourceTexts;
  if (isPlainObject(sourceTexts)) return new Map(Object.entries(sourceTexts));
  return new Map();
}

function stripCitations(text) {
  return String(text ?? '').replace(/\[\d+\]/g, '');
}

/** Remove a leading Markdown list marker ("4. ", "4、", "(4) ") from a sentence. */
export function stripListMarker(text) {
  return String(text ?? '').replace(LIST_MARKER_RE, '').trim();
}

/**
 * A claim candidate must assert a fact. Imperative, advice and evaluative
 * sentences are skipped by the deterministic fact check so that a
 * recommendation such as "用回滚率验收，而不是争论 AI 会不会出错" is not
 * reported as an unsupported factual claim.
 */
export function isOpinionOrAdviceSentence(text) {
  const value = stripListMarker(stripCitations(text)).trim();
  if (!value) return false;
  if (ADVICE_LEAD_RE.test(value)) return true;
  return EVALUATIVE_RE.test(value);
}

function normalizeForMatch(text) {
  return stripCitations(text).replace(/\s+/g, '').replace(/[“”「」"'‘’]/g, '');
}

function factsMatch(sentence, factClaim) {
  const a = normalizeForMatch(sentence);
  const b = normalizeForMatch(factClaim);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Split body prose into sentences. Headings, citation lines and markdown list
 * markers are excluded; paragraph indexes are kept for reviewable evidence.
 */
export function extractSentences(body) {
  const paragraphs = String(body ?? '').split(/\r?\n/);
  const result = [];
  let paragraphIndex = -1;
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    buffer = [];
    if (!text) return;
    for (const sentence of text.split(/(?<=[。！？!?；;])\s*/)) {
      const trimmed = sentence.trim();
      const withoutCitations = stripListMarker(stripCitations(trimmed)).trim();
      if (withoutCitations.length < 6) continue;
      result.push({ text: withoutCitations, paragraph_index: paragraphIndex });
    }
  };

  for (const line of paragraphs) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      paragraphIndex += 1;
      continue;
    }
    // Rendered source lines carry a title, publisher, snapshot hash and URL;
    // they are citations, not prose, and must never be fact-checked as claims.
    if (/^\[\d+\]\s+\S/.test(trimmed)) continue;
    if (/^(?:[-*+]|\d{1,3}[.)、]|\(\d{1,3}\)|（\d{1,3}）)\s+/.test(trimmed)) {
      flush();
      paragraphIndex += 1;
      buffer = [stripListMarker(trimmed)];
      continue;
    }
    if (buffer.length === 0) paragraphIndex += 1;
    buffer.push(trimmed);
  }
  flush();
  return result;
}

export function extractNumbers(text) {
  return [
    ...new Set(
      (String(text ?? '').match(/\d+(?:[.,]\d+)?%?/g) ?? []).map((value) =>
        value.replace(/,/g, ''),
      ),
    ),
  ];
}

function factCorpus(facts) {
  return asArray(facts)
    .map((fact) => fact?.claim ?? '')
    .filter(Boolean)
    .join('\n');
}

function checkFactuality({ body, facts, sourceTexts }) {
  const corpusParts = [factCorpus(facts)];
  for (const text of sourceTexts.values()) corpusParts.push(String(text));
  const corpus = corpusParts.join('\n').replace(/,/g, '');

  const sentences = extractSentences(body);
  const unsupported = [];
  const supportedSamples = [];
  const skippedOpinionClaims = [];
  for (const sentence of sentences) {
    // Advice/opinion is not a factual assertion: skip it instead of demanding a
    // source. Declarative sentences with numbers/attribution are still checked.
    if (isOpinionOrAdviceSentence(sentence.text)) {
      skippedOpinionClaims.push({
        claim: sentence.text,
        paragraph_index: sentence.paragraph_index,
        reason: 'opinion_or_advice',
      });
      continue;
    }
    const matchedFact = asArray(facts).find((fact) => factsMatch(sentence.text, fact.claim));
    const numbers = extractNumbers(sentence.text);
    const missing = numbers.filter((value) => !corpus.includes(value));
    const attribution = ATTRIBUTION_RE.test(sentence.text);

    if (missing.length > 0) {
      unsupported.push({
        claim: stripCitations(sentence.text).trim(),
        paragraph_index: sentence.paragraph_index,
        reason: 'numbers_not_in_sources',
        missing_numbers: missing,
      });
      continue;
    }
    if (attribution && !matchedFact) {
      unsupported.push({
        claim: stripCitations(sentence.text).trim(),
        paragraph_index: sentence.paragraph_index,
        reason: 'attribution_without_source',
        missing_numbers: [],
      });
      continue;
    }
    if (numbers.length > 0 && supportedSamples.length < 3) {
      supportedSamples.push({
        claim: stripCitations(sentence.text).trim(),
        numbers,
        matched_fact: matchedFact?.claim ?? null,
      });
    }
  }

  const issues = unsupported.map((entry) => ({
    code: 'unsupported_claim',
    severity: 'critical',
    message: `正文事实缺少来源支持：${entry.claim}`,
    evidence: entry,
    rubric_item: 'factuality',
  }));
  const score = unsupported.length === 0 ? 100 : clamp(100 - unsupported.length * 50);
  return {
    item: {
      id: 'factuality',
      label: '事实与证据',
      score,
      threshold: 80,
      passed: score >= 80,
      evidence: {
        checked_sentences: sentences.length - skippedOpinionClaims.length,
        total_sentences: sentences.length,
        unsupported_claims: unsupported.slice(0, 8),
        skipped_opinion_claims: skippedOpinionClaims.slice(0, 8),
        skipped_opinion_count: skippedOpinionClaims.length,
        supported_samples: supportedSamples,
        source_texts_available: sourceTexts.size,
      },
      issues,
    },
    unsupported,
  };
}

function checkSourcing({ facts, sources, keyFacts = null }) {
  const loadedSources = asArray(sources);
  const selected = Array.isArray(keyFacts) && keyFacts.length > 0
    ? asArray(keyFacts)
    : asArray(facts).filter((fact) => fact?.key === true);
  const detail = selected.map((fact) => {
    const refs = asArray(fact.source_refs).filter(isNonEmptyString);
    const hosts = [...new Set(refs.map(hostOf).filter(Boolean))];
    // Independent sourcing is judged on the original publisher (falling back
    // to the URL host), never on an aggregator that merely carried the item.
    const publishers = distinctPublisherLabels(refs, loadedSources);
    return {
      claim: fact.claim,
      key: true,
      source_refs: refs,
      hosts,
      publishers,
      distinct_hosts: publishers,
      independent_hosts: publishers.length,
      passed: publishers.length >= 2,
    };
  });
  const weak = detail.filter((entry) => !entry.passed);
  const sourceIssues = [];
  if (loadedSources.length === 0) {
    sourceIssues.push({
      code: 'no_sources',
      severity: 'critical',
      message: '稿件没有可核查的来源。',
      rubric_item: 'sourcing',
    });
  }
  for (const entry of weak) {
    if (entry.source_refs.length === 0) {
      sourceIssues.push({
        code: 'key_fact_without_source',
        severity: 'critical',
        message: `关键事实没有来源引用：${entry.claim}`,
        evidence: entry,
        rubric_item: 'sourcing',
      });
      continue;
    }
    sourceIssues.push({
      code: 'single_host_sourcing',
      severity: 'warning',
      message: `关键事实只有 ${entry.independent_hosts} 个独立出版方来源：${entry.claim}`,
      evidence: entry,
      rubric_item: 'sourcing',
    });
  }
  const missingSnapshot = loadedSources.filter(
    (source) =>
      !isNonEmptyString(source?.url) ||
      !/^[a-f0-9]{64}$/.test(String(source?.sha256 ?? '')) ||
      !isNonEmptyString(source?.excerpt),
  );
  if (missingSnapshot.length > 0) {
    sourceIssues.push({
      code: 'missing_source_snapshot',
      severity: 'warning',
      message: `${missingSnapshot.length} 个来源缺少快照（url/sha256/摘要），不能作为已核对来源。`,
      evidence: { missing: missingSnapshot.map((source) => source?.url ?? null).slice(0, 8) },
      rubric_item: 'sourcing',
    });
  }
  if (detail.length === 0 && loadedSources.length > 0) {
    sourceIssues.push({
      code: 'no_key_facts',
      severity: 'warning',
      message: '没有标记为关键事实的条目，无法证明双源核查。',
      rubric_item: 'sourcing',
    });
  }

  let score = 100;
  if (loadedSources.length === 0) score = 0;
  score -= Math.min(60, weak.length * 25);
  if (missingSnapshot.length > 0) score -= 20;
  if (detail.length === 0 && loadedSources.length > 0) score -= 15;
  score = clamp(score);
  return {
    item: {
      id: 'sourcing',
      label: '来源与快照',
      score,
      threshold: 80,
      passed:
        score >= 80 &&
        weak.length === 0 &&
        loadedSources.length > 0 &&
        missingSnapshot.length === 0,
      evidence: {
        source_count: loadedSources.length,
        hosts: [...new Set(loadedSources.map((source) => hostOf(source?.url)).filter(Boolean))],
        publishers: distinctPublisherLabels(
          loadedSources.map((source) => source?.url),
          loadedSources,
        ),
        snapshot_count: loadedSources.length - missingSnapshot.length,
        key_fact_count: detail.length,
        key_facts: detail,
      },
      issues: sourceIssues,
    },
  };
}

function proseParagraphs(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^#{1,6}\s/.test(line) &&
        !/^\[\d+\]\s+\S/.test(line),
    );
}

function checkStructure({ article, layout }) {
  const titles = asArray(article?.title_candidates).filter(isNonEmptyString);
  const body = String(article?.body ?? '');
  const paragraphs = proseParagraphs(body);
  const hasH1 = /^#\s+\S/m.test(body);
  const hasSources = /^##\s*(来源|参考|Sources?)\s*$/im.test(body);
  const wordCount = Number.isFinite(layout?.word_count) ? layout.word_count : countWords(body);
  const issues = [];
  let score = 100;

  if (!hasH1) {
    score -= 25;
    issues.push({
      code: 'missing_h1',
      severity: 'warning',
      message: '正文缺少一级标题。',
      rubric_item: 'structure',
    });
  }
  if (titles.length < 3) {
    score -= 25;
    issues.push({
      code: 'too_few_title_candidates',
      severity: 'warning',
      message: `标题候选不足 3 个（当前 ${titles.length} 个）。`,
      rubric_item: 'structure',
    });
  }
  if (paragraphs.length < 3) {
    score -= 20;
    issues.push({
      code: 'too_few_paragraphs',
      severity: 'warning',
      message: `正文段落不足 3 段（当前 ${paragraphs.length} 段）。`,
      rubric_item: 'structure',
    });
  }
  if (!hasSources) {
    score -= 25;
    issues.push({
      code: 'missing_source_section',
      severity: 'warning',
      message: '正文缺少来源清单小节。',
      rubric_item: 'structure',
    });
  }
  if (wordCount < 200) {
    score -= 20;
    issues.push({
      code: 'too_short',
      severity: 'warning',
      message: `正文过短（${wordCount} 字，目标至少 200）。`,
      rubric_item: 'structure',
    });
  }
  score = clamp(score);
  return {
    item: {
      id: 'structure',
      label: '结构完整',
      score,
      threshold: 70,
      passed: score >= 70,
      evidence: {
        title_candidates: titles.length,
        paragraphs: paragraphs.length,
        word_count: wordCount,
        has_h1: hasH1,
        has_source_section: hasSources,
      },
      issues,
    },
  };
}

function checkReadability({ article }) {
  const body = String(article?.body ?? '');
  const paragraphs = proseParagraphs(body);
  const lengths = paragraphs.map((paragraph) => paragraph.replace(/\s+/g, '').length);
  const average = lengths.length === 0 ? 0 : lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  const sentences = extractSentences(body);
  const longest = sentences.reduce((max, sentence) => Math.max(max, sentence.text.length), 0);

  const issues = [];
  let score = 100;
  if (average > 260) {
    score -= 30;
    issues.push({
      code: 'paragraphs_too_long',
      severity: 'warning',
      message: `正文段落平均 ${Math.round(average)} 字，阅读负担偏高。`,
      rubric_item: 'readability',
    });
  } else if (average > 180) {
    score -= 20;
    issues.push({
      code: 'paragraphs_long',
      severity: 'warning',
      message: `正文段落平均 ${Math.round(average)} 字，建议拆分。`,
      rubric_item: 'readability',
    });
  }
  if (longest > 160) {
    score -= 30;
    issues.push({
      code: 'sentences_too_long',
      severity: 'warning',
      message: `最长句子 ${longest} 字，建议拆分。`,
      rubric_item: 'readability',
    });
  } else if (longest > 100) {
    score -= 15;
    issues.push({
      code: 'sentences_long',
      severity: 'warning',
      message: `最长句子 ${longest} 字，略长。`,
      rubric_item: 'readability',
    });
  }
  if (paragraphs.length < 3) {
    score -= 20;
  }
  score = clamp(score);
  return {
    item: {
      id: 'readability',
      label: '可读性',
      score,
      threshold: 70,
      passed: score >= 70,
      evidence: {
        average_paragraph_chars: Math.round(average),
        longest_sentence_chars: longest,
        paragraphs: paragraphs.length,
        sentences: sentences.length,
      },
      issues,
    },
  };
}

function checkStyle({ article }) {
  const body = String(article?.body ?? '');
  const chosenTitle = asArray(article?.title_candidates).filter(isNonEmptyString)[0] ?? '';
  const hits = FORBIDDEN_STYLE.filter((phrase) => body.includes(phrase) || chosenTitle.includes(phrase));
  const exclamations = (body.match(/[！!]/g) ?? []).length;
  const issues = [];
  let score = 100;
  for (const phrase of hits) {
    score -= 20;
    issues.push({
      code: 'marketing_style',
      severity: 'warning',
      message: `出现营销化或绝对化表达：“${phrase}”。`,
      evidence: { phrase },
      rubric_item: 'style',
    });
  }
  if (exclamations > 1) {
    score -= 10;
    issues.push({
      code: 'too_many_exclamations',
      severity: 'warning',
      message: `感叹号过多（${exclamations} 个）。`,
      rubric_item: 'style',
    });
  }
  if (chosenTitle.length > 40) {
    score -= 10;
    issues.push({
      code: 'title_too_long',
      severity: 'warning',
      message: `首选标题 ${chosenTitle.length} 字，偏长。`,
      rubric_item: 'style',
    });
  }
  score = clamp(score);
  return {
    item: {
      id: 'style',
      label: '文风',
      score,
      threshold: 70,
      passed: score >= 70,
      evidence: {
        forbidden_hits: hits,
        exclamations,
        chosen_title_chars: chosenTitle.length,
      },
      issues,
    },
  };
}

function quotedChars(body) {
  const text = String(body ?? '');
  let total = 0;
  for (const match of text.matchAll(/[“「]([^”」]{1,500})[”」]/g)) total += match[1].length;
  return total;
}

function checkCompliance({ article, license }) {
  const body = String(article?.body ?? '');
  const quoteRatio = body.length === 0 ? 0 : quotedChars(body) / body.length;
  const licenseStatus = license?.status ?? 'unauthorized';
  const published = license?.published === true || license?.publish?.executed === true;
  const issues = [];
  let score = 100;

  if (licenseStatus !== 'unauthorized' || published) {
    score = 0;
    issues.push({
      code: 'license_not_unauthorized',
      severity: 'critical',
      message: '稿件必须保持未授权状态，且不得执行发布。',
      evidence: { license_status: licenseStatus, published },
      rubric_item: 'compliance',
    });
  }
  if (quoteRatio > 0.3) {
    score = 0;
    issues.push({
      code: 'quote_ratio_hard_block',
      severity: 'critical',
      message: `引文比例 ${Math.round(quoteRatio * 100)}% 超过 30% 硬上限。`,
      evidence: { quote_ratio: round1(quoteRatio) },
      rubric_item: 'compliance',
    });
  } else if (quoteRatio > 0.15) {
    score -= 30;
    issues.push({
      code: 'quote_ratio_high',
      severity: 'warning',
      message: `引文比例 ${Math.round(quoteRatio * 100)}% 超过 15% 建议上限。`,
      evidence: { quote_ratio: round1(quoteRatio) },
      rubric_item: 'compliance',
    });
  }
  if (ABSOLUTE_PROMISE_RE.test(body)) {
    score -= 25;
    issues.push({
      code: 'absolute_promise',
      severity: 'warning',
      message: '正文出现绝对化承诺，需要改为有条件表述。',
      rubric_item: 'compliance',
    });
  }
  score = clamp(score);
  return {
    item: {
      id: 'compliance',
      label: '合规与许可',
      score,
      threshold: 80,
      passed: score >= 80,
      evidence: {
        license_status: licenseStatus,
        published,
        quote_ratio: round1(quoteRatio),
      },
      issues,
    },
  };
}

function normalizeIssue(issue) {
  if (!isPlainObject(issue)) {
    return {
      code: 'review_issue',
      severity: 'warning',
      message: String(issue),
      rubric_item: null,
    };
  }
  const severity = issue.severity === 'critical' ? 'critical' : 'warning';
  return {
    ...issue,
    code: isNonEmptyString(issue.code) ? issue.code : 'review_issue',
    severity,
    message: isNonEmptyString(issue.message) ? issue.message : 'review issue',
    rubric_item: isNonEmptyString(issue.rubric_item) ? issue.rubric_item : null,
  };
}

/** Normalize the per-item `{item, status, evidence}` checklist from the model. */
function normalizeModelChecks(checks) {
  return asArray(checks)
    .filter(isPlainObject)
    .map((check) => ({
      item: isNonEmptyString(check.item) ? check.item.trim() : null,
      status: ['pass', 'warn', 'fail'].includes(check.status) ? check.status : null,
      evidence: reviewEvidenceList(check.evidence),
    }))
    .filter((check) => check.item !== null || check.status !== null || check.evidence.length > 0);
}

function applyModelReview(items, modelReview) {
  const extraIssues = [];
  if (!modelReview) return { items, extraIssues, modelUsed: false, modelChecks: [] };

  if (modelReview.__error) {
    extraIssues.push({
      code: 'review_model_failed',
      severity: 'critical',
      message: `独立审校模型调用失败：${modelReview.__error}`,
      rubric_item: null,
    });
    return { items, extraIssues, modelUsed: true, modelChecks: [] };
  }
  if (modelReview.__parse_error) {
    const repairAttempts = Number.isFinite(modelReview.retry_count)
      ? Math.max(0, Math.trunc(modelReview.retry_count))
      : 1;
    extraIssues.push({
      code: 'review_invalid_json',
      severity: 'critical',
      message: `独立审校模型连续 ${repairAttempts + 1} 次没有返回可解析的 JSON（已自动修复 ${repairAttempts} 次），按未通过处理。`,
      rubric_item: null,
    });
    return { items, extraIssues, modelUsed: true, modelChecks: [] };
  }

  const modelChecks = normalizeModelChecks(modelReview.checks);
  const modelRubric = isPlainObject(modelReview.rubric) ? modelReview.rubric : {};
  const missingItems = [];
  const missingEvidence = [];
  for (const item of items) {
    const entry = modelRubric[item.id];
    if (!isPlainObject(entry) || !Number.isFinite(entry.score)) {
      missingItems.push(item.id);
      continue;
    }
    if (reviewEvidenceList(entry.evidence).length === 0) {
      missingEvidence.push(item.id);
    }
  }
  // Parsing succeeded but the review shape is incomplete: that is still a
  // failure. Never let a partial model answer relax the local strictness.
  if (missingItems.length > 0) {
    extraIssues.push({
      code: 'review_rubric_incomplete',
      severity: 'critical',
      message: `独立审校 JSON 缺少评分项：${missingItems.join(', ')}；按未通过处理。`,
      evidence: { missing_items: missingItems },
      rubric_item: null,
    });
  }
  if (missingEvidence.length > 0) {
    extraIssues.push({
      code: 'review_evidence_missing',
      severity: 'warning',
      message: `独立审校 JSON 缺少评分证据：${missingEvidence.join(', ')}。`,
      evidence: { missing_evidence: missingEvidence },
      rubric_item: null,
    });
  }

  for (const item of items) {
    const entry = modelRubric[item.id];
    if (!isPlainObject(entry) || !Number.isFinite(entry.score)) continue;
    const modelScore = clamp(entry.score);
    item.score = Math.min(item.score, round1(modelScore));
    item.passed = item.score >= item.threshold;
    item.evidence = {
      ...item.evidence,
      independent_model: {
        score: modelScore,
        evidence: reviewEvidenceList(entry.evidence).slice(0, 6),
      },
    };
    if (!item.passed) {
      item.issues.push({
        code: 'rubric_below_threshold',
        severity: 'warning',
        message: `${item.label}未达到阈值 ${item.threshold}（独立模型评分 ${modelScore}）。`,
        rubric_item: item.id,
      });
    }
  }

  for (const raw of asArray(modelReview.issues)) {
    const issue = normalizeIssue(raw);
    if (issue.severity !== 'critical' && issue.severity !== 'warning') continue;
    if (!issue.rubric_item && /事实|来源|数字|编造|错误/.test(issue.message)) issue.rubric_item = 'factuality';
    extraIssues.push(issue);
  }
  if (modelReview.verdict === 'rework' && extraIssues.length === 0) {
    extraIssues.push({
      code: 'reviewer_requested_rework',
      severity: 'critical',
      message: '独立审校给出 rework，但没有列出具体问题。',
      rubric_item: null,
    });
  }
  return { items, extraIssues, modelUsed: true, modelChecks };
}

function dedupeIssues(issues) {
  const seen = new Set();
  const result = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

/**
 * Run the rubric. Returns a review artifact and the normalized review object
 * the content chain consumes ({ score, issues, needs_rework, ... }).
 */
export function reviewArticle({
  topic,
  article,
  facts = [],
  sources = [],
  keyFacts = null,
  sourceTexts = null,
  license = { status: 'unauthorized', published: false },
  layout = {},
  mode = 'fake',
  reviewer = DEFAULT_REVIEWER,
  modelReview = null,
  now = Date.now,
} = {}) {
  const texts = textMapOf(sourceTexts);
  const items = [
    checkFactuality({ body: article?.body ?? '', facts, sourceTexts: texts }).item,
    checkSourcing({ facts, sources, keyFacts }).item,
    checkStructure({ article, layout }).item,
    checkReadability({ article }).item,
    checkStyle({ article }).item,
    checkCompliance({ article, license }).item,
  ].map((item) => ({
    ...item,
    weight: RUBRIC_ITEMS.find((definition) => definition.id === item.id)?.weight ?? 0,
  }));

  const applied = applyModelReview(items, modelReview);
  const finalItems = applied.items;
  const globalIssues = [];
  for (const item of finalItems) {
    if (!item.passed) {
      const hasSpecific = item.issues.some((issue) => issue.severity === 'critical');
      if (item.issues.length === 0 || !hasSpecific) {
        item.issues.push({
          code: 'rubric_below_threshold',
          severity: 'warning',
          message: `${item.label}得分 ${item.score}，低于阈值 ${item.threshold}。`,
          rubric_item: item.id,
        });
      }
      globalIssues.push(...item.issues);
    }
  }
  globalIssues.push(...applied.extraIssues);
  const issues = dedupeIssues(globalIssues);
  const critical = issues.some((issue) => issue.severity === 'critical');
  const allPassed = finalItems.every((item) => item.passed);
  // The content chain treats any issue as a rework signal. Keep the reviewer
  // verdict consistent with that: a warning-level issue still means rework.
  const verdict =
    allPassed && !critical && issues.length === 0 && modelReview?.verdict !== 'rework'
      ? 'passed'
      : 'rework';
  const weighted = finalItems.reduce((sum, item) => sum + item.score * item.weight, 0);
  const score = round1(weighted);

  const factItem = finalItems.find((item) => item.id === 'factuality');
  const sourcingItem = finalItems.find((item) => item.id === 'sourcing');
  const unsupportedClaims = factItem?.evidence?.unsupported_claims ?? [];
  const evidence = {
    source_count: asArray(sources).length,
    source_hosts: [...new Set(asArray(sources).map((source) => hostOf(source?.url)).filter(Boolean))],
    source_publishers: sourcingItem?.evidence?.publishers ?? [],
    fact_count: asArray(facts).length,
    key_fact_count: sourcingItem?.evidence?.key_fact_count ?? 0,
    key_facts: sourcingItem?.evidence?.key_facts ?? [],
    checked_sentences: factItem?.evidence?.checked_sentences ?? 0,
    unsupported_claims: unsupportedClaims,
    skipped_opinion_claims: factItem?.evidence?.skipped_opinion_claims ?? [],
    reviewer_model: reviewer?.model ?? null,
    independent_model_used: applied.modelUsed,
    reviewer_checks: applied.modelChecks,
    reviewer_retry_count: Number.isFinite(modelReview?.retry_count)
      ? Math.max(0, Math.trunc(modelReview.retry_count))
      : 0,
    reviewer_repair_attempts: Number.isFinite(modelReview?.repair_attempts)
      ? Math.max(0, Math.trunc(modelReview.repair_attempts))
      : Number.isFinite(modelReview?.retry_count)
        ? Math.max(0, Math.trunc(modelReview.retry_count))
        : 0,
    reviewer_parse_strategy: isNonEmptyString(modelReview?.parse_strategy)
      ? modelReview.parse_strategy
      : null,
  };

  const summary =
    verdict === 'passed'
      ? '审校通过：事实、来源、结构、可读性、文风与合规均达到阈值。'
      : `审校未通过：${finalItems.filter((item) => !item.passed).length} 项未达阈值，${issues.filter((issue) => issue.severity === 'critical').length} 个阻断问题。`;

  const artifact = {
    review_version: REVIEW_VERSION,
    topic,
    mode,
    reviewer: {
      id: reviewer?.id ?? DEFAULT_REVIEWER.id,
      context_id: reviewer?.context_id ?? DEFAULT_REVIEWER.context_id,
      independent: reviewer?.independent !== false,
      model: reviewer?.model ?? DEFAULT_REVIEWER.model,
    },
    verdict,
    needs_rework: verdict === 'rework',
    score,
    rubric: finalItems,
    issues,
    evidence,
    summary,
    generated_at: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
  };

  return {
    ...artifact,
    // The content chain consumes these normalized fields.
    issues,
  };
}
