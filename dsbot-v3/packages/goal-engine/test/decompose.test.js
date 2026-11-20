import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decompose,
  defaultTemplate,
  ERROR_CODES,
  SECTION_KEYS,
  SECTION_TITLES,
} from '../src/index.js';
import {
  BASE_SHA,
  deepFreeze,
  expectCode,
  goal,
  input,
  lane,
  OTHER_SHA,
} from './helpers.js';

test('decompose returns the documented milestone/lane/taskBook shape', () => {
  const result = decompose(input());

  assert.deepEqual(Object.keys(result), ['milestones']);
  assert.equal(result.milestones.length, 2);
  for (const milestone of result.milestones) {
    assert.deepEqual(Object.keys(milestone), ['id', 'title', 'lanes']);
    assert.equal(typeof milestone.id, 'string');
    assert.equal(typeof milestone.title, 'string');
    for (const entry of milestone.lanes) {
      assert.deepEqual(Object.keys(entry), ['lane', 'dir', 'taskBook']);
      assert.equal(typeof entry.lane, 'string');
      assert.equal(typeof entry.dir, 'string');
      assert.equal(typeof entry.taskBook, 'object');
    }
  }
});

test('every task book carries the six sections, the headings and the base sha', () => {
  const result = decompose(input());

  for (const milestone of result.milestones) {
    for (const { taskBook } of milestone.lanes) {
      for (const key of SECTION_KEYS) {
        assert.ok(Object.hasOwn(taskBook, key), `missing section ${key}`);
      }
      for (const title of Object.values(SECTION_TITLES)) {
        assert.ok(taskBook.markdown.includes(`## ${title}`), `missing heading ${title}`);
      }
      assert.equal(taskBook.workBase.sha, BASE_SHA);
      assert.ok(taskBook.markdown.includes(BASE_SHA));
    }
  }
});

test('PRD references from prdIndex are resolved into the background', () => {
  const result = decompose(input());
  const engine = result.milestones[0].lanes[0].taskBook;
  const docs = result.milestones[1].lanes[0].taskBook;

  assert.match(engine.background, /03 验收规范/);
  assert.match(engine.background, /docs\/prd\/03-acceptance-spec\.md/);
  assert.match(docs.background, /06 测试矩阵/);
  assert.match(docs.background, /docs\/prd\/06-test-matrix\.md/);
});

test('lanes are grouped under their milestones in declared order', () => {
  const result = decompose(input());

  assert.deepEqual(result.milestones.map((milestone) => milestone.id), ['m1', 'm2']);
  assert.deepEqual(
    result.milestones.map((milestone) => milestone.lanes.map((entry) => entry.lane)),
    [['engine'], ['docs']],
  );
});

test('lane defaults fill forbidden, acceptance commands, minCases and allowed paths', () => {
  const result = decompose({
    goal: { title: '单 lane 目标', baseSha: BASE_SHA },
    lanes: [{ lane: 'solo', dir: 'packages/solo', cost: 1 }],
    budget: 1,
  });
  const [milestone] = result.milestones;
  const [{ taskBook }] = milestone.lanes;

  assert.equal(milestone.id, 'm1');
  assert.equal(milestone.title, '单 lane 目标');
  assert.deepEqual(taskBook.allowedPaths, ['packages/solo/**']);
  assert.deepEqual(taskBook.acceptanceCommands, ['node --test packages/solo/test']);
  assert.equal(taskBook.minCases, 1);
  assert.ok(taskBook.forbidden.length > 0);
  assert.equal(taskBook.workBase.ref, 'origin/main');
});

test('an injected template function controls the generated sections', () => {
  const custom = (context) => ({
    ...defaultTemplate(context),
    background: `CUSTOM ${context.goal.title} / ${context.lane.lane}`,
    minCases: 42,
  });

  const result = decompose(input({ template: custom }));
  const taskBook = result.milestones[0].lanes[0].taskBook;

  assert.equal(taskBook.background, 'CUSTOM 交付目标引擎 / engine');
  assert.equal(taskBook.minCases, 42);
  assert.ok(taskBook.markdown.includes('CUSTOM 交付目标引擎 / engine'));
});

test('an object template with render(context) is accepted', () => {
  const template = {
    render(context) {
      return { ...defaultTemplate(context), background: `OBJECT ${context.milestone.id}` };
    },
  };
  const result = decompose(input({ template }));

  assert.match(result.milestones[0].lanes[0].taskBook.background, /^OBJECT m1/);
});

test('a template that omits a section fails with invalid_task_book', () => {
  const template = (context) => {
    const book = defaultTemplate(context);
    delete book.minCases;
    return book;
  };

  expectCode(
    () => decompose(input({ template })),
    ERROR_CODES.invalidTaskBook,
    'missing minCases must be rejected',
  );
});

test('the same frozen input always yields the same result and is not mutated', () => {
  const frozen = deepFreeze(input());
  const before = JSON.stringify(frozen);

  const first = decompose(frozen);
  const second = decompose(frozen);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(frozen), before);
});

test('only milestones that own a lane are returned', () => {
  const result = decompose(input({
    goal: goal({
      milestones: [
        { id: 'm1', title: '核心引擎' },
        { id: 'm2', title: '验证' },
        { id: 'm3', title: '空里程碑' },
      ],
    }),
    lanes: [lane()],
  }));

  assert.deepEqual(result.milestones.map((milestone) => milestone.id), ['m1']);
});

test('directories are normalized before reaching the task book', () => {
  const result = decompose(input({
    goal: goal({ milestones: [] }),
    lanes: [lane({
      dir: 'packages\\goal-engine\\',
      milestone: undefined,
      allowedPaths: undefined,
    })],
  }));
  const [entry] = result.milestones[0].lanes;

  assert.equal(entry.dir, 'packages/goal-engine');
  assert.deepEqual(entry.taskBook.allowedPaths, ['packages/goal-engine/**']);
});

test('a lane-level base sha overrides the goal base sha', () => {
  const result = decompose(input({
    lanes: [lane({ baseSha: OTHER_SHA })],
  }));

  assert.equal(result.milestones[0].lanes[0].taskBook.workBase.sha, OTHER_SHA);
});
