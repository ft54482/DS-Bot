/**
 * Path and commit-sha helpers for the verifier's scope gate.
 *
 * Git reports repository-relative paths with forward slashes. The helpers
 * below still normalize backslashes and `./` prefixes so a caller cannot slip
 * a file past the scope check with a cosmetic difference.
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** True when `value` is a complete 40-hex commit sha. */
export function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA.test(value);
}

/**
 * Normalize one allowed directory. Throws a TypeError for values that do not
 * name a repository-relative directory.
 */
export function normalizeAllowedDir(dir) {
  if (typeof dir !== 'string') {
    throw new TypeError('allowedDirs entries must be strings');
  }

  let normalized = dir.replace(/\\/g, '/').trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');

  if (normalized === '' || normalized === '.') {
    throw new TypeError('allowedDirs entries must name a directory');
  }
  if (normalized.split('/').includes('..')) {
    throw new TypeError(`allowedDirs entry must not escape the repository: ${dir}`);
  }

  return normalized;
}

/**
 * Normalize one changed file reported by the runner. Returns `null` for a
 * non-string or empty entry so the caller can fail it as out of scope.
 */
export function normalizeChangedPath(file) {
  if (typeof file !== 'string') return null;
  if (/\0/.test(file)) return null;

  let normalized = file.replace(/\\/g, '/').trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '');

  return normalized === '' ? null : normalized;
}

/**
 * Filter a changed-file list down to the files outside `allowedDirs`.
 *
 * A path is inside a directory when it equals the directory or starts with
 * `<dir>/`; `packages/verifier-agent-other` is therefore outside
 * `packages/verifier-agent`. `..` segments, absolute paths, NUL bytes and
 * non-string entries are always outside. The result is de-duplicated and
 * sorted so two runs of the same diff produce the same JSON.
 */
export function outOfScope(files, allowedDirs) {
  if (!Array.isArray(files)) {
    throw new TypeError('changed files must be an array');
  }
  if (!Array.isArray(allowedDirs)) {
    throw new TypeError('allowedDirs must be an array');
  }

  const dirs = allowedDirs.map(normalizeAllowedDir);
  const outside = new Set();

  for (const file of files) {
    // An absolute path is never a repository-relative git path; fail it
    // before normalization could make it look like one.
    if (typeof file === 'string') {
      const raw = file.replace(/\\/g, '/');
      if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
        outside.add(raw);
        continue;
      }
    }

    const normalized = normalizeChangedPath(file);
    if (normalized === null) {
      outside.add(String(file));
      continue;
    }

    const segments = normalized.split('/');
    if (segments.includes('..')) {
      outside.add(normalized);
      continue;
    }

    const allowed = dirs.some(
      (dir) => normalized === dir || normalized.startsWith(`${dir}/`),
    );
    if (!allowed) outside.add(normalized);
  }

  return [...outside].sort();
}
