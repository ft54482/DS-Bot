/**
 * CLI argument parsing for `node tools/selfmedia-run/run.mjs`.
 *
 * The parser is intentionally small and dependency-free. It accepts
 * `--flag value` and `--flag=value`; booleans take no value. Unknown flags are
 * configuration errors so a typo cannot silently change the run mode.
 */

import { ConfigError } from './errors.mjs';

export const MODES = Object.freeze(['fake', 'offline', 'real']);

export const USAGE = `selfmedia-run — self-media article run harness (M2)

Usage:
  node tools/selfmedia-run/run.mjs --topic "<topic>" --out <dir> [options]

Modes:
  --fake                 deterministic offline run with fixture sources (default)
  --offline              read sources from a snapshot/source pack; block if absent
  --real                 use a real model gateway and real retrieval
                         (gateway env needs DSBOT_MODEL_*; gateway bridge needs
                         the DSH bridge secret file)

Options:
  --gateway <env|bridge>  --real model transport (default: env)
                          env    = OpenAI-compatible DSBOT_MODEL_* endpoint + API key
                          bridge = local DSH MCP bridge, no API key; one session per
                                   run is created and reused for writer + reviewer
  --search               real mode: use DSBOT_SEARCH_BASE_URL metadata search
                         (title/summary only; article bodies are never fetched)
  --allow-fulltext       DEBUG ONLY: let --real --search fetch article bodies.
                         Violates product decision D-04; never use for project
                         runs. Off by default.
  --inject-fact-error    inject one unsupported fact for a review drill
  --snapshots <dir>      snapshot directory (sources.json | snapshots.json | source-pack.json)
  --sources <file>       source-pack JSON file (real/offline input)
  --platform <name>      target platform (default: wechat)
  --account <name>       optional account label
  --help                 show this help

D-04: this tool only uses source metadata and summaries. The default path never
requests an article body URL.

Real-mode environment:
  DSBOT_MODEL_BASE_URL, DSBOT_MODEL_API_KEY, DSBOT_MODEL_NAME   (required, gateway env)
  DSBOT_BRIDGE_URL, DSBOT_BRIDGE_SECRET_FILE                    (gateway bridge)
  DSBOT_BRIDGE_MODEL, DSBOT_BRIDGE_PRESET                       (gateway bridge, optional)
  DSBOT_BRIDGE_TIMEOUT_MS                                       (gateway bridge, default 180000)
  DSBOT_SOURCE_PACK_FILE, or --sources/--snapshots              (retrieval)
  DSBOT_SEARCH_BASE_URL (+ optional DSBOT_SEARCH_API_KEY)       (retrieval)
  DSBOT_MODEL_PRICE_INPUT_CNY_PER_1K / ..._OUTPUT_CNY_PER_1K     (cost estimate)
  DSBOT_MODEL_TIMEOUT_MS                                        (optional, gateway env)

Cost note: the bridge is free of an API key, but one DSH session carries the
whole run's context; later prompts in the same session cost progressively more
tokens. The harness creates one session per run and reuses it.

Exit codes: 0 ok, 1 internal error, 2 configuration error, 3 blocked.
The harness never publishes and never prints DSBOT_MODEL_API_KEY or the bridge
secret. The bridge secret is read from a file only and is only sent in the
Authorization: Bearer header.
`;

const VALUE_FLAGS = new Set([
  'topic',
  'out',
  'snapshots',
  'sources',
  'platform',
  'account',
  'gateway',
]);

const BOOLEAN_FLAGS = new Set([
  'fake',
  'offline',
  'real',
  'search',
  'allow-fulltext',
  'inject-fact-error',
  'help',
]);

function normalizeTrustedFlag(raw) {
  return raw.replace(/_/g, '-');
}

