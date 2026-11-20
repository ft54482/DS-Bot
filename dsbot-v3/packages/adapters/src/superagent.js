/**
 * `superagent` executor adapter — path B of docs/prd/16-execution-paths.md.
 *
 * SuperAgent has no "create ticket" API. A ticket is produced by a GitHub event:
 * an Issue (or comment) whose body ends with a standalone line mentioning the
 * bot account, created by the main account (16 §3, 17 §7.1). Tracking and
 * cancellation go through the orchestrator management API:
 *
 *   GET  {base}/orchestrator/api/state              (header x-orchestrator-request: 1)
 *   GET  {base}/orchestrator/api/tickets
 *   GET  {base}/orchestrator/api/tickets/{id}
 *   POST {base}/orchestrator/api/tickets/{id}/stop
 *
 * Both clients are injected (`fetch`, base URLs), so tests use a local fake
 * server and nothing here can silently reach a real network. When the
 * orchestrator is unavailable the adapter returns `blocked`; it never falls
 * back to `dsh_session` (16 §2.5, T-PATH-04). The router owns that decision.
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

const KIND = 'superagent';

const ORCH_HEADERS = Object.freeze({ 'x-orchestrator-request': '1' });

const TICKET_STATE_MAP = Object.freeze({
  queued: 'queued',
  planned: 'queued',
  working: 'running',
  running: 'running',
  reviewing: 'running',
  review: 'running',
  ready: 'running',
  accepting: 'running',
  done: 'completed',
  completed: 'completed',
  merged: 'completed',
  blocked: 'blocked',
  stalled: 'stalled',
  failed: 'failed',
  stopped: 'cancelled',
  cancelled: 'cancelled',
  cancelling: 'cancelling',
  stop_unknown: 'stop_unknown',
});

const STOPPED_TICKET_STATES = Object.freeze(['stopped', 'cancelled', 'done']);

function ticketIdOf(ticket) {
  return ticket?.id ?? ticket?.ticket_id ?? ticket?.ticketId ?? null;
}

function cardOf(ticket) {
  return ticket?.card && typeof ticket.card === 'object' ? ticket.card : ticket ?? {};
}

function matchesIssue(ticket, issue) {
  if (!ticket || !issue) return false;
  const card = cardOf(ticket);
  const values = [
    ticket.source_url,
    ticket.sourceUrl,
    ticket.source?.url,
    card.source_url,
    card.sourceUrl,
    card.issue_number,
    card.issue?.number,
    ticket.title,
  ];
  const number = String(issue.number);
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return String(value) === number;
    return typeof value === 'string' && (value.includes(`/issues/${number}`) || value === number);
  });
}

function mapTicketState(state) {
  if (typeof state !== 'string') return 'unknown';
  return TICKET_STATE_MAP[state] ?? 'unknown';
}

function usageFromTicket(ticket) {
  if (!ticket) return emptyUsage('unavailable');
  const card = cardOf(ticket);
  const usage = card.usage ?? ticket.usage ?? {};
  const pick = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return 0;
  };
  const usageValues = {
    tokens_in: pick(usage.tokens_in, usage.tokensIn, card.tokens_in, ticket.tokens_in),
    tokens_out: pick(usage.tokens_out, usage.tokensOut, card.tokens_out, ticket.tokens_out),
    tokens_cached: pick(usage.tokens_cached, usage.tokensCached, card.tokens_cached, ticket.tokens_cached),
    cost_cny: pick(usage.cost_cny, usage.costCny, card.cost_cny, ticket.cost_cny),
  };
  const hasValue = Object.values(usageValues).some((value) => value > 0);
  return { ...usageValues, source: hasValue ? 'ticket_card' : 'unavailable' };
}

function buildIssueBody(taskPack, run, teammate) {
  const mention = teammate.startsWith('@') ? teammate : `@${teammate}`;
  const lines = [
    `L3 适配器派发（run ${run.id}）`,
    '',
    `## 目标\n${taskPack.goal}`,
    '',
    `## 约束\n${(taskPack.constraints ?? []).map((item) => `- ${item}`).join('\n') || '- 无'}`,
    '',
    `## 验收\n${(taskPack.acceptance ?? []).map((item) => `- ${item}`).join('\n') || '- 无'}`,
    '',
    `## 工作区\n- repo: ${run.workspace_repo ?? 'n/a'}\n- base_commit: ${run.base_commit ?? 'n/a'}`,
    '',
    `<!-- ds-bot run:${run.id} -->`,
    mention,
  ];
  return lines.join('\n');
}

export function createSuperagentAdapter(options = {}) {
  const fetch = options.fetch;
  if (typeof fetch !== 'function') {
    throw new TypeError('superagent adapter requires an injected fetch function');
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const github = options.github ?? {};
  const orchestrator = options.orchestrator ?? {};
  const identity = options.identity ?? {};
  const teammate = identity.teammate ?? 'yuxianghan-droid';
  const actingAccount = identity.actor ?? 'ft54482';
  const minStableMs = Number(options.minStableMs ?? 2000);
  const runs = new Map();

  function recordOf(handle) {
    const { run_id: runId } = readHandle(handle);
    return runId ? runs.get(runId) ?? null : null;
  }

  async function requestJson(url, init, unreachableCode) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return { ok: false, code: unreachableCode, message: error?.message ?? String(error) };
    }
    if (!response || response.ok !== true) {
      return {
        ok: false,
        code: `${unreachableCode}:http_${response?.status ?? 'unknown'}`,
        status: response?.status ?? null,
        message: `${url} failed with HTTP ${response?.status ?? 'unknown'}`,
      };
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, code: `${unreachableCode}:bad_json`, message: `${url} returned non-JSON` };
    }
    return { ok: true, payload };
  }

  function orchestratorUrl(path) {
    return new URL(path, orchestrator.baseUrl);
  }

  async function probeOrchestrator() {
    if (typeof orchestrator.baseUrl !== 'string' || orchestrator.baseUrl.length === 0) {
      return { available: false, kind: KIND, reason: ERROR_CODES.notConfigured, message: 'orchestrator.baseUrl is not configured' };
    }
    const response = await requestJson(
      orchestratorUrl('/orchestrator/api/state'),
      { headers: { ...ORCH_HEADERS, ...(orchestrator.token ? { authorization: `Bearer ${orchestrator.token}` } : {}) } },
      ERROR_CODES.orchestratorUnreachable,
    );
    if (!response.ok) {
      return { available: false, kind: KIND, reason: response.code, message: response.message };
    }
    return {
      available: true,
      kind: KIND,
      state: response.payload?.state ?? null,
      version: response.payload?.version ?? null,
    };
  }

  async function availability() {
    if (typeof options.availability === 'function') return options.availability();
    if (options.availability !== undefined) {
      return typeof options.availability === 'boolean'
        ? { available: options.availability, kind: KIND, reason: options.availability ? null : 'injected_unavailable' }
        : options.availability;
    }
    return probeOrchestrator();
  }

  async function getTicket(ticketId) {
    const response = await requestJson(
      orchestratorUrl(`/orchestrator/api/tickets/${encodeURIComponent(ticketId)}`),
      { headers: { ...ORCH_HEADERS } },
      ERROR_CODES.orchestratorUnreachable,
    );
    if (!response.ok) return response;
    return { ok: true, ticket: response.payload?.ticket ?? response.payload };
  }

  async function listTickets() {
    const response = await requestJson(
      orchestratorUrl('/orchestrator/api/tickets'),
      { headers: { ...ORCH_HEADERS } },
      ERROR_CODES.orchestratorUnreachable,
    );
    if (!response.ok) return response;
    const payload = response.payload;
    const tickets = Array.isArray(payload) ? payload : payload?.tickets ?? payload?.items ?? [];
    return { ok: true, tickets };
  }

  async function resolveTicket(record) {
    if (record.ticketId) {
      const single = await getTicket(record.ticketId);
      if (single.ok) return single;
    }
    const listed = await listTickets();
    if (!listed.ok) return listed;
    const found = listed.tickets.find((ticket) => matchesIssue(ticket, record.issue)) ?? null;
    if (!found) {
      return { ok: false, code: ERROR_CODES.ticketNotFound, message: 'orchestrator has no ticket for this issue yet' };
    }
    record.ticketId = ticketIdOf(found);
    return { ok: true, ticket: found };
  }

  function syncEvents(record, ticket) {
    const card = cardOf(ticket);
    const key = JSON.stringify({
      state: ticket?.state ?? null,
      updated_at: ticket?.updated_at ?? ticket?.updatedAt ?? card.updated_at ?? null,
      pr: card?.pr?.url ?? ticket?.pr?.url ?? null,
      stop: card?.stop ?? null,
    });
    if (key === record.lastSnapshotKey) return;
    record.lastSnapshotKey = key;
    record.eventSeq += 1;
    const previous = record.lastTicketState;
    record.lastTicketState = ticket?.state ?? null;
    record.events.push({
      seq: record.eventSeq,
      type: 'ticket.state',
      at: now(),
      data: {
        ticket_id: ticketIdOf(ticket),
        state: ticket?.state ?? null,
        previous,
        pr_url: card?.pr?.url ?? null,
      },
    });
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
      const { run, taskPack: pack, workspace: ws } = parsed.value;
      const availabilityResult = await availability();
      if (!availabilityResult?.available) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          state: 'blocked',
          code: ERROR_CODES.executorUnavailable,
          message: `superagent unavailable: ${availabilityResult?.reason ?? 'unknown'}`,
          degraded: true,
          fallback: 'none',
          details: { reason: availabilityResult?.reason ?? null, probe: availabilityResult ?? null },
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
      const repo = ws.repo ?? github.repo ?? null;
      if (typeof repo !== 'string' || !repo.includes('/')) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          code: ERROR_CODES.invalidRequest,
          message: 'superagent dispatch requires workspace.repo (owner/name)',
        });
      }
      if (typeof github.apiBaseUrl !== 'string' || github.apiBaseUrl.length === 0) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          state: 'blocked',
          code: ERROR_CODES.notConfigured,
          message: 'superagent unavailable: github.apiBaseUrl is not configured',
          degraded: true,
          fallback: 'none',
          details: { reason: ERROR_CODES.notConfigured },
        });
      }
      const issueRequest = {
        title: `[DS Bot] ${pack.goal.slice(0, 120)}`,
        body: buildIssueBody(
          pack,
          { ...run, workspace_repo: repo, base_commit: ws.base_commit ?? null },
          teammate,
        ),
      };
      const created = await requestJson(
        new URL(`/repos/${repo}/issues`, github.apiBaseUrl),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/vnd.github+json',
            'user-agent': 'ds-bot-adapters',
            ...(github.token ? { authorization: `Bearer ${github.token}` } : {}),
          },
          body: JSON.stringify(issueRequest),
        },
        ERROR_CODES.githubUnreachable,
      );
      if (!created.ok) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          state: 'blocked',
          code: created.code,
          message: `GitHub issue creation failed: ${created.message}`,
          degraded: true,
          fallback: 'none',
          details: { repo },
        });
      }
      const issue = {
        number: created.payload?.number ?? null,
        url: created.payload?.html_url ?? created.payload?.url ?? null,
        id: created.payload?.id ?? null,
      };
      if (issue.number === null) {
        return dispatchRejected({
          kind: KIND,
          run_id: run.id,
          state: 'blocked',
          code: ERROR_CODES.githubError,
          message: 'GitHub issue creation returned no issue number',
          degraded: true,
          fallback: 'none',
          details: { repo },
        });
      }
      const record = {
        run,
        request: parsed.value,
        repo,
        issue,
        ticketId: null,
        dispatchedAt: now(),
        events: [],
        eventSeq: 0,
        lastSnapshotKey: null,
        lastTicketState: null,
      };
      runs.set(run.id, record);
      return dispatchAccepted({
        kind: KIND,
        run_id: run.id,
        tracking: { modes: tracking.modes },
        ticket_id: null,
        ticket_id_pending: true,
        issue,
        state: 'dispatched',
        detail: {
          repo,
          acting_account: actingAccount,
          teammate,
          note: 'ticket id is assigned by the orchestrator Source when the issue event arrives',
        },
      });
    },

    status: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return runStatusUnknown({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run' });
      }
      const available = await availability();
      if (!available?.available) {
        return runStatusUnknown({
          kind: KIND,
          run_id: record.run.id,
          code: available?.reason ?? ERROR_CODES.executorUnavailable,
          message: `orchestrator unreachable: ${available?.reason ?? 'unknown'}`,
          detail: { issue: record.issue },
        });
      }
      const resolved = await resolveTicket(record);
      if (!resolved.ok) {
        return runStatusOk({
          kind: KIND,
          run_id: record.run.id,
          state: 'dispatched',
          health: TRACKER_HEALTH.noProgress,
          usage: emptyUsage('unavailable'),
          progress: { ticket_pending: true, issue_number: record.issue.number },
          detail: { issue: record.issue, reason: resolved.code },
        });
      }
      const ticket = resolved.ticket;
      syncEvents(record, ticket);
      const state = mapTicketState(ticket?.state);
      const health =
        state === 'blocked' || state === 'stalled'
          ? TRACKER_HEALTH.noProgress
          : state === 'unknown'
            ? TRACKER_HEALTH.unknown
            : TRACKER_HEALTH.progress;
      const card = cardOf(ticket);
      return runStatusOk({
        kind: KIND,
        run_id: record.run.id,
        state,
        health,
        usage: usageFromTicket(ticket),
        progress: {
          ticket_state: ticket?.state ?? null,
          ticket_id: ticketIdOf(ticket),
          pr_url: card?.pr?.url ?? null,
          review_rounds: card?.review_rounds ?? null,
        },
        detail: { issue: record.issue, ticket: { id: ticketIdOf(ticket), state: ticket?.state ?? null } },
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
      const resolved = await resolveTicket(record);
      if (!resolved.ok) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: false,
          state: 'stop_unknown',
          remote_may_still_run: true,
          code: resolved.code,
          message: `cannot stop: ${resolved.message}`,
          reasons: ['ticket_not_found'],
        });
      }
      const ticketId = ticketIdOf(resolved.ticket);
      const stopped = await requestJson(
        orchestratorUrl(`/orchestrator/api/tickets/${encodeURIComponent(ticketId)}/stop`),
        { method: 'POST', headers: { ...ORCH_HEADERS } },
        ERROR_CODES.orchestratorUnreachable,
      );
      if (!stopped.ok) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: false,
          state: 'stop_unknown',
          remote_may_still_run: true,
          code: stopped.code,
          message: `stop request not accepted: ${stopped.message}`,
          reasons: ['stop_not_accepted'],
        });
      }
      const after = await getTicket(ticketId);
      if (!after.ok) {
        return cancelResult({
          kind: KIND,
          run_id: record.run.id,
          requested: true,
          state: 'stop_unknown',
          remote_may_still_run: true,
          code: after.code,
          message: 'stop accepted but the ticket could not be re-read',
          reasons: ['ticket_unreadable_after_stop'],
        });
      }
      const ticket = after.ticket;
      const card = cardOf(ticket);
      const verifier = cancelOptions.verifyNoNewWrites ?? options.verifyNoNewWrites;
      let verification = null;
      try {
        verification = typeof verifier === 'function'
          ? await verifier({ ticket, ticket_id: ticketId, stop_at: now() })
          : null;
      } catch (error) {
        verification = { error: error?.message ?? String(error) };
      }
      const reasons = [...(cancelOptions.reasons ?? [])];
      if (verification?.error) reasons.push('stop_verifier_failed');
      const writesAfterStop =
        verification?.workspaceWritesAfterStop ??
        card?.workspace_writes_after_stop ??
        ticket?.workspace_writes_after_stop ??
        null;
      if (writesAfterStop === null) reasons.push('workspace_writes_unknown');
      if (writesAfterStop !== null && writesAfterStop > 0) reasons.push('workspace_writes_after_stop');
      const ticketStopped = STOPPED_TICKET_STATES.includes(ticket?.state);
      const confirmation = confirmStop({
        accepted: true,
        remoteStopped: ticketStopped,
        children: 0,
        stableForMs: writesAfterStop === 0 ? Number.POSITIVE_INFINITY : null,
        minStableMs: Number(cancelOptions.minStableMs ?? minStableMs),
        reasons: reasons.filter((reason) => reason !== 'workspace_writes_unstable'),
      });
      if (!confirmation.verified) {
        record.stopAttempt = { at: now(), ticket_state: ticket?.state ?? null, reasons: confirmation.reasons };
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
      record.stopVerifiedAt = now();
      return cancelResult({
        kind: KIND,
        run_id: record.run.id,
        requested: true,
        state: 'cancelled',
        verified_stopped_at: record.stopVerifiedAt,
        message: 'orchestrator stop accepted, ticket stopped, no workspace writes after stop',
      });
    },

    follow: async (handle, sinceSeq = 0) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return followUnavailable({ kind: KIND, run_id: runId, code: ERROR_CODES.unknownRun, message: 'unknown run', next_seq: sinceSeq });
      }
      const current = await adapter.status({ run_id: record.run.id });
      if (current.ok === false) {
        return followUnavailable({
          kind: KIND,
          run_id: record.run.id,
          code: current.code ?? ERROR_CODES.orchestratorUnreachable,
          message: current.message ?? 'orchestrator unreachable',
          next_seq: sinceSeq,
        });
      }
      const events = record.events.filter((event) => event.seq > sinceSeq);
      return followResult({
        kind: KIND,
        run_id: record.run.id,
        events,
        next_seq: record.eventSeq,
        detail: { transport: 'orchestrator_poll', has_push: false },
      });
    },

    collectArtifacts: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return artifactList({ kind: KIND, run_id: runId, items: [] });
      const items = [];
      if (record.issue?.url) {
        items.push({ path: `github:${record.repo}#issues/${record.issue.number}`, sha256: sha256(record.issue.url), bytes: 0 });
      }
      const resolved = await resolveTicket(record);
      if (!resolved.ok) {
        return { ...artifactList({ kind: KIND, run_id: record.run.id, items }), ok: false, code: resolved.code, message: resolved.message };
      }
      const card = cardOf(resolved.ticket);
      const pr = card?.pr ?? resolved.ticket?.pr ?? null;
      if (typeof pr === 'string') {
        items.push({ path: `github:${record.repo}#pull/${pr}`, sha256: sha256(`pull/${pr}`), bytes: 0 });
      } else if (pr?.url) {
        items.push({
          path: pr.number ? `github:${record.repo}#pull/${pr.number}` : pr.url,
          sha256: sha256(pr.url),
          bytes: 0,
        });
      }
      if (card?.branch || card?.commit) {
        const ref = `${card.branch ?? 'branch'}:${card.commit ?? card.head_sha ?? ''}`;
        items.push({ path: `github:${record.repo}@${ref}`, sha256: sha256(ref), bytes: 0 });
      }
      for (const artifact of card?.artifacts ?? []) {
        if (typeof artifact === 'string') {
          items.push({ path: artifact, sha256: sha256(artifact), bytes: 0 });
        } else if (artifact?.path) {
          items.push({
            path: artifact.path,
            sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : sha256(artifact.path),
            bytes: Number(artifact.bytes ?? 0),
          });
        }
      }
      return artifactList({ kind: KIND, run_id: record.run.id, items });
    },

    collectEvidence: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) return evidenceList({ kind: KIND, run_id: runId, items: [] });
      const items = [
        {
          kind: 'issue',
          ref: record.issue?.url ?? `github:${record.repo}#issues/${record.issue?.number}`,
          sha256: sha256(JSON.stringify(record.issue ?? {})),
          command: null,
          output_excerpt: truncate(`issue ${record.issue?.number ?? 'unknown'} on ${record.repo}`),
        },
      ];
      const resolved = await resolveTicket(record);
      if (!resolved.ok) {
        return {
          ...evidenceList({ kind: KIND, run_id: record.run.id, items }),
          ok: false,
          code: resolved.code,
          message: `ticket evidence unavailable: ${resolved.message}`,
        };
      }
      const ticket = resolved.ticket;
      items.push({
        kind: 'ticket',
        ref: `superagent:ticket:${ticketIdOf(ticket)}`,
        sha256: sha256(JSON.stringify(ticket)),
        command: null,
        output_excerpt: truncate(ticket),
      });
      const card = cardOf(ticket);
      if (card?.report) {
        items.push({
          kind: 'report',
          ref: `superagent:ticket:${ticketIdOf(ticket)}:report`,
          sha256: sha256(JSON.stringify(card.report)),
          command: null,
          output_excerpt: truncate(card.report),
        });
      }
      return evidenceList({ kind: KIND, run_id: record.run.id, items });
    },

    usage: async (handle) => {
      const record = recordOf(handle);
      const { run_id: runId } = readHandle(handle);
      if (!record) {
        return { ...usageReport({ kind: KIND, run_id: runId, usage: emptyUsage('unavailable') }), ok: false, code: ERROR_CODES.unknownRun };
      }
      const resolved = await resolveTicket(record);
      if (!resolved.ok) {
        return {
          ...usageReport({ kind: KIND, run_id: record.run.id, usage: emptyUsage('unavailable') }),
          ok: false,
          code: resolved.code,
          message: resolved.message,
        };
      }
      return usageReport({ kind: KIND, run_id: record.run.id, usage: usageFromTicket(resolved.ticket) });
    },

    /** Capability probe (16 §7): the orchestrator management API with its header. */
    probe: probeOrchestrator,
  };

  adapter = defineAdapter({
    kind: KIND,
    capabilities: {
      tracking: { status: true, follow: true },
      artifacts: true,
      evidence: true,
      usage: true,
      cancel: { verify: 'stop+ticket+workspace' },
      creation: 'github_issue',
      remote: true,
      no_fallback: true,
    },
    methods,
  });
  return adapter;
}
