/**
 * Shared test helpers. This file is not a test suite; it only exports helpers
 * used by the *.test.mjs files in this directory.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../run.mjs';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(TEST_DIR, '..', '..', '..');

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'selfmedia-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function captureStream() {
  const chunks = [];
  return {
    stream: {
      write(value) {
        chunks.push(String(value));
        return true;
      },
    },
    text() {
      return chunks.join('');
    },
  };
}

/**
 * Call the CLI in-process. This avoids child_process pipes (which can be
 * restricted by the Windows sandbox) and keeps the tests hermetic.
 */
export async function runCli(argv, { env = {}, cwd = ROOT, fetchImpl } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main({ argv, env, cwd, stdout: stdout.stream, stderr: stderr.stream, fetchImpl });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function readJson(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
