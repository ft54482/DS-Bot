import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluate, RESULTS, STAGES } from '../src/index.js';
import {
  commitEvidence,
  deepFreeze,
  domainRubric,
  goalRubric,
  passItem,
  testEvidence,
} from './helpers.js';

test('every item has exactly the documented shape and a valid result', () => {
  const evaluation = evaluate({
    stage: 'execution',
    task: { level: 'execution' },
    evidence: [commitEvidence(), testEvidence()],
  });

  assert.ok([RESULTS.pass, RESULTS.rework, RESULTS.blocked].includes(evaluation.result));
  for (const item of evaluation.items) {
    assert.deepEqual(Object.keys(item), ['id', 'required', 'ok', 'detail']);
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.required, 'boolean');
    assert.equal(typeof item.ok, 'boolean');
    assert.equal(typeof item.detail, 'string');
    assert.ok(item.detail.length > 0);
  }
});

test('the same input returns the same evaluation and never mutates input', () => {
  const input = deepFreeze({
    stage: STAGES.business,
    task: { id: 'tsk', level: 'business' },
    evidence: [{ id: 'review', kind: 'independent_review', content: 'body', verdict: 'pass' }],
    rubric: domainRubric([passItem('independent.visual'), { id: 'independent.flow', verdict: 'fail' }]),
  });
  const before = JSON.stringify(input);

  const first = evaluate(input);
  const second = evaluate(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.result, RESULTS.rework);
});

test('the aggregate is never better than its worst item', () => {
  const blocked = evaluate({
    stage: 'execution',
    evidence: [
      commitEvidence(),
      testEvidence({ exitCode: 1 }),
      { id: 'note', kind: 'note', content: 'x', sha256: 'not-a-hash' },
    ],
  });
  assert.equal(blocked.result, RESULTS.blocked);

  const rework = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: goalRubric([passItem('independent.goal_review'), { id: 'human.goal_signoff', verdict: 'fail' }]),
  });
  assert.equal(rework.result, RESULTS.rework);
});

test('the engine source imports no I/O modules and no dependencies', () => {
  const sourceDirectory = new URL('../src/', import.meta.url);
  const files = readdirSync(sourceDirectory).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);

  const externalImports = new Set();
  for (const file of files) {
    const source = readFileSync(new URL(file, sourceDirectory), 'utf8');
    assert.equal(/\brequire\s*\(/.test(source), false, `${file} must stay ESM`);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) externalImports.add(match[1]);
    }
  }

  assert.deepEqual([...externalImports].sort(), ['node:crypto']);
});

test('all three stages are reachable through one evaluate function', () => {
  const execution = evaluate({
    stage: STAGES.execution,
    task: { level: 'execution' },
    evidence: [commitEvidence(), testEvidence()],
  });
  const business = evaluate({
    stage: STAGES.business,
    task: { level: 'business' },
    rubric: domainRubric([passItem('independent.visual')]),
  });
  const goal = evaluate({
    stage: STAGES.goal,
    task: { level: 'goal' },
    rubric: goalRubric([passItem('independent.goal_review')]),
  });

  assert.equal(execution.result, RESULTS.pass);
  assert.equal(business.result, RESULTS.pass);
  assert.equal(goal.result, RESULTS.pass);
  assert.equal(typeof evaluate, 'function');
});
