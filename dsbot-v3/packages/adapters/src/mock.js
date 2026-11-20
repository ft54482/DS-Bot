/**
 * `mock` executor adapter — scriptable progress / completion / failure / timeout.
 *
 * The mock uses an injected clock (`now`) instead of real timers, so tests are
 * deterministic. A script entry `{ at, type, ... }` becomes visible once
 * `now() - startedAt >= at`:
 *
 *   { at: 0,    type: 'progress', message }
 *   { at: 100,  type: 'complete', summary, result, usage, artifacts }
 *   { at: 100,  type: 'fail', error: { code, message } }
 *   { at: 5000, type: 'timeout', message }        // run stops making progress
 *
 * Cancellation is local, therefore normally verified synchronously. Pass
 * `cancelVerification: 'unverified'` to exercise the `stop_unknown` path.
 */

import {
  ERROR_CODES,
  TRACKER_HEALTH,
  artifactList,
  cancelResult,
  defineAdapter,
  dispatchAccepted,
  dispatchRejected,
  emptyUsage,
  evidenceList,
  followResult,
  readDispatchRequest,
  readHandle,
  resolveTracking,
  runStatusOk,
  runStatusUnknown,
  sha256,
  truncate,
  usageReport,
} from './contract.js';

const KIND = 'mock';

