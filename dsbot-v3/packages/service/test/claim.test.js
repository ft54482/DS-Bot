import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMIT, SHA256, createHarness, startRunningTask, validClaim } from './support/fixtures.js';

test('executor claim moves run to reported and task to accepting — never completed', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);

  const result = service.claimRun({ runId: run.id, claim: validClaim() });

  assert.equal(result.run.state, 'reported');
  assert.equal(result.task.state, 'accepting');
  assert.notEqual(result.task.state, 'completed');
  assert.notEqual(result.run.state, 'accepted');
  assert.equal(result.acceptance.state, 'open');
  assert.equal(result.task.openAcceptanceId, result.acceptance.id);
  assert.equal(result.task.subjectFingerprint, result.claim.subjectFingerprint);
  assert.equal(result.claim.validationState, 'valid');

  const allRuns = service.listRuns({ taskId: task.id });
  assert.equal(allRuns.length, 1);
  assert.equal(allRuns[0].state, 'reported');

  const types = service.listEvents().map((event) => event.type);
  assert.ok(types.includes('claim.recorded'));
  assert.ok(types.includes('run.reported'));
  assert.ok(types.includes('run.sealed'));
  assert.ok(types.includes('acceptance.opened'));
  assert.ok(types.includes('task.accepting'));
  assert.ok(!types.includes('task.completed'));
  assert.ok(!types.includes('run.accepted'));
});

test('a dirty worktree claim is refused and leaves run/task untouched', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);

  assert.throws(
    () => service.claimRun({ runId: run.id, claim: validClaim({ dirty: true }) }),
    (error) => {
      assert.equal(error.code, 'claim_invalid');
      assert.equal(error.status, 422);
      assert.ok(error.details.reasons.includes('dirty_worktree'));
      return true;
    },
  );

  assert.equal(service.getRun(run.id).state, 'running');
  assert.equal(service.getTask(task.id).state, 'running');
  assert.equal(service.listClaims({ runId: run.id }).length, 0);
  assert.equal(service.listAcceptances({ taskId: task.id }).length, 0);
  assert.equal(
    service.listEvents().some((event) => event.type === 'acceptance.opened'),
    false,
  );
});

test('missing manifest / non-40-hex commit are claim_invalid for the same reason', () => {
  const { service } = createHarness();
  const { run } = startRunningTask(service);

  for (const claim of [
    validClaim({ commit: 'abc123' }),
    validClaim({ manifest: [] }),
    validClaim({ manifest: [{ path: 'a.js', sha256: 'short' }] }),
    validClaim({ nonce: '' }),
  ]) {
    assert.throws(
      () => service.claimRun({ runId: run.id, claim }),
      (error) => {
        assert.equal(error.code, 'claim_invalid');
        assert.equal(error.status, 422);
        return true;
      },
    );
  }
  assert.equal(service.getRun(run.id).state, 'running');
});

test('the same claim nonce replays without opening a second acceptance', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  const first = service.claimRun({ runId: run.id, claim: validClaim() });
  const second = service.claimRun({ runId: run.id, claim: validClaim() });

  assert.equal(second.claim.id, first.claim.id);
  assert.equal(second.acceptance.id, first.acceptance.id);
  assert.equal(service.listClaims({ runId: run.id }).length, 1);
  assert.equal(service.listAcceptances({ taskId: task.id }).length, 1);
  assert.equal(service.getTask(task.id).state, 'accepting');
});

test('a different nonce on an already reported run is rejected as run_already_reported', () => {
  const { service } = createHarness();
  const { run } = startRunningTask(service);
  service.claimRun({ runId: run.id, claim: validClaim() });

  assert.throws(
    () =>
      service.claimRun({
        runId: run.id,
        claim: validClaim({ nonce: 'nonce-2' }),
      }),
    (error) => {
      assert.equal(error.code, 'run_already_reported');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(service.listClaims({ runId: run.id }).length, 1);
  assert.equal(
    service.listEvents().filter((event) => event.type === 'completion.duplicate_rejected').length,
    1,
  );
});

test('a claim that matches neither current revision nor stage is refused', () => {
  const { service } = createHarness();
  const { run } = startRunningTask(service);

  assert.throws(
    () => service.claimRun({ runId: run.id, claim: validClaim({ revision: 7 }) }),
    (error) => {
      assert.equal(error.code, 'claim_invalid');
      assert.ok(error.details.reasons.includes('revision_mismatch'));
      return true;
    },
  );
  assert.throws(
    () => service.claimRun({ runId: run.id, claim: validClaim({ stage: 'business' }) }),
    (error) => {
      assert.equal(error.code, 'claim_invalid');
      assert.ok(error.details.reasons.includes('stage_mismatch'));
      return true;
    },
  );
});

test('claiming from a not-running run is an invalid transition, not an accepted report', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'early claim' });
  const { run } = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-1' });

  assert.throws(
    () => service.claimRun({ runId: run.id, claim: validClaim() }),
    (error) => {
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.status, 409);
      assert.equal(error.details.from, 'dispatched');
      assert.equal(error.details.to, 'reported');
      return true;
    },
  );
  assert.equal(service.getRun(run.id).state, 'dispatched');
});

test('acceptance item defaults are pending, so evidence-free passes are not implied', () => {
  const { service } = createHarness();
  const { run } = startRunningTask(service);
  const { acceptance } = service.claimRun({ runId: run.id, claim: validClaim() });

  assert.equal(acceptance.items.length, 1);
  assert.equal(acceptance.items[0].key, 'auto.checks');
  assert.equal(acceptance.items[0].class, 'auto');
  assert.equal(acceptance.items[0].required, true);
  assert.equal(acceptance.items[0].state, 'pending');
});

test('a claim cannot pre-fill acceptance outcomes', () => {
  const { service } = createHarness();
  const { run } = startRunningTask(service);
  const { acceptance } = service.claimRun({
    runId: run.id,
    claim: validClaim({
      acceptanceItems: [{ key: 'auto.checks', class: 'auto', required: true, state: 'pass' }],
    }),
  });
  assert.equal(acceptance.items[0].state, 'pending');
  assert.throws(
    () => service.decideAcceptance({ acceptanceId: acceptance.id, verdict: 'pass' }),
    (error) => {
      assert.equal(error.code, 'acceptance_incomplete');
      return true;
    },
  );
});

test('claim subject fingerprint is deterministic for the same commit+manifest', () => {
  const { service } = createHarness();
  const first = startRunningTask(service);
  const firstClaim = service.claimRun({ runId: first.run.id, claim: validClaim() });

  const second = startRunningTask(service, { title: 'second', dispatchKey: 'dispatch-2' });
  const secondClaim = service.claimRun({ runId: second.run.id, claim: validClaim() });

  assert.equal(firstClaim.claim.subjectFingerprint, secondClaim.claim.subjectFingerprint);
  assert.equal(firstClaim.claim.subjectFingerprint.length, 64);
  assert.equal(firstClaim.claim.commit, COMMIT.toLowerCase());
  assert.equal(firstClaim.claim.manifest[0].sha256, SHA256);
  assert.deepEqual(firstClaim.claim.subject.manifest, firstClaim.claim.manifest);
});
