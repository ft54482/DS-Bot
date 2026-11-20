import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTaskPack, choosePath } from '../src/index.js';
import {
  FULL_CAPABILITY,
  baseInput,
  basePack,
  deepFreeze,
} from './helpers.js';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

test('the same input produces the same pack and decision every time', () => {
  const input = baseInput({ signals: { estimated_steps: 3, stages: ['a'] } });

  assert.deepEqual(buildTaskPack(input), buildTaskPack(input));

  const taskPack = buildTaskPack(input);
  const decision = choosePath({ taskPack, capability: FULL_CAPABILITY });
  assert.deepEqual(
    decision,
    choosePath({ taskPack, capability: FULL_CAPABILITY }),
  );
});

test('routing does not mutate a frozen task pack', () => {
  const taskPack = deepFreeze(basePack({ signals: { multi_file: true } }));
  const before = JSON.stringify(taskPack);

  choosePath({ taskPack, capability: FULL_CAPABILITY });

  assert.equal(JSON.stringify(taskPack), before);
});

test('building does not share arrays with the input', () => {
  const input = baseInput();
  const pack = buildTaskPack(input);

  pack.constraints.push('mutated output');
  pack.context_refs.push('mutated output');

  assert.deepEqual(input.constraints, [
    'do not touch other packages',
    'no new dependencies',
  ]);
  assert.deepEqual(input.contextRefs, ['docs/prd/16-execution-paths.md']);
});

test('pack and routing decision are plain JSON data', () => {
  const pack = basePack({ signals: { stages: ['a', 'b'] } });
  const decision = choosePath({ taskPack: pack, capability: FULL_CAPABILITY });

  for (const value of [pack, decision]) {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
    assert.equal(containsFunction(value), false);
  }
});

test('source modules import no IO, clock or randomness', () => {
  const forbidden = [
    /from\s+['"](?:node:)?(?:fs|net|http|https|http2|child_process|crypto)['"]/,
    /\bDate\.now\s*\(/,
    /\bnew\s+Date\s*\(/,
    /\bMath\.random\s*\(/,
    /\bprocess\.env\b/,
    /\bfetch\s*\(/,
  ];

  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 5);

  for (const file of files) {
    const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8');
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${file} must not match ${pattern}`,
      );
    }
  }
});

function containsFunction(value) {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(containsFunction);
}
