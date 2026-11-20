import fs from 'node:fs';
import os from 'node:os';

/**
 * The only implementation that touches the real machine. `provision` and
 * `removeProvision` accept this adapter (or a fake with the same seven
 * methods), which is what keeps tests away from the operator's `~/.dsh`.
 */
export function createNodeFs() {
  return {
    homedir: () => os.homedir(),
    exists: (target) => fs.existsSync(target),
    readFile: (target) => fs.readFileSync(target, 'utf8'),
    writeFile: (target, data) => fs.writeFileSync(target, data, 'utf8'),
    mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
    remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
    list: (target) => {
      try {
        return fs.readdirSync(target);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
