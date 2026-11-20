import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHZ_CODES, effectiveScope } from '../src/index.js';

const PARENT = {
  projects: ['ai-video', 'gd-customer-service'],
  paths: ['scripts/m0_slice/', 'docs/'],
  tools: ['read', 'write', 'shell'],
  spend_cny_cap: 200,
  max_parallel_runs: 2,
  max_delegate_level: 'business',
  git: { branch_prefix: 'feat/', can_merge: false, can_push: true },
};

const CHILD = {
  projects: ['ai-video'],
  paths: ['scripts/m0_slice/authz/'],
  tools: ['read'],
  spend_cny_cap: 50,
  max_parallel_runs: 1,
  max_delegate_level: 'execution',
  git: { branch_prefix: 'feat/authz-', can_merge: false, can_push: false },
};

test('a child scope inside the parent is accepted and returned as effective', () => {
  const result = effectiveScope(PARENT, CHILD);

  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.deepEqual(result.scope, {
    projects: ['ai-video'],
    paths: ['scripts/m0_slice/authz/'],
    tools: ['read'],
    spend_cny_cap: 50,
    max_parallel_runs: 1,
    max_delegate_level: 'execution',
    git: { branch_prefix: 'feat/authz-', can_merge: false, can_push: false },
  });
});

test('an omitted child dimension inherits the parent value', () => {
  const result = effectiveScope(
    { projects: ['ai-video'], spend_cny_cap: 10, git: { can_push: true } },
    {},
  );

  assert.deepEqual(result, {
    ok: true,
    scope: {
      projects: ['ai-video'],
      spend_cny_cap: 10,
      git: { can_merge: false, can_push: true },
    },
  });
});

test('a parent without a dimension is unconstrained, so the child may add a restriction', () => {
  const result = effectiveScope(
    {},
    {
      projects: ['ai-video'],
      paths: ['docs/'],
      tools: ['read'],
      spend_cny_cap: 5,
      max_parallel_runs: 1,
      max_delegate_level: 'execution',
      git: { branch_prefix: 'feat/x-', can_merge: false, can_push: false },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    scope: {
      projects: ['ai-video'],
      paths: ['docs/'],
      tools: ['read'],
      spend_cny_cap: 5,
      max_parallel_runs: 1,
      max_delegate_level: 'execution',
      git: { branch_prefix: 'feat/x-', can_merge: false, can_push: false },
    },
  });
});

test('an empty child list is a valid narrowing', () => {
  const result = effectiveScope({ projects: ['ai-video'] }, { projects: [] });
  assert.deepEqual(result, { ok: true, scope: { projects: [] } });
});

test('null scopes are treated as empty objects', () => {
  assert.deepEqual(effectiveScope(null, { projects: ['ai-video'] }), {
    ok: true,
    scope: { projects: ['ai-video'] },
  });
  assert.deepEqual(effectiveScope(PARENT, null), { ok: true, scope: PARENT });
});

