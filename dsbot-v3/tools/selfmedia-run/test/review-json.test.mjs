import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeWriter, createRealReviewer, parseReview } from '../src/model.mjs';
import { createFixtureRetrieval, sha256Hex } from '../src/retrieval.mjs';
import { reviewArticle } from '../src/review.mjs';

const TOPIC = '测试选题';
const NOW = () => 1700000000000;
const LICENSE = { status: 'unauthorized', published: false };
const RUBRIC_IDS = ['factuality', 'sourcing', 'structure', 'readability', 'style', 'compliance'];

/** A complete, well-formed reviewer JSON payload. */
function fullReview() {
  const rubric = {};
  for (const id of RUBRIC_IDS) {
    rubric[id] = { score: 100, evidence: [`${id} 已核对`] };
  }
  return { rubric, issues: [], verdict: 'passed' };
}

/** A deterministic article that passes every local rubric item. */
async function passingArticle() {
  const retrieval = createFixtureRetrieval(TOPIC);
  const sources = retrieval.sources.map((source) => {
    const text = retrieval.documents.get(source.url) ?? '';
    return {
      ...source,
      fetched_at: '2026-11-20T10:00:00.000Z',
      sha256: sha256Hex(text),
      excerpt: text.slice(0, 280),
    };
  });
  const article = await createFakeWriter()({ topic: TOPIC, facts: retrieval.facts, sources });
  return { topic: TOPIC, article, facts: retrieval.facts, sources, sourceTexts: retrieval.documents };
}

function reviewFixture(modelReview) {
  return passingArticle().then((fixture) =>
    reviewArticle({ ...fixture, license: LICENSE, modelReview, now: NOW }),
  );
}

test('parseReview parses bare JSON directly', () => {
  const result = parseReview('{"verdict":"passed","score":97}');
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'direct');
  assert.deepEqual(result.value, { verdict: 'passed', score: 97 });
});

test('parseReview strips a ```json fenced block', () => {
  const result = parseReview('```json\n{"verdict":"passed"}\n```');
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'fence');
  assert.equal(result.value.verdict, 'passed');
});

test('parseReview strips a bare ``` fenced block', () => {
  const result = parseReview('```\n{"verdict":"rework"}\n```');
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'fence');
  assert.equal(result.value.verdict, 'rework');
});

test('parseReview slices the JSON object out of surrounding prose', () => {
  const text = '审校结论如下：\n{"verdict":"passed","rubric":{}}\n以上，请查收。';
  const result = parseReview(text);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'brace_slice');
  assert.equal(result.value.verdict, 'passed');
});

test('parseReview reports non-JSON text without throwing', () => {
  const result = parseReview('I think the article is fine.');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_json_object');
});

test('parseReview reports an unclosed object without throwing', () => {
  assert.doesNotThrow(() => parseReview('prefix {"verdict":"passed"'));
  const result = parseReview('prefix {"verdict":"passed"');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unclosed_json_object');
});

