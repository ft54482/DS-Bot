/**
 * Argument parser for the operator CLI.
 *
 * Parsing is deliberately separated from command execution so `runCli` stays a
 * pure function and the accepted grammar is unit-testable without a runtime.
 */
import { cliError } from './errors.js';

export const COMMAND_IDS = Object.freeze([
  'task.create',
  'task.list',
  'task.get',
  'dispatch',
  'accept',
  'stop',
  'cost',
]);

const LEVELS = Object.freeze(['goal', 'business', 'execution']);
const EXECUTOR_KINDS = Object.freeze(['tool_chain', 'dsh_session', 'superagent', 'manual']);
const VERDICTS = Object.freeze(['pass', 'reject']);

const COMMANDS = Object.freeze({
  'task.create': {
    positional: 0,
    positionals: [],
    options: ['level', 'title', 'parent', 'actor'],
    required: ['level', 'title'],
  },
  'task.list': {
    positional: 0,
    positionals: [],
    options: ['level', 'state', 'limit'],
  },
  'task.get': { positional: 1, positionals: ['id'] },
  dispatch: {
    positional: 1,
    positionals: ['id'],
    options: ['executor-kind', 'idempotency-key'],
  },
  accept: {
    positional: 1,
    positionals: ['run'],
    options: ['verdict', 'reason', 'items'],
    required: ['verdict'],
  },
  stop: { positional: 1, positionals: ['id'], options: ['reason', 'requested-by'] },
  cost: { positional: 1, positionals: ['id'] },
});

const GLOBAL_OPTIONS = Object.freeze(['json', 'help']);

export const COMMAND_USAGE = Object.freeze({
  'task.create':
    'task create --level goal|business|execution --title <title> [--parent <task-id>] [--actor <actor>]',
  'task.list': 'task list [--level <level>] [--state <state>] [--limit <n>]',
  'task.get': 'task get <task-id>',
  dispatch:
    'dispatch <task-id> [--executor-kind tool_chain|dsh_session|superagent|manual] [--idempotency-key <key>]',
  accept: 'accept <run-id> --verdict pass|reject [--reason <reason>] [--items <json>]',
  stop: 'stop <task-id> [--reason <reason>] [--requested-by <actor>]',
  cost: 'cost <task-id>',
});

export const GLOBAL_USAGE = Object.freeze([
  'superagent task create --level goal --title "写一篇关于 AI 的文章"',
  'superagent task list --json',
  'superagent task get <task-id>',
  'superagent dispatch <task-id>',
  'superagent accept <run-id> --verdict pass',
  'superagent stop <task-id> --reason user_stop',
  'superagent cost <task-id>',
]);

export function usageText(command = null) {
  if (command && COMMAND_USAGE[command]) {
    return `Usage: superagent ${COMMAND_USAGE[command]}\n`;
  }
  const lines = [
    'superagent — operator CLI',
    '',
    'Usage: superagent <command> [options]',
    '',
    'Commands:',
    `  ${COMMAND_USAGE['task.create']}`,
    `  ${COMMAND_USAGE['task.list']}`,
    `  ${COMMAND_USAGE['task.get']}`,
    `  ${COMMAND_USAGE.dispatch}`,
    `  ${COMMAND_USAGE.accept}`,
    `  ${COMMAND_USAGE.stop}`,
    `  ${COMMAND_USAGE.cost}`,
    '',
    'Global options:',
    '  --json           machine-readable output on stdout (errors on stderr)',
    '  -h, --help       show this help',
    '  -V, --version    show the CLI version',
    '',
    'Examples:',
    ...GLOBAL_USAGE.map((line) => `  ${line}`),
    '',
  ];
  return `${lines.join('\n')}`;
}

export function commandUsageText(command) {
  return usageText(command);
}

export function wantsJson(argv) {
  return Array.isArray(argv) && argv.some((token) => token === '--json');
}

export function wantsHelp(argv) {
  return (
    Array.isArray(argv) &&
    argv.some((token) => token === '--help' || token === '-h' || token === '-V' || token === '--version')
  );
}

function isOptionToken(token) {
  return typeof token === 'string' && token.startsWith('--') && token.length > 2;
}

function splitLongOption(token) {
  const body = token.slice(2);
  const equals = body.indexOf('=');
  if (equals === -1) return { name: body, inlineValue: undefined };
  return { name: body.slice(0, equals), inlineValue: body.slice(equals + 1) };
}

function resolveCommand(positionals) {
  if (positionals.length === 0) {
    throw cliError('validation_error', 'missing command; run "superagent --help" for usage', {});
  }
  const head = positionals[0];
  if (head === 'task') {
    if (positionals.length < 2) {
      throw cliError('validation_error', 'missing task subcommand (create|list|get)', {});
    }
    const sub = positionals[1];
    const id = `task.${sub}`;
    if (!COMMANDS[id]) {
      throw cliError('validation_error', `unknown task subcommand: ${sub}`, { subcommand: sub });
    }
    return { command: id, consumed: 2 };
  }
  if (!COMMANDS[head] || !['dispatch', 'accept', 'stop', 'cost'].includes(head)) {
    throw cliError('validation_error', `unknown command: ${head}`, { command: head });
  }
  return { command: head, consumed: 1 };
}

