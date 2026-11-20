import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPack, estimateTokens, measurePack } from '../src/index.js';
import {
  COUNT,
  deepFreeze,
  makeQuestions,
  makeRecent,
  makeTask,
} from './helpers.js';

test('the builder does not mutate frozen input', () => {
  const task = deepFreeze(makeTask());
  const recent = deepFreeze(makeRecent(3));
  const questions = deepFreeze(makeQuestions());
  const before = JSON.parse(JSON.stringify({ task, recent, questions }));

  const pack = buildContextPack({
    level: 'business',
    task,
    recent,
    open_questions: questions,
    budgets: { business: 5_000 },
    countTokens: COUNT,
  });

  assert.ok(pack.task_pack.task_id);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ task, recent, questions })),
    before,
  );
});

test('the same input produces the same pack on every call', () => {
  const input = {
    level: 'business',
    task: makeTask(),
    recent: makeRecent(3),
    open_questions: makeQuestions(),
    budgets: { business: 5_000 },
    countTokens: COUNT,
  };
  assert.deepEqual(buildContextPack(input), buildContextPack(input));
});

test('an injected counter receives serialized packs and controls trimming', () => {
  const seen = [];
  const counter = (text) => {
    seen.push(text);
    return Math.ceil(text.length / 10);
  };

  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(3),
    open_questions: makeQuestions(),
    budgets: { business: 100_000 },
    countTokens: counter,
  });

  assert.ok(seen.length > 0);
  assert.ok(seen.every((text) => typeof text === 'string'));
  assert.equal(
    measurePack(pack, COUNT),
    COUNT(JSON.stringify(pack)),
  );
  assert.deepEqual(
    measurePack(pack, counter),
    measurePack(pack, counter),
  );
});

test('measurePack rejects a counter that does not return a token count', () => {
  const pack = { identity: {}, task_pack: {}, recent: [], open_questions: [], pointers: [] };
  assert.throws(
    () => measurePack(pack, () => Number.NaN),
    /non-negative finite number/,
  );
  assert.throws(
    () => measurePack(pack, () => -1),
    /non-negative finite number/,
  );
  assert.throws(
    () => measurePack(pack, () => 'many'),
    /non-negative finite number/,
  );
});

test('estimateTokens is stable for normalized input', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('😀'), 1);
});

test('input arrays are not shared with the output', () => {
  const recent = makeRecent(2);
  const questions = makeQuestions();
  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent,
    open_questions: questions,
    budgets: {},
    countTokens: COUNT,
  });

  pack.recent[0].text = 'mutated output';
  pack.open_questions[0].question = 'mutated output';
  pack.task_pack.scope.allowed_paths.push('mutated/output');

  assert.notEqual(recent[0].text, 'mutated output');
  assert.notEqual(questions[0].question, 'mutated output');
  assert.equal(makeTask().scope.allowed_paths.includes('mutated/output'), false);
});
