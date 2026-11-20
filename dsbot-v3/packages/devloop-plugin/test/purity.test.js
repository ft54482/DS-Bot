import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, startInput } from './support/harness.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FORBIDDEN = [
  /node:fs/,
  /node:http/,
  /node:https/,
  /node:child_process/,
  /node:os/,
  /from 'node:net'/,
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\.homedir\(\)/,
  /process\.env/,
];

test('source has no ambient fs, network, child-process, home-directory or env access', () => {
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${file} must not match ${pattern}`);
    }
  }
});

test('start does not mutate a deeply frozen input', async () => {
  const { manager } = createHarness();
  const input = startInput({
    lanes: [
      { lane: 'ui', dir: 'packages/ui', cost: 2, acceptanceCommands: ['node --test packages/ui/test'] },
    ],
  });
  deepFreeze(input);

  const started = await manager.start(input);

  assert.equal(started.running, true);
  assert.equal(input.goal.baseSha, 'a'.repeat(40));
  assert.equal(input.lanes[0].lane, 'ui');
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
