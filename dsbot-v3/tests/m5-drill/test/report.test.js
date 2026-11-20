import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { runDrill } from '../src/drill.js';
import { validateReport, verifyEvidence } from '../src/report.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const runScript = join(repoRoot, 'tests', 'm5-drill', 'run.mjs');

function listRepoFiles(directory = repoRoot, base = repoRoot, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      listRepoFiles(full, base, files);
    } else {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

let cached = null;
function drilled() {
  if (!cached) {
    const outDir = mkdtempSync(join(tmpdir(), 'm5-drill-test-'));
    cached = { outDir, report: null };
    cached.ready = runDrill({ outDir }).then((report) => {
      cached.report = report;
      return report;
    });
  }
  return cached.ready;
}

test.after(() => {
  if (cached?.outDir) rmSync(cached.outDir, { recursive: true, force: true });
});

test('cli: node run.mjs --out writes a report and exits 0', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'm5-drill-cli-'));
  try {
    const result = spawnSync(process.execPath, [runScript, '--out', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /M5 drill: 10\/10 steps ok/);
    assert.match(result.stdout, /RESULT: PASS/);
    assert.ok(existsSync(join(outDir, 'drill-report.json')));
    assert.ok(existsSync(join(outDir, 'evidence', 'manifest.json')));
    const report = JSON.parse(readFileSync(join(outDir, 'drill-report.json'), 'utf8'));
    assert.equal(report.result.ok, true);
    assert.equal(report.steps.length, 10);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('report: ten ordered steps each carry the required contract fields', async () => {
  const report = await drilled();
  assert.equal(report.schema, 'm5-drill/v1');
  assert.equal(report.steps.length, 10);
  for (const [index, step] of report.steps.entries()) {
    assert.equal(step.step, index + 1);
    assert.equal(step.ok, true, `step ${step.step} failed: ${JSON.stringify(step.actual)}`);
    assert.equal(typeof step.action, 'string');
    assert.ok(step.action.length > 0);
    assert.equal(typeof step.expect, 'object');
    assert.equal(typeof step.actual, 'object');
    assert.match(step.evidenceRef, /^evidence\/.+\.json$/);
  }
  assert.deepEqual(validateReport(report), { ok: true, errors: [] });
});

test('cost: three attribution levels, hierarchy roll-up and retry cost reconcile', async () => {
  const report = await drilled();
  const { cost } = report;
  assert.deepEqual(
    cost.levels.map((level) => level.level),
    ['task', 'run', 'acceptance'],
  );
  assert.equal(cost.levelCount, 3);
  assert.equal(cost.levels[0].costCny, 0.32);
  assert.equal(cost.levels[1].costCny, 0.3);
  assert.equal(cost.levels[2].costCny, 0.02);
  assert.deepEqual(cost.hierarchy, { execution: 0.32, business: 0.32, goal: 0.32 });
  assert.equal(cost.retry.attemptNo, 2);
  assert.equal(cost.retry.costCny, 0.18);
  assert.equal(cost.reconciliation.taskEqualsRunPlusAcceptance, true);
  assert.equal(cost.reconciliation.eachRunBilledOnce, true);
  assert.equal(cost.rows.filter((row) => row.kind === 'llm').length, 2);
  assert.equal(cost.rows.filter((row) => row.kind === 'acceptance').length, 2);
});

test('restart: reopening the same store restores state without a second run or outbox row', async () => {
  const report = await drilled();
  assert.equal(report.restart.recovery.tasksRestored, true);
  assert.equal(report.restart.recovery.runRestored, true);
  assert.equal(report.restart.recovery.eventsIntact, true);
  assert.equal(report.restart.recovery.outboxIntact, true);
  assert.equal(report.restart.recovery.duplicateReplay, true);
  assert.equal(report.restart.recovery.runCount, 1);
  assert.equal(report.restart.recovery.newRunsCreated, 0);
  assert.equal(report.restart.recovery.newOutboxCreated, 0);
});

test('stop: request becomes verified only with proof, and no new dispatch is accepted', async () => {
  const report = await drilled();
  assert.equal(report.stop.request.state, 'requested');
  assert.equal(report.stop.verification.cancelled, true);
  assert.equal(report.stop.verification.stopState, 'verified');
  assert.equal(report.stop.verification.blockerCount, 0);
  assert.equal(report.stop.verification.executorCancelState, 'cancelled');
  assert.equal(report.stop.verification.executorRemoteMayStillRun, false);
  assert.equal(report.stop.verification.verifiedProofRecorded, true);
  assert.equal(report.stop.workspace.writesStable, true);
  assert.equal(report.stop.workspace.hashBefore, report.stop.workspace.hashAfter);
  assert.equal(report.stop.tasks.completedChild, 'completed');
  assert.equal(report.stop.tasks.followup, 'cancelled');
  assert.equal(report.stop.noNewDispatch.rejectedCode, 'invalid_state_transition');
  assert.equal(report.stop.noNewDispatch.runsAfter, report.stop.noNewDispatch.runsBefore);
});

test('injection: one real rework round and a separate stop_unknown proof', async () => {
  const report = await drilled();
  assert.equal(report.failureInjection.rework.injectedError.includes('50°C'), true);
  assert.equal(report.failureInjection.rework.failedItem, 'fact.accuracy');
  assert.equal(report.failureInjection.rework.reworkRounds, 1);
  assert.equal(report.failureInjection.rework.reworkRunKind, 'rework');
  const stopUnknown = report.failureInjection.stopUnknown;
  assert.equal(stopUnknown.ok, true);
  assert.equal(stopUnknown.cancelled, false);
  assert.equal(stopUnknown.stopState, 'stop_unknown');
  assert.equal(stopUnknown.executor.cancelState, 'stop_unknown');
  assert.equal(stopUnknown.executor.remoteMayStillRun, true);
  assert.equal(stopUnknown.taskStates.goal, 'stopping');
  assert.equal(stopUnknown.runState, 'running');
  assert.equal(stopUnknown.noNewDispatch.rejectedCode, 'invalid_state_transition');
  assert.equal(
    stopUnknown.blockers.some((blocker) => blocker.reasons.includes('process_still_alive')),
    true,
  );
});

test('evidence: every step reference exists and the manifest hashes match', async () => {
  const report = await drilled();
  const { outDir } = cached;
  assert.deepEqual(verifyEvidence(outDir, report), { ok: true, errors: [] });
  const manifest = JSON.parse(readFileSync(join(outDir, 'evidence', 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.length >= 10);
  const referenced = new Set(report.steps.map((step) => step.evidenceRef));
  for (const ref of referenced) {
    assert.ok(manifest.files.some((entry) => entry.path === ref), `manifest misses ${ref}`);
  }
});

test('scope: the CLI writes only under --out, never inside the repository', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'm5-drill-scope-'));
  const before = listRepoFiles();
  try {
    const result = spawnSync(process.execPath, [runScript, '--out', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(listRepoFiles(), before);
    assert.equal(existsSync(join(repoRoot, 'drill-report.json')), false);
    assert.equal(existsSync(join(repoRoot, 'evidence')), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('validation: a report without all ten steps is rejected', async () => {
  const report = await drilled();
  const tampered = structuredClone(report);
  tampered.steps = tampered.steps.slice(0, 9);
  const result = validateReport(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.includes('expected 10 steps')), true);
});
