/**
 * L29 one-command end-to-end self-media demo.
 *
 * The demo composes the shipped layers rather than reimplementing them:
 *
 *   goal task                         packages/runtime + packages/service
 *     -> Chief delegates business     packages/agents
 *        -> business bot plans        packages/agents
 *        -> dispatch to mock          packages/adapters (scripted mock)
 *        -> self-media pilot          packages/pipelines/selfmedia
 *             (search/fetch/model stubs from ./fixtures.js)
 *        -> acceptance passed         packages/service acceptance state machine
 *        -> publish package           license_status: "unauthorized"
 *
 * Every external dependency is an injected stub; the runtime database is an
 * in-memory SQLite store. The only files written are inside `outDir`:
 * `article.md`, `publish-package.json` and `demo-report.json`.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createMockAdapter } from '../../adapters/src/mock.js';
import { createBusinessTools, createChiefTools } from '../../agents/src/index.js';
import { runSelfMediaPilot } from '../../pipelines/selfmedia/src/index.js';
import { createRuntime } from '../../runtime/src/index.js';
import { createDemoClock, createDemoIds } from './clock.js';
import {
  DEMO_ACCOUNT,
  DEMO_PLATFORM,
  DEMO_PROJECT,
  DEMO_TICKET,
  DEMO_TOPIC,
  createStubs,
} from './fixtures.js';
import { verifyDemo } from './verify.js';

export const DEMO_VERSION = 1;
export const DEMO_STEP_GAP_MS = 25;
export const MOCK_COMPLETE_AT_MS = 100;

export const GOAL_PROFILE = Object.freeze({
  id: 'goal.selfmedia_demo_v1',
  version: 1,
  items: [{ key: 'human.goal_signoff', class: 'human', required: true }],
});

export const BUSINESS_PROFILE = Object.freeze({
  id: 'business.selfmedia_demo_v1',
  version: 1,
  items: [{ key: 'independent.business_review', class: 'independent', required: true }],
});

export const EXECUTION_PROFILE = Object.freeze({
  id: 'execution.selfmedia_demo_v1',
  version: 1,
  items: [
    { key: 'auto.contract', class: 'auto', required: true },
    { key: 'independent.review', class: 'independent', required: true },
  ],
});

export const CHIEF_SCOPE = Object.freeze({
  projects: [DEMO_PROJECT],
  // The Chief never dispatches, but the delegation it grants may carry the
  // only executor this demo registers.
  executors: ['mock'],
  spend_cny_cap: 100,
  max_delegate_level: 'goal',
});

export const BUSINESS_SCOPE = Object.freeze({
  projects: [DEMO_PROJECT],
  executors: ['mock'],
  spend_cny_cap: 20,
  max_delegate_level: 'business',
});

export const MOCK_USAGE = Object.freeze({
  tokens_in: 1200,
  tokens_out: 800,
  tokens_cached: 200,
  cost_cny: 0.12,
});

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function taskView(task) {
  if (!task) return null;
  return {
    id: task.id,
    level: task.level,
    parent_task_id: task.parentTaskId ?? null,
    title: task.title,
    state: task.state,
    owner: task.owner ?? null,
    project: task.subject?.project ?? task.authScope?.projects?.[0] ?? null,
    revision: task.revision,
  };
}

function assertToolOk(result, label) {
  if (!result || result.ok !== true) {
    const code = result?.code ?? 'tool_error';
    const message = result?.message ?? 'the tool returned no result';
    throw new Error(`${label} failed: ${code}: ${message}`);
  }
  return result;
}

function createStepRecorder(clock) {
  const steps = [];

  async function step(id, name, taskIdOf, fn) {
    const startedAt = clock.now();
    const started = performance.now();
    const entry = {
      id,
      name,
      status: 'running',
      started_at: new Date(startedAt).toISOString(),
      duration_ms: null,
      task_id: null,
    };
    steps.push(entry);
    try {
      const value = await fn();
      entry.status = 'passed';
      entry.duration_ms = round(performance.now() - started);
      const taskId = typeof taskIdOf === 'function' ? taskIdOf(value) : taskIdOf;
      entry.task_id = typeof taskId === 'string' && taskId !== '' ? taskId : null;
      return value;
    } catch (error) {
      entry.status = 'failed';
      entry.duration_ms = round(performance.now() - started);
      entry.error = error?.message ?? String(error);
      throw error;
    } finally {
      clock.advance(DEMO_STEP_GAP_MS);
    }
  }

  return { steps, step };
}

/**
 * Run the whole demo and write its artifacts.
 *
 * @param {{outDir: string, clock?: object, idFactory?: object, stubs?: object}} options
 * @returns {Promise<{report: object, reportPath: string, packagePath: string, articlePath: string}>}
 */
