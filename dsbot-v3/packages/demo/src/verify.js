/**
 * Post-run verification for the L29 demo.
 *
 * `verify` is deliberately separate from the orchestration: the demo must be
 * able to fail its own report when the expected task tree, acceptance round,
 * evidence or publish license is not what the run claims. Every check returns
 * the observable detail it used, so a failure names the broken invariant.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const FLOW_STEP_IDS = Object.freeze([
  'create-goal',
  'delegate-business',
  'plan-execution',
  'dispatch-mock',
  'selfmedia-pilot',
  'acceptance',
  'publish-package',
]);

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function countPassed(steps) {
  return steps.filter((step) => step.status === 'passed').length;
}

export async function verifyDemo({
  steps,
  ids,
  goal,
  business,
  execution,
  run,
  mockState,
  acceptance,
  pilot,
  stubs,
  articlePath,
  articleSha256,
  packagePath,
}) {
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok: ok === true, detail });
  };
  const flowSteps = steps.filter((step) => step.id !== 'verify');

  check(
    'flow_steps_passed',
    flowSteps.length === FLOW_STEP_IDS.length &&
      flowSteps.every((step, index) => step.id === FLOW_STEP_IDS[index] && step.status === 'passed'),
    `${countPassed(flowSteps)}/${flowSteps.length} flow steps passed in the expected order`,
  );

  check(
    'step_timings',
    flowSteps.every((step) => Number.isFinite(step.duration_ms) && step.duration_ms >= 0),
    'every flow step records a non-negative duration_ms',
  );

  check(
    'task_ids',
    ['goal', 'business', 'execution', 'run', 'acceptance'].every(
      (key) => typeof ids?.[key] === 'string' && ids[key] !== '',
    ) &&
      flowSteps.every((step) => typeof step.task_id === 'string' && step.task_id !== ''),
    'every flow step carries a task_id and the report records goal/business/execution/run/acceptance ids',
  );

  check(
    'task_tree',
    goal.level === 'goal' &&
      business.level === 'business' &&
      business.parentTaskId === goal.id &&
      execution.level === 'execution' &&
      execution.parentTaskId === business.id,
    `goal ${goal.id} -> business ${business.id} -> execution ${execution.id}`,
  );

  check(
    'mock_dispatch',
    run.executorKind === 'mock' && mockState === 'completed',
    `run ${run.id} dispatched to the mock executor; mock state=${mockState}`,
  );

  const expectedCalls = { search: 1, fetch: 2, write: 1, review: 1 };
  check(
    'pilot_stub_only',
    Object.entries(expectedCalls).every(([key, expected]) => stubs.calls[key] === expected) &&
      stubs.unexpectedUrls.length === 0,
    `search=${stubs.calls.search}, fetch=${stubs.calls.fetch}, write=${stubs.calls.write}, ` +
      `review=${stubs.calls.review}, unexpected_urls=${stubs.unexpectedUrls.length}`,
  );

  check(
    'pilot_acceptance',
    pilot.review.result === 'pass' &&
      pilot.review.acceptance_result === 'pass' &&
      pilot.review.rework_rounds === 0,
    `pilot review=${pilot.review.result}, acceptance=${pilot.review.acceptance_result}, ` +
      `rework_rounds=${pilot.review.rework_rounds}`,
  );

  check(
    'runtime_acceptance',
    acceptance.state === 'passed' &&
      acceptance.decidedBy === 'acceptance_service' &&
      execution.state === 'completed' &&
      acceptance.items.every((item) => item.state === 'pass'),
    `acceptance ${acceptance.id} state=${acceptance.state}, ` +
      `items=${acceptance.items.filter((item) => item.state === 'pass').length}/${acceptance.items.length}, ` +
      `task ${execution.id} state=${execution.state}`,
  );

  const packageLicense = pilot.publish_package?.license;
  const reasonCodes = (packageLicense?.decision?.reasons ?? []).map((reason) => reason.code);
  check(
    'publish_license',
    pilot.publish_package?.license_status === 'unauthorized' &&
      packageLicense?.status === 'unauthorized' &&
      packageLicense?.allowed === false &&
      packageLicense?.authorization === null &&
      pilot.publish_package?.publish?.executed === false &&
      reasonCodes.includes('publish_authorization_required'),
    `license_status=${pilot.publish_package?.license_status}, allowed=${packageLicense?.allowed}, ` +
      `published=${pilot.publish_package?.publish?.executed}, ` +
      `reason=${reasonCodes.includes('publish_authorization_required') ? 'publish_authorization_required' : 'missing'}`,
  );

  let artifactDetail = 'artifacts unreadable';
  let artifactsOk = false;
  try {
    const article = await readFile(articlePath, 'utf8');
    const packageText = await readFile(packagePath, 'utf8');
    const packageJson = JSON.parse(packageText);
    artifactsOk =
      sha256(article) === articleSha256 &&
      packageJson.license_status === 'unauthorized' &&
      packageJson.publish?.executed === false;
    artifactDetail =
      `article sha256=${sha256(article).slice(0, 12)}…, ` +
      `package license=${packageJson.license_status}, published=${packageJson.publish?.executed}`;
  } catch (error) {
    artifactDetail = `artifact read failed: ${error.message}`;
  }
  check('artifacts_written', artifactsOk, artifactDetail);

  const passed = checks.filter((entry) => entry.ok).length;
  return {
    ok: passed === checks.length,
    summary: `${passed}/${checks.length} checks passed`,
    checks,
  };
}
