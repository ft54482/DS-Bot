/**
 * Report contract checks for the M5 drill.
 *
 * `validateReport` is pure (no IO) and `verifyEvidence` re-hashes the evidence
 * pack on disk. The CLI fails when either returns an error.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STEP_KEYS = Object.freeze(['step', 'action', 'expect', 'actual', 'ok', 'evidenceRef']);

export function validateReport(report) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['report is not an object'] };
  }
  if (report.schema !== 'm5-drill/v1') fail(`unexpected schema: ${String(report.schema)}`);
  if (!Array.isArray(report.steps)) {
    fail('steps must be an array');
  } else {
    if (report.steps.length !== 10) fail(`expected 10 steps, got ${report.steps.length}`);
    report.steps.forEach((step, index) => {
      const where = `steps[${index}]`;
      if (!step || typeof step !== 'object') {
        fail(`${where} is not an object`);
        return;
      }
      for (const key of STEP_KEYS) {
        if (!(key in step)) fail(`${where} is missing ${key}`);
      }
      if (step.step !== index + 1) fail(`${where}.step must be ${index + 1}`);
      if (typeof step.action !== 'string' || step.action === '') fail(`${where}.action is empty`);
      if (typeof step.evidenceRef !== 'string' || !step.evidenceRef.startsWith('evidence/')) {
        fail(`${where}.evidenceRef must point into evidence/`);
      }
      if (step.ok !== true) fail(`${where}.ok is not true`);
    });
  }

  if (!report.cost || typeof report.cost !== 'object') {
    fail('cost summary is missing');
  } else {
    if (!Array.isArray(report.cost.levels) || report.cost.levels.length !== 3) {
      fail('cost.levels must contain the three attribution levels');
    }
    if (!report.cost.retry || typeof report.cost.retry.costCny !== 'number') {
      fail('cost.retry.costCny is missing');
    }
    if (report.cost.reconciliation?.taskEqualsRunPlusAcceptance !== true) {
      fail('cost.reconciliation.taskEqualsRunPlusAcceptance is not true');
    }
  }

  if (!report.stop || report.stop.request?.state !== 'requested') {
    fail('stop.request.state must be requested');
  }
  if (report.stop?.verification?.stopState !== 'verified') {
    fail('stop.verification.stopState must be verified');
  }
  if (report.stop?.noNewDispatch?.rejectedCode !== 'invalid_state_transition') {
    fail('stop.noNewDispatch must record the refused dispatch');
  }

  if (!report.restart || report.restart.recovery?.tasksRestored !== true) {
    fail('restart.recovery.tasksRestored must be true');
  }
  if (report.restart?.recovery?.duplicateReplay !== true) {
    fail('restart.recovery.duplicateReplay must be true');
  }
  if (report.restart?.recovery?.newRunsCreated !== 0) {
    fail('restart must not create a run');
  }

  if (report.failureInjection?.rework?.reworkRounds !== 1) {
    fail('failureInjection.rework.reworkRounds must be 1');
  }
  if (report.failureInjection?.stopUnknown?.stopState !== 'stop_unknown') {
    fail('failureInjection.stopUnknown.stopState must be stop_unknown');
  }
  if (report.failureInjection?.stopUnknown?.ok !== true) {
    fail('failureInjection.stopUnknown.ok must be true');
  }
  if (report.result?.ok !== true) fail('result.ok is not true');

  return { ok: errors.length === 0, errors };
}

export function verifyEvidence(outDir, report) {
  const errors = [];
  const manifestPath = join(outDir, report?.evidence?.manifest ?? 'evidence/manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`missing evidence manifest: ${manifestPath}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`invalid evidence manifest: ${error.message}`] };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) errors.push('evidence manifest lists no files');

  for (const entry of files) {
    const absolute = join(outDir, entry.path);
    if (!existsSync(absolute)) {
      errors.push(`missing evidence file: ${entry.path}`);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    if (digest !== entry.sha256) errors.push(`hash mismatch: ${entry.path}`);
  }

  for (const step of report?.steps ?? []) {
    if (!step.evidenceRef) {
      errors.push(`step ${step.step} has no evidenceRef`);
      continue;
    }
    if (!existsSync(join(outDir, step.evidenceRef))) {
      errors.push(`step ${step.step} evidenceRef does not exist: ${step.evidenceRef}`);
    }
  }

  if (!existsSync(join(outDir, 'drill-report.json'))) {
    errors.push('drill-report.json is missing');
  }

  return { ok: errors.length === 0, errors };
}
