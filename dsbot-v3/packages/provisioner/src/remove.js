import { ProvisionError } from './errors.js';
import { resolvePaths } from './paths.js';
import { readManifest, readRegistry, removeInstance, writeRegistry } from './registry.js';
import { assertFs, assertName, normalizeDshHome } from './validate.js';

/**
 * Remove one provisioner-managed profile.
 *
 * Only the profile directory and the registry record are removed by default;
 * `<dshHome>/state/<name>` can contain worktrees and user data, so deleting it
 * requires an explicit `removeState: true`. An unmanaged profile directory is
 * never deleted.
 *
 * Removing an unknown instance is a successful no-op (`removed: false`), which
 * keeps `--remove` idempotent like `provision` itself.
 */
export function removeProvision(options = {}) {
  const fs = assertFs(options.fs);
  const name = assertName(options.name);
  const dshHome = normalizeDshHome(options.dshHome);
  const paths = resolvePaths({ name, dshHome, fs });

  const manifest = readManifest(fs, paths.manifestPath);
  const registry = readRegistry(fs, paths.registryPath);
  const record = registry.instances.find((item) => item?.name === name) ?? null;
  const profileExists = fs.exists(paths.profileDir);

  if (!manifest && !record) {
    if (profileExists) {
      throw new ProvisionError(
        'profile_exists',
        `refusing to remove an unmanaged profile directory: ${paths.profileDir}`,
        { path: paths.profileDir },
      );
    }
    return {
      name,
      removed: false,
      profileDir: paths.profileDir,
      stateDir: paths.stateDir,
      stateRemoved: false,
    };
  }

  if (profileExists) fs.remove(paths.profileDir);
  if (record) writeRegistry(fs, paths.registryPath, removeInstance(registry, name));

  let stateRemoved = false;
  if (options.removeState === true && fs.exists(paths.stateDir)) {
    fs.remove(paths.stateDir);
    stateRemoved = true;
  }

  return {
    name,
    removed: true,
    profileDir: paths.profileDir,
    stateDir: paths.stateDir,
    stateRemoved,
  };
}
