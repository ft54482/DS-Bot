import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHZ_CODES, gateRules } from '../src/index.js';

function publishRule(overrides = {}) {
  return {
    id: 'rule-no-publish',
    kind: 'hard',
    version: 1,
    active: 1,
    action: 'publish',
    text: 'No external publishing without human approval.',
    ...overrides,
  };
}

test('an empty rule set allows the action', () => {
  assert.deepEqual(gateRules([], 'publish'), { ok: true, applied: [] });
});

test('a soft rule is reported but never blocks', () => {
  const result = gateRules([publishRule({ kind: 'soft' })], 'publish');

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].id, 'rule-no-publish');
});

test('a matching hard rule returns rule_blocked', () => {
  const result = gateRules([publishRule()], 'publish');

  assert.equal(result.ok, false);
  assert.equal(result.code, AUTHZ_CODES.RULE_BLOCKED);
  assert.equal(result.rule.id, 'rule-no-publish');
  assert.deepEqual(result.blocked_by.map((rule) => rule.id), ['rule-no-publish']);
  assert.deepEqual(result.applied.map((rule) => rule.id), ['rule-no-publish']);
});

test('a rule does not apply to a different action type', () => {
  assert.deepEqual(gateRules([publishRule()], 'read'), { ok: true, applied: [] });
});

test('rules accept an array of action types', () => {
  const rule = publishRule({ action: undefined, actions: ['publish', 'merge'] });
  assert.equal(gateRules([rule], 'merge').code, AUTHZ_CODES.RULE_BLOCKED);
  assert.equal(gateRules([rule], 'read').ok, true);
});

test('a wildcard matcher applies to every action', () => {
  const rule = publishRule({ action: '*' });
  assert.equal(gateRules([rule], 'read').code, AUTHZ_CODES.RULE_BLOCKED);
  assert.equal(gateRules([rule], { type: 'run', tool: 'shell' }).code, AUTHZ_CODES.RULE_BLOCKED);
});

test('the newest version wins: a newer soft rule lifts an older hard rule', () => {
  const result = gateRules(
    [publishRule({ version: 1 }), publishRule({ version: 2, kind: 'soft' })],
    'publish',
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.applied.map((rule) => rule.version), [2]);
});

test('the newest version wins: a newer hard rule blocks an older soft rule', () => {
  const result = gateRules(
    [publishRule({ version: 1, kind: 'soft' }), publishRule({ version: 2, kind: 'hard' })],
    'publish',
  );

  assert.equal(result.ok, false);
  assert.equal(result.rule.version, 2);
  assert.deepEqual(result.applied.map((rule) => rule.version), [2]);
});

test('version identity can be key instead of id', () => {
  const result = gateRules(
    [
      { key: 'no-publish', kind: 'hard', version: 1, action: 'publish' },
      { key: 'no-publish', kind: 'soft', version: 3, action: 'publish' },
    ],
    'publish',
  );

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].version, 3);
});

test('an inactive newest version does not resurrect an older active one', () => {
  const result = gateRules(
    [publishRule({ version: 1, active: 1 }), publishRule({ version: 2, active: 0 })],
    'publish',
  );

  assert.deepEqual(result, { ok: true, applied: [] });
});

test('an out-of-window newest version does not resurrect an older active one', () => {
  const result = gateRules(
    [
      publishRule({ version: 1, effective_from: 0, effective_to: 1000 }),
      publishRule({ version: 2, effective_from: 2000, effective_to: 3000 }),
    ],
    { type: 'publish', at: 1500 },
  );

  assert.deepEqual(result, { ok: true, applied: [] });
});

test('project-scoped rules only apply to the same project', () => {
  const rule = publishRule({ scope: 'project', project: 'ai-video' });

  assert.equal(gateRules([rule], 'publish').ok, true);
  assert.equal(gateRules([rule], { type: 'publish', project: 'other' }).ok, true);
  assert.equal(
    gateRules([rule], { type: 'publish', project: 'ai-video' }).code,
    AUTHZ_CODES.RULE_BLOCKED,
  );
});

test('task-scoped rules only apply to the same task', () => {
  const rule = publishRule({ scope: 'task', task_id: 'task-1' });

  assert.equal(gateRules([rule], { type: 'publish', task_id: 'task-2' }).ok, true);
  assert.equal(
    gateRules([rule], { type: 'publish', task_id: 'task-1' }).code,
    AUTHZ_CODES.RULE_BLOCKED,
  );
});

