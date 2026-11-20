/**
 * Redaction helpers.
 *
 * The gateway never logs, and it never returns a credential. Any text that
 * crosses the boundary (completion text, upstream error detail) passes through
 * `sanitize` with the credential values known to the backend, so an upstream
 * that echoes `Authorization` cannot leak a key.
 */

function secretList(secrets) {
  const flat = [];
  for (const item of secrets.flat(Number.POSITIVE_INFINITY)) {
    if (typeof item === 'string' && item.length > 0) flat.push(item);
  }
  return flat;
}

export function redact(text, secrets) {
  let output = String(text);
  for (const secret of secretList([secrets])) {
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

/** Deep-sanitize plain JSON-ish values; other values are returned unchanged. */
export function sanitize(value, secrets) {
  const list = secretList([secrets]);
  const walk = (input) => {
    if (typeof input === 'string') {
      let output = input;
      for (const secret of list) output = output.split(secret).join('[redacted]');
      return output;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(input)) output[key] = walk(entry);
      return output;
    }
    return input;
  };
  return walk(value);
}

export function secretsOf(...values) {
  return values.flat(Number.POSITIVE_INFINITY).filter((value) => typeof value === 'string' && value.length > 0);
}
