import path from 'node:path';
import { ProvisionError } from './errors.js';

export const REGISTRY_VERSION = 1;

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: [] };
}

/**
 * The registry is advisory metadata for port allocation and cleanup. An
 * unreadable registry is treated as an error instead of being overwritten:
 * silently discarding it could hand out an already-assigned port.
 */
export function readRegistry(fs, registryPath) {
  if (!fs.exists(registryPath)) return emptyRegistry();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFile(registryPath));
  } catch (error) {
    throw new ProvisionError('registry_corrupt', `registry is not valid JSON: ${registryPath}`, {
      path: registryPath,
      cause: error.message,
    });
  }
  if (!parsed || !Array.isArray(parsed.instances)) {
    throw new ProvisionError('registry_corrupt', `registry has no instances array: ${registryPath}`, {
      path: registryPath,
    });
  }
  return parsed;
}

export function writeRegistry(fs, registryPath, registry) {
  fs.mkdir(path.dirname(registryPath));
  fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

export function upsertInstance(registry, record) {
  const instances = registry.instances.filter((item) => item?.name !== record.name);
  instances.push(record);
  instances.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { version: REGISTRY_VERSION, instances };
}

export function removeInstance(registry, name) {
  return {
    version: REGISTRY_VERSION,
    instances: registry.instances.filter((item) => item?.name !== name),
  };
}

/** Read and shape-check a provisioner manifest; `null` when it does not exist. */
export function readManifest(fs, manifestPath) {
  if (!fs.exists(manifestPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFile(manifestPath));
  } catch (error) {
    throw new ProvisionError('profile_corrupt', `instance manifest is not valid JSON: ${manifestPath}`, {
      path: manifestPath,
      cause: error.message,
    });
  }
  if (
    !parsed ||
    typeof parsed.name !== 'string' ||
    !Number.isInteger(parsed.port) ||
    typeof parsed.repo !== 'string' ||
    typeof parsed.settings !== 'object' ||
    parsed.settings === null
  ) {
    throw new ProvisionError('profile_corrupt', `instance manifest is incomplete: ${manifestPath}`, {
      path: manifestPath,
    });
  }
  return parsed;
}

/**
 * All ports already claimed for this DSH home: the central registry plus any
 * orphaned per-profile manifest. Scanning both means a torn install cannot
 * silently have its port reused.
 */
export function listReservations(fs, paths) {
  const registry = readRegistry(fs, paths.registryPath);
  const byName = new Map();
  for (const item of registry.instances) {
    if (item && typeof item.name === 'string' && Number.isInteger(item.port)) {
      byName.set(item.name, item);
    }
  }

  const profilesRoot = path.join(paths.dshHome, 'profiles');
  for (const entry of fs.list(profilesRoot)) {
    const manifestPath = path.join(profilesRoot, entry, 'instance.json');
    if (!fs.exists(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFile(manifestPath));
      if (
        manifest &&
        typeof manifest.name === 'string' &&
        Number.isInteger(manifest.port) &&
        !byName.has(manifest.name)
      ) {
        byName.set(manifest.name, manifest);
      }
    } catch {
      // An unreadable manifest of another profile cannot reserve a port; the
      // registry entry (if any) still does. The target profile is checked
      // separately by readManifest and fails closed with `profile_corrupt`.
    }
  }
  return [...byName.values()];
}
