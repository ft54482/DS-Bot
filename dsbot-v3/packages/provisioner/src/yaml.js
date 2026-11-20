/**
 * Minimal, deterministic YAML writer for `cordis.patch.yml`.
 *
 * The provisioner only emits plain nested mappings, scalars and short scalar
 * arrays, so a full YAML library would be unnecessary weight. Strings are
 * always JSON-quoted: that is valid YAML and keeps Windows paths, `$`
 * variables and globs unambiguous.
 *
 * The reader in `packages/loop/src/yaml.js` accepts this output subset.
 */
export function toYaml(value) {
  return `${render(value, 0)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function render(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          return `${pad}-\n${render(item, indent + 2)}`;
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}`;
    return keys
      .map((key) => {
        const child = value[key];
        const renderedKey = keyPattern.test(key) ? key : JSON.stringify(key);
        const emptyContainer =
          (Array.isArray(child) && child.length === 0) ||
          (isPlainObject(child) && Object.keys(child).length === 0);
        if ((isPlainObject(child) || Array.isArray(child)) && !emptyContainer) {
          return `${pad}${renderedKey}:\n${render(child, indent + 2)}`;
        }
        return `${pad}${renderedKey}: ${scalar(child)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}

const keyPattern = /^[A-Za-z0-9_.-]+$/;

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value) && value.length === 0) return '[]';
  if (isPlainObject(value) && Object.keys(value).length === 0) return '{}';
  if (typeof value === 'string') return JSON.stringify(value);
  throw new TypeError(`cannot serialize ${typeof value} to YAML`);
}