export function createMockAdapter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const script = Array.isArray(options.script) ? options.script : [{ at: 0, type: 'complete', summary: 'mock completed' }];
  const staleAfterMs = Number(options.staleAfterMs ?? 30_000);
  const cancelVerification = options.cancelVerification === 'unverified' ? 'unverified' : 'verified';
  const runs = new Map();

  function recordOf(handle) {
    const { run_id: runId } = readHandle(handle);
    return runId ? runs.get(runId) ?? null : null;
  }

  function eventsOf(record) {
    const elapsed = Math.max(0, now() - record.startedAt);
    const events = [
      {
        seq: 1,
        type: 'run.started',
        at: record.startedAt,
        data: { goal: record.request.taskPack.goal, executor_kind: KIND },
      },
    ];
    let seq = 1;
    let lastProgressAt = record.startedAt;
    const eventTypes = { progress: 'run.progress', complete: 'run.completed', fail: 'run.failed', timeout: 'run.timeout' };
    for (const entry of record.script) {
      if (entry.at > elapsed) break;
      seq += 1;
      const at = record.startedAt + entry.at;
      if (entry.type === 'progress') lastProgressAt = at;
      events.push({
        seq,
        type: eventTypes[entry.type] ?? `run.${entry.type}`,
        at,
        data: {
          ...entry,
          message: entry.message ?? null,
        },
      });
    }
    if (record.cancelRequested) {
      seq += 1;
      events.push({
        seq,
        type: 'run.cancelled',
        at: record.cancelledAt,
        data: { reason: record.cancelReason ?? 'cancel_requested', local: true },
      });
    }
    return { events, lastProgressAt };
  }

  function snapshotOf(record) {
    const { events, lastProgressAt } = eventsOf(record);
    const elapsed = Math.max(0, now() - record.startedAt);
    let state = 'running';
    let timedOut = false;
    let failure = null;
    let result = null;
    let scriptedUsage = null;
    let scriptedArtifacts = options.artifacts ?? [];
    for (const entry of record.script) {
      if (entry.at > elapsed) break;
      if (entry.type === 'fail') {
        state = 'failed';
        failure = entry.error ?? { code: 'mock_failed', message: 'mock run failed' };
      } else if (entry.type === 'complete') {
        state = 'completed';
        failure = null;
        result = entry.result ?? entry.summary ?? 'mock completed';
        scriptedUsage = entry.usage ?? scriptedUsage;
        scriptedArtifacts = entry.artifacts ?? scriptedArtifacts;
      } else if (entry.type === 'timeout') {
        state = 'stalled';
        timedOut = true;
      }
    }
    if (record.cancelRequested && !['completed', 'failed'].includes(state)) state = 'cancelled';

    let health = TRACKER_HEALTH.progress;
    if (state === 'stalled' || state === 'running') {
      health = elapsed - lastProgressAt > staleAfterMs ? TRACKER_HEALTH.noProgress : TRACKER_HEALTH.progress;
    }
    if (state === 'stalled') health = TRACKER_HEALTH.noProgress;

    return {
      state,
      health,
      timedOut,
      failure,
      result,
      events,
      artifacts: scriptedArtifacts,
      usage: { ...emptyUsage('mock'), ...(record.usage ?? {}), ...(scriptedUsage ?? {}) },
      elapsed,
    };
  }

  let adapter;
  const methods = {
    dispatch: async (request, taskPack, workspace, budget) => {
      const parsed = readDispatchRequest(request, taskPack, workspace, budget);
      if (!parsed.ok) {
        return dispatchRejected({ kind: KIND, code: parsed.code, message: parsed.message });
      }
      const tracking = resolveTracking(adapter, parsed.value.tracking);
      if (!tracking.ok) {
        return dispatchRejected({ kind: KIND, code: tracking.code, message: tracking.message, details: tracking.details });
      }
      const { run, taskPack: pack } = parsed.value;
      if (runs.has(run.id)) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          code: 'duplicate_dispatch',
          message: `run ${run.id} was already dispatched to this mock`,
        });
      }
      runs.set(run.id, {
        run,
        request: parsed.value,
        script,
        startedAt: now(),
        cancelRequested: false,
        cancelledAt: null,
        cancelReason: null,
        usage: options.usage ?? null,
      });
      const record = runs.get(run.id);
      const snapshot = snapshotOf(record);
      return dispatchAccepted({
        kind: KIND,
        run_id: run.id,
        tracking: { modes: tracking.modes },
        state: snapshot.state === 'completed' ? 'completed' : 'dispatched',
        detail: { goal: pack.goal, script_entries: script.length },
      });
    },

    status: async (handle) => {
      const record = recordOf(handle);
      if (!record) {
        const { run_id: runId } = readHandle(handle);
        return runStatusUnknown({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run' });
      }
      const snapshot = snapshotOf(record);
      return runStatusOk({
        kind: KIND,
        run_id: record.run.id,
        state: snapshot.state,
        health: snapshot.health,
        usage: snapshot.usage,
        progress: {
          elapsed_ms: snapshot.elapsed,
          event_count: snapshot.events.length,
          timed_out: snapshot.timedOut,
          failure: snapshot.failure,
        },
        detail: { result: snapshot.result },
      });
    },

    cancel: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return cancelResult({
          kind: KIND,
          run_id: runId,
          requested: false,
          state: 'unknown',
          code: ERROR_CODES.unknownRun,
          message: 'unknown run',
        });
      }
      const snapshot = snapshotOf(record);
      if (['completed', 'failed'].includes(snapshot.state)) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: false,
          state: snapshot.state,
          code: ERROR_CODES.alreadyFinished,
          message: `run already ${snapshot.state}`,
        });
      }
      record.cancelRequested = true;
      record.cancelledAt = now();
      if (cancelVerification === 'unverified') {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: true,
          state: 'stop_unknown',
          remote_may_still_run: true,
          reasons: ['workspace_writes_unstable'],
          message: 'cancel accepted but local stop could not be confirmed',
        });
      }
      return cancelResult({
        kind: KIND,
        run_id: record.run.id,
        requested: true,
        state: 'cancelled',
        verified_stopped_at: now(),
        message: 'local mock run stopped',
      });
    },

    follow: async (handle, sinceSeq = 0) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return followResult({ kind: KIND, run_id: runId, events: [], next_seq: sinceSeq, detail: { code: ERROR_CODES.unknownRun } });
      }
      const snapshot = snapshotOf(record);
      const events = snapshot.events.filter((event) => event.seq > sinceSeq);
      const nextSeq = snapshot.events.reduce((max, event) => Math.max(max, event.seq), sinceSeq);
      return followResult({
        kind: KIND,
        run_id: record.run.id,
        events,
        next_seq: nextSeq,
        timedOut: snapshot.timedOut,
        detail: { health: snapshot.health },
      });
    },

    collectArtifacts: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return artifactList({ kind: KIND, run_id: runId, items: [] });
      const snapshot = snapshotOf(record);
      const items = (snapshot.artifacts ?? []).map((artifact) => {
        const content = typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content ?? null);
        return { path: artifact.path, sha256: sha256(content), bytes: Buffer.byteLength(content) };
      });
      return artifactList({ kind: KIND, run_id: record.run.id, items });
    },

    collectEvidence: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return evidenceList({ kind: KIND, run_id: runId, items: [] });
      const snapshot = snapshotOf(record);
      const items = [
        {
          kind: 'dispatch',
          ref: `mock:${record.run.id}`,
          sha256: sha256(JSON.stringify(record.request)),
          command: null,
          output_excerpt: truncate(record.request.taskPack.goal),
        },
        ...snapshot.events.map((event) => ({
          kind: 'event',
          ref: `mock:${record.run.id}:seq:${event.seq}`,
          sha256: sha256(JSON.stringify(event)),
          command: null,
          output_excerpt: truncate(event.type),
        })),
      ];
      return evidenceList({ kind: KIND, run_id: record.run.id, items });
    },

    usage: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return usageReport({ kind: KIND, run_id: runId, usage: emptyUsage('unavailable') });
      const snapshot = snapshotOf(record);
      return usageReport({ kind: KIND, run_id: record.run.id, usage: snapshot.usage });
    },
  };

  adapter = defineAdapter({
    kind: KIND,
    capabilities: {
      tracking: { status: true, follow: true },
      artifacts: true,
      evidence: true,
      usage: true,
      cancel: { verify: cancelVerification },
      scripted: true,
    },
    methods,
  });
  return adapter;
}
