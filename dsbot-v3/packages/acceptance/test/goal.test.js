import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, RESULTS } from '../src/index.js';
import { goalRubric, itemById, passItem } from './helpers.js';

test('goal passes only when the goal-level evaluator rubric passes', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { id: 'tsk-goal', level: 'goal' },
    rubric: goalRubric([
      passItem('independent.goal_review'),
      passItem('auto.user_request_binding'),
      { id: 'human.goal_signoff', verdict: 'pass' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.equal(itemById(evaluation, 'goal.evaluator').ok, true);
  assert.equal(itemById(evaluation, 'goal.rubric').ok, true);
  assert.equal(itemById(evaluation, 'independent.goal_review').ok, true);
});

test('a goal-level evaluator object may declare stage=goal', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: goalRubric([passItem('independent.goal_review')], {
      evaluator: { id: 'chief', stage: 'goal' },
    }),
  });

  assert.equal(evaluation.result, RESULTS.pass);
  assert.match(itemById(evaluation, 'goal.evaluator').detail, /chief/);
});

test('passing child stages cannot make the goal pass without a goal evaluator', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: {
      level: 'goal',
      children: [
        { id: 'tsk-exec', level: 'execution', state: 'completed', result: 'pass' },
        { id: 'tsk-business', level: 'business', state: 'completed', result: 'pass' },
      ],
    },
    evidence: [
      { id: 'child-exec', kind: 'child_acceptance', stage: 'execution', content: 'passed', verdict: 'pass' },
      { id: 'child-business', kind: 'child_acceptance', stage: 'business', content: 'passed', verdict: 'pass' },
    ],
    rubric: null,
  });

  assert.notEqual(evaluation.result, RESULTS.pass);
  assert.equal(evaluation.result, RESULTS.blocked);
  const evaluator = itemById(evaluation, 'goal.evaluator');
  assert.equal(evaluator.ok, false);
  assert.match(evaluator.detail, /no goal-level evaluator/);
  assert.equal(itemById(evaluation, 'goal.rubric').ok, false);
});

test('a business-stage rubric cannot decide a goal', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: { id: 'business.product_v1', stage: 'business', items: [passItem('independent.visual')] },
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  const evaluator = itemById(evaluation, 'goal.evaluator');
  assert.equal(evaluator.ok, false);
  assert.match(evaluator.detail, /not "goal"/);
  assert.match(itemById(evaluation, 'rubric.stage').detail, /cannot decide a "goal" stage/);
});

test('a goal evaluator without goal=stage is rejected', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: {
      stage: 'goal',
      evaluator: { id: 'business-bot', stage: 'business' },
      items: [passItem('independent.goal_review')],
    },
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'goal.evaluator').detail, /not goal-level/);
});

test('a failing required goal item is rework even when every child passed', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal', children: [{ level: 'business', state: 'completed', result: 'pass' }] },
    evidence: [{ id: 'child', kind: 'child_acceptance', stage: 'business', content: 'passed', verdict: 'pass' }],
    rubric: goalRubric([
      passItem('independent.goal_review'),
      { id: 'human.goal_signoff', verdict: 'fail' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.rework);
  assert.equal(itemById(evaluation, 'human.goal_signoff').ok, false);
});

test('a pending human sign-off blocks the goal, never passes it', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: goalRubric([
      passItem('independent.goal_review'),
      { id: 'human.goal_signoff', verdict: 'pending' },
    ]),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.equal(itemById(evaluation, 'human.goal_signoff').ok, false);
});

test('a goal rubric with no entries blocks instead of passing vacuously', () => {
  const evaluation = evaluate({
    stage: 'goal',
    task: { level: 'goal' },
    rubric: goalRubric([]),
  });

  assert.equal(evaluation.result, RESULTS.blocked);
  assert.match(itemById(evaluation, 'goal.rubric').detail, /goal rubric missing/);
});
