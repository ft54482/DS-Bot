import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultTemplate,
  ERROR_CODES,
  renderTaskBook,
  SECTION_KEYS,
  SECTION_TITLES,
  validateTaskBook,
} from '../src/index.js';
import { BASE_SHA, expectCode, validBook } from './helpers.js';

test('validateTaskBook accepts a complete book and returns it', () => {
  const book = validBook();

  assert.equal(validateTaskBook(book), book);
});

test('each missing section fails with invalid_task_book and names the section', () => {
  for (const key of SECTION_KEYS) {
    const book = validBook();
    delete book[key];
    assert.throws(
      () => validateTaskBook(book, { lane: 'engine' }),
      (error) => {
        assert.equal(error.code, ERROR_CODES.invalidTaskBook);
        assert.equal(error.details.section, key);
        assert.equal(error.details.lane, 'engine');
        return true;
      },
      `missing ${key} must be rejected`,
    );
  }
});

test('workBase requires a full 40-hex base sha', () => {
  for (const workBase of [
    undefined,
    {},
    { sha: 'abc' },
    { sha: 'z'.repeat(40) },
    { sha: BASE_SHA, ref: '' },
  ]) {
    expectCode(
      () => validateTaskBook(validBook({ workBase })),
      ERROR_CODES.invalidTaskBook,
      `workBase ${JSON.stringify(workBase)} must be rejected`,
    );
  }
});

test('minCases must be a positive integer', () => {
  for (const minCases of [0, -1, 1.5, '12', null, undefined]) {
    expectCode(
      () => validateTaskBook(validBook({ minCases })),
      ERROR_CODES.invalidTaskBook,
      `minCases ${String(minCases)} must be rejected`,
    );
  }
});

test('list sections may not be empty', () => {
  for (const key of ['allowedPaths', 'forbidden', 'acceptanceCommands']) {
    expectCode(
      () => validateTaskBook(validBook({ [key]: [] })),
      ERROR_CODES.invalidTaskBook,
      `empty ${key} must be rejected`,
    );
  }
});

test('renderTaskBook emits the six headings in canonical order', () => {
  const markdown = renderTaskBook(validBook());
  const positions = Object.values(SECTION_TITLES).map((title) => markdown.indexOf(`## ${title}`));

  assert.ok(positions.every((position) => position >= 0), 'every heading must exist');
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], 'headings must keep their order');
  }
  assert.match(markdown, new RegExp(BASE_SHA));
  assert.match(markdown, /node --test packages\/goal-engine\/test/);
});

test('renderTaskBook refuses an invalid book', () => {
  expectCode(
    () => renderTaskBook(validBook({ background: '   ' })),
    ERROR_CODES.invalidTaskBook,
  );
});

test('defaultTemplate builds all six sections from the normalized context', () => {
  const context = {
    goal: {
      id: 'g1',
      title: '交付目标引擎',
      background: '目标背景说明',
      acceptance: [],
    },
    lane: {
      lane: 'engine',
      dir: 'packages/goal-engine',
      allowedPaths: ['packages/goal-engine/**'],
      forbidden: ['白名单外写入'],
      acceptanceCommands: ['node --test packages/goal-engine/test'],
      minCases: 7,
      baseRef: 'origin/main',
      background: '',
    },
    milestone: { id: 'm1', title: '核心引擎' },
    prd: [{ id: '03', title: '验收规范', path: 'docs/prd/03-acceptance-spec.md' }],
    baseSha: BASE_SHA,
  };

  const book = defaultTemplate(context);

  assert.deepEqual(Object.keys(book), [...SECTION_KEYS]);
  assert.match(book.background, /交付目标引擎/);
  assert.match(book.background, /目标背景说明/);
  assert.match(book.background, /03 验收规范/);
  assert.match(book.background, /docs\/prd\/03-acceptance-spec\.md/);
  assert.deepEqual(book.allowedPaths, ['packages/goal-engine/**']);
  assert.deepEqual(book.workBase, { sha: BASE_SHA, ref: 'origin/main' });
  assert.deepEqual(book.forbidden, ['白名单外写入']);
  assert.deepEqual(book.acceptanceCommands, ['node --test packages/goal-engine/test']);
  assert.equal(book.minCases, 7);
});

test('a lane background overrides the goal background in the default template', () => {
  const book = defaultTemplate({
    goal: { id: 'g', title: 'T', background: 'G', acceptance: [] },
    lane: {
      lane: 'x',
      dir: 'packages/x',
      allowedPaths: ['packages/x/**'],
      forbidden: ['f'],
      acceptanceCommands: ['c'],
      minCases: 1,
      baseRef: 'origin/main',
      background: 'LANE',
    },
    milestone: { id: 'm1', title: 'M' },
    prd: [],
    baseSha: BASE_SHA,
  });

  assert.match(book.background, /背景：LANE/);
  assert.doesNotMatch(book.background, /背景：G/);
});
