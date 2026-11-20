/**
 * `dsh_session` executor adapter — path A of docs/prd/16-execution-paths.md.
 *
 * It is a thin, injected-`fetch` HTTP client for the 12 DSH bridge tools
 * (recon.md §3.2). The adapter never creates its own network client: callers
 * pass `fetch`, so tests point it at a local fake server and production wiring
 * is explicit.
 *
 * dispatch   -> dsh_create_session (when no session yet) + dsh_prompt
 * status     -> dsh_get_status + dsh_get_projections
 * follow     -> dsh_follow (<=30s / <=200 events; the client advances sinceSeq)
 * cancel     -> dsh_cancel + stop verification (bridge cancelled, no child
 *               processes, workspace writes stable N seconds) else stop_unknown
 * artifacts  -> dsh_list_artifacts (+ dsh_read_workspace_file for sha256)
 * evidence   -> dispatch + events + artifacts
 * usage      -> dsh_get_projections (usage/cost), source=unavailable when absent
 */

import {
  ERROR_CODES,
  TRACKER_HEALTH,
  artifactList,
  cancelResult,
  confirmStop,
  defineAdapter,
  dispatchAccepted,
  dispatchRejected,
  emptyUsage,
  evidenceList,
  followResult,
  followUnavailable,
  readDispatchRequest,
  readHandle,
  resolveTracking,
  runStatusOk,
  runStatusUnknown,
  sha256,
  truncate,
  usageReport,
} from './contract.js';

const KIND = 'dsh_session';

export const BRIDGE_TOOLS = Object.freeze([
  'dsh_list_sessions',
  'dsh_create_session',
  'dsh_prompt',
  'dsh_steer',
  'dsh_update_queue',
  'dsh_cancel',
  'dsh_get_status',
  'dsh_get_projections',
  'dsh_follow',
  'dsh_read_workspace_file',
  'dsh_list_artifacts',
  'dsh_list_workspaces',
]);

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function camelCase(tool) {
  return tool
    .replace(/^dsh_/, '')
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Injected-fetch client for the 12 bridge tools; one POST per tool call. */
export function createBridgeClient({ fetch, baseUrl, token }) {
  if (typeof fetch !== 'function') {
    throw new TypeError('dsh_session adapter requires an injected fetch function');
  }
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new TypeError('dsh_session adapter requires a bridgeUrl');
  }
  async function call(tool, args = {}) {
    let response;
    try {
      response = await fetch(new URL(`/tools/${tool}`, baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(typeof token === 'string' && token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(args),
      });
    } catch (error) {
      return { ok: false, code: ERROR_CODES.bridgeUnreachable, message: error?.message ?? String(error) };
    }
    if (!response || response.ok !== true) {
      const status = response?.status ?? null;
      const code =
        status === 401 || status === 403
          ? 'bridge_unauthorized'
          : ERROR_CODES.bridgeError;
      return { ok: false, code, status, message: `${tool} failed with HTTP ${status ?? 'unknown'}` };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, code: ERROR_CODES.bridgeBadResponse, message: `${tool} returned non-JSON` };
    }
    if (payload && payload.ok === false) {
      return {
        ok: false,
        code: payload.error?.code ?? ERROR_CODES.bridgeError,
        message: payload.error?.message ?? `${tool} failed`,
      };
    }
    return { ok: true, result: payload?.result ?? payload ?? {} };
  }

  const client = { call };
  for (const tool of BRIDGE_TOOLS) {
    client[camelCase(tool)] = (args) => call(tool, args);
  }
  return client;
}

function buildPromptText(taskPack, run) {
  const lines = [`# 任务 ${run.id}`, `目标：${taskPack.goal}`];
  if (Array.isArray(taskPack.constraints) && taskPack.constraints.length > 0) {
    lines.push(`约束：\n- ${taskPack.constraints.join('\n- ')}`);
  }
  if (Array.isArray(taskPack.acceptance) && taskPack.acceptance.length > 0) {
    lines.push(`验收标准：\n- ${taskPack.acceptance.join('\n- ')}`);
  }
  if (Array.isArray(taskPack.context_refs) && taskPack.context_refs.length > 0) {
    lines.push(`上下文：\n- ${taskPack.context_refs.join('\n- ')}`);
  }
  lines.push(`派发标记：${run.id}`);
  return lines.join('\n\n');
}

