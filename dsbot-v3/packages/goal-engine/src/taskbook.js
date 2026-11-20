import { ERROR_CODES, SECTION_TITLES } from './constants.js';
import { goalError } from './errors.js';
import { FULL_SHA, isPlainObject } from './normalize.js';

function fail(message, details) {
  throw goalError(ERROR_CODES.invalidTaskBook, message, details);
}

function sectionError(lane, section, reason) {
  const suffix = lane === null ? '' : ` for lane "${lane}"`;
  fail(`invalid task book${suffix}: ${section} ${reason}`, { lane, section, reason });
}

function checkText(value, lane, section) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    sectionError(lane, section, 'must be a non-empty string');
  }
  return value.trim();
}

function checkList(value, lane, section) {
  if (!Array.isArray(value) || value.length === 0) {
    sectionError(lane, section, 'must be a non-empty array');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      sectionError(lane, section, `item ${index} must be a non-empty string`);
    }
    return item.trim();
  });
}

/**
 * Validate the six mandatory sections of a task book. Throws
 * `invalid_task_book` with `{lane, section, reason}` on the first defect.
 * Returns the same book so callers can chain.
 */
export function validateTaskBook(book, { lane = null } = {}) {
  if (!isPlainObject(book)) {
    sectionError(lane, 'taskBook', 'must be an object');
  }

  checkText(book.background, lane, 'background');
  checkList(book.allowedPaths, lane, 'allowedPaths');

  if (!isPlainObject(book.workBase)) {
    sectionError(lane, 'workBase', 'must be an object with a base sha');
  }
  if (typeof book.workBase.sha !== 'string' || !FULL_SHA.test(book.workBase.sha.trim())) {
    sectionError(lane, 'workBase', 'sha must be a 40-character hexadecimal commit sha');
  }
  if (book.workBase.ref !== undefined) {
    checkText(book.workBase.ref, lane, 'workBase.ref');
  }

  checkList(book.forbidden, lane, 'forbidden');
  checkList(book.acceptanceCommands, lane, 'acceptanceCommands');

  if (!Number.isInteger(book.minCases) || book.minCases < 1) {
    sectionError(lane, 'minCases', 'must be a positive integer');
  }

  return book;
}

/**
 * Render a validated task book as Markdown with exactly the six required
 * section headings, in the canonical order.
 */
export function renderTaskBook(book) {
  validateTaskBook(book);
  const lines = [
    `## ${SECTION_TITLES.background}`,
    book.background,
    '',
    `## ${SECTION_TITLES.allowedPaths}`,
    ...book.allowedPaths.map((path) => `- \`${path}\``),
    '',
    `## ${SECTION_TITLES.workBase}`,
    `- base = \`${book.workBase.sha}\``,
    ...(book.workBase.ref === undefined ? [] : [`- ref = \`${book.workBase.ref}\``]),
    '',
    `## ${SECTION_TITLES.forbidden}`,
    ...book.forbidden.map((item) => `- ${item}`),
    '',
    `## ${SECTION_TITLES.acceptanceCommands}`,
    ...book.acceptanceCommands.map((command) => `- \`${command}\``),
    '',
    `## ${SECTION_TITLES.minCases}`,
    `- ${book.minCases}`,
  ];
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Default injectable template. It receives the normalized context and returns
 * the six sections; validation happens after, so a custom template that omits
 * a section fails with `invalid_task_book` instead of producing a partial doc.
 */
export function defaultTemplate(context) {
  const { goal, lane, milestone, prd, baseSha } = context;
  const references = prd.map((entry) => `- ${entry.id} ${entry.title} (${entry.path})`);
  const background = [
    `目标：${goal.title}`,
    `背景：${lane.background.length > 0 ? lane.background : goal.background.length > 0 ? goal.background : `实现目标「${goal.title}」的 ${lane.lane} 部分。`}`,
    `里程碑：${milestone.title}`,
    `负责 lane：${lane.lane}`,
    ...(references.length > 0 ? ['PRD 参考：', ...references] : []),
  ].join('\n');

  return {
    background,
    allowedPaths: [...lane.allowedPaths],
    workBase: {
      sha: baseSha,
      ref: lane.baseRef,
    },
    forbidden: [...lane.forbidden],
    acceptanceCommands: [...lane.acceptanceCommands],
    minCases: lane.minCases,
  };
}

export function resolveTemplate(template) {
  if (template === undefined || template === null) return defaultTemplate;
  if (typeof template === 'function') return template;
  if (isPlainObject(template) && typeof template.render === 'function') {
    return (context) => template.render(context);
  }
  throw goalError(ERROR_CODES.invalidInput, 'template must be a function or an object with render(context)', {
    received: typeof template,
  });
}

/**
 * Validate the draft produced by a template, attach the rendered Markdown and
 * return the final task book. The six validated fields are copied so a
 * template cannot return a getter that changes between reads.
 */
export function finalizeTaskBook(draft, lane) {
  if (!isPlainObject(draft)) {
    sectionError(lane, 'taskBook', 'template must return an object');
  }
  const book = {
    background: draft.background,
    allowedPaths: draft.allowedPaths,
    workBase: draft.workBase,
    forbidden: draft.forbidden,
    acceptanceCommands: draft.acceptanceCommands,
    minCases: draft.minCases,
  };
  validateTaskBook(book, { lane });
  return { ...book, markdown: renderTaskBook(book) };
}
