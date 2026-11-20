/**
 * Attribution and key-fact rendering for the self-media run harness.
 *
 * The harness supports dual attribution: `publisher` is the original outlet
 * and is what independent sourcing is judged on; `via` names an aggregator
 * (for example AIHOT) that merely carried the item. Source snapshots and key
 * facts are rendered deterministically here so a real-model writer cannot
 * silently omit the evidence the reviewer requires.
 */

import { hostOf, publisherOf } from './retrieval.mjs';

export const MIN_KEY_FACTS = 3;
export const MAX_KEY_FACTS = 6;
export const MAX_SOURCE_SUMMARY_CHARS = 300;

export const KEY_FACTS_HEADING = '## 关键事实';
export const SOURCE_HEADING = '## 来源';

const KEY_FACTS_HEADING_RE = /^##\s*(关键事实|Key\s*facts?)\s*$/i;
const SOURCE_HEADING_RE = /^##\s*(来源|参考|Sources?)\s*$/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedForMatch(value) {
  return String(value ?? '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, '')
    .replace(/[“”「」"'‘’]/g, '');
}

function publisherKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Distinct publisher labels for a fact's source references. */
export function distinctPublisherLabels(refs, sources) {
  const byUrl = new Map(asArray(sources).map((source) => [source.url, source]));
  const byKey = new Map();
  for (const ref of asArray(refs)) {
    if (!isNonEmptyString(ref)) continue;
    const source = byUrl.get(ref) ?? { url: ref };
    const label = publisherOf(source);
    if (!isNonEmptyString(label)) continue;
    const key = publisherKey(label);
    if (!byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()];
}

/**
 * Pick the 3-6 key facts shown at the top of the article. Verified facts with
 * usable source references are preferred; when fewer than three qualify the
 * available facts are used instead of inventing any.
 */
export function selectKeyFacts(facts, sources, { limit = MAX_KEY_FACTS } = {}) {
  const sourceUrls = new Set(asArray(sources).map((source) => source.url));
  const seen = new Set();
  const candidates = [];
  asArray(facts).forEach((fact, index) => {
    const claim = isNonEmptyString(fact?.claim) ? fact.claim.trim() : '';
    if (!claim || seen.has(claim)) return;
    seen.add(claim);
    const refs = [
      ...new Set(
        asArray(fact?.source_refs).filter(
          (ref) => isNonEmptyString(ref) && sourceUrls.has(ref),
        ),
      ),
    ];
    const publishers = distinctPublisherLabels(refs, sources);
    candidates.push({
      claim,
      source_refs: refs,
      index,
      status: fact?.status === 'verified' ? 'verified' : null,
      key: fact?.key === true,
      publishers: publishers.length,
    });
  });
  if (candidates.length === 0) return [];

  const rank = (entry) =>
    (entry.source_refs.length > 0 ? 4 : 0) +
    (entry.status === 'verified' ? 2 : 0) +
    (entry.key ? 1 : 0) +
    (entry.publishers >= 2 ? 1 : 0);
  const sorted = [...candidates].sort((a, b) => rank(b) - rank(a) || a.index - b.index);
  const withRefs = sorted.filter((entry) => entry.source_refs.length > 0);
  const pool = withRefs.length > 0 ? withRefs : sorted;
  const count = Math.min(limit, pool.length);
  return pool.slice(0, count).map(({ claim, source_refs }) => ({ claim, source_refs }));
}

/** Citation markers (`[1][2]`) for a fact, in source-list order. */
export function citationFor(refs, sources) {
  const list = asArray(sources);
  const indexes = [];
  for (const ref of asArray(refs)) {
    const index = list.findIndex((source) => source?.url === ref);
    if (index >= 0) indexes.push(index + 1);
  }
  return [...new Set(indexes)]
    .sort((a, b) => a - b)
    .map((index) => `[${index}]`)
    .join('');
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAttribution(source) {
  const publisher = oneLine(publisherOf(source) || hostOf(source?.url) || '未知来源');
  const via = isNonEmptyString(source?.via) ? oneLine(source.via) : '';
  return via && publisherKey(via) !== publisherKey(publisher)
    ? `${publisher}（via ${via}）`
    : publisher;
}

function boundedSummary(source) {
  const summary = String(source?.excerpt ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!summary) return '（无摘要）';
  return summary.length <= MAX_SOURCE_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, MAX_SOURCE_SUMMARY_CHARS - 1)}…`;
}

/** `[n] 标题 — 原始媒体（via AIHOT）｜快照 sha256:…｜摘要：…｜URL` */
export function renderSourceLine(source, index) {
  const title = oneLine(
    isNonEmptyString(source?.title)
      ? source.title
      : hostOf(source?.url) || String(source?.url ?? ''),
  );
  const sha = isNonEmptyString(source?.sha256) ? source.sha256.trim() : '缺失';
  return `[${index + 1}] ${title} — ${formatAttribution(source)}｜快照 sha256:${sha}｜摘要：${boundedSummary(source)}｜${source?.url ?? ''}`;
}

export function renderSourceLines(sources) {
  return asArray(sources).map((source, index) => renderSourceLine(source, index));
}

export function renderKeyFactLines(keyFacts, sources) {
  if (asArray(keyFacts).length === 0) return [];
  const lines = [KEY_FACTS_HEADING, ''];
  for (const fact of keyFacts) {
    const citations = citationFor(fact.source_refs, sources);
    lines.push(`- ${oneLine(fact.claim)}${citations ? ` ${citations}` : ''}`);
  }
  lines.push('');
  return lines;
}

function appendCitation(text, citation) {
  const match = /^(.*?)(\s*)$/s.exec(text);
  if (!match) return `${text}${citation}`;
  return `${match[1]}${citation}${match[2]}`;
}

/**
 * Append a citation after the sentence that states a key fact, unless the
 * sentence already carries one. Sentence punctuation is preserved.
 */
function addCitationsToLine(line, keyFacts, sources) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^\[\d+\]\s+\S/.test(trimmed)) return line;

  const parts = line.split(/(?<=[。！？!?；;])/);
  let changed = false;
  const updated = parts.map((part, index) => {
    if (!part.trim() || /\[\d+\]/.test(part)) return part;
    // A citation immediately after this sentence already covers it; keep the
    // writer's marker instead of appending a duplicate group.
    if (/^\s*\[\d+\]/.test(parts[index + 1] ?? '')) return part;
    const normalizedPart = normalizedForMatch(part);
    if (!normalizedPart) return part;
    const fact = keyFacts.find((entry) => {
      const claim = normalizedForMatch(entry.claim);
      return claim.length > 0 && normalizedPart.includes(claim);
    });
    if (!fact) return part;
    const citation = citationFor(fact.source_refs, sources);
    if (!citation) return part;
    changed = true;
    return appendCitation(part, citation);
  });
  if (changed) return updated.join('');

  // A claim can straddle the punctuation split; never append a second group
  // when the line already carries a citation.
  if (/\[\d+\]/.test(line)) return line;
  const normalizedLine = normalizedForMatch(line);
  const fact = keyFacts.find((entry) => {
    const claim = normalizedForMatch(entry.claim);
    return claim.length > 0 && normalizedLine.includes(claim);
  });
  if (!fact) return line;
  const citation = citationFor(fact.source_refs, sources);
  return citation ? appendCitation(line, citation) : line;
}

function removeKeyFactsSection(lines) {
  const start = lines.findIndex((line) => KEY_FACTS_HEADING_RE.test(String(line).trim()));
  if (start < 0) return;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() === '') end += 1;
  const bulletStart = end;
  while (end < lines.length && /^-\s+/.test(lines[end].trim())) end += 1;
  if (end > bulletStart) {
    while (end < lines.length && lines[end].trim() === '') end += 1;
    lines.splice(start, end - start);
    return;
  }
  while (end < lines.length && lines[end].trim() === '') end += 1;
  lines.splice(start, end - start);
}

function removeSourceSection(lines) {
  const start = lines.findIndex((line) => SOURCE_HEADING_RE.test(String(line).trim()));
  if (start < 0) return;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s/.test(String(lines[index]).trim())) {
      end = index;
      break;
    }
  }
  lines.splice(start, end - start);
}

function trimTrailingBlankLines(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
}

/**
 * Render the final article body: a key-facts block directly under the H1, a
 * canonical source section with snapshot summaries and sha256, and citations
 * after the sentences that state each selected key fact. Idempotent.
 */
export function enrichArticleBody({ body, keyFacts = [], sources = [] } = {}) {
  const lines = String(body ?? '').split(/\r?\n/);
  removeKeyFactsSection(lines);
  removeSourceSection(lines);

  const cited = lines.map((line) => addCitationsToLine(line, keyFacts, sources));
  trimTrailingBlankLines(cited);

  const keyLines = renderKeyFactLines(keyFacts, sources);
  if (keyLines.length > 0) {
    const h1Index = cited.findIndex((line) => /^#\s+\S/.test(String(line).trim()));
    const insertAt = h1Index >= 0 ? h1Index + 1 : 0;
    cited.splice(insertAt, 0, '', ...keyLines);
  }

  const sourceLines = renderSourceLines(sources);
  if (sourceLines.length > 0) {
    trimTrailingBlankLines(cited);
    cited.push('', SOURCE_HEADING, '', ...sourceLines, '');
  }

  return `${cited.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
