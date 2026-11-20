import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, ITEM_CLASS, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makePack, NOW } from './fixtures.js';

function readExample(name) {
  return JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
}

test('a complete article pack passes every acceptance item', () => {
  const evaluation = evaluateArticlePack(makePack(), selfMediaProfileV1, { now: NOW });

  assert.equal(evaluation.result, RESULT.pass);
  assert.equal(evaluation.items.length, 11);
  for (const item of evaluation.items) {
    assert.equal(item.result, RESULT.pass, `${item.id}: ${item.detail}`);
  }

  const ids = evaluation.items.map((item) => item.id);
  assert.deepEqual(ids, [
    'auto.pack_schema',
    'independent.facts',
    'independent.freshness',
    'independent.quality.reviewer',
    'independent.quality.structure',
    'independent.quality.readability',
    'independent.quality.style',
    'auto.layout.titles',
    'auto.layout.tags',
    'auto.compliance.quote_ratio',
    'auto.compliance.risk_list',
  ]);
});

test('every item has exactly the documented shape', () => {
  const evaluation = evaluateArticlePack(makePack(), selfMediaProfileV1, { now: NOW });
  for (const item of evaluation.items) {
    assert.deepEqual(Object.keys(item), ['id', 'class', 'result', 'detail']);
    assert.ok([ITEM_CLASS.auto, ITEM_CLASS.independent].includes(item.class), item.class);
    assert.ok([RESULT.pass, RESULT.needsRework, RESULT.blocked].includes(item.result), item.result);
    assert.equal(typeof item.detail, 'string');
    assert.ok(item.detail.length > 0);
  }
});

test('the aggregate can never be better than the worst item', () => {
  const evaluation = evaluateArticlePack(
    makePack({
      facts: [makePack().facts[0], { ...makePack().facts[1], sources: [makePack().facts[1].sources[0]] }],
      compliance: { risks: [{ id: 'R1', severity: 'blocker', resolved: false, detail: 'unverified claim' }] },
    }),
    selfMediaProfileV1,
    { now: NOW },
  );
  assert.equal(evaluation.result, RESULT.blocked);
  assert.equal(itemById(evaluation, 'independent.facts').result, RESULT.needsRework);
  assert.equal(itemById(evaluation, 'auto.compliance.risk_list').result, RESULT.blocked);
});

test('a structurally invalid pack is blocked by the schema item', () => {
  for (const pack of [null, {}, { article: { body: '   ' } }, { article: { body: 'x' }, facts: 'nope' }]) {
    const evaluation = evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW });
    assert.equal(evaluation.result, RESULT.blocked);
    assert.equal(itemById(evaluation, 'auto.pack_schema').result, RESULT.blocked);
    assert.match(itemById(evaluation, 'auto.pack_schema').detail, /cannot be evaluated/);
  }
});

test('evaluation is deterministic and does not mutate the pack', () => {
  const pack = makePack();
  const before = JSON.stringify(pack);
  const first = evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW });
  const second = evaluateArticlePack(pack, selfMediaProfileV1, { now: NOW });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(pack), before);
});

test('the packaged valid example passes under the pinned clock', () => {
  const evaluation = evaluateArticlePack(readExample('article-pack.valid.json'), selfMediaProfileV1, {
    now: NOW,
  });
  assert.equal(evaluation.result, RESULT.pass, JSON.stringify(evaluation, null, 2));
});

test('the packaged single-source example is caught by the facts check', () => {
  const evaluation = evaluateArticlePack(readExample('article-pack.single-source.json'), selfMediaProfileV1, {
    now: NOW,
  });
  assert.equal(evaluation.result, RESULT.needsRework);
  assert.equal(itemById(evaluation, 'independent.facts').result, RESULT.needsRework);
  assert.match(itemById(evaluation, 'independent.facts').detail, /need >=2 distinct hosts/);
});

test('acceptance never exposes or returns a publishable state', () => {
  const evaluation = evaluateArticlePack(makePack(), selfMediaProfileV1, { now: NOW });
  assert.equal(evaluation.result, RESULT.pass);
  assert.ok(!('publishable' in evaluation));
  assert.ok(!('publish' in evaluation));
  assert.ok(!('ready_to_publish' in evaluation));
  assert.ok(!JSON.stringify(evaluation).toLowerCase().includes('ready_to_publish'));
});
