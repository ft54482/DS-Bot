import path from 'node:path';
import { ProvisionError } from './errors.js';
import { resolvePaths } from './paths.js';
import {
  listReservations,
  readManifest,
  readRegistry,
  upsertInstance,
  writeRegistry,
} from './registry.js';
import { toYaml } from './yaml.js';
import {
  assertAccount,
  assertFs,
  assertModel,
  assertName,
  assertRepo,
  normalizeBlockedCommands,
  normalizeDshHome,
  normalizeIsPortFree,
  normalizeMaxWorkers,
  normalizeNow,
  normalizePort,
  normalizeProbe,
  normalizeWorkRoot,
} from './validate.js';

export { DEFAULT_MAX_WORKERS } from './validate.js';

/** Port pool used when `port` is `auto`. Includes the lab's 3082/3084/3086. */
export const PORT_RANGE = Object.freeze({ min: 3080, max: 3099 });

/**
 * Default GitHub account trusted by the generated policy. It matches the lab's
 * executor account (`packages/adapters/src/superagent.js` uses the same
 * teammate default); callers on another deployment pass `account`.
 */
export const DEFAULT_AGENT_ACCOUNT = 'yuxianghan-droid';

/**
 * The `prepare` command written into executor settings. It uses the runtime
 * variables DSH already injects into every ticket directory:
 * `$DSH_SUPERAGENT_NAME` (branch suffix) and `$DSH_SUPERAGENT_DIR` (worktree).
 */
export const PREPARE_SCRIPT =
  'git fetch origin main && git worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" origin/main';

function buildSettings({ model, maxWorkers, workRoot, blockedCommands, repo, account }) {
  return {
    executor: {
      model,
      maxWorkers,
      directory: workRoot,
      prepare: PREPARE_SCRIPT,
      blockedCommands: [...blockedCommands],
    },
    policy: {
      sources: {
        github: {
          repository: repo,
          owner: repo.split('/')[0],
          account,
          allowed: [account],
        },
      },
    },
  };
}

function buildCordisPatch({ port, stateDir, repo, account, model }) {
  return {
    webserver: { port },
    'dsh-superagent': {
      stateDir,
      repository: repo,
      account,
    },
    executor: { model },
  };
}

function existingResult(manifest, paths) {
  return {
    name: manifest.name,
    repo: manifest.repo,
    account: manifest.account,
    port: manifest.port,
    profileDir: paths.profileDir,
    stateDir: manifest.stateDir ?? paths.stateDir,
    workRoot: manifest.workRoot ?? paths.workRoot,
    cordisPatch: manifest.cordisPatch,
    prepareScript: manifest.prepareScript,
    settings: manifest.settings,
    created: false,
    existing: true,
    health: { ok: true, checked: false, skipped: true },
  };
}

async function portIsFree(isPortFree, port) {
  try {
    return (await isPortFree(port)) === true;
  } catch {
    // A port probe that cannot answer must not be treated as free.
    return false;
  }
}

async function choosePort({ requested, name, reservations, isPortFree }) {
  if (requested !== 'auto') {
    const holder = reservations.find((item) => item.port === requested && item.name !== name);
    if (holder) {
      throw new ProvisionError('port_taken', `port ${requested} is already assigned to ${holder.name}`, {
        port: requested,
        holder: holder.name,
      });
    }
    if (isPortFree && !(await portIsFree(isPortFree, requested))) {
      throw new ProvisionError('port_taken', `port ${requested} is not free`, {
        port: requested,
        reason: 'not_free',
      });
    }
    return requested;
  }

  for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port += 1) {
    if (reservations.some((item) => item.port === port && item.name !== name)) continue;
    if (isPortFree && !(await portIsFree(isPortFree, port))) continue;
    return port;
  }
  throw new ProvisionError(
    'port_exhausted',
    `no free port in ${PORT_RANGE.min}-${PORT_RANGE.max}`,
    { range: { ...PORT_RANGE } },
  );
}

/**
 * Run the injected health probe. A probe returns `true`, `{ok: true}` or
 * `{ok: false, reason}`; a thrown error is a failed check, never a pass.
 * Omitting `probe` records `checked: false` and is reported as skipped.
 */
async function runProbe(probe, context) {
  if (!probe) return { ok: true, checked: false, skipped: true };

  let raw;
  try {
    raw = await probe(context);
  } catch (error) {
    return { ok: false, checked: true, reason: error?.message ?? String(error) };
  }

  if (raw === true) return { ok: true, checked: true };
  if (raw && typeof raw === 'object') {
    if (raw.ok === true) return { ...raw, ok: true, checked: true };
    return {
      ...raw,
      ok: false,
      checked: true,
      reason: raw.reason ?? raw.message ?? 'probe reported not ready',
    };
  }
  return { ok: false, checked: true, reason: 'probe returned no health result' };
}

function removeCreatedDirs(fs, createdDirs) {
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.remove(dir);
    } catch {
      // Best effort during rollback; the original failure is more useful.
    }
  }
}

function restoreRegistry(fs, registryPath, snapshot) {
  try {
    if (snapshot === null) {
      if (fs.exists(registryPath)) fs.remove(registryPath);
      const parent = path.dirname(registryPath);
      if (fs.exists(parent) && fs.list(parent).length === 0) fs.remove(parent);
      return;
    }
    fs.writeFile(registryPath, snapshot);
  } catch {
    // Best effort; the failure being reported happened before/at the write.
  }
}

