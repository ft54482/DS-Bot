/**
 * `tool_chain` executor adapter — the self-media content chain
 * (docs/prd/17-minimal-implementation-package.md §S3):
 * retrieve -> snapshot -> fact_check -> write -> review -> typeset.
 *
 * Steps run sequentially and synchronously by default (placeholders only; no
 * network, no model calls). A step may be async and may cancel itself through
 * `ctx.cancel(reason)`; an external `cancel(handle)` while the chain is running
 * stops the chain before the next step. Because the chain is local, a stop is
 * verified once the last step has returned and no further step starts.
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

const KIND = 'tool_chain';

/** Default placeholder chain; every step is clearly marked `placeholder: true`. */
export function defaultContentSteps() {
  return [
    { name: 'retrieve', run: () => ({ output: { sources: [], placeholder: true } }) },
    { name: 'snapshot', run: () => ({ output: { snapshots: [], placeholder: true } }) },
    { name: 'fact_check', run: () => ({ output: { checks: [], placeholder: true } }) },
    {
      name: 'write',
      run: (ctx) => ({
        output: { manuscript: '', placeholder: true },
        artifact: { path: 'article-pack.json', content: JSON.stringify({ goal: ctx.goal, placeholder: true }) },
      }),
    },
    { name: 'review', run: () => ({ output: { verdict: 'pending_human_review', placeholder: true } }) },
    { name: 'typeset', run: () => ({ output: { layout: 'markdown', placeholder: true } }) },
  ];
}

function normalizeSteps(steps) {
  return (Array.isArray(steps) && steps.length > 0 ? steps : defaultContentSteps()).map((step, index) => {
    const name = typeof step?.name === 'string' && step.name.length > 0 ? step.name : `step_${index + 1}`;
    if (typeof step?.run === 'function') return { name, run: step.run };
    const output = step?.output ?? null;
    return { name, run: () => ({ output }) };
  });
}

