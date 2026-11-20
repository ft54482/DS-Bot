import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRACT_METHODS,
  CONTRACT_VERSION,
  CONTRACT_METHODS as METHODS,
  ERROR_CODES,
  EXECUTOR_KINDS,
  cancelResult,
  confirmStop,
  defineAdapter,
  readDispatchRequest,
  resolveTracking,
  validateContract,
  validateResult,
} from '../src/contract.js';
import { createMockAdapter } from '../src/mock.js';
import { createToolChainAdapter } from '../src/tool_chain.js';
import { createDshSessionAdapter } from '../src/dsh_session.js';
import { createSuperagentAdapter } from '../src/superagent.js';
import { dispatchEnvelope } from './helpers/harness.js';

function adapters() {
  return {
    mock: createMockAdapter({ now: () => 0 }),
    tool_chain: createToolChainAdapter({ now: () => 0 }),
    dsh_session: createDshSessionAdapter({ fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }), bridgeUrl: 'http://127.0.0.1:1' }),
    superagent: createSuperagentAdapter({ fetch: async () => ({ ok: true, json: async () => ({}) }), availability: false }),
  };
}

test('contract: the four executor kinds expose the same seven methods', () => {
  for (const [kind, adapter] of Object.entries(adapters())) {
    const result = validateContract(adapter);
    assert.deepEqual(result, { ok: true, issues: [] }, `${kind}: ${result.issues}`);
    assert.equal(adapter.kind, kind);
    assert.equal(adapter.contract_version, CONTRACT_VERSION);
    for (const method of CONTRACT_METHODS) assert.equal(typeof adapter[method], 'function', `${kind}.${method}`);
    assert.equal(adapter.capabilities.tracking.status, true);
    assert.equal(adapter.capabilities.tracking.follow, true);
  }
  assert.deepEqual([...EXECUTOR_KINDS].sort(), ['dsh_session', 'mock', 'superagent', 'tool_chain']);
});

test('contract: defineAdapter rejects a missing method', () => {
  assert.throws(
    () => defineAdapter({ kind: 'mock', capabilities: { tracking: { status: true } }, methods: { dispatch: async () => ({}) } }),
    /status/,
  );
  assert.throws(
    () => defineAdapter({ kind: 'manual', capabilities: { tracking: { status: true } }, methods: Object.fromEntries(METHODS.map((m) => [m, async () => ({})])) }),
    /unknown executor kind/,
  );
});

test('contract: dispatch requires a tracker, otherwise tracker_missing', async () => {
  const adapter = createMockAdapter({ now: () => 0 });
  const noTracker = dispatchEnvelope();
  delete noTracker.tracking;
  const withoutTracker = await adapter.dispatch(noTracker);
  assert.equal(withoutTracker.ok, false);
  assert.equal(withoutTracker.code, ERROR_CODES.trackerMissing);
  assert.equal(withoutTracker.fallback, 'none');

  const disabled = await adapter.dispatch(dispatchEnvelope({ tracking: { status: false, follow: false } }));
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, ERROR_CODES.trackerMissing);
});

test('contract: tracking mode the adapter cannot provide is rejected', async () => {
  const methods = Object.fromEntries(METHODS.map((method) => [method, async () => ({})]));
  const statusOnly = defineAdapter({
    kind: 'mock',
    capabilities: { tracking: { status: true, follow: false } },
    methods,
  });
  const resolution = resolveTracking(statusOnly, { follow: true });
  assert.equal(resolution.ok, false);
  assert.equal(resolution.code, ERROR_CODES.trackingUnsupported);
  assert.deepEqual(resolution.details.unsupported, ['follow']);
});

test('contract: positional dispatch arguments are accepted (02 §2.4 form)', async () => {
  const adapter = createMockAdapter({ now: () => 0 });
  const run = { id: 'run-pos', executor_kind: 'mock', tracking: { status: true } };
  const result = await adapter.dispatch(run, { goal: '写一份说明' }, { path: '/w' }, { cny_cap: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 'run-pos');
  assert.deepEqual(result.tracking.modes, ['status']);

  const parsed = readDispatchRequest(run, { goal: 'x' }, { path: '/w' }, { cny_cap: 1 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.session_id, null);

  const invalid = await adapter.dispatch({});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, ERROR_CODES.invalidRequest);
});

test('contract: confirmStop requires every stop condition', () => {
  assert.equal(confirmStop({ accepted: true, remoteStopped: true, children: 0, stableForMs: 3000 }).verified, true);
  const unverified = confirmStop({ accepted: true, remoteStopped: true, children: 2, stableForMs: 0 });
  assert.equal(unverified.verified, false);
  assert.ok(unverified.reasons.includes('process_children_remaining'));
  assert.ok(unverified.reasons.includes('workspace_writes_unstable'));
  const rejected = confirmStop({ accepted: false, remoteStopped: false });
  assert.ok(rejected.reasons.includes('cancel_not_accepted'));
});

test('contract: validateResult catches inconsistent shapes', () => {
  const adapter = createMockAdapter({ now: () => 0 });
  const badCancel = cancelResult({ kind: 'mock', run_id: 'r', requested: true, state: 'cancelled', verified_stopped_at: null });
  assert.deepEqual(validateResult(adapter, 'cancel', badCancel).issues, ['cancel.cancelled_without_verification']);

  const badStopUnknown = cancelResult({ kind: 'mock', run_id: 'r', requested: true, state: 'stop_unknown' });
  assert.ok(validateResult(adapter, 'cancel', badStopUnknown).issues.includes('cancel.stop_unknown_without_remote_flag'));

  const badArtifact = { contract_version: CONTRACT_VERSION, kind: 'mock', method: 'collectArtifacts', ok: true, run_id: 'r', items: [{ path: 'x', sha256: 'nope', bytes: 1 }] };
  assert.ok(validateResult(adapter, 'collectArtifacts', badArtifact).issues.includes('artifacts.sha256'));

  const wrongKind = { ...badArtifact, kind: 'superagent' };
  assert.ok(validateResult(adapter, 'collectArtifacts', wrongKind).issues.includes('kind:superagent'));
});
