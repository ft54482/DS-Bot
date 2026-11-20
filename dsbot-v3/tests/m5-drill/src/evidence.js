/**
 * Evidence pack writer for the M5 drill.
 *
 * The pack is a flat `evidence/` directory of JSON documents plus a
 * `manifest.json` that records every file's SHA-256. Nothing is written outside
 * the caller's `--out` directory.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function createEvidenceWriter(outDir) {
  const evidenceDir = join(outDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const entries = new Map();

  function write(name, value) {
    if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(name)) {
      throw new TypeError(`invalid evidence file name: ${name}`);
    }
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(evidenceDir, name), text, 'utf8');
    const rel = `evidence/${name}`;
    entries.set(rel, { path: rel, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    return rel;
  }

  function finalize(generatedAt = new Date().toISOString()) {
    const files = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schema: 'm5-drill-evidence/v1',
      generatedAt,
      files,
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(evidenceDir, 'manifest.json'), text, 'utf8');
    return {
      dir: 'evidence',
      manifest: 'evidence/manifest.json',
      fileCount: files.length,
      files,
    };
  }

  return { dir: evidenceDir, write, finalize, entries };
}