/**
 * @param {string[]} argv
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [context]
 * @returns {{
 *   topic: string|null,
 *   out: string|null,
 *   mode: 'fake'|'offline'|'real',
 *   gateway: 'env'|'bridge',
 *   injectFactError: boolean,
 *   search: boolean,
 *   allowFulltext: boolean,
 *   snapshots: string|null,
 *   sources: string|null,
 *   platform: string,
 *   account: string|null,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv = [], { cwd = process.cwd(), env = process.env } = {}) {
  const values = {
    topic: null,
    out: null,
    snapshots: null,
    sources: null,
    platform: 'wechat',
    account: null,
    gateway: 'env',
  };
  const booleans = {
    fake: false,
    offline: false,
    real: false,
    search: false,
    'allow-fulltext': false,
    'inject-fact-error': false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || token === '') {
      throw new ConfigError('empty argument is not allowed');
    }
    if (!token.startsWith('--')) {
      throw new ConfigError(`unexpected positional argument: ${token}`);
    }

    const eq = token.indexOf('=');
    const rawName = (eq >= 0 ? token.slice(2, eq) : token.slice(2));
    const name = normalizeTrustedFlag(rawName);
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : null;

    if (name in booleans) {
      if (inlineValue !== null) {
        throw new ConfigError(`flag --${name} does not take a value`);
      }
      booleans[name] = true;
      continue;
    }

    if (name in values) {
      let value = inlineValue;
      if (value === null) {
        value = argv[index + 1];
        if (typeof value !== 'string' || value.startsWith('--')) {
          throw new ConfigError(`flag --${name} requires a value`);
        }
        index += 1;
      }
      if (value.trim() === '') {
        throw new ConfigError(`flag --${name} requires a non-empty value`);
      }
      values[name] = value.trim();
      continue;
    }

    throw new ConfigError(`unknown flag: ${token}`, {
      hint: 'run with --help to see supported flags',
    });
  }

  const selected = MODES.filter((mode) => booleans[mode]);
  if (selected.length > 1) {
    throw new ConfigError(`choose exactly one mode; got: ${selected.map((m) => `--${m}`).join(', ')}`);
  }

  const mode = selected[0] ?? 'fake';
  if (values.gateway !== 'env' && values.gateway !== 'bridge') {
    throw new ConfigError(`--gateway must be env or bridge; got: ${values.gateway}`);
  }
  if (values.gateway === 'bridge' && mode !== 'real') {
    throw new ConfigError('--gateway bridge is only valid with --real', {
      hint: 'the bridge replaces the real-mode model endpoint; fake/offline never call a model',
    });
  }
  if (booleans.search && mode !== 'real') {
    throw new ConfigError('--search is only valid with --real', {
      hint: 'metadata search needs the --real mode and DSBOT_SEARCH_BASE_URL',
    });
  }
  if (booleans['allow-fulltext'] && !booleans.search) {
    throw new ConfigError('--allow-fulltext is only valid with --real --search', {
      hint: 'it is a debug-only escape hatch; the default path never fetches article bodies (D-04)',
    });
  }
  let snapshots = values.snapshots;
  let sources = values.sources;
  if (snapshots && sources) {
    throw new ConfigError('use either --snapshots or --sources, not both');
  }
  if (booleans.search && (snapshots || sources)) {
    throw new ConfigError('--search uses DSBOT_SEARCH_BASE_URL; do not pass --snapshots or --sources');
  }

  // A source pack can be supplied through the environment in real/offline mode.
  if (!booleans.search && !snapshots && !sources && env.DSBOT_SOURCE_PACK_FILE?.trim()) {
    sources = env.DSBOT_SOURCE_PACK_FILE.trim();
  }

  return {
    topic: values.topic,
    out: values.out,
    mode,
    gateway: values.gateway,
    injectFactError: booleans['inject-fact-error'],
    search: booleans.search,
    allowFulltext: booleans['allow-fulltext'],
    snapshots,
    sources,
    platform: values.platform || 'wechat',
    account: values.account,
    help: booleans.help,
  };
}

export function requireRunInputs(options) {
  if (!options.topic || options.topic.trim() === '') {
    throw new ConfigError('--topic is required', { hint: 'example: --topic "测试选题"' });
  }
  if (!options.out || options.out.trim() === '') {
    throw new ConfigError('--out is required', { hint: 'example: --out .tmp/selfmedia-run' });
  }
  if (options.mode === 'offline' && options.snapshots && options.sources) {
    throw new ConfigError('offline mode accepts either --snapshots or --sources, not both');
  }
}