test('reviewer retries once after unparseable JSON and records retry_count=1', async () => {
  const prompts = [];
  const replies = ['抱歉，这是一段说明文字，不是 JSON。', JSON.stringify(fullReview())];
  const reviewer = createRealReviewer({
    chat: async (messages) => {
      prompts.push(messages);
      return { content: replies[prompts.length - 1], usage: null };
    },
  });

  const result = await reviewer({
    topic: TOPIC,
    article: { title_candidates: ['T1', 'T2', 'T3'], body: '# T' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });

  assert.equal(prompts.length, 2);
  assert.equal(result.__parse_error, undefined);
  assert.equal(result.retry_count, 1);
  assert.equal(result.parse_strategy, 'direct');
  assert.equal(result.verdict, 'passed');
  assert.equal(result.rubric.style.score, 100);

  const retryPrompt = prompts[1].at(-1);
  assert.equal(retryPrompt.role, 'user');
  assert.match(retryPrompt.content, /只输出 JSON/);
  assert.match(retryPrompt.content, /不要解释/);
});

test('three unparseable reviewer responses end in review_invalid_json rework', async () => {
  let calls = 0;
  const reviewer = createRealReviewer({
    chat: async () => {
      calls += 1;
      return { content: '抱歉，我无法给出评分。', usage: null };
    },
  });
  const modelReview = await reviewer({
    topic: TOPIC,
    article: { title_candidates: [], body: '' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });

  assert.equal(calls, 3);
  assert.equal(modelReview.__parse_error, true);
  assert.equal(modelReview.retry_count, 2);
  assert.equal(modelReview.repair_attempts, 2);
  assert.equal(modelReview.reason, 'no_json_object');

  const result = await reviewFixture(modelReview);
  assert.equal(result.verdict, 'rework');
  const issue = result.issues.find((entry) => entry.code === 'review_invalid_json');
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  assert.match(issue.message, /自动修复 2 次/);
});

test('a parsed review that omits rubric items still fails as rework', async () => {
  const incomplete = fullReview();
  incomplete.rubric = {
    factuality: { score: 100, evidence: ['事实已核对'] },
    style: { score: 100, evidence: ['文风已核对'] },
  };

  const result = await reviewFixture(incomplete);
  assert.equal(result.verdict, 'rework');
  const issue = result.issues.find((entry) => entry.code === 'review_rubric_incomplete');
  assert.ok(issue);
  assert.equal(issue.severity, 'critical');
  for (const id of ['sourcing', 'structure', 'readability', 'compliance']) {
    assert.ok(issue.evidence.missing_items.includes(id));
  }
});

test('a parsed review with missing rubric evidence still fails as rework', async () => {
  const incomplete = fullReview();
  incomplete.rubric.readability = { score: 100 };

  const result = await reviewFixture(incomplete);
  assert.equal(result.verdict, 'rework');
  const issue = result.issues.find((entry) => entry.code === 'review_evidence_missing');
  assert.ok(issue);
  assert.deepEqual(issue.evidence.missing_evidence, ['readability']);
});

test('a parsed review with string evidence is accepted as complete', async () => {
  const review = fullReview();
  review.rubric.readability = { score: 100, evidence: '可读性已核对' };

  const result = await reviewFixture(review);
  assert.equal(result.verdict, 'passed');
  const readability = result.rubric.find((item) => item.id === 'readability');
  assert.deepEqual(readability.evidence.independent_model.evidence, ['可读性已核对']);
});

test('a complete parsed review can still pass and exposes retry metadata', async () => {
  const result = await reviewFixture({ ...fullReview(), retry_count: 1, parse_strategy: 'fence' });
  assert.equal(result.verdict, 'passed');
  assert.equal(result.issues.length, 0);
  assert.equal(result.evidence.reviewer_retry_count, 1);
  assert.equal(result.evidence.reviewer_parse_strategy, 'fence');
});

test('reviewer system prompt pins strict JSON and a numbered rubric checklist', async () => {
  const prompts = [];
  const reviewer = createRealReviewer({
    chat: async (messages) => {
      prompts.push(messages);
      return { content: JSON.stringify(fullReview()), usage: null };
    },
  });
  await reviewer({
    topic: TOPIC,
    article: { title_candidates: ['T1'], body: '# T' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });

  const system = prompts[0][0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /只输出一个 JSON 对象/);
  assert.match(system.content, /不要 markdown/);
  assert.match(system.content, /不要解释/);
  assert.match(system.content, /事实核查口径/);
  RUBRIC_IDS.forEach((id, index) => {
    assert.ok(system.content.includes(`${index + 1}. ${id}`), `numbered checklist item ${id}`);
    assert.ok(system.content.includes(`"${id}": {"score"`), `rubric schema field ${id}`);
    assert.ok(system.content.includes(`"item": "${id}", "status": "pass"`), `checks schema item ${id}`);
  });
  assert.match(system.content, /"status": "pass\|warn\|fail"/);
  assert.match(system.content, /"verdict"/);
});

test('reviewer feeds the previous output back for the first repair', async () => {
  const prompts = [];
  const first = '抱歉，这是一段说明文字，不是 JSON。';
  const reviewer = createRealReviewer({
    chat: async (messages) => {
      prompts.push(messages);
      return {
        content: prompts.length === 1 ? first : JSON.stringify(fullReview()),
        usage: null,
      };
    },
  });

  const result = await reviewer({
    topic: TOPIC,
    article: { title_candidates: ['T1'], body: '# T' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });

  assert.equal(prompts.length, 2);
  const repair = prompts[1];
  const assistant = repair.find((message) => message.role === 'assistant');
  assert.ok(assistant, 'previous reviewer output is fed back as an assistant message');
  assert.equal(assistant.content, first);
  const instruction = repair.at(-1);
  assert.equal(instruction.role, 'user');
  assert.match(instruction.content, /只把上面的评审改写为 JSON/);
  assert.match(instruction.content, /不要新增内容/);
  assert.match(instruction.content, /只输出 JSON/);
  assert.equal(result.retry_count, 1);
  assert.equal(result.verdict, 'passed');
});

test('a second repair succeeds after two unparseable responses (three calls)', async () => {
  const prompts = [];
  const replies = ['第一段不是 JSON。', '第二段仍然不是 JSON。', JSON.stringify(fullReview())];
  const reviewer = createRealReviewer({
    chat: async (messages) => {
      prompts.push(messages);
      return { content: replies[prompts.length - 1], usage: null };
    },
  });

  const result = await reviewer({
    topic: TOPIC,
    article: { title_candidates: ['T1'], body: '# T' },
    facts: [],
    sources: [],
    sourceTexts: new Map(),
  });

  assert.equal(prompts.length, 3);
  assert.ok(
    prompts[1].some((message) => message.role === 'assistant' && message.content === replies[0]),
    'the first raw response is fed back for repair 1',
  );
  const finalRepair = prompts[2];
  assert.ok(
    finalRepair.some((message) => message.role === 'assistant' && message.content === replies[1]),
    'the second raw response is fed back for repair 2',
  );
  const instruction = finalRepair.at(-1);
  assert.match(instruction.content, /格式修复/);
  assert.match(instruction.content, /"rubric"/);
  assert.match(instruction.content, /"checks"/);
  assert.equal(result.retry_count, 2);
  assert.equal(result.repair_attempts, 2);
  assert.equal(result.parse_strategy, 'direct');
  assert.equal(result.verdict, 'passed');
});

test('reviewer checks are accepted and recorded with the parsed review', async () => {
  const checks = RUBRIC_IDS.map((id) => ({ item: id, status: 'pass', evidence: `${id} ok` }));
  const result = await reviewFixture({ ...fullReview(), checks, retry_count: 1, repair_attempts: 1 });

  assert.equal(result.verdict, 'passed');
  assert.equal(result.evidence.reviewer_checks.length, RUBRIC_IDS.length);
  assert.deepEqual(result.evidence.reviewer_checks[0], {
    item: 'factuality',
    status: 'pass',
    evidence: ['factuality ok'],
  });
  assert.equal(result.evidence.reviewer_repair_attempts, 1);
});

test('parseReview accepts the strict reviewer payload including checks', () => {
  const payload = JSON.stringify({
    rubric: { factuality: { score: 90, evidence: ['数字可核对'] } },
    checks: [{ item: 'factuality', status: 'pass', evidence: '数字可核对' }],
    issues: [],
    verdict: 'passed',
  });
  const result = parseReview(payload);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'direct');
  assert.equal(result.value.checks[0].item, 'factuality');
});
