import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { readJson, readText, runInTemp } from './support.js';

test('demo: writes demo-report.json, article.md and publish-package.json', async (t) => {
  const { outDir, reportPath, packagePath, articlePath, report } = await runInTemp(t);

  await access(reportPath);
  await access(packagePath);
  await access(articlePath);
  assert.equal(reportPath, join(outDir, 'demo-report.json'));
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.summary, '10/10 checks passed');

  const written = await readJson(reportPath);
  assert.deepEqual(written, JSON.parse(JSON.stringify(report)));

  const article = await readText(articlePath);
  assert.ok(article.includes('Why long AI chats make work messier'));
});

test('demo: reports every flow step in order with a duration and task id', async (t) => {
  const { report } = await runInTemp(t);
  const ids = report.steps.map((step) => step.id);

  assert.deepEqual(ids, [
    'create-goal',
    'delegate-business',
    'plan-execution',
    'dispatch-mock',
    'selfmedia-pilot',
    'acceptance',
    'publish-package',
    'verify',
  ]);
  assert.equal(report.steps.length, 8);
  for (const step of report.steps) {
    assert.equal(step.status, 'passed', `${step.id} should pass`);
    assert.equal(Number.isFinite(step.duration_ms), true, `${step.id} duration_ms`);
    assert.ok(step.duration_ms >= 0, `${step.id} duration_ms >= 0`);
    assert.equal(typeof step.task_id, 'string', `${step.id} task_id`);
  }
});

test('demo: builds the goal -> business -> execution tree', async (t) => {
  const { report } = await runInTemp(t);

  assert.equal(report.ids.goal, report.flow.goal.id);
  assert.equal(report.ids.business, report.flow.business.id);
  assert.equal(report.ids.execution, report.flow.execution.id);
  assert.equal(report.flow.goal.level, 'goal');
  assert.equal(report.flow.business.level, 'business');
  assert.equal(report.flow.business.parent_task_id, report.flow.goal.id);
  assert.equal(report.flow.execution.level, 'execution');
  assert.equal(report.flow.execution.parent_task_id, report.flow.business.id);
  assert.equal(report.flow.goal.state, 'queued');
  assert.equal(report.flow.business.state, 'queued');
});

test('demo: mock dispatch completes and the execution acceptance passes', async (t) => {
  const { report } = await runInTemp(t);

  assert.equal(report.flow.run.executor_kind, 'mock');
  assert.equal(report.flow.run.mock_state, 'completed');
  assert.equal(report.flow.run.state, 'accepted');
  assert.equal(report.flow.execution.state, 'completed');
  assert.equal(report.flow.acceptance.state, 'passed');
  assert.equal(report.flow.acceptance.verdict, 'pass');
  assert.equal(report.flow.acceptance.decided_by, 'acceptance_service');
  assert.ok(report.flow.acceptance.items.length >= 6);
  assert.ok(report.flow.acceptance.items.every((item) => item.state === 'pass'));
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.checks.find((check) => check.id === 'runtime_acceptance').ok, true);
});

test('demo: self-media pilot runs offline on injected search/fetch/model stubs', async (t) => {
  const { report } = await runInTemp(t);

  assert.equal(report.pilot.review_result, 'pass');
  assert.equal(report.pilot.acceptance_result, 'pass');
  assert.equal(report.pilot.rework_rounds, 0);
  assert.equal(report.pilot.sources.length, 2);
  assert.equal(report.external_calls.mode, 'stubbed');
  assert.deepEqual(report.external_calls.executors, ['mock']);
  assert.equal(report.external_calls.search, 1);
  assert.equal(report.external_calls.fetch, 2);
  assert.equal(report.external_calls.model_write, 1);
  assert.equal(report.external_calls.model_review, 1);
  assert.deepEqual(report.external_calls.unexpected_urls, []);
  assert.deepEqual(
    report.external_calls.fetched_urls,
    report.pilot.sources,
    'the pilot fetched exactly the sources it reports',
  );
  assert.equal(report.cost.recorded, true);
  assert.equal(report.cost.usage.source, 'mock');
});

test('demo: publish package is ready for review but license is unauthorized', async (t) => {
  const { report, packagePath } = await runInTemp(t);
  const packageDoc = await readJson(packagePath);

  assert.equal(report.publish_package.status, 'ready_for_review');
  assert.equal(report.publish_package.license_status, 'unauthorized');
  assert.equal(report.publish_package.license.allowed, false);
  assert.equal(report.publish_package.license.authorization, null);
  assert.deepEqual(report.publish_package.publish, { executed: false, authorization: null });
  assert.equal(report.publish_package.acceptance_result, 'pass');
  assert.ok(
    report.publish_package.license.decision.reasons.some(
      (reason) => reason.code === 'publish_authorization_required',
    ),
  );

  assert.equal(packageDoc.license_status, 'unauthorized');
  assert.equal(packageDoc.publish.executed, false);
  assert.equal(packageDoc.demo.ticket, 'L29');
  assert.ok(packageDoc.body.trim().length > 0);
  assert.ok(packageDoc.title_candidates.length >= 3);
  assert.ok(packageDoc.tags.length >= 3);
});

test('demo: two runs are independent and deterministic', async (t) => {
  const first = await runInTemp(t);
  const second = await runInTemp(t);

  assert.deepEqual(first.report.ids, second.report.ids);
  assert.deepEqual(
    first.report.steps.map((step) => step.id),
    second.report.steps.map((step) => step.id),
  );
  assert.equal(first.report.publish_package.chosen_title, second.report.publish_package.chosen_title);
  assert.equal(first.report.publish_package.license_status, second.report.publish_package.license_status);
  assert.notEqual(first.outDir, second.outDir);
  assert.equal(first.report.out_dir, first.outDir);
  assert.equal(second.report.out_dir, second.outDir);
});
