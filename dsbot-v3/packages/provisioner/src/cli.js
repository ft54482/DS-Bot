import { provision } from './provision.js';
import { removeProvision } from './remove.js';
import { MAX_WORKERS_LIMIT } from './validate.js';

export const USAGE = `Usage:
  dsbot-provisioner --name <profile> --repo <owner/name> --model <model> [options]
  dsbot-provisioner --remove --name <profile> [--remove-state] [--json]

Options:
  --name <profile>            profile / directory name (required)
  --repo <owner/name>         GitHub repository bound to the instance (required)
  --model <model>             executor model id (required)
  --port <auto|number>        port to allocate (default: auto, range 3080-3099)
  --work-root <path>          executor work root (default: ~/.dsh/state/<name>/work)
  --account <login>           policy whitelist account (default: lab agent)
  --max-workers <n>           executor concurrency (default: 4)
  --blocked-commands <cmd>    one blocked command; repeat the flag for more
  --dsh-home <path>           DSH home (default: ~/.dsh)
  --health-check              call the real overview endpoint after writing config
  --remove                    delete the profile directory and registry record
  --remove-state              with --remove, also delete ~/.dsh/state/<name>
  --json                      emit machine-readable JSON
  --help                      show this help
`;

const VALUE_FLAGS = new Map([
  ['name', 'name'],
  ['repo', 'repo'],
  ['port', 'port'],
  ['model', 'model'],
  ['work-root', 'workRoot'],
  ['account', 'account'],
  ['max-workers', 'maxWorkers'],
  ['blocked-commands', 'blockedCommands'],
  ['dsh-home', 'dshHome'],
]);

const BOOLEAN_FLAGS = new Map([
  ['remove', 'remove'],
  ['remove-state', 'removeState'],
  ['health-check', 'healthCheck'],
  ['json', 'json'],
  ['help', 'help'],
]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parsePort(value) {
  if (value === 'auto') return 'auto';
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--port must be \`auto\` or an integer, got: ${value}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new UsageError(`--port must be between 1 and 65535, got: ${value}`);
  }
  return port;
}

function parseMaxWorkers(value) {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--max-workers must be an integer, got: ${value}`);
  }
  const maxWorkers = Number(value);
  if (maxWorkers < 1 || maxWorkers > MAX_WORKERS_LIMIT) {
    throw new UsageError(`--max-workers must be between 1 and ${MAX_WORKERS_LIMIT}, got: ${value}`);
  }
  return maxWorkers;
}

/**
 * Parse argv without touching the process or the file system.
 *
 * @param {string[]} argv
 * @returns {object} options accepted by `provision`/`removeProvision` plus
 *   CLI-only switches (`json`, `help`, `remove`, `removeState`, `healthCheck`)
 */
export function parseArgs(argv) {
  const result = {
    name: undefined,
    repo: undefined,
    port: 'auto',
    model: undefined,
    workRoot: undefined,
    account: undefined,
    maxWorkers: undefined,
    blockedCommands: [],
    dshHome: undefined,
    remove: false,
    removeState: false,
    healthCheck: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new UsageError(`unexpected argument: ${token}`);
    }

    let flag = token.slice(2);
    let inline;
    const equals = flag.indexOf('=');
    if (equals !== -1) {
      inline = flag.slice(equals + 1);
      flag = flag.slice(0, equals);
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) {
        throw new UsageError(`--${flag} does not take a value`);
      }
      result[BOOLEAN_FLAGS.get(flag)] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(`unknown option: --${flag}`);
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${flag} requires a value`);
      }
      index += 1;
      value = next;
    }

    const key = VALUE_FLAGS.get(flag);
    if (key === 'blockedCommands') {
      result.blockedCommands.push(value);
    } else if (key === 'port') {
      result.port = parsePort(value);
    } else if (key === 'maxWorkers') {
      result.maxWorkers = parseMaxWorkers(value);
    } else {
      result[key] = value;
    }
  }

  if (result.help) return result;

  if (!result.name) throw new UsageError('--name is required');
  if (result.remove) {
    if (result.healthCheck) throw new UsageError('--health-check cannot be used with --remove');
    return result;
  }

  if (!result.repo) throw new UsageError('--repo is required');
  if (!result.model) throw new UsageError('--model is required');
  if (result.removeState) throw new UsageError('--remove-state requires --remove');
  return result;
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatProvisioned(result) {
  return [
    `provisioned ${result.name} on port ${result.port}${result.created ? '' : ' (existing)'}`,
    `  profile: ${result.profileDir}`,
    `  state:   ${result.stateDir}`,
    `  work:    ${result.workRoot}`,
    `  health:  ${result.health?.checked ? 'ok' : 'skipped'}`,
  ].join('\n');
}

function formatRemoved(result) {
  if (!result.removed) return `not found: ${result.name} (${result.profileDir})`;
  return [
    `removed ${result.name}`,
    `  profile: ${result.profileDir}`,
    `  state:   ${result.stateDir}${result.stateRemoved ? ' (deleted)' : ' (kept)'}`,
  ].join('\n');
}

/**
 * CLI entry point. All IO comes from `deps`; the bin wires real adapters.
 *
 * @param {string[]} argv
 * @param {{fs: object, probe?: Function, isPortFree?: Function, stdout?: object, stderr?: object, now?: string|Function}} deps
 * @returns {Promise<number>} process exit code (0 ok, 1 runtime error, 2 usage)
 */
export async function runCli(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`provisioner: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  try {
    if (!deps.fs) throw new Error('runCli requires an injected fs adapter');

    if (args.remove) {
      const result = removeProvision({
        name: args.name,
        dshHome: args.dshHome,
        fs: deps.fs,
        removeState: args.removeState,
      });
      if (args.json) writeJson(stdout, { ok: true, ...result });
      else stdout.write(`${formatRemoved(result)}\n`);
      return 0;
    }

    if (args.healthCheck && typeof deps.probe !== 'function') {
      throw new Error('--health-check requires an injected probe adapter');
    }

    const result = await provision({
      name: args.name,
      repo: args.repo,
      port: args.port,
      model: args.model,
      workRoot: args.workRoot,
      account: args.account,
      maxWorkers: args.maxWorkers,
      blockedCommands: args.blockedCommands,
      dshHome: args.dshHome,
      fs: deps.fs,
      probe: args.healthCheck ? deps.probe : undefined,
      isPortFree: deps.isPortFree,
      now: deps.now,
    });

    if (args.json) writeJson(stdout, { ok: true, ...result });
    else stdout.write(`${formatProvisioned(result)}\n`);
    return 0;
  } catch (error) {
    const code = error.code ?? 'failed';
    if (args.json) {
      writeJson(stdout, {
        ok: false,
        code,
        message: error.message,
        details: error.details ?? {},
      });
    } else {
      stderr.write(`provisioner: ${code}: ${error.message}\n`);
    }
    return 1;
  }
}