test('a global hard rule with no matcher blocks every action', () => {
  const rule = { id: 'rule-global', kind: 'hard', version: 1, text: 'Stop.' };
  assert.equal(
    gateRules([rule], { type: 'anything', project: 'ai-video' }).code,
    AUTHZ_CODES.RULE_BLOCKED,
  );
});

test('match compares structured action fields', () => {
  const rule = publishRule({ action: undefined, match: { tool: 'shell' } });

  assert.equal(gateRules([rule], { type: 'run', tool: 'shell' }).ok, false);
  assert.equal(gateRules([rule], { type: 'run', tool: 'read' }).ok, true);
  assert.equal(gateRules([rule], { type: 'run' }).ok, true);
});

test('effective windows are inclusive', () => {
  const rule = publishRule({ effective_from: 100, effective_to: 200 });

  assert.equal(gateRules([rule], { type: 'publish', at: 100 }).ok, false);
  assert.equal(gateRules([rule], { type: 'publish', at: 200 }).ok, false);
  assert.equal(gateRules([rule], { type: 'publish', at: 99 }).ok, true);
  assert.equal(gateRules([rule], { type: 'publish', at: 201 }).ok, true);
});

test('without action.at, time windows are not consulted (deterministic)', () => {
  const rule = publishRule({ effective_from: 2000, effective_to: 3000 });
  assert.equal(gateRules([rule], 'publish').code, AUTHZ_CODES.RULE_BLOCKED);
});

test('action.at accepts ISO-8601 strings', () => {
  const rule = publishRule({ effective_from: '2026-11-20T00:00:00Z' });
  assert.equal(
    gateRules([rule], { type: 'publish', at: '2026-11-20T12:00:00Z' }).code,
    AUTHZ_CODES.RULE_BLOCKED,
  );
  assert.equal(
    gateRules([rule], { type: 'publish', at: '2026-11-19T12:00:00Z' }).ok,
    true,
  );
});

test('false and 0 deactivate a rule', () => {
  assert.deepEqual(gateRules([publishRule({ active: false })], 'publish'), {
    ok: true,
    applied: [],
  });
  assert.deepEqual(gateRules([publishRule({ active: 0 })], 'publish'), {
    ok: true,
    applied: [],
  });
  assert.deepEqual(gateRules([publishRule({ active: 'false' })], 'publish'), {
    ok: true,
    applied: [],
  });
});

test('multiple blockers are returned in deterministic identity order', () => {
  const result = gateRules(
    [
      publishRule({ id: 'rule-z' }),
      publishRule({ id: 'rule-a' }),
    ],
    'publish',
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.blocked_by.map((rule) => rule.id), ['rule-a', 'rule-z']);
  assert.equal(result.rule.id, 'rule-a');
  assert.deepEqual(result.applied.map((rule) => rule.id), ['rule-a', 'rule-z']);
});

test('the result is a copy and does not mutate the input rules', () => {
  const rule = publishRule();
  const result = gateRules([rule], 'publish');

  result.rule.text = 'changed';
  assert.equal(rule.text, 'No external publishing without human approval.');
});

test('malformed rules and actions throw TypeError', () => {
  assert.throws(() => gateRules(null, 'publish'), TypeError);
  assert.throws(() => gateRules([null], 'publish'), TypeError);
  assert.throws(() => gateRules([{ id: 'x', action: 'publish' }], 'publish'), TypeError);
  assert.throws(() => gateRules([publishRule({ kind: 'other' })], 'publish'), TypeError);
  assert.throws(() => gateRules([publishRule({ version: 0 })], 'publish'), TypeError);
  assert.throws(
    () => gateRules([publishRule({ scope: 'project', project: null })], 'publish'),
    TypeError,
  );
  assert.throws(() => gateRules([publishRule({ match: 'shell' })], 'publish'), TypeError);
  assert.throws(
    () => gateRules([publishRule({ effective_from: 'not-a-date' })], 'publish'),
    TypeError,
  );
  assert.throws(() => gateRules([publishRule()], null), TypeError);
  assert.throws(() => gateRules([publishRule()], { type: '' }), TypeError);
  assert.throws(() => gateRules([publishRule()], { type: 42 }), TypeError);
});
