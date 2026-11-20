import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, RESULTS } from '../src/index.js';
import { domainRubric, itemById, passItem } from './helpers.js';

test('business passes when every required domain rubric entry passes', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { id: 'tsk-business', level: 'business' },
    rubric: domainRubric([
      passItem('independent.visual'),
      passItem('independent.experience'),
      passItem('auto.children_gate'),
    ]),
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'business.rubric').ok, true);
  assert.equal(itemById(evaluation, 'rubric.stage').ok, true);
  assert.equal(itemById(evaluation, 'independent.visual').ok, true);
  assert.equal(itemById(evaluation, 'independent.experience').ok, true);
});

test('business reworks when any required domain rubric entry fails', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: domainRubric([
      passItem('independent.visual'),
      { id: 'independent.semantic', verdict: 'fail', detail: 'claim has no source' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.rework);
  const semantic = itemById(evaluation, 'independent.semantic');
  assert.equal(semantic.ok, false);
  assert.equal(semantic.detail, 'claim has no source');
  assert.equal(semantic.required, true);
});

test('business blocks without a domain rubric', () => {
  const evaluation = evaluate({ stage: 'business', task: { level: 'business' } });

  assert.equal(evaluation.result, RESULTS.blocked);
  const rubric = itemById(evaluation, 'business.rubric');
  assert.equal(rubric.ok, false);
  assert.match(rubric.detail, /domain rubric missing/);
});

test('business blocks on an empty domain rubric instead of passing vacuously', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: domainRubric([]),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'business.rubric').detail, /at least one rubric entry/);
});

test('business blocks on a pending domain rubric entry', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: domainRubric([passItem('independent.visual'), { id: 'independent.flow', verdict: 'pending' }]),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const flow = itemById(evaluation, 'independent.flow');
  assert.equal(flow.ok, false);
  assert.match(flow.detail, /cannot be judged/);
});

test('business blocks when an execution-stage rubric is supplied', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: domainRubric([passItem('auto.tests')], { stage: 'execution' }),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const stage = itemById(evaluation, 'rubric.stage');
  assert.equal(stage.ok, false);
  assert.match(stage.detail, /cannot decide a "business" stage/);
});

test('optional rubric entries are reported but never gate the result', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: domainRubric([
      passItem('independent.visual'),
      { id: 'independent.extra', required: false, verdict: 'fail' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.pass);
  const extra = itemById(evaluation, 'independent.extra');
  assert.equal(extra.required, false);
  assert.equal(extra.ok, false);
});

test('a passing execution child cannot promote a business parent with a failing rubric', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business', children: [{ id: 'tsk-exec', level: 'execution', state: 'completed' }] },
    evidence: [
      { id: 'child-1', kind: 'child_acceptance', content: 'passed', stage: 'execution', verdict: 'pass' },
    ],
    rubric: domainRubric([
      passItem('independent.visual'),
      { id: 'independent.semantic', verdict: 'fail' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.rework);
  assert.equal(itemById(evaluation, 'independent.semantic').ok, false);
});

test('business accepts a bare rubric item array', () => {
  const evaluation = evaluate({
    stage: 'business',
    task: { level: 'business' },
    rubric: [passItem('independent.visual')],
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(evaluation.items.some((item) => item.id === 'rubric.stage'), false);
});

test('rubric entries with ok booleans map to pass/rework', () => {
  const passing = evaluate({
    stage: 'business',
    rubric: domainRubric([{ id: 'independent.visual', ok: true }]),
  });
  assert.equal(passing.result, RESULTS.pass);

  const failing = evaluate({
    stage: 'business',
    rubric: domainRubric([{ id: 'independent.visual', ok: false }]),
  });
  assert.equal(failing.result, RESULTS.rework);
});