export function createToolChainAdapter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const runs = new Map();

  function recordOf(handle) {
    const { run_id: runId } = readHandle(handle);
    return runId ? runs.get(runId) ?? null : null;
  }

  function pushEvent(record, type, data = {}) {
    record.seq += 1;
    record.events.push({ seq: record.seq, type, at: now(), data });
  }

  async function execute(record) {
    const { taskPack } = record.request;
    record.state = 'running';
    record.startedAt = now();
    pushEvent(record, 'run.started', { goal: taskPack.goal, steps: record.steps.map((step) => step.name) });
    const ctx = {
      goal: taskPack.goal,
      constraints: taskPack.constraints ?? [],
      acceptance: taskPack.acceptance ?? [],
      inputs: taskPack.inputs ?? {},
      cancel: (reason = 'cancel_requested') => {
        record.cancelRequested = true;
        record.cancelReason = reason;
      },
      cancelled: () => record.cancelRequested === true,
    };

    for (const step of record.steps) {
      if (record.cancelRequested) break;
      const startedAt = now();
      pushEvent(record, 'step.started', { step: step.name });
      let outcome;
      try {
        outcome = await step.run(ctx);
      } catch (error) {
        record.state = 'failed';
        record.failure = { code: 'step_failed', step: step.name, message: error?.message ?? String(error) };
        pushEvent(record, 'step.failed', { step: step.name, message: record.failure.message });
        break;
      }
      if (record.cancelRequested) {
        pushEvent(record, 'step.aborted', { step: step.name });
        break;
      }
      const endedAt = now();
      const output = outcome?.output ?? outcome ?? null;
      record.stepped.push({
        name: step.name,
        output,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
      });
      if (outcome?.artifact) {
        record.artifacts.push({ path: outcome.artifact.path, content: outcome.artifact.content });
      }
      if (outcome?.usage) record.usageEntries.push(outcome.usage);
      pushEvent(record, 'step.completed', { step: step.name, duration_ms: endedAt - startedAt });
    }

    if (record.cancelRequested) {
      record.state = 'cancelled';
      record.cancelledAt = now();
      record.stopVerifiedAt = now();
      pushEvent(record, 'run.cancelled', { reason: record.cancelReason ?? 'cancel_requested', local: true });
    } else if (record.state !== 'failed') {
      record.state = 'completed';
      record.completedAt = now();
      pushEvent(record, 'run.completed', { steps: record.stepped.length });
    } else {
      record.completedAt = now();
    }
    record.finished = true;
  }

  function usageOf(record) {
    const merged = { ...emptyUsage(record.usageEntries.length === 0 ? 'tool_chain_placeholder' : 'tool_chain_steps') };
    for (const entry of record.usageEntries) {
      for (const key of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost_cny']) {
        const value = Number(entry?.[key] ?? 0);
        if (Number.isFinite(value)) merged[key] += value;
      }
    }
    return merged;
  }

  let adapter;
  const methods = {
    dispatch: async (request, taskPack, workspace, budget) => {
      const parsed = readDispatchRequest(request, taskPack, workspace, budget);
      if (!parsed.ok) return dispatchRejected({ kind: KIND, code: parsed.code, message: parsed.message });
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
          message: `run ${run.id} was already dispatched`,
        });
      }
      const record = {
        run,
        request: parsed.value,
        steps: normalizeSteps(options.steps),
        events: [],
        seq: 0,
        stepped: [],
        artifacts: [],
        usageEntries: [],
        state: 'queued',
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        stopVerifiedAt: null,
        cancelRequested: false,
        cancelReason: null,
        failure: null,
        finished: false,
      };
      runs.set(run.id, record);
      const execution = execute(record);
      record.execution = execution;
      await execution;
      return dispatchAccepted({
        kind: KIND,
        run_id: run.id,
        tracking: { modes: tracking.modes },
        state: record.state,
        detail: {
          goal: pack.goal,
          steps: record.stepped.map((step) => step.name),
          artifacts: record.artifacts.map((artifact) => artifact.path),
        },
      });
    },

    status: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return runStatusUnknown({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run' });
      }
      const health =
        record.state === 'failed'
          ? TRACKER_HEALTH.noProgress
          : record.state === 'queued'
            ? TRACKER_HEALTH.progress
            : TRACKER_HEALTH.progress;
      return runStatusOk({
        kind: KIND,
        run_id: record.run.id,
        state: record.state,
        health,
        usage: usageOf(record),
        progress: {
          steps_completed: record.stepped.length,
          steps_total: record.steps.length,
          current_step: record.stepped.at(-1)?.name ?? null,
          failure: record.failure,
        },
        detail: {
          stop_verified_at: record.stopVerifiedAt,
          artifacts: record.artifacts.map((artifact) => artifact.path),
        },
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
      if (record.finished) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: false,
          state: record.state,
          code: ERROR_CODES.alreadyFinished,
          message: `run already ${record.state}`,
        });
      }
      record.cancelRequested = true;
      record.cancelReason = record.cancelReason ?? 'cancel_requested';
      return cancelResult({
        kind: KIND,
        run_id: record.run.id,
        requested: true,
        state: 'cancelling',
        code: 'stop_pending',
        message: 'cancel requested; waiting for the current step to return',
      });
    },

    follow: async (handle, sinceSeq = 0) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return followResult({ kind: KIND, run_id: runId, events: [], next_seq: sinceSeq, detail: { code: ERROR_CODES.unknownRun } });
      }
      const events = record.events.filter((event) => event.seq > sinceSeq);
      const nextSeq = record.events.reduce((max, event) => Math.max(max, event.seq), sinceSeq);
      return followResult({ kind: KIND, run_id: record.run.id, events, next_seq: nextSeq });
    },

    collectArtifacts: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return artifactList({ kind: KIND, run_id: runId, items: [] });
      const items = record.artifacts.map((artifact) => {
        const content =
          typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content ?? null);
        return { path: artifact.path, sha256: sha256(content), bytes: Buffer.byteLength(content) };
      });
      return artifactList({ kind: KIND, run_id: record.run.id, items });
    },

    collectEvidence: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return evidenceList({ kind: KIND, run_id: runId, items: [] });
      const items = [
        {
          kind: 'dispatch',
          ref: `tool_chain:${record.run.id}`,
          sha256: sha256(JSON.stringify(record.request)),
          command: null,
          output_excerpt: truncate(record.request.taskPack.goal),
        },
        ...record.stepped.map((step) => ({
          kind: 'step',
          ref: `tool_chain:${record.run.id}:${step.name}`,
          sha256: sha256(JSON.stringify(step.output)),
          command: null,
          output_excerpt: truncate(step.output),
        })),
      ];
      return evidenceList({ kind: KIND, run_id: record.run.id, items });
    },

    usage: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return usageReport({ kind: KIND, run_id: runId, usage: emptyUsage('unavailable') });
      return usageReport({ kind: KIND, run_id: record.run.id, usage: usageOf(record) });
    },
  };

  adapter = defineAdapter({
    kind: KIND,
    capabilities: {
      tracking: { status: true, follow: true },
      artifacts: true,
      evidence: true,
      usage: true,
      cancel: { verify: 'local' },
      synchronous: true,
    },
    methods,
  });
  return adapter;
}
