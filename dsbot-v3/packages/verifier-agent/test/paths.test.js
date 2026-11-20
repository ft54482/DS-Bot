import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFullSha,
  normalizeAllowedDir,
  outOfScope,
} from '../src/index.js';

test('scope: exact directory and nested files are allowed', () => {
  assert.deepEqual(
    outOfScope(
      [
        'packages/verifier-agent/package.json',
        'packages/verifier-agent/src/verify.js',
        'packages/verifier-agent/test/verify.test.js',
      ],
      ['packages/verifier-agent'],
    ),
    [],
  );
});

test('scope: a sibling directory sharing the prefix is outside', () => {
  assert.deepEqual(
    outOfScope(
      ['packages/verifier-agent-other/src/verify.js'],
      ['packages/verifier-agent'],
    ),
    ['packages/verifier-agent-other/src/verify.js'],
  );
});

test('scope: ./ prefixes, backslashes and trailing slashes normalize', () => {
  assert.deepEqual(normalizeAllowedDir('./packages\\verifier-agent/'), 'packages/verifier-agent');
  assert.deepEqual(
    outOfScope(
      ['./packages\\verifier-agent/src/a.js', 'packages/verifier-agent/b.js'],
      ['packages/verifier-agent/'],
    ),
    [],
  );
});

test('scope: traversal, absolute-looking and non-string entries are outside', () => {
  assert.deepEqual(
    outOfScope(
      [
        'packages/verifier-agent/../secret.txt',
        'docs/prd/00-PRD.md',
        'packages/other/x.js',
        'packages/other/x.js',
        '/etc/passwd',
        null,
      ],
      ['packages/verifier-agent'],
    ),
    [
      '/etc/passwd',
      'docs/prd/00-PRD.md',
      'null',
      'packages/other/x.js',
      'packages/verifier-agent/../secret.txt',
    ],
  );
});

test('scope: a complete sha is required and short shas are rejected', () => {
  assert.equal(isFullSha('a'.repeat(40)), true);
  assert.equal(isFullSha('A'.repeat(40)), true);
  assert.equal(isFullSha('a'.repeat(39)), false);
  assert.equal(isFullSha('a'.repeat(41)), false);
  assert.equal(isFullSha(undefined), false);
});