function parseItems(raw, optionName) {
  if (raw === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw cliError('validation_error', `--${optionName} must be valid JSON`, {
      option: optionName,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cliError('validation_error', `--${optionName} must be a JSON object`, {
      option: optionName,
    });
  }
  return parsed;
}

function requireEnum(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw cliError('validation_error', `--${name} must be one of: ${allowed.join(', ')}`, {
      option: name,
      value,
      allowed,
    });
  }
}

function parseLimit(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw cliError('validation_error', '--limit must be an integer between 1 and 1000', {
      option: 'limit',
      value: raw,
    });
  }
  return value;
}

/**
 * Parse argv into a command descriptor.
 *
 * Throws a `CliError` (validation_error / 422) for grammar and enum failures.
 *
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {{command: string|null, options: object, positional: string[], json: boolean, help: boolean}}
 */
export function parseArgv(argv) {
  if (!Array.isArray(argv)) {
    throw cliError('validation_error', 'argv must be an array', { argv: typeof argv });
  }

  const tokens = argv.map((token) => String(token));
  const positionals = [];
  const flags = {};
  let json = false;
  let help = false;
  let version = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--version' || token === '-V') {
      version = true;
      continue;
    }
    if (isOptionToken(token)) {
      const { name, inlineValue } = splitLongOption(token);
      if (GLOBAL_OPTIONS.includes(name)) {
        if (name === 'json') {
          json = true;
          continue;
        }
        if (name === 'help') {
          help = true;
          continue;
        }
      }
      let value = inlineValue;
      if (value === undefined) {
        const next = tokens[index + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) {
          throw cliError('validation_error', `option --${name} requires a value`, { option: name });
        }
        value = next;
        index += 1;
      }
      if (Object.prototype.hasOwnProperty.call(flags, name)) {
        throw cliError('validation_error', `option --${name} was given more than once`, {
          option: name,
        });
      }
      flags[name] = value;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw cliError('validation_error', `unknown option: ${token}`, { option: token });
    }
    positionals.push(token);
  }

  if (positionals.length === 0 && (help || version)) {
    return { command: null, options: {}, positional: [], json, help, version };
  }

  const resolved = resolveCommand(positionals);
  const spec = COMMANDS[resolved.command];
  if (help || version) {
    return { command: resolved.command, options: {}, positional: [], json, help, version };
  }

  const rest = positionals.slice(resolved.consumed);
  if (rest.length !== spec.positional) {
    throw cliError(
      'validation_error',
      rest.length < spec.positional
        ? `missing argument <${spec.positionals[rest.length] ?? 'argument'}>`
        : `unexpected argument: ${rest[spec.positional]}`,
      { command: resolved.command, expected: spec.positional, got: rest.length },
    );
  }

  const allowed = new Set([...(spec.options ?? []), ...GLOBAL_OPTIONS]);
  for (const name of Object.keys(flags)) {
    if (!allowed.has(name)) {
      throw cliError('validation_error', `unknown option for ${resolved.command}: --${name}`, {
        command: resolved.command,
        option: name,
      });
    }
  }
  for (const name of spec.required ?? []) {
    if (flags[name] === undefined) {
      throw cliError('validation_error', `missing required option --${name}`, {
        command: resolved.command,
        option: name,
      });
    }
  }

  const positional = rest;
  const options = {};

  if (resolved.command === 'task.create') {
    requireEnum('level', flags.level, LEVELS);
    if (flags.title.trim() === '') {
      throw cliError('validation_error', '--title must be a non-empty string', { option: 'title' });
    }
    options.level = flags.level;
    options.title = flags.title;
    options.parent = flags.parent ?? null;
    if (flags.actor !== undefined) options.actor = flags.actor;
  } else if (resolved.command === 'task.list') {
    if (flags.level !== undefined) {
      requireEnum('level', flags.level, LEVELS);
      options.level = flags.level;
    }
    if (flags.state !== undefined) options.state = flags.state;
    if (flags.limit !== undefined) options.limit = parseLimit(flags.limit);
  } else if (resolved.command === 'dispatch') {
    if (flags['executor-kind'] !== undefined) {
      requireEnum('executor-kind', flags['executor-kind'], EXECUTOR_KINDS);
      options.executorKind = flags['executor-kind'];
    }
    if (flags['idempotency-key'] !== undefined) {
      options.idempotencyKey = flags['idempotency-key'];
    }
  } else if (resolved.command === 'accept') {
    requireEnum('verdict', flags.verdict, VERDICTS);
    options.verdict = flags.verdict;
    if (flags.reason !== undefined) options.reason = flags.reason;
    const items = parseItems(flags.items, 'items');
    if (items !== undefined) options.itemStates = items;
  } else if (resolved.command === 'stop') {
    if (flags.reason !== undefined) options.reason = flags.reason;
    if (flags['requested-by'] !== undefined) options.requestedBy = flags['requested-by'];
  }

  return { command: resolved.command, options, positional, json, help: false, version: false };
}