test('adding a project outside the parent is authorization_exceeded', () => {
  const result = effectiveScope(PARENT, {
    ...CHILD,
    projects: ['ai-video', 'other-project'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AUTHZ_CODES.AUTHORIZATION_EXCEEDED);
  assert.deepEqual(result.violations, [
    {
      dimension: 'projects',
      reason: 'not_subset',
      parent: PARENT.projects,
      child: ['ai-video', 'other-project'],
      offending: ['other-project'],
    },
  ]);
});

test('paths are prefixes: a deeper path is inside a parent directory grant', () => {
  const result = effectiveScope(
    { paths: ['scripts/m0_slice/', 'README.md'] },
    { paths: ['scripts/m0_slice/authz/src/scope.js', 'README.md'] },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.scope.paths, [
    'scripts/m0_slice/authz/src/scope.js',
    'README.md',
  ]);
});

test('a path outside the parent grant is authorization_exceeded', () => {
  const result = effectiveScope(
    { paths: ['scripts/m0_slice/'] },
    { paths: ['scripts/m0_slice/authz/', 'tools/verify/'] },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    {
      dimension: 'paths',
      reason: 'not_subset',
      parent: ['scripts/m0_slice/'],
      child: ['scripts/m0_slice/authz/', 'tools/verify/'],
      offending: ['tools/verify/'],
    },
  ]);
});

test('a file path without a trailing slash is exact, not a prefix', () => {
  assert.equal(effectiveScope({ paths: ['README.md'] }, { paths: ['README.md.bak'] }).ok, false);
  assert.equal(effectiveScope({ paths: ['README.md'] }, { paths: ['README.md'] }).ok, true);
});

test('adding a tool outside the parent is authorization_exceeded', () => {
  const result = effectiveScope({ tools: ['read'] }, { tools: ['read', 'shell'] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations[0].dimension, 'tools');
  assert.deepEqual(result.violations[0].offending, ['shell']);
});

test('caps may only go down', () => {
  assert.equal(effectiveScope({ spend_cny_cap: 10 }, { spend_cny_cap: 10 }).ok, true);
  assert.equal(effectiveScope({ spend_cny_cap: 10 }, { spend_cny_cap: 9 }).ok, true);

  const overCap = effectiveScope({ spend_cny_cap: 10 }, { spend_cny_cap: 11 });
  assert.equal(overCap.ok, false);
  assert.deepEqual(overCap.violations, [
    { dimension: 'spend_cny_cap', reason: 'cap_exceeds_parent', parent: 10, child: 11 },
  ]);

  const overParallel = effectiveScope({ max_parallel_runs: 2 }, { max_parallel_runs: 3 });
  assert.equal(overParallel.ok, false);
  assert.equal(overParallel.violations[0].dimension, 'max_parallel_runs');
});

test('the delegation level may only stay at or below the parent', () => {
  assert.equal(
    effectiveScope({ max_delegate_level: 'business' }, { max_delegate_level: 'execution' }).ok,
    true,
  );
  assert.equal(
    effectiveScope({ max_delegate_level: 'business' }, { max_delegate_level: 'business' }).ok,
    true,
  );

  const raised = effectiveScope(
    { max_delegate_level: 'execution' },
    { max_delegate_level: 'business' },
  );
  assert.equal(raised.ok, false);
  assert.deepEqual(raised.violations, [
    {
      dimension: 'max_delegate_level',
      reason: 'level_exceeds_parent',
      parent: 'execution',
      child: 'business',
    },
  ]);
});

test('git.can_merge is always false (AR-6)', () => {
  const result = effectiveScope(PARENT, {
    git: { can_merge: true, can_push: false },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { dimension: 'git.can_merge', reason: 'merge_not_allowed', parent: false, child: true },
  ]);
});

test('git.can_push requires an explicit parent grant and cannot be invented', () => {
  assert.equal(
    effectiveScope({ git: { can_push: true } }, { git: { can_push: true } }).scope.git.can_push,
    true,
  );
  assert.equal(
    effectiveScope({ git: { can_push: false } }, { git: { can_push: false } }).scope.git.can_push,
    false,
  );

  const denied = effectiveScope({}, { git: { can_push: true } });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.violations, [
    { dimension: 'git.can_push', reason: 'not_subset', parent: false, child: true },
  ]);

  const lowered = effectiveScope({ git: { can_push: true } }, { git: { can_push: false } });
  assert.equal(lowered.ok, true);
  assert.equal(lowered.scope.git.can_push, false);
});

test('a branch prefix must stay inside the parent prefix', () => {
  assert.equal(
    effectiveScope(
      { git: { branch_prefix: 'feat/' } },
      { git: { branch_prefix: 'feat/authz-' } },
    ).ok,
    true,
  );

  const outside = effectiveScope(
    { git: { branch_prefix: 'feat/' } },
    { git: { branch_prefix: 'hotfix/' } },
  );
  assert.equal(outside.ok, false);
  assert.deepEqual(outside.violations[0], {
    dimension: 'git.branch_prefix',
    reason: 'not_subset',
    parent: 'feat/',
    child: 'hotfix/',
  });
});

test('unknown capability keys cannot be introduced by the child', () => {
  const result = effectiveScope({ projects: ['ai-video'] }, { projects: ['ai-video'], debug: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { dimension: 'debug', reason: 'unknown_key', child: true },
  ]);
});

test('unknown keys already granted by the parent may be narrowed', () => {
  const result = effectiveScope(
    { limits: { cpu: 4, memory: 8 }, note: 'parent' },
    { limits: { cpu: 2 } },
  );

  assert.deepEqual(result, {
    ok: true,
    scope: { limits: { cpu: 2 }, note: 'parent' },
  });
});

test('a broader unknown value is authorization_exceeded', () => {
  const result = effectiveScope({ limits: { cpu: 2 } }, { limits: { cpu: 4 } });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].dimension, 'limits');
  assert.equal(result.violations[0].reason, 'not_subset');
});

test('unknown git keys follow the same subset rule', () => {
  assert.equal(
    effectiveScope({ git: { protect: true } }, { git: { protect: true } }).ok,
    true,
  );
  const introduced = effectiveScope({}, { git: { protect: true } });
  assert.equal(introduced.ok, false);
  assert.equal(introduced.violations[0].dimension, 'git.protect');
  assert.equal(introduced.violations[0].reason, 'unknown_key');
});

test('multiple violations are all reported', () => {
  const result = effectiveScope(
    { ...PARENT, git: { ...PARENT.git, can_push: false } },
    {
      projects: ['nope'],
      spend_cny_cap: 999,
      git: { branch_prefix: 'hotfix/', can_merge: true, can_push: true },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((entry) => entry.dimension),
    ['projects', 'spend_cny_cap', 'git.branch_prefix', 'git.can_merge', 'git.can_push'],
  );
});

test('does not mutate the input scopes', () => {
  const parent = { ...PARENT, git: { ...PARENT.git } };
  const child = { ...CHILD, git: { ...CHILD.git } };
  const parentBefore = JSON.stringify(parent);
  const childBefore = JSON.stringify(child);

  const result = effectiveScope(parent, child);
  result.scope.projects.push('mutated-after-the-fact');

  assert.equal(JSON.stringify(parent), parentBefore);
  assert.equal(JSON.stringify(child), childBefore);
});

test('malformed scopes throw TypeError instead of silently passing', () => {
  assert.throws(() => effectiveScope([], {}), TypeError);
  assert.throws(() => effectiveScope({ projects: 'ai-video' }, {}), TypeError);
  assert.throws(() => effectiveScope({ paths: [42] }, {}), TypeError);
  assert.throws(
    () => effectiveScope({ paths: ['scripts/'] }, { paths: ['scripts/../secrets/'] }),
    TypeError,
  );
  assert.throws(() => effectiveScope({ spend_cny_cap: -1 }, {}), TypeError);
  assert.throws(() => effectiveScope({ spend_cny_cap: Number.POSITIVE_INFINITY }, {}), TypeError);
  assert.throws(() => effectiveScope({ max_delegate_level: 'ceo' }, {}), TypeError);
  assert.throws(() => effectiveScope({ git: { branch_prefix: 1 } }, {}), TypeError);
  assert.throws(() => effectiveScope({ git: { can_push: 'yes' } }, {}), TypeError);
});
