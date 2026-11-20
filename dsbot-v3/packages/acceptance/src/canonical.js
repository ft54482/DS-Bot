import { createHash } from 'node:crypto';

/**
 * SHA-256 of a UTF-8 string, as lowercase hex. This is the only cryptographic
 * primitive the engine needs, and it runs entirely in memory: no file, network
 * or process access takes place here.
 */
export function sha256Hex(input) {
  if (typeof input !== 'string') {
    throw new TypeError('sha256Hex expects a UTF-8 string');
  }
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
