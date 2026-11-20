import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * One deterministic hash for a workspace tree. Stop verification uses it to
 * prove that an executor stopped writing: cancel is not "stopped" unless the
 * namespace hash is unchanged after the cancellation acknowledgement.
 *
 * Read failures are surfaced (not swallowed) so a missing workspace fails the
 * stop verification instead of producing an empty, "stable" hash.
 */
export function hashTree(root) {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError('hashTree requires a workspace path');
  }
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const path = relative(root, full).replaceAll('\\', '/');
        entries.push(`${path}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
