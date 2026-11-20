/**
 * `tool_chain` adapter for the self-media content pipeline.
 *
 * It implements the shared executor contract from `packages/adapters/src/contract.js`
 * (dispatch / status / cancel / follow / collectArtifacts / collectEvidence / usage)
 * while executing the six-stage content chain in `./pipeline.js`. The adapter is
 * local and synchronous, performs no network calls itself, and treats every
 * external capability as injected configuration.
 *
 * Cancellation follows the same rule as the generic tool_chain adapter: a run is
 * `cancelled` only after the currently running stage returns and no later stage
 * starts. The chain never claims a remote stop it cannot verify.
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
} from '../../../adapters/src/contract.js';
import { CANCELLED_CODE, STAGES, createContentPipeline } from './pipeline.js';

const KIND = 'tool_chain';

function cancelledError() {
  const error = new Error('content chain cancelled');
  error.code = CANCELLED_CODE;
  return error;
}

function pipelineInput(taskPack) {
  const inputs = taskPack.inputs ?? {};
  const topic = typeof inputs.topic === 'string' && inputs.topic.trim().length > 0
    ? inputs.topic
    : taskPack.goal;
  return {
    topic,
    goal: taskPack.goal,
    platform: inputs.platform,
    audience: inputs.audience,
    tone: inputs.tone,
    tags: inputs.tags,
    facts: inputs.facts,
    constraints: taskPack.constraints,
    acceptance: taskPack.acceptance,
    min_title_candidates: inputs.min_title_candidates,
    min_independent_sources_for_key_fact: inputs.min_independent_sources_for_key_fact,
  };
}

export function createContentToolChainAdapter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const pipeline = options.pipeline ?? createContentPipeline({
    now,
    search: options.search,
    fetch: options.fetch,
    model: options.model,
    snapshotStore: options.snapshotStore,
    minTitleCandidates: options.minTitleCandidates,
    minIndependentSourcesForKeyFact: options.minIndependentSourcesForKeyFact,
    excerptChars: options.excerptChars,
  });
  const runs = new Map();

  function recordOf(handle) {
    const { run_id: runId } = readHandle(handle);
    return runId ? runs.get(runId) ?? null : null;
  }

  function pushEvent(record, type, data = {}) {
    record.seq += 1;
    record.events.push({ seq: record.seq, type, at: now(), data });
  }

  function markCancelled(record) {
    record.state = 'cancelled';
    record.cancelledAt = now();
    record.stopVerifiedAt = now();
    pushEvent(record, 'run.cancelled', {
      reason: record.cancelReason ?? 'cancel_requested',
      local: true,
    });
  }

  async function execute(record) {
    record.state = 'running';
    record.startedAt = now();
    pushEvent(record, 'run.started', {
      goal: record.request.taskPack.goal,
      steps: [...STAGES],
    });

    const onStep = (event) => {
      if (event.status === 'started') {
        if (record.cancelRequested) throw cancelledError();
        pushEvent(record, 'step.started', { step: event.name });
        return;
      }
      if (event.status === 'completed') {
        record.stepped.push({
          name: event.name,
          output: event.output ?? null,
          durationMs: event.duration_ms ?? 0,
        });
        pushEvent(record, 'step.completed', {
          step: event.name,
          duration_ms: event.duration_ms ?? 0,
        });
        return;
      }
      if (event.status === 'cancelled') {
        pushEvent(record, 'step.aborted', { step: event.name });
        return;
      }
      pushEvent(record, 'step.failed', { step: event.name, message: event.message ?? 'step failed' });
    };

    try {
      const result = await pipeline.run(pipelineInput(record.request.taskPack), { onStep });
      record.result = result;
      record.outcome = result.status;
      record.warnings = result.warnings ?? [];
      record.blockedReasons = (result.blockers ?? []).map((blocker) => blocker.code);
      record.usageEntries.push(result.usage);

      if (record.cancelRequested) {
        markCancelled(record);
      } else {
        record.artifacts.push({
          path: 'article-pack.json',
          content: JSON.stringify(result.article_pack, null, 2),
        });
        record.state = 'completed';
        record.completedAt = now();
        pushEvent(record, 'run.completed', {
          outcome: result.status,
          steps: record.stepped.length,
        });
      }
    } catch (error) {
      if (error?.code === CANCELLED_CODE) {
        markCancelled(record);
      } else {
        record.state = 'failed';
        record.failure = {
          code: 'pipeline_failed',
          message: error?.message ?? String(error),
        };
        record.completedAt = now();
        pushEvent(record, 'run.failed', { message: record.failure.message });
      }
    } finally {
      record.finished = true;
    }
  }

  function usageOf(record) {
    const merged = emptyUsage('content_pipeline');
    for (const entry of record.usageEntries) {
      for (const key of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost_cny']) {
        const value = Number(entry?.[key] ?? 0);
        if (Number.isFinite(value)) merged[key] += value;
      }
    }
    merged.source = record.usageEntries.some((entry) => entry?.source === 'model_call')
      ? 'model_call'
      : 'unavailable';
    return merged;
  }

  let adapter;
  const methods = {
    dispatch: async (request, taskPack, workspace, budget) => {
      const parsed = readDispatchRequest(request, taskPack, workspace, budget);
      if (!parsed.ok) return dispatchRejected({ kind: KIND, code: parsed.code, message: parsed.message });
      const tracking = resolveTracking(adapter, parsed.value.tracking);
      if (!tracking.ok) {
        return dispatchRejected({
          kind: KIND,
          code: tracking.code,
          message: tracking.message,
          details: tracking.details,
        });
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
        events: [],
        seq: 0,
        stepped: [],
        artifacts: [],
        usageEntries: [],
        state: 'queued',
        outcome: null,
        warnings: [],
        blockedReasons: [],
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
          outcome: record.outcome,
          status: record.outcome,
          blocked: record.outcome === 'blocked',
          steps: record.stepped.map((step) => step.name),
          artifacts: record.artifacts.map((artifact) => artifact.path),
          blocked_reasons: record.blockedReasons,
          warnings: record.warnings,
          failure: record.failure,
        },
      });
    },

    status: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return runStatusUnknown({
          kind: KIND,
          run_id: runId,
          code: ERROR_CODES.unknownRun,
          message: 'unknown run',
        });
      }
      const health = record.state === 'failed' || record.outcome === 'blocked'
        ? TRACKER_HEALTH.noProgress
        : TRACKER_HEALTH.progress;
      return runStatusOk({
        kind: KIND,
        run_id: record.run.id,
        state: record.state,
        health,
        usage: usageOf(record),
        progress: {
          steps_completed: record.stepped.length,
          steps_total: STAGES.length,
          current_step: record.stepped.at(-1)?.name ?? null,
          outcome: record.outcome,
          status: record.outcome,
          blocked: record.outcome === 'blocked',
          blocked_reasons: record.blockedReasons,
          failure: record.failure,
        },
        detail: {
          stop_verified_at: record.stopVerifiedAt,
          artifacts: record.artifacts.map((artifact) => artifact.path),
          outcome: record.outcome,
          status: record.outcome,
          blocked: record.outcome === 'blocked',
          warnings: record.warnings,
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
        message: 'cancel requested; waiting for the current stage to return',
      });
    },

    follow: async (handle, sinceSeq = 0) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return followResult({
          kind: KIND,
          run_id: runId,
          events: [],
          next_seq: sinceSeq,
          detail: { code: ERROR_CODES.unknownRun },
        });
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
        const content = typeof artifact.content === 'string'
          ? artifact.content
          : JSON.stringify(artifact.content ?? null);
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
          ref: `content:${record.run.id}`,
          sha256: sha256(JSON.stringify(record.request)),
          command: null,
          output_excerpt: truncate(record.request.taskPack.goal),
        },
        ...record.stepped.map((step) => ({
          kind: 'step',
          ref: `content:${record.run.id}:${step.name}`,
          sha256: sha256(JSON.stringify(step.output)),
          command: null,
          output_excerpt: truncate(step.output),
        })),
      ];
      for (const artifact of record.artifacts) {
        const content = typeof artifact.content === 'string'
          ? artifact.content
          : JSON.stringify(artifact.content ?? null);
        items.push({
          kind: 'artifact',
          ref: `content:${record.run.id}:${artifact.path}`,
          sha256: sha256(content),
          command: null,
          output_excerpt: truncate(content),
        });
      }
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
