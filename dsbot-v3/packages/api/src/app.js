import { hashValue } from '../../service/src/canonical.js';
import { serviceError } from '../../service/src/errors.js';
import { toErrorBody } from './errors.js';

const MAX_BODY_BYTES = 1024 * 1024;
const EXECUTOR_KINDS = new Set(['tool_chain', 'dsh_session', 'superagent', 'manual']);

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(
          serviceError('validation_error', 'request body exceeds 1 MiB', { limit: MAX_BODY_BYTES }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(serviceError('validation_error', 'request body must be valid JSON'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(serviceError('validation_error', 'request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function idempotencyKey(req) {
  const value = req.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeVerdict(value) {
  const normalized = String(value ?? '').toLowerCase();
  const map = {
    pass: 'pass',
    passed: 'pass',
    revise: 'revise',
    rejected: 'fail',
    reject: 'fail',
    fail: 'fail',
    block: 'block',
    blocked: 'block',
    void: 'void',
    invalidated: 'void',
  };
  return map[normalized] ?? normalized;
}

function normalizeAcceptanceItems(body) {
  const source =
    body.acceptance_items ?? body.acceptanceItems ?? body.items ?? body.criteria ?? null;
  return Array.isArray(source) ? source : undefined;
}

function normalizeAcceptanceProfile(body, level) {
  if (body.acceptance_profile && typeof body.acceptance_profile === 'object') {
    return clone(body.acceptance_profile);
  }
  if (body.acceptance && !Array.isArray(body.acceptance) && typeof body.acceptance === 'object') {
    return clone(body.acceptance);
  }
  const items = [];
  let index = 0;
  const addItem = (entry, fallbackClass = 'auto') => {
    index += 1;
    if (typeof entry === 'string') {
      items.push({ key: entry, class: fallbackClass, required: true });
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const itemClass = entry.class ?? fallbackClass;
    if (Array.isArray(entry.criteria)) {
      for (const criterion of entry.criteria) {
        addItem(
          typeof criterion === 'object'
            ? { ...criterion, class: criterion.class ?? itemClass }
            : { key: String(criterion) },
          itemClass,
        );
      }
      return;
    }
    items.push({
      key: entry.key ?? `${level}.${index}`,
      class: itemClass,
      required: entry.required !== false,
    });
  };
  if (Array.isArray(body.acceptance)) {
    for (const entry of body.acceptance) addItem(entry);
  } else if (Array.isArray(body.items)) {
    for (const entry of body.items) addItem(entry);
  }
  if (items.length === 0) return null;
  return { id: `profile-${level}`, version: 1, items };
}

function normalizeClaim(body, { runId, idempotencyKey }) {
  const source = body.claim && typeof body.claim === 'object' ? body.claim : body;
  const commit = source.commit ?? source.target_commit ?? body.target_commit;
  const manifest = source.manifest ?? source.artifact_hashes ?? source.artifacts ?? body.manifest;
  const nonce =
    source.nonce ??
    body.nonce ??
    idempotencyKey ??
    hashValue({ runId, commit: commit ?? null, manifest: manifest ?? null });
  const claim = {
    commit,
    dirty: source.dirty ?? body.dirty ?? false,
    manifest,
    nonce,
  };
  for (const field of ['summary', 'subject', 'revision', 'stage']) {
    const value = source[field] ?? body[field];
    if (value !== undefined) claim[field] = value;
  }
  return claim;
}

function taskEnvelope(task) {
  return { ...clone(task), task: clone(task) };
}

/**
 * Create the HTTP handler for the L6 task-service API.
 *
 * The handler is deliberately transport-only: every state decision belongs to
 * `packages/service`. It adds the PRD's HTTP conventions (Idempotency-Key,
 * PRD error codes/statuses, task envelope shape) on top.
 *
 * @param {object} options
 * @param {object} options.service created by `createTaskService`
 * @param {object} [options.store] service store (defaults to `service.store`)
 * @param {() => number} [options.clock]
 * @param {string} [options.token] optional local API token
 */
export function createApp({ service, store = service?.store, clock = () => Date.now(), token = null } = {}) {
  if (!service || !store) {
    throw new Error('createApp requires { service }');
  }

  function assertAuthorized(req) {
    if (!token) return;
    const header = req.headers.authorization;
    if (header === `Bearer ${token}` || req.headers['x-api-token'] === token) return;
    throw serviceError('unauthorized', 'local API token is required', {}, 401);
  }

  function runIdempotent(req, path, body, execute) {
    const key = idempotencyKey(req);
    if (!key) return execute();
    const storeKey = `http:${key}`;
    const payloadHash = hashValue({ method: req.method, path, body });
    const existing = store.getIdempotency(storeKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        const code = path.endsWith('/dispatch') ? 'duplicate_dispatch' : 'idempotency_conflict';
        throw serviceError(
          code,
          `idempotency key ${key} was already used with a different payload`,
          { key, scope: 'http', path },
        );
      }
      return {
        status: existing.status,
        body: { ...clone(existing.body), replayed: true },
        replayed: true,
      };
    }
    const result = execute();
    store.putIdempotency(storeKey, {
      scope: 'http',
      key,
      payloadHash,
      status: result.status,
      body: clone(result.body),
      at: clock(),
    });
    return result;
  }

  async function route(req, res) {
    assertAuthorized(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // POST /v1/tasks
    if (method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'tasks') {
      const body = await readJson(req);
      const level = body.level ?? 'execution';
      const acceptanceProfile = normalizeAcceptanceProfile(body, level);
      const result = runIdempotent(req, url.pathname, body, () => {
        const task = service.createTask({
          level,
          parentTaskId: body.parent_task_id ?? body.parentTaskId ?? null,
          title: body.title,
          owner: body.owner_ref ?? body.owner ?? null,
          acceptanceProfile,
          subject:
            body.subject ??
            {
              goal: body.goal ?? body.title,
              project: body.project ?? null,
              due_at: body.due_at ?? null,
            },
          budget:
            body.budget ??
            (body.budget_cny_cap === undefined || body.budget_cny_cap === null
              ? null
              : { capCny: body.budget_cny_cap }),
          authScope: body.auth_scope ?? body.authorization_json ?? body.authorization ?? null,
          actor: body.actor,
        });
        return { status: 201, body: taskEnvelope(task) };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // GET /v1/tasks/:id
    if (method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'tasks') {
      const task = service.getTask(parts[2]);
      const runs = service.listRuns({ taskId: task.id });
      const acceptances = service.listAcceptances({ taskId: task.id });
      const claims = service.listClaims({ taskId: task.id });
      const openAcceptance = task.openAcceptanceId
        ? service.getAcceptance(task.openAcceptanceId)
        : null;
      const currentRun =
        (task.currentRunId && runs.find((run) => run.id === task.currentRunId)) || null;
      sendJson(res, 200, {
        ...taskEnvelope(task),
        runs,
        acceptances,
        claims,
        open_acceptance: openAcceptance,
        current_run: currentRun,
        latest_acceptance: acceptances.length > 0 ? acceptances[acceptances.length - 1] : null,
      });
      return;
    }

    // POST /v1/tasks/:id/dispatch
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'tasks' &&
      parts[3] === 'dispatch'
    ) {
      const taskId = parts[2];
      const body = await readJson(req);
      const executorKind = body.executor_kind ?? body.executorKind ?? 'dsh_session';
      if (!EXECUTOR_KINDS.has(executorKind)) {
        throw serviceError('validation_error', `unknown executor_kind: ${executorKind}`, {
          executorKind,
        });
      }
      const payload = clone(body.payload ?? {});
      for (const field of ['routing_reason', 'session_id', 'ticket', 'degraded']) {
        if (body[field] !== undefined) payload[field] = clone(body[field]);
      }
      const rawAckDeadline = body.ack_deadline_ms ?? body.ackDeadlineMs;
      let ackDeadlineMs;
      if (rawAckDeadline !== undefined) {
        ackDeadlineMs = Number(rawAckDeadline);
        if (!Number.isFinite(ackDeadlineMs) || ackDeadlineMs < 0) {
          throw serviceError('validation_error', 'ack_deadline_ms must be a non-negative number', {
            ackDeadlineMs: rawAckDeadline,
          });
        }
      }
      const result = runIdempotent(req, url.pathname, body, () => {
        const dispatched = service.dispatchTask({
          taskId,
          idempotencyKey: idempotencyKey(req) ?? undefined,
          executorKind,
          payload,
          actor: body.actor ?? 'scheduler',
          ackDeadlineMs,
        });
        return {
          status: 200,
          body: {
            ...dispatched,
            task_id: dispatched.task.id,
            run_id: dispatched.run.id,
            executor_kind: executorKind,
          },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // POST /v1/tasks/:id/stop
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'tasks' &&
      parts[3] === 'stop'
    ) {
      const taskId = parts[2];
      const body = await readJson(req);
      const result = runIdempotent(req, url.pathname, body, () => {
        const requested = service.requestStop({
          taskId,
          requestedBy: body.requested_by ?? body.requestedBy ?? 'human',
          reason: body.reason ?? 'user_stop',
          idempotencyKey: idempotencyKey(req) ?? undefined,
        });
        let finalResult = requested;
        if (Array.isArray(body.verifications) || body.verification) {
          const verification = service.verifyStop({
            taskId,
            verifications: body.verifications ?? [body.verification],
            force: body.force === true,
            decisionToken: body.decision_token ?? body.decisionToken ?? null,
            deadlinePassed: body.deadline_passed === true,
            idempotencyKey: idempotencyKey(req) ? `${idempotencyKey(req)}:verify` : undefined,
          });
          finalResult = { ...requested, ...verification };
        }
        const finalTask = service.getTask(taskId);
        const status = finalTask.state === 'cancelled' ? 200 : 202;
        return {
          status,
          body: {
            ...finalResult,
            task: finalTask,
            tasks: finalResult.tasks ?? requested.tasks,
            stop_id: finalTask.id,
            stop_state: finalResult.stopState ?? finalTask.stopState,
            verified: finalTask.state === 'cancelled',
          },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // POST /v1/runs/:id/ack  (the first half of the executor contract; needed
    // before a claim because a claim is only legal on a running run.)
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'runs' &&
      parts[3] === 'ack'
    ) {
      const runId = parts[2];
      const body = await readJson(req);
      const result = runIdempotent(req, url.pathname, body, () => {
        const acked = service.ackRun({
          runId,
          idempotencyKey: idempotencyKey(req) ?? undefined,
          actor: body.actor ?? 'executor',
          ack: body.ack ?? body,
        });
        return {
          status: 200,
          body: { ...acked, task_id: acked.task.id, run_id: acked.run.id },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // POST /v1/runs/:id/claim
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'runs' &&
      parts[3] === 'claim'
    ) {
      const runId = parts[2];
      const body = await readJson(req);
      const result = runIdempotent(req, url.pathname, body, () => {
        const claimed = service.claimRun({
          runId,
          claim: normalizeClaim(body, { runId, idempotencyKey: idempotencyKey(req) }),
          idempotencyKey: idempotencyKey(req) ?? undefined,
          actor: body.actor ?? 'executor',
          acceptanceItems: normalizeAcceptanceItems(body),
        });
        return {
          status: 200,
          body: {
            ...claimed,
            task_id: claimed.task.id,
            run_id: claimed.run.id,
            acceptance_id: claimed.acceptance?.id ?? null,
          },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // POST /v1/acceptances  (PRD 02 §2.3 payload; opens the round via the
    // service's claim path, which is the only legal way to open acceptance.)
    if (method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'acceptances') {
      const body = await readJson(req);
      const result = runIdempotent(req, url.pathname, body, () => {
        let taskId = body.target_task_id ?? body.targetTaskId ?? null;
        let runId = body.run_id ?? body.runId ?? null;
        if (!taskId && runId) taskId = service.getRun(runId).taskId;
        if (!taskId) {
          throw serviceError(
            'validation_error',
            'POST /v1/acceptances requires target_task_id (or run_id)',
          );
        }
        const task = service.getTask(taskId);
        if (runId) {
          const run = service.getRun(runId);
          if (run.taskId !== taskId) {
            throw serviceError(
              'validation_error',
              'run_id does not belong to target_task_id',
              { taskId, runId, runTaskId: run.taskId },
            );
          }
        }
        if (body.stage !== undefined && body.stage !== task.level) {
          throw serviceError('validation_error', 'acceptance stage must equal task level', {
            stage: body.stage,
            taskLevel: task.level,
            taskId,
          });
        }
        if (task.openAcceptanceId) {
          const acceptance = service.getAcceptance(task.openAcceptanceId);
          const run = acceptance.runId ? service.getRun(acceptance.runId) : null;
          return { status: 200, body: { acceptance, task, run, created: false } };
        }
        if (!runId && task.currentRunId) runId = task.currentRunId;

        if (task.level === 'execution') {
          if (!runId) {
            throw serviceError(
              'validation_error',
              'POST /v1/acceptances for an execution task requires run_id',
              { taskId },
            );
          }
          const claim = normalizeClaim(body, { runId, idempotencyKey: idempotencyKey(req) });
          if (claim.stage === undefined) claim.stage = task.level;
          const claimed = service.claimRun({
            runId,
            claim,
            idempotencyKey: idempotencyKey(req) ?? undefined,
            actor: body.actor ?? 'executor',
            acceptanceItems: normalizeAcceptanceItems(body),
          });
          return {
            status: 201,
            body: {
              ...claimed,
              created: true,
              acceptance_id: claimed.acceptance.id,
              task_id: claimed.task.id,
              run_id: claimed.run.id,
            },
          };
        }

        const readiness = service.claimReadiness({
          taskId,
          claim: {
            nonce: body.nonce ?? idempotencyKey(req) ?? undefined,
            summary: body.summary,
            childAcceptanceIds: body.child_acceptance_ids ?? body.childAcceptanceIds,
          },
          acceptanceItems: normalizeAcceptanceItems(body),
          actor: body.actor ?? 'bot',
          idempotencyKey: idempotencyKey(req) ?? undefined,
        });
        return {
          status: 201,
          body: {
            ...readiness,
            created: true,
            acceptance_id: readiness.acceptance.id,
            task_id: readiness.task.id,
          },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // POST /v1/acceptances/:id/verdict
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'acceptances' &&
      parts[3] === 'verdict'
    ) {
      const acceptanceId = parts[2];
      const body = await readJson(req);
      const verdict = normalizeVerdict(body.verdict ?? body.decision ?? body.outcome);
      const result = runIdempotent(req, url.pathname, body, () => {
        const decided = service.decideAcceptance({
          acceptanceId,
          verdict,
          itemStates:
            body.item_states ?? body.itemStates ?? body.items ?? body.acceptance_items ?? undefined,
          actor: body.actor ?? 'acceptance_service',
          idempotencyKey: idempotencyKey(req) ?? undefined,
          reviewer: body.reviewer ?? null,
          reason: body.reason ?? null,
        });
        return {
          status: 200,
          body: {
            ...decided,
            task_id: decided.task?.id ?? null,
            acceptance_id: decided.acceptance?.id ?? acceptanceId,
          },
        };
      });
      sendJson(res, result.status, result.body, result.replayed ? { 'idempotency-replayed': 'true' } : {});
      return;
    }

    // Convenience read endpoints.
    if (method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'runs') {
      const run = service.getRun(parts[2]);
      sendJson(res, 200, { ...run, run, task: service.getTask(run.taskId) });
      return;
    }

    if (
      method === 'GET' &&
      parts.length === 3 &&
      parts[0] === 'v1' &&
      parts[1] === 'acceptances'
    ) {
      const acceptance = service.getAcceptance(parts[2]);
      sendJson(res, 200, {
        ...acceptance,
        acceptance,
        task: service.getTask(acceptance.taskId),
        run: acceptance.runId ? service.getRun(acceptance.runId) : null,
      });
      return;
    }

    sendJson(res, 404, {
      code: 'not_found',
      status: 404,
      message: `no route for ${method} ${url.pathname}`,
      details: {},
    });
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      const { status, body } = toErrorBody(error);
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    }
  };
}
