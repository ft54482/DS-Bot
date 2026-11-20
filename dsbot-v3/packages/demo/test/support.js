/**
 * Shared helpers for the package tests. Every test writes only to an OS temp
 * directory; no fixture and no database file is created inside the repository.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDemo } from '../src/index.js';

export async function runInTemp(t, options = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'dsbot-demo-test-'));
  t.after(async () => {
    await rm(outDir, { recursive: true, force: true });
  });
  const result = await runDemo({ outDir, ...options });
  return { outDir, ...result };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readText(path) {
  return readFile(path, 'utf8');
}