function usageFromProjections(projections) {
  if (!projections?.ok) return emptyUsage('unavailable');
  const values = projections.result?.values ?? {};
  if (!projections.result?.present) return emptyUsage('unavailable');
  const raw = values.usage ?? {};
  const cost = values.cost ?? {};
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return 0;
  };
  return {
    tokens_in: pick(raw.tokens_in, raw.tokensIn, raw.input_tokens),
    tokens_out: pick(raw.tokens_out, raw.tokensOut, raw.output_tokens),
    tokens_cached: pick(raw.tokens_cached, raw.tokensCached, raw.cached_tokens),
    cost_cny: pick(raw.cost_cny, raw.costCny, cost.cny, cost.cost_cny),
    source: 'projections',
  };
}

export function createDshSessionAdapter(options = {}) {
  const bridge =
    options.bridge ??
    createBridgeClient({ fetch: options.fetch, baseUrl: options.bridgeUrl ?? options.baseUrl, token: options.token });
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const minStableMs = Number(options.minStableMs ?? 2000);
  const maxFollowEvents = clamp(options.maxEvents ?? 200, 1, 200);
  const followTimeoutMs = clamp(options.timeoutMs ?? 30_000, 500, 30_000);
  const maxArtifactBytes = clamp(options.maxArtifactBytes ?? 65_536, 1, 8 * 1024 * 1024);
  const maxArtifacts = clamp(options.maxArtifacts ?? 50, 1, 500);
  const runs = new Map();

  function recordOf(handle) {
    const { run_id: runId } = readHandle(handle);
    return runId ? runs.get(runId) ?? null : null;
  }

  async function resolveSessionId(record) {
    if (record.sessionId) return { ok: true, sessionId: record.sessionId };
    const { workspace, run } = record.request;
    const created = await bridge.createSession({
      cwd: workspace.path,
      title: `run ${run.id}`,
      source: String(run.id).replace(/[^a-z0-9._-]/gi, '-'),
    });
    if (!created.ok) return { ok: false, code: created.code, message: created.message };
    const sessionId = created.result?.sessionId ?? created.result?.session_id ?? null;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, code: ERROR_CODES.bridgeBadResponse, message: 'dsh_create_session returned no sessionId' };
    }
    return { ok: true, sessionId };
  }

  let adapter;
  const methods = {
    /** The 12 bridge tools, exposed deliberately: same names as the bridge docs. */
    tools: bridge,

    dispatch: async (request, taskPack, workspace, budget) => {
      const parsed = readDispatchRequest(request, taskPack, workspace, budget);
      if (!parsed.ok) return dispatchRejected({ kind: KIND, code: parsed.code, message: parsed.message });
      const tracking = resolveTracking(adapter, parsed.value.tracking);
      if (!tracking.ok) {
        return dispatchRejected({ kind: KIND, code: tracking.code, message: tracking.message, details: tracking.details });
      }
      const { run, taskPack: pack, workspace: ws } = parsed.value;
      if (typeof ws.path !== 'string' || ws.path.length === 0) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          code: ERROR_CODES.invalidRequest,
          message: 'dsh_session dispatch requires workspace.path (the bridge cwd)',
        });
      }
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
        sessionId: parsed.value.session_id ?? null,
        startedAt: now(),
        lastSeq: 0,
        usageEntries: [],
      };
      runs.set(run.id, record);

      if (record.sessionId) {
        // Session reuse (T-PATH-05): verify the session is alive before prompting.
        const status = await bridge.getStatus({ sessionId: record.sessionId });
        if (!status.ok) {
          runs.delete(run.id);
          return dispatchRejected({
            kind: KIND,
            run_id: run.id,
            code: status.code,
            message: `existing session ${record.sessionId} is not usable: ${status.message}`,
          });
        }
      } else {
        const session = await resolveSessionId(record);
        if (!session.ok) {
          runs.delete(run.id);
          return dispatchRejected({ kind: KIND, run_id: run.id, code: session.code, message: session.message });
        }
        record.sessionId = session.sessionId;
      }

      const prompted = await bridge.prompt({ sessionId: record.sessionId, text: buildPromptText(pack, run), delivery: 'queue' });
      if (!prompted.ok) {
        runs.delete(run.id);
        return dispatchRejected({ kind: KIND, run_id: run.id, code: prompted.code, message: prompted.message });
      }
      if (prompted.result?.accepted !== true) {
        runs.delete(run.id);
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          code: 'prompt_not_accepted',
          message: 'dsh_prompt did not accept the dispatch',
        });
      }
      record.requestId = prompted.result?.requestId ?? prompted.result?.request_id ?? null;
      record.acceptedAt = now();
      return dispatchAccepted({
        kind: KIND,
        run_id: run.id,
        tracking: { modes: tracking.modes },
        session_id: record.sessionId,
        state: 'dispatched',
        detail: { request_id: record.requestId, reused_session: parsed.value.session_id !== null && parsed.value.session_id !== undefined },
      });
    },

    status: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return runStatusUnknown({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run' });
      }
      const status = await bridge.getStatus({ sessionId: record.sessionId });
      if (!status.ok) {
        return runStatusUnknown({
          kind: KIND,
          run_id: record.run.id,
          code: status.code,
          message: status.message,
          detail: { session_id: record.sessionId },
        });
      }
      const projections = await bridge.getProjections({ sessionId: record.sessionId, keys: ['usage', 'cost'] });
      const running = status.result?.running === true;
      const queueLength = Number(status.result?.queueLength ?? status.result?.queue_length ?? 0);
      const state = running ? 'running' : queueLength > 0 ? 'queued' : 'idle';
      const health = running || queueLength > 0 ? TRACKER_HEALTH.progress : TRACKER_HEALTH.noProgress;
      return runStatusOk({
        kind: KIND,
        run_id: record.run.id,
        state,
        health,
        usage: usageFromProjections(projections),
        progress: {
          running,
          queue_length: queueLength,
          last_seq: record.lastSeq,
          cursor: status.result?.cursor ?? null,
        },
        detail: { session_id: record.sessionId, agent_available: status.result?.agentAvailable ?? null },
      });
    },

    cancel: async (handle, cancelOptions = {}) => {
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
      const cancelled = await bridge.cancel({ sessionId: record.sessionId });
      if (!cancelled.ok || cancelled.result?.accepted === false) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: false,
          state: 'stop_unknown',
          remote_may_still_run: true,
          code: cancelled.ok ? 'cancel_not_accepted' : cancelled.code,
          message: cancelled.ok
            ? 'bridge refused the cancel request (only the current turn can be cancelled)'
            : `cancel not accepted: ${cancelled.message}`,
          reasons: ['cancel_not_accepted'],
        });
      }

      const status = await bridge.getStatus({ sessionId: record.sessionId });
      const verifyStop = cancelOptions.verifyStop ?? options.verifyStop;
      let verification = null;
      try {
        verification = typeof verifyStop === 'function' ? await verifyStop({ run: record.run, session_id: record.sessionId }) : null;
      } catch (error) {
        verification = { error: error?.message ?? String(error) };
      }
      const reasons = [...(cancelOptions.reasons ?? [])];
      if (verification?.error) reasons.push('stop_verifier_failed');
      const confirmation = confirmStop({
        accepted: true,
        remoteStopped: status.ok && status.result?.running === false,
        children: verification?.children ?? null,
        stableForMs: verification?.stableForMs ?? null,
        minStableMs: Number(cancelOptions.minStableMs ?? minStableMs),
        reasons,
      });
      if (!status.ok) confirmation.reasons.push('status_unreachable');
      if (!confirmation.verified) {
        record.state = 'stop_unknown';
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: true,
          state: 'stop_unknown',
          remote_may_still_run: true,
          code: ERROR_CODES.stopUnverified,
          message: `stop unverified: ${confirmation.reasons.join(', ')}`,
          reasons: confirmation.reasons,
        });
      }
      record.state = 'cancelled';
      record.stopVerifiedAt = now();
      return cancelResult({
        kind: KIND,
        run_id: record.run.id,
        requested: true,
        state: 'cancelled',
        verified_stopped_at: record.stopVerifiedAt,
        message: 'bridge accepted cancel; no child processes; workspace writes stable',
      });
    },

    follow: async (handle, sinceSeq = 0) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return followUnavailable({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run', next_seq: sinceSeq });
      }
      const follow = await bridge.follow({
        sessionId: record.sessionId,
        sinceSeq: Number(sinceSeq) || 0,
        maxEvents: maxFollowEvents,
        timeoutMs: followTimeoutMs,
      });
      if (!follow.ok) {
        return followUnavailable({ kind: KIND, run_id: record.run.id, code: follow.code, message: follow.message, next_seq: sinceSeq });
      }
      const records = Array.isArray(follow.result?.records) ? follow.result.records : [];
      const events = records.map((entry) => ({
        seq: Number(entry.seq),
        type: String(entry.type),
        at: Number(entry.time ?? entry.at ?? now()),
        data: entry.data ?? null,
      }));
      const nextSeq = events.reduce((max, event) => Math.max(max, event.seq), Number(sinceSeq) || 0);
      record.lastSeq = Math.max(record.lastSeq, nextSeq);
      return followResult({
        kind: KIND,
        run_id: record.run.id,
        events,
        next_seq: nextSeq,
        timedOut: follow.result?.timedOut === true,
        hasMore: follow.result?.hasMore === true,
        detail: { cursor: follow.result?.cursor ?? null },
      });
    },

    collectArtifacts: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return artifactList({ kind: KIND, run_id: runId, items: [] });
      const listed = await bridge.listArtifacts({ sessionId: record.sessionId });
      if (!listed.ok) {
        return { ...artifactList({ kind: KIND, run_id: record.run.id, items: [] }), ok: false, code: listed.code, message: listed.message };
      }
      const rawItems = Array.isArray(listed.result?.items) ? listed.result.items.slice(0, maxArtifacts) : [];
      const items = [];
      for (const entry of rawItems) {
        const read = await bridge.readWorkspaceFile({
          sessionId: record.sessionId,
          path: entry.path,
          maxBytes: maxArtifactBytes,
        });
        const content = read.ok ? String(read.result?.content ?? '') : null;
        items.push({
          path: String(entry.path),
          sha256: content === null ? null : sha256(content),
          bytes: Number(entry.size ?? (content === null ? 0 : Buffer.byteLength(content))),
        });
      }
      return artifactList({ kind: KIND, run_id: record.run.id, items });
    },

    collectEvidence: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return evidenceList({ kind: KIND, run_id: runId, items: [] });
      const items = [
        {
          kind: 'dispatch',
          ref: `dsh_session:${record.sessionId}`,
          sha256: sha256(JSON.stringify(record.request)),
          command: null,
          output_excerpt: truncate(buildPromptText(record.request.taskPack, record.run)),
        },
      ];
      const follow = await bridge.follow({ sessionId: record.sessionId, sinceSeq: 0, maxEvents: maxFollowEvents, timeoutMs: 500 });
      if (!follow.ok) {
        return {
          ...evidenceList({ kind: KIND, run_id: record.run.id, items }),
          ok: false,
          code: follow.code,
          message: `follow unavailable: ${follow.message}`,
        };
      }
      const records = Array.isArray(follow.result?.records) ? follow.result.records : [];
      for (const entry of records) {
        items.push({
          kind: 'event',
          ref: `dsh_session:${record.sessionId}:seq:${entry.seq}`,
          sha256: sha256(JSON.stringify(entry)),
          command: null,
          output_excerpt: truncate(JSON.stringify(entry.data ?? entry)),
        });
      }
      const artifacts = await adapter.collectArtifacts({ run_id: record.run.id });
      for (const artifact of artifacts.items) {
        items.push({
          kind: 'artifact',
          ref: artifact.path,
          sha256: artifact.sha256,
          command: null,
          output_excerpt: `${artifact.path} (${artifact.bytes} bytes)`,
        });
      }
      return evidenceList({ kind: KIND, run_id: record.run.id, items });
    },

    usage: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return usageReport({ kind: KIND, run_id: runId, usage: emptyUsage('unavailable') });
      const projections = await bridge.getProjections({ sessionId: record.sessionId, keys: ['usage', 'cost'] });
      const usage = usageFromProjections(projections);
      const report = usageReport({ kind: KIND, run_id: record.run.id, usage });
      if (!projections.ok) return { ...report, ok: false, code: projections.code, message: projections.message };
      return report;
    },

    /** Capability probe (16 §7). Not part of the seven-method contract. */
    probe: async () => {
      const listed = await bridge.listWorkspaces({});
      if (!listed.ok) return { available: false, kind: KIND, reason: listed.code, message: listed.message };
      return { available: true, kind: KIND, bridge: 'ok' };
    },
  };

  adapter = defineAdapter({
    kind: KIND,
    capabilities: {
      tracking: { status: true, follow: true },
      artifacts: true,
      evidence: true,
      usage: true,
      cancel: { verify: 'bridge+process+workspace' },
      session_reuse: true,
      remote: true,
      tools: BRIDGE_TOOLS.length,
    },
    methods,
  });
  return adapter;
}
