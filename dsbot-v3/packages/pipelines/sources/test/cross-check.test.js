import assert from 'node:assert/strict';
import test from 'node:test';

import { CROSS_CHECK_FIELDS, crossCheck, sha256Hex } from '../src/index.js';

const SUMMARY = 'The same finding, reported by two sources.';

function item(overrides = {}) {
  const summary = overrides.summary ?? SUMMARY;
  return {
    id: 'source-a-1',
    title: 'The same headline',
    summary,
    sourceName: 'Source A',
    sourceUrl: 'https://a.example/story/1',
    publishedAt: '2026-11-20T10:00:00.000Z',
    contentHash: sha256Hex(summary),
    ...overrides,
  };
}

test('crossCheck: agrees when title, instant and subject match', () => {
  const first = item({
    title: 'The  same\nheadline',
    summary: 'The same finding,  reported by two sources.',
  });
  const second = item({
    id: 'source-b-9',
    title: 'The same headline',
    summary: SUMMARY,
    sourceName: 'Source B',
    sourceUrl: 'https://b.example/story/9',
    publishedAt: '2026-11-20T18:00:00+08:00',
  });

  assert.deepEqual(crossCheck({ item: first, second }), { agree: true, conflicts: [] });
});

test('crossCheck: a different title is a title conflict', () => {
  const result = crossCheck({
    item: item(),
    second: item({ title: 'A different headline' }),
  });

  assert.equal(result.agree, false);
  assert.deepEqual(result.conflicts, [
    { field: 'title', a: 'The same headline', b: 'A different headline' },
  ]);
});

test('crossCheck: different instants are a publishedAt conflict', () => {
  const result = crossCheck({
    item: item(),
    second: item({ publishedAt: '2026-11-20T11:00:00.000Z' }),
  });

  assert.equal(result.agree, false);
  assert.deepEqual(result.conflicts, [
    {
      field: 'publishedAt',
      a: '2026-11-20T10:00:00.000Z',
      b: '2026-11-20T11:00:00.000Z',
    },
  ]);
});

test('crossCheck: a different subject is a subject conflict', () => {
  const result = crossCheck({
    item: item(),
    second: item({ summary: 'A different finding.' }),
  });

  assert.equal(result.agree, false);
  assert.deepEqual(result.conflicts, [
    {
      field: 'subject',
      a: SUMMARY,
      b: 'A different finding.',
    },
  ]);
});

test('crossCheck: every difference is reported, in title/time/subject order', () => {
  const result = crossCheck({
    item: item(),
    second: item({
      title: 'Elsewhere',
      summary: 'Elsewhere summary.',
      publishedAt: '2026-11-21T10:00:00.000Z',
    }),
  });

  assert.equal(result.agree, false);
  assert.deepEqual(
    result.conflicts.map((conflict) => conflict.field),
    [...CROSS_CHECK_FIELDS],
  );
});

test('crossCheck: a field present on one side only is a conflict; both missing is not', () => {
  const first = item();
  const second = item({ title: undefined });

  const withMissing = crossCheck({ item: first, second });
  assert.deepEqual(withMissing.conflicts, [
    { field: 'title', a: 'The same headline', b: undefined },
  ]);

  const bothMissing = crossCheck({
    item: item({ title: undefined }),
    second: item({ title: undefined }),
  });
  assert.deepEqual(bothMissing, { agree: true, conflicts: [] });
});

test('crossCheck: an equal summary hash proves the subject when the text is absent', () => {
  const result = crossCheck({
    item: item(),
    second: item({ summary: undefined, contentHash: sha256Hex(SUMMARY) }),
  });

  assert.deepEqual(result, { agree: true, conflicts: [] });
});

test('crossCheck: invalid input is a TypeError, not a conflict list', () => {
  assert.throws(() => crossCheck(null), TypeError);
  assert.throws(() => crossCheck({ item: item() }), TypeError);
  assert.throws(() => crossCheck({ item: item(), second: 'source' }), TypeError);
});
