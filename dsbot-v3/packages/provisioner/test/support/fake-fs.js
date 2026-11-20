import path from 'node:path';

/**
 * In-memory fs adapter with the seven methods provisioner requires. It never
 * touches the real disk; every path is normalized with `path.resolve` so the
 * tests exercise the same path handling as the node adapter.
 */
export function createFakeFs({ home, files = {}, dirs = [] } = {}) {
  if (typeof home !== 'string' || home === '') {
    throw new Error('createFakeFs requires a home directory');
  }

  const fileMap = new Map();
  const dirSet = new Set();

  const normalize = (target) => path.resolve(target);

  function addAncestors(directory) {
    let current = normalize(directory);
    const { root } = path.parse(current);
    for (;;) {
      dirSet.add(current);
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const [target, content] of Object.entries(files)) {
    const normalized = normalize(target);
    fileMap.set(normalized, String(content));
    addAncestors(path.dirname(normalized));
  }
  for (const directory of dirs) addAncestors(directory);
  addAncestors(home);

  return {
    home,
    _files: fileMap,
    _dirs: dirSet,

    homedir() {
      return home;
    },

    exists(target) {
      const normalized = normalize(target);
      return fileMap.has(normalized) || dirSet.has(normalized);
    },

    readFile(target) {
      const normalized = normalize(target);
      if (!fileMap.has(normalized)) {
        const error = new Error(`ENOENT: no such file or directory, open '${normalized}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return fileMap.get(normalized);
    },

    writeFile(target, data) {
      const normalized = normalize(target);
      addAncestors(path.dirname(normalized));
      fileMap.set(normalized, String(data));
    },

    mkdir(target) {
      addAncestors(target);
    },

    remove(target) {
      const normalized = normalize(target);
      const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
      for (const key of [...fileMap.keys()]) {
        if (key === normalized || key.startsWith(prefix)) fileMap.delete(key);
      }
      for (const directory of [...dirSet]) {
        if (directory === normalized || directory.startsWith(prefix)) dirSet.delete(directory);
      }
    },

    list(target) {
      const normalized = normalize(target);
      if (!dirSet.has(normalized)) return [];
      const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
      const names = new Set();
      for (const key of [...fileMap.keys(), ...dirSet]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest !== '' && !rest.includes(path.sep)) names.add(rest);
      }
      return [...names].sort();
    },
  };
}
