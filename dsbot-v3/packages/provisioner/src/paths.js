import path from 'node:path';

/**
 * Resolve every path once, from the injected home directory.
 *
 * Layout (matching the existing DSH install):
 *   <dshHome>/profiles/<name>            profile directory (cordis patch + manifest)
 *   <dshHome>/state/<name>               instance state directory
 *   <dshHome>/state/<name>/work          default executor work root
 *   <dshHome>/state/provisioner/registry.json
 *
 * Callers may override `dshHome` and `workRoot`, but never the layout below a
 * provisioner-managed profile directory. `name` is validated before this runs.
 */
export function resolvePaths({ name, dshHome, workRoot, fs }) {
  const home = path.resolve(dshHome ?? path.join(fs.homedir(), '.dsh'));
  const profileDir = path.join(home, 'profiles', name);
  const stateDir = path.join(home, 'state', name);
  const effectiveWorkRoot = path.resolve(workRoot ?? path.join(stateDir, 'work'));
  return {
    dshHome: home,
    profileDir,
    stateDir,
    workRoot: effectiveWorkRoot,
    manifestPath: path.join(profileDir, 'instance.json'),
    cordisPatchPath: path.join(profileDir, 'cordis.patch.yml'),
    registryPath: path.join(home, 'state', 'provisioner', 'registry.json'),
  };
}
