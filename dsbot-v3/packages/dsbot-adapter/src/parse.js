import { LEAPFROG_COMMANDS, USAGE } from './constants.js';

/**
 * Parse the DS Bot command text without touching any injected dependency.
 *
 * The parser only answers "what was asked?"; the adapter decides whether it is
 * allowed and which tool to call. Every `missing_argument` result names the
 * exact argument so the receipt can point at it.
 */

const MAX_LABEL = 80;

function label(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 3)}...` : text;
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) return text.slice(1, -1).trim();
  }
  return text;
}

/** Split one whitespace-delimited token off the front, preserving the rest. */
function splitOnce(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return { value: match[1], rest: (match[2] ?? '').trim() };
}

function missing(command, argument, args = {}, raw = '') {
  return {
    kind: 'missing_argument',
    command,
    argument,
    args,
    usage: USAGE[command] ?? USAGE.goal,
    raw,
  };
}

function invalid(command, argument, value, args = {}, raw = '', reason = 'invalid value') {
  return {
    kind: 'invalid_argument',
    command,
    argument,
    value: label(value),
    reason,
    args,
    usage: USAGE[command] ?? USAGE.goal,
    raw,
  };
}

function parseGoalNew(raw, rest) {
  let source = rest;
  let budgetCny = null;

  // A flag token is `--budget` at the start or after whitespace. Support both
  // `--budget 30` and `--budget=30`, and keep the rest of the text as title.
  const flags = [...source.matchAll(/(^|\s)--budget(?=\s|=|$)/g)];
  if (flags.length > 1) {
    return invalid('goal.new', 'budget', '--budget', {}, raw, '--budget may appear only once');
  }

  if (flags.length === 1) {
    const match = flags[0];
    const start = match.index + match[1].length;
    let cursor = start + '--budget'.length;
    if (source[cursor] === '=') cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const withoutFlag = `${source.slice(0, start)} ${source.slice(cursor)}`;
    const valueMatch = /^\S+/.exec(source.slice(cursor));
    if (!valueMatch) {
      return missing('goal.new', 'budget', { title: titleOf(withoutFlag) }, raw);
    }
    const valueText = valueMatch[0];
    if (valueText.startsWith('--')) {
      return missing('goal.new', 'budget', { title: titleOf(withoutFlag) }, raw);
    }
    const parsed = Number(valueText);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return invalid(
        'goal.new',
        'budget',
        valueText,
        { title: titleOf(source) },
        raw,
        'budget must be a non-negative number',
      );
    }
    budgetCny = parsed;
    source = `${source.slice(0, start)} ${source.slice(cursor + valueText.length)}`;
  }

  const title = titleOf(source);
  const args = { title };
  if (budgetCny !== null) args.budgetCny = budgetCny;
  if (title === '') return missing('goal.new', 'title', args, raw);
  return { kind: 'command', command: 'goal.new', args, raw };
}

function titleOf(value) {
  return unquote(String(value ?? '').replace(/\s+/g, ' ').trim());
}

function parseGoal(raw, rest) {
  if (rest === '') return missing('goal', 'action', {}, raw);
  const head = splitOnce(rest);
  const subcommand = head.value.toLowerCase();
  if (subcommand === 'new') return parseGoalNew(raw, head.rest);
  if (subcommand === 'status') {
    if (head.rest === '') return missing('goal.status', 'id', {}, raw);
    const id = splitOnce(head.rest);
    return {
      kind: 'command',
      command: 'goal.status',
      args: { goalId: unquote(id.value) },
      raw,
    };
  }
  return { kind: 'unknown_command', command: `goal ${label(subcommand)}`, subcommand, raw };
}

function parseDelegate(raw, rest) {
  const goal = splitOnce(rest);
  if (!goal) return missing('delegate', 'goalId', {}, raw);
  const goalId = unquote(goal.value);
  const bot = splitOnce(goal.rest);
  if (!bot) return missing('delegate', 'bot', { goalId }, raw);
  const botName = unquote(bot.value);
  if (bot.rest === '') return missing('delegate', 'brief', { goalId, bot: botName }, raw);
  return {
    kind: 'command',
    command: 'delegate',
    args: { goalId, bot: botName, brief: unquote(bot.rest) },
    raw,
  };
}

function parseSingleId(raw, rest, command, argument, field) {
  if (rest === '') return missing(command, argument, {}, raw);
  const token = splitOnce(rest);
  return {
    kind: 'command',
    command,
    args: { [field]: unquote(token.value) },
    raw,
  };
}

export function parseInvocation(text) {
  if (typeof text !== 'string') return missing('input', 'text', {}, '');
  const raw = text.trim();
  if (raw === '') return missing('input', 'text', {}, raw);

  if (!raw.startsWith('/')) {
    return { kind: 'unknown_command', command: 'text', raw };
  }

  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(raw);
  if (!match) return { kind: 'unknown_command', command: 'text', raw };
  const name = match[1].toLowerCase();
  const rest = (match[2] ?? '').trim();

  if (name === 'help') return { kind: 'help', command: 'help', raw };
  if (LEAPFROG_COMMANDS.includes(name)) {
    return {
      kind: 'leapfrog',
      command: name,
      args: rest === '' ? {} : { text: rest },
      raw,
    };
  }
  if (name === 'goal') return parseGoal(raw, rest);
  if (name === 'delegate') return parseDelegate(raw, rest);
  if (name === 'deliver') return parseSingleId(raw, rest, 'deliver', 'goalId', 'goalId');
  if (name === 'stop') return parseSingleId(raw, rest, 'stop', 'id', 'taskId');
  return { kind: 'unknown_command', command: name, raw };
}
