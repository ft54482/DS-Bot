import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateArticlePack, RESULT, selfMediaProfileV1 } from '../src/index.js';
import { itemById, makePack, NOW } from './fixtures.js';

function evaluatePack(overrides) {
  return evaluateArticlePack(makePack(overrides), selfMediaProfileV1, { now: NOW });
}

test('quotation ratio above the soft limit needs rework', () => {
  const evaluation = evaluatePack({ citations: { total_chars: 2000, quoted_chars: 400 } });
  const ratio = itemById(evaluation, 'auto.compliance.quote_ratio');
  assert.equal(ratio.result, RESULT.needsRework);
  assert.match(ratio.detail, /quotation ratio 20\.0% exceeds 15\.0%/);
});

test('quotation ratio above the hard limit blocks as suspected copying', () => {
  const evaluation = evaluatePack({ citations: { total_chars: 2000, quoted_chars: 700 } });
  const ratio = itemById(evaluation, 'auto.compliance.quote_ratio');
  assert.equal(ratio.result, RESULT.blocked);
  assert.match(ratio.detail, /exceeds the hard limit 30\.0%/);
  assert.match(ratio.detail, /suspected copying/);
});

test('missing or invalid quotation data needs rework', () => {
  for (const citations of [undefined, { total_chars: 0, quoted_chars: 0 }, { total_chars: 100, quoted_chars: 200 }]) {
    const evaluation = evaluatePack({ citations });
    const ratio = itemById(evaluation, 'auto.compliance.quote_ratio');
    assert.equal(ratio.result, RESULT.needsRework, JSON.stringify(citations));
  }
});

test('an unresolved blocker risk blocks acceptance', () => {
  const evaluation = evaluatePack({
    compliance: { risks: [{ id: 'R-1', severity: 'blocker', resolved: false, detail: 'unverifiable claim' }] },
  });
  const risks = itemById(evaluation, 'auto.compliance.risk_list');
  assert.equal(risks.result, RESULT.blocked);
  assert.match(risks.detail, /R-1: unresolved blocker/);
});

test('an unresolved major risk needs rework', () => {
  const evaluation = evaluatePack({
    compliance: { risks: [{ id: 'R-2', severity: 'major', resolved: false }] },
  });
  const risks = itemById(evaluation, 'auto.compliance.risk_list');
  assert.equal(risks.result, RESULT.needsRework);
  assert.match(risks.detail, /R-2: unresolved major/);
});

test('a resolved blocker no longer blocks', () => {
  const evaluation = evaluatePack({
    compliance: {
      risks: [
        { id: 'R-1', severity: 'blocker', resolved: true },
        { id: 'R-3', severity: 'minor', state: 'resolved' },
      ],
    },
  });
  assert.equal(itemById(evaluation, 'auto.compliance.risk_list').result, RESULT.pass);
});

test('missing risk list or unknown severity needs rework', () => {
  for (const compliance of [undefined, { risks: 'none' }, { risks: [{ id: 'R-4', severity: 'critical' }] }]) {
    const evaluation = evaluatePack({ compliance });
    assert.equal(itemById(evaluation, 'auto.compliance.risk_list').result, RESULT.needsRework);
  }
});