export async function runDemo({
  outDir,
  clock = createDemoClock(),
  idFactory = createDemoIds(),
  stubs = createStubs(),
} = {}) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new TypeError('runDemo requires a non-empty outDir');
  }
  const resolvedOut = resolve(outDir);
  await mkdir(resolvedOut, { recursive: true });

  const articlePath = join(resolvedOut, 'article.md');
  const packagePath = join(resolvedOut, 'publish-package.json');
  const reportPath = join(resolvedOut, 'demo-report.json');

  const startedAt = new Date(clock.now()).toISOString();
  const totalStart = performance.now();

  const adapter = createMockAdapter({
    now: clock.now,
    usage: MOCK_USAGE,
    script: [
      { at: 0, type: 'progress', message: 'self-media pilot started' },
      { at: MOCK_COMPLETE_AT_MS, type: 'complete', summary: 'publish package drafted' },
    ],
  });

  const runtime = createRuntime({
    dbPath: ':memory:',
    adapters: { mock: adapter },
    clock: clock.now,
    idFactory: idFactory.next,
  });
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  const businessBot = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { steps, step } = createStepRecorder(clock);

  let report;
  try {
    const goal = await step('create-goal', 'Create goal', (value) => value.id, async () => {
      const task = runtime.tasks.create({
        level: 'goal',
        title: `goal: produce one self-media publish package (${DEMO_TOPIC})`,
        owner: 'human:owner',
        subject: { project: DEMO_PROJECT, topic: DEMO_TOPIC },
        budget: { capCny: 10 },
        acceptanceProfile: GOAL_PROFILE,
        authScope: { projects: [DEMO_PROJECT], max_delegate_level: 'goal' },
      });
      runtime.tasks.queue({ taskId: task.id, actor: 'chief' });
      return runtime.tasks.get(task.id);
    });

    const business = await step(
      'delegate-business',
      'Delegate business task',
      (value) => value.task.id,
      async () => {
        const result = assertToolOk(
          chief.delegate({
            goalTaskId: goal.id,
            title: `business: run the self-media pilot for "${DEMO_TOPIC}"`,
            toBot: 'content',
            project: DEMO_PROJECT,
            budgetCny: 5,
            acceptanceProfile: BUSINESS_PROFILE,
            subject: { topic: DEMO_TOPIC },
            scope: {
              projects: [DEMO_PROJECT],
              executors: ['mock'],
              spend_cny_cap: BUSINESS_SCOPE.spend_cny_cap,
              max_delegate_level: 'business',
            },
          }),
          'chief.delegate',
        );
        runtime.tasks.queue({ taskId: result.task.id, actor: 'bot:content' });
        return { task: runtime.tasks.get(result.task.id) };
      },
    );

    const execution = await step(
      'plan-execution',
      'Plan execution task',
      (value) => value.task.id,
      async () => {
        const result = assertToolOk(
          businessBot.plan({
            businessTaskId: business.task.id,
            title: `execution: write and self-review the article on "${DEMO_TOPIC}"`,
            project: DEMO_PROJECT,
            budgetCny: 2,
            acceptanceProfile: EXECUTION_PROFILE,
            subject: { project: DEMO_PROJECT, goal: DEMO_TOPIC },
          }),
          'business.plan',
        );
        return { task: runtime.tasks.get(result.task.id) };
      },
    );

    const dispatched = await step(
      'dispatch-mock',
      'Dispatch to mock executor',
      () => execution.task.id,
      async () => {
        const accepted = assertToolOk(
          await businessBot.dispatch({
            taskId: execution.task.id,
            executorKind: 'mock',
            payload: { demo: DEMO_TICKET, topic: DEMO_TOPIC },
            taskPack: {
              goal: DEMO_TOPIC,
              constraints: ['offline demo: all external dependencies are stubbed'],
              acceptance: EXECUTION_PROFILE.items.map((item) => item.key),
            },
          }),
          'business.dispatch',
        );

        const running = runtime.runs.ack({ runId: accepted.run.id });
        clock.advance(MOCK_COMPLETE_AT_MS + 50);
        const mockStatus = await adapter.status({ run_id: accepted.run.id });
        if (mockStatus.state !== 'completed') {
          throw new Error(`mock executor did not complete: ${mockStatus.state}`);
        }
        return { run: running.run, task: running.task, mockStatus, executor: accepted.executor };
      },
    );

    const pilotRun = await step(
      'selfmedia-pilot',
      'Run the self-media pilot with stubs',
      () => execution.task.id,
      async () => {
        const result = await runSelfMediaPilot({
          topic: DEMO_TOPIC,
          deps: {
            search: stubs.search,
            fetch: stubs.fetch,
            model: stubs.model,
            now: clock.now,
            tags: ['AI', '注意力', '效率'],
            platform: DEMO_PLATFORM,
            account: DEMO_ACCOUNT,
            maxReworkRounds: 2,
          },
        });
        if (result.review.result !== 'pass' || !result.publish_package) {
          throw new Error(
            `self-media pilot did not pass: ${result.review.result}` +
              (result.blocked_reason ? ` (${result.blocked_reason})` : ''),
          );
        }
        const article = result.draft.body;
        await writeFile(articlePath, article, 'utf8');
        return { pilot: result, articleSha256: sha256(article) };
      },
    );

    const accepted = await step(
      'acceptance',
      'Record executor claim and pass acceptance',
      () => execution.task.id,
      async () => {
        const acceptanceItems = pilotRun.pilot.review.acceptance.items.map((item) => ({
          key: item.id,
          class: item.class,
          required: true,
        }));
        const itemStates = Object.fromEntries(
          pilotRun.pilot.review.acceptance.items.map((item) => [
            item.id,
            item.result === 'pass' ? 'pass' : 'fail',
          ]),
        );

        const claimed = await runtime.runs.claim({
          runId: dispatched.run.id,
          claim: {
            commit: pilotRun.articleSha256.slice(0, 40),
            dirty: false,
            manifest: [{ path: 'article.md', sha256: pilotRun.articleSha256 }],
            nonce: `demo-claim-${execution.task.id}`,
            summary: 'self-media publish package ready for review',
          },
          acceptanceItems,
        });

        const decision = assertToolOk(
          businessBot.accept({
            acceptanceId: claimed.acceptance.id,
            verdict: 'pass',
            itemStates,
            reason: 'self-media acceptance profile passed',
          }),
          'business.accept',
        );
        const acceptance = runtime.acceptances.get(claimed.acceptance.id);
        if (decision.verdict !== 'pass' || acceptance.state !== 'passed') {
          throw new Error(
            `acceptance did not pass: verdict=${decision.verdict} state=${acceptance.state}`,
          );
        }
        return { claimed, decision, acceptance };
      },
    );

    const publishPackage = await step(
      'publish-package',
      'Write unauthorized publish package',
      () => execution.task.id,
      async () => {
        const pilot = pilotRun.pilot;
        const packageDoc = {
          ...pilot.publish_package,
          demo: {
            ticket: DEMO_TICKET,
            mode: 'mock',
            note: 'Generated offline by packages/demo/run.mjs; no publish was attempted.',
          },
        };
        await writeFile(packagePath, `${JSON.stringify(packageDoc, null, 2)}\n`, 'utf8');
        return { package: packageDoc };
      },
    );

    const verify = await step(
      'verify',
      'Verify demo invariants',
      () => execution.task.id,
      async () => {
        const currentExecution = runtime.tasks.get(execution.task.id);
        return verifyDemo({
          steps,
          ids: {
            goal: goal.id,
            business: business.task.id,
            execution: execution.task.id,
            run: dispatched.run.id,
            acceptance: accepted.acceptance.id,
          },
          goal: runtime.tasks.get(goal.id),
          business: runtime.tasks.get(business.task.id),
          execution: currentExecution,
          run: runtime.runs.get(dispatched.run.id),
          mockState: dispatched.mockStatus.state,
          acceptance: accepted.acceptance,
          pilot: pilotRun.pilot,
          stubs,
          articlePath,
          articleSha256: pilotRun.articleSha256,
          packagePath,
        });
      },
    );

    const pilot = pilotRun.pilot;
    const packageDoc = publishPackage.package;
    const publishSummary = {
      status: packageDoc.status,
      license_status: packageDoc.license_status,
      chosen_title: packageDoc.chosen_title,
      tags: packageDoc.tags,
      source_count: packageDoc.sources.length,
      key_fact_count: packageDoc.facts.filter((fact) => fact.key).length,
      acceptance_result: packageDoc.acceptance.result,
      license: {
        status: packageDoc.license.status,
        allowed: packageDoc.license.allowed,
        authorization: packageDoc.license.authorization,
        decision: {
          result: packageDoc.license.decision.result,
          reasons: packageDoc.license.decision.reasons,
        },
      },
      publish: packageDoc.publish,
      generated_at: packageDoc.generated_at,
    };

    report = {
      schema_version: DEMO_VERSION,
      ticket: DEMO_TICKET,
      title: 'One-command end-to-end self-media demo',
      mode: 'mock',
      started_at: startedAt,
      finished_at: new Date(clock.now()).toISOString(),
      duration_ms: round(performance.now() - totalStart),
      out_dir: resolvedOut,
      steps,
      ids: {
        goal: goal.id,
        business: business.task.id,
        execution: execution.task.id,
        run: dispatched.run.id,
        acceptance: accepted.acceptance.id,
        claim: accepted.claimed.claim.id,
      },
      flow: {
        goal: taskView(runtime.tasks.get(goal.id)),
        business: taskView(runtime.tasks.get(business.task.id)),
        execution: taskView(runtime.tasks.get(execution.task.id)),
        run: {
          id: dispatched.run.id,
          state: runtime.runs.get(dispatched.run.id).state,
          executor_kind: dispatched.run.executorKind,
          mock_state: dispatched.mockStatus.state,
        },
        acceptance: {
          id: accepted.acceptance.id,
          state: accepted.acceptance.state,
          verdict: accepted.decision.verdict,
          decided_by: accepted.acceptance.decidedBy,
          round_no: accepted.acceptance.roundNo,
          items: accepted.acceptance.items.map((item) => ({
            key: item.key,
            class: item.class,
            state: item.state,
          })),
        },
      },
      pilot: {
        topic: pilot.topic,
        review_result: pilot.review.result,
        acceptance_result: pilot.review.acceptance_result,
        rework_rounds: pilot.review.rework_rounds,
        rubric_source: pilot.review.rubric_source,
        attempts: pilot.attempts.length,
        sources: pilot.publish_package.sources.map((source) => source.url),
      },
      external_calls: {
        mode: 'stubbed',
        executors: ['mock'],
        search: stubs.calls.search,
        fetch: stubs.calls.fetch,
        model_write: stubs.calls.write,
        model_review: stubs.calls.review,
        fetched_urls: [...stubs.fetchedUrls],
        unexpected_urls: [...stubs.unexpectedUrls],
      },
      cost: accepted.claimed.cost ?? null,
      publish_package: publishSummary,
      artifacts: {
        report: reportPath,
        article: { path: articlePath, sha256: pilotRun.articleSha256 },
        publish_package: { path: packagePath },
      },
      verify,
    };
  } finally {
    await runtime.close();
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return { report, reportPath, packagePath, articlePath };
}
