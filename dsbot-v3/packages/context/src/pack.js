import {
  CLOSED_QUESTION_STATES,
  LEVELS,
  TASK_PACK_TRIM_ORDER,
} from './constants.js';
import {
  measurePack,
  resolveBudget,
  resolveTokenCounter,
} from './budget.js';
import { buildIdentity } from './identity.js';
import { buildPointers } from './pointers.js';
import { buildTaskPack } from './task-pack.js';
import {
  cloneValue,
  firstString,
  isRecord,
  toList,
  toStringList,
} from './normalize.js';

const CLOSED_STATES = new Set(CLOSED_QUESTION_STATES);

/**
 * Assemble one level's context pack within its hard token budget.
 *
 * Contract:
 *
 *   buildContextPack({ level, task, recent, budgets, open_questions?, countTokens? })
 *     -> { identity, task_pack, recent, open_questions, pointers }
 *
 * The function is pure: it performs no I/O, reads no ambient clock and never
 * mutates its input. `countTokens(text)` is injectable; the default is a
 * deterministic UTF-8-bytes-per-four estimate. Every budget decision measures
 * the entire serialized pack with that same counter.
 *
 * Trimming order is fixed: recent dialogue (oldest first), then open questions
 * (lowest priority first), then optional task-pack fields. Required task-pack
 * fields are never removed; if they alone exceed the budget a RangeError says
 * the configured budget is impossible.
 */
export function buildContextPack(input = {}) {
  if (!isRecord(input)) {
    throw new TypeError('buildContextPack requires an input object');
  }

  const {
    level,
    task,
    recent: recentInput,
    budgets,
    open_questions: openQuestionsInput,
  } = input;
  if (!LEVELS.includes(level)) {
    throw new TypeError(`\`level\` must be one of ${LEVELS.join(', ')}`);
  }
  if (!isRecord(task)) {
    throw new TypeError('buildContextPack requires a task object');
  }

  const countTokens = resolveTokenCounter(input.countTokens);
  const identity = buildIdentity(level, task);
  const taskPack = buildTaskPack(level, task);
  const recent = normalizeRecent(recentInput);
  const openQuestions = normalizeOpenQuestions(
    openQuestionsInput ??
      task.open_questions ??
      task.openQuestions ??
      task.escalations ??
      task.needs_decision,
  );
  const pointers = buildPointers(task, openQuestions);
  const budget = resolveBudget(level, budgets);

  const pack = {
    identity,
    task_pack: taskPack,
    recent,
    open_questions: openQuestions,
    pointers,
  };

  let total = measurePack(pack, countTokens);

  // 1. Recent dialogue: keep the newest turns, drop the oldest first.
  while (pack.recent.length > 0 && total > budget.limit) {
    pack.recent.shift();
    total = measurePack(pack, countTokens);
  }

  // 2. Open questions: input order is priority order; drop the least
  //    important tail first.
  while (pack.open_questions.length > 0 && total > budget.limit) {
    pack.open_questions.pop();
    total = measurePack(pack, countTokens);
  }

  // 3. Optional task-pack fields. Required fields and conclusions stay.
  for (const field of TASK_PACK_TRIM_ORDER) {
    if (total <= budget.limit) break;
    if (Object.hasOwn(pack.task_pack, field)) {
      delete pack.task_pack[field];
      total = measurePack(pack, countTokens);
    }
  }

  if (total > budget.limit) {
    throw new RangeError(
      `context budget ${budget.limit} is too small for the required ${level} pack ` +
        `(${total} tokens with optional content removed)`,
    );
  }

  return pack;
}

function normalizeRecent(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [{ role: 'user', text: value.trim() }];
  }

  let list = value;
  if (
    isRecord(value) &&
    (value.messages !== undefined ||
      value.turns !== undefined ||
      value.items !== undefined)
  ) {
    list = value.messages ?? value.turns ?? value.items;
  } else if (isRecord(value) && isMessageRecord(value)) {
    list = [value];
  }

  const recent = [];
  for (const entry of toList(list, 'recent')) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') recent.push({ role: 'user', text: entry.trim() });
      continue;
    }
    if (!isRecord(entry)) continue;

    const text = firstString(
      entry.text,
      entry.content,
      entry.summary,
      entry.message,
      entry.body,
    );
    if (text === null) continue;

    const message = {
      role: firstString(entry.role, entry.from, entry.speaker, 'user'),
      text,
    };
    const at = entry.at ?? entry.created_at ?? entry.createdAt ?? entry.timestamp;
    if (at !== undefined && at !== null) message.at = cloneValue(at);
    const id = firstString(entry.id, entry.message_id, entry.messageId);
    if (id !== null) message.id = id;
    recent.push(message);
  }
  return recent;
}

function isMessageRecord(value) {
  return (
    value.text !== undefined ||
    value.content !== undefined ||
    value.summary !== undefined ||
    value.message !== undefined ||
    value.body !== undefined
  );
}

function normalizeOpenQuestions(value) {
  if (value === undefined || value === null) return [];

  let list;
  if (typeof value === 'string') {
    list = [value];
  } else if (Array.isArray(value)) {
    list = value;
  } else if (
    isRecord(value) &&
    (value.question !== undefined ||
      value.summary !== undefined ||
      value.detail !== undefined ||
      value.title !== undefined ||
      value.text !== undefined)
  ) {
    list = [value];
  } else {
    list = toList(value, 'open_questions');
  }

  const questions = [];
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text !== '' && !seen.has(text)) {
        seen.add(text);
        questions.push({ question: text });
      }
      continue;
    }
    if (!isRecord(entry)) continue;

    const state = firstString(entry.state, entry.status);
    if (state !== null && CLOSED_STATES.has(state.toLowerCase())) continue;

    const question = firstString(
      entry.question,
      entry.summary,
      entry.detail,
      entry.title,
      entry.text,
    );
    if (question === null) continue;

    const id = firstString(entry.id, entry.escalation_id, entry.escalationId);
    const key = id ?? question;
    if (seen.has(key)) continue;
    seen.add(key);

    const normalized = {};
    if (id !== null) normalized.id = id;
    normalized.question = question;
    const kind = firstString(entry.kind, entry.type);
    if (kind !== null) normalized.kind = kind;
    const taskId = firstString(entry.task_id, entry.taskId);
    if (taskId !== null) normalized.task_id = taskId;
    const options = toStringList(entry.options ?? entry.choices);
    if (options.length > 0) normalized.options = options;
    questions.push(normalized);
  }
  return questions;
}
