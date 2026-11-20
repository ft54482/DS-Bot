import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makePack, NOW } from './fixtures.js';

function evaluateWithLayout(layout) {
  return evaluateArticlePack(makePack({ layout }), selfMediaProfileV1, { now: NOW });
}

test('fewer than three title candidates need rework', () => {
  const evaluation = evaluateWithLayout({ titles: ['Only title', 'Second title'] });
  const titles = itemById(evaluation, 'auto.layout.titles');

  assert.equal(titles.result, RESULT.needsRework);
  assert.match(titles.detail, /2 unique title candidate\(s\), need >=3/);
  assert.equal(evaluation.result, RESULT.needsRework);
});

test('duplicate title candidates do not count twice', () => {
  const evaluation = evaluateWithLayout({ titles: ['Same title', 'Same title', 'Another title'] });
  const titles = itemById(evaluation, 'auto.layout.titles');
  assert.equal(titles.result, RESULT.needsRework);
  assert.match(titles.detail, /2 unique title candidate\(s\)/);
  assert.match(titles.detail, /1 duplicate\(s\) ignored/);
});

test('three title candidates pass', () => {
  const evaluation = evaluateWithLayout({ titles: ['A', 'B', 'C'] });
  assert.equal(itemById(evaluation, 'auto.layout.titles').result, RESULT.pass);
});

test('fewer than three tags need rework', () => {
  const evaluation = evaluateWithLayout({ tags: ['AI', '效率'] });
  const tags = itemById(evaluation, 'auto.layout.tags');
  assert.equal(tags.result, RESULT.needsRework);
  assert.match(tags.detail, /2 tag\(s\), need >=3/);
});

test('empty and duplicate tags do not count as complete tagging', () => {
  const evaluation = evaluateWithLayout({ tags: ['AI', 'AI', '   '] });
  const tags = itemById(evaluation, 'auto.layout.tags');
  assert.equal(tags.result, RESULT.needsRework);
  assert.match(tags.detail, /1 tag\(s\)/);
  assert.match(tags.detail, /1 duplicate\(s\) ignored/);
  assert.match(tags.detail, /1 empty\/non-string entry ignored/);
});

test('missing layout data needs rework', () => {
  const evaluation = evaluateWithLayout({ titles: undefined, tags: undefined });
  assert.equal(itemById(evaluation, 'auto.layout.titles').result, RESULT.needsRework);
  assert.equal(itemById(evaluation, 'auto.layout.tags').result, RESULT.needsRework);
});