/**
 * Create (or return) one SuperAgent instance.
 *
 * @param {object} options
 * @param {string} options.name              profile name, also the directory name
 * @param {string} options.repo              `owner/name`
 * @param {number|'auto'} [options.port]     default `auto`
 * @param {string} options.model             executor model id
 * @param {string} [options.workRoot]        default `<dshHome>/state/<name>/work`
 * @param {string} [options.account]         policy whitelist account; defaults to the lab agent
 * @param {number} [options.maxWorkers]      default 4
 * @param {string|string[]} [options.blockedCommands]
 * @param {string} [options.dshHome]         default `<fs.homedir()>/.dsh`
 * @param {object} options.fs                injected file-system adapter
 * @param {Function} [options.probe]         injected health probe
 * @param {Function} [options.isPortFree]    optional live port check (async ok)
 * @param {string|Function} [options.now]    deterministic timestamp for manifests
 * @returns {Promise<object>} `{profileDir, cordisPatch, prepareScript, settings, ...}`
 */
export async function provision(options = {}) {
  const fs = assertFs(options.fs);
  const name = assertName(options.name);
  const repo = assertRepo(options.repo);
  const account = assertAccount(options.account ?? DEFAULT_AGENT_ACCOUNT);
  const model = assertModel(options.model);
  const maxWorkers = normalizeMaxWorkers(options.maxWorkers);
  const blockedCommands = normalizeBlockedCommands(options.blockedCommands);
  const requestedPort = normalizePort(options.port);
  const probe = normalizeProbe(options.probe);
  const isPortFree = normalizeIsPortFree(options.isPortFree);
  const now = normalizeNow(options.now);
  const dshHome = normalizeDshHome(options.dshHome);
  const workRoot = normalizeWorkRoot(options.workRoot);
  const paths = resolvePaths({ name, dshHome, workRoot, fs });

  // Idempotency: a provisioner-managed profile with this name is returned
  // as-is. No duplicate files, process or registry entry are created.
  const existing = readManifest(fs, paths.manifestPath);
  if (existing) {
    if (existing.name !== name) {
      throw new ProvisionError('profile_corrupt', `manifest name does not match profile: ${paths.manifestPath}`, {
        path: paths.manifestPath,
        expected: name,
        actual: existing.name,
      });
    }
    return existingResult(existing, paths);
  }

  // An unmanaged profile directory may belong to the operator (for example
  // the hand-built `superagent-lab` profile). Fail closed instead of
  // overwriting it with generated config.
  if (fs.exists(paths.profileDir)) {
    throw new ProvisionError(
      'profile_exists',
      `profile directory exists but is not provisioner-managed: ${paths.profileDir}`,
      { path: paths.profileDir },
    );
  }

  const reservations = listReservations(fs, paths);
  const port = await choosePort({ requested: requestedPort, name, reservations, isPortFree });

  const settings = buildSettings({ model, maxWorkers, workRoot: paths.workRoot, blockedCommands, repo, account });
  const cordisPatch = buildCordisPatch({ port, stateDir: paths.stateDir, repo, account, model });

  const createdDirs = [];
  if (!fs.exists(paths.stateDir)) createdDirs.push(paths.stateDir);
  if (paths.workRoot !== paths.stateDir && !fs.exists(paths.workRoot)) createdDirs.push(paths.workRoot);

  const registrySnapshot = fs.exists(paths.registryPath) ? fs.readFile(paths.registryPath) : null;
  let profileDirCreated = false;
  let failed = true;
  try {
    fs.mkdir(paths.profileDir);
    profileDirCreated = true;
    fs.writeFile(paths.cordisPatchPath, toYaml(cordisPatch));
    fs.mkdir(paths.stateDir);
    fs.mkdir(paths.workRoot);

    const health = await runProbe(probe, {
      name,
      repo,
      account,
      port,
      profileDir: paths.profileDir,
      stateDir: paths.stateDir,
      workRoot: paths.workRoot,
      settings,
      url: `http://127.0.0.1:${port}`,
    });
    if (!health.ok) {
      throw new ProvisionError('not_ready', `health check failed: ${health.reason}`, {
        reason: health.reason,
        port,
        probe: health,
      });
    }

    const manifest = {
      version: 1,
      name,
      repo,
      account,
      port,
      model,
      maxWorkers,
      blockedCommands,
      profileDir: paths.profileDir,
      stateDir: paths.stateDir,
      workRoot: paths.workRoot,
      prepareScript: PREPARE_SCRIPT,
      cordisPatch,
      settings,
      createdAt: now,
    };
    fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const registry = readRegistry(fs, paths.registryPath);
    writeRegistry(
      fs,
      paths.registryPath,
      upsertInstance(registry, {
        name,
        port,
        repo,
        account,
        profileDir: paths.profileDir,
        stateDir: paths.stateDir,
        workRoot: paths.workRoot,
        model,
        createdAt: now,
      }),
    );

    failed = false;
    return {
      name,
      repo,
      account,
      port,
      profileDir: paths.profileDir,
      stateDir: paths.stateDir,
      workRoot: paths.workRoot,
      cordisPatch,
      prepareScript: PREPARE_SCRIPT,
      settings,
      created: true,
      existing: false,
      health,
    };
  } finally {
    if (failed) {
      removeCreatedDirs(fs, createdDirs);
      if (profileDirCreated) {
        try {
          fs.remove(paths.profileDir);
        } catch {
          // Best effort.
        }
      }
      restoreRegistry(fs, paths.registryPath, registrySnapshot);
    }
  }
}
