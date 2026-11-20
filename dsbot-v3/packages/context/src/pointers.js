import {
  firstString,
  isRecord,
  toArray,
  toList,
} from './normalize.js';

const KNOWN_KINDS = new Set([
  'task',
  'run',
  'acceptance',
  'report',
  'artifact',
  'evidence',
  'escalation',
  'session',
  'question',
]);

/**
 * Build the drill-down index. Pointers are stable references, never log
 * bodies. A pointer is `{kind, id, ref, uri?, label?, sha256?}`:
 *
 * - `ref` is the canonical opaque reference (`task:...`, `run:...`, ...).
 * - `uri` is present only where the API contract has a read endpoint
 *   (`/v1/tasks/{id}`, `/v1/evidence/{id}`).
 * - `drilldownRef(pointer, {fields})` composes the read reference.
 */
export function buildPointers(task, openQuestions = []) {
  const pointers = [];
  const seen = new Set();

  const add = (pointer) => {
    if (!pointer || typeof pointer.ref !== 'string' || pointer.ref === '') return;
    if (seen.has(pointer.ref)) return;
    seen.add(pointer.ref);
    pointers.push(pointer);
  };

  const addEvidenceRef = (value) => {
    const pointer = normalizePointer(value);
    if (!pointer) return;
    if (pointer.kind === 'ref' && pointer.uri === undefined) {
      add(
        makePointer('evidence', pointer.id, {
          ref: `evidence:${pointer.id}`,
        }),
      );
      return;
    }
    add(pointer);
  };

  const taskId = firstString(task.task_id, task.taskId, task.id);
  if (taskId !== null) {
    add(makePointer('task', taskId, { uri: uriFor('task', taskId) }));
  }

  for (const raw of pointerList(
    task.pointers ??
      task.evidence_refs ??
      task.evidenceRefs ??
      task.drilldown ??
      task.drilldown_refs,
  )) {
    add(normalizePointer(raw));
  }

  for (const ref of [
    task.evidence_ref,
    task.evidenceRef,
    task.result?.evidence_ref,
    task.result?.acceptance?.evidence_ref,
    task.acceptance?.evidence_ref,
    task.latest_acceptance?.evidence_ref,
    task.latestAcceptance?.evidenceRef,
    task.latest_run?.evidence_ref,
    task.latestRun?.evidenceRef,
    task.latest_report?.evidence_ref,
  ]) {
    addEvidenceRef(ref);
  }

  const run = task.latest_run ?? task.latestRun ?? lastEntry(task.runs);
  if (isRecord(run)) {
    const runId = firstString(run.run_id, run.runId, run.id);
    if (runId !== null) add(makePointer('run', runId));
  }

  const acceptance =
    task.latest_acceptance ??
    task.latestAcceptance ??
    task.acceptance_result ??
    lastEntry(task.acceptances);
  if (isRecord(acceptance)) {
    const acceptanceId = firstString(
      acceptance.acceptance_id,
      acceptance.acceptanceId,
      acceptance.id,
    );
    if (acceptanceId !== null) add(makePointer('acceptance', acceptanceId));
  }

  for (const report of listOf(task.reports)) {
    if (!isRecord(report)) continue;
    const reportId = firstString(report.report_id, report.reportId, report.id);
    if (reportId !== null) add(makePointer('report', reportId));
  }
  const latestReport = task.latest_report ?? task.latestReport;
  if (isRecord(latestReport)) {
    const reportId = firstString(
      latestReport.report_id,
      latestReport.reportId,
      latestReport.id,
    );
    if (reportId !== null) add(makePointer('report', reportId));
  }

  for (const artifact of listOf(
    task.artifacts ?? task.deliverables ?? task.result?.deliverables,
  )) {
    if (typeof artifact === 'string') {
      add(makePointer('artifact', artifact.trim()));
      continue;
    }
    if (!isRecord(artifact)) continue;
    const path = firstString(
      artifact.path,
      artifact.artifact_path,
      artifact.name,
      artifact.file,
    );
    if (path === null) continue;
    add(
      makePointer('artifact', path, {
        sha256: firstString(artifact.sha256, artifact.hash),
        label: firstString(artifact.label),
      }),
    );
  }

  for (const question of openQuestions) {
    if (!isRecord(question)) continue;
    const id = firstString(question.id, question.escalation_id);
    if (id !== null) add(makePointer('escalation', id));
  }

  return pointers;
}

function pointerList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  if (isRecord(value) && (value.ref || value.kind || value.id || value.uri)) {
    return [value];
  }
  return toList(value, 'pointers');
}

function listOf(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (
    typeof value === 'object' &&
    typeof value[Symbol.iterator] === 'function'
  ) {
    return [...value];
  }
  if (
    isRecord(value) &&
    (value.report_id ||
      value.reportId ||
      value.id ||
      value.path ||
      value.name ||
      value.sha256)
  ) {
    return [value];
  }
  if (isRecord(value)) return Object.values(value);
  return [];
}

function lastEntry(value) {
  if (Array.isArray(value)) return value[value.length - 1];
  if (value instanceof Map) return [...value.values()].at(-1);
  return undefined;
}

function makePointer(kind, id, extra = {}) {
  if (typeof id !== 'string' || id === '') return null;
  const pointer = {
    kind,
    id,
    ref: extra.ref ?? `${kind}:${id}`,
  };
  const uri = extra.uri ?? uriFor(kind, id);
  if (uri !== undefined && uri !== null) pointer.uri = uri;
  if (typeof extra.label === 'string' && extra.label !== '') {
    pointer.label = extra.label;
  }
  if (typeof extra.sha256 === 'string' && extra.sha256 !== '') {
    pointer.sha256 = extra.sha256;
  }
  return pointer;
}

function normalizePointer(value) {
  if (typeof value === 'string') {
    const ref = value.trim();
    if (ref === '') return null;
    const parsed = parseRef(ref);
    return makePointer(parsed.kind, parsed.id, { ref });
  }
  if (!isRecord(value)) return null;

  let kind = firstString(value.kind, value.type, value.resource);
  let id = firstString(
    value.id,
    value.task_id,
    value.evidence_id,
    value.run_id,
    value.acceptance_id,
    value.report_id,
    value.artifact_path,
    value.path,
  );
  let ref = firstString(value.ref);

  if (ref !== null && kind === null) {
    const parsed = parseRef(ref);
    kind = parsed.kind;
    id = id ?? parsed.id;
  }
  if (ref === null && kind !== null && id !== null) ref = `${kind}:${id}`;
  if (ref === null && value.uri !== undefined) {
    ref = firstString(value.uri);
    if (ref !== null && kind === null) kind = 'ref';
  }
  if (ref === null) return null;
  if (kind === null) kind = 'ref';

  const uri = firstString(value.uri) ?? uriFor(kind, id);
  return makePointer(kind, id ?? ref, {
    ref,
    uri,
    label: firstString(value.label, value.title),
    sha256: firstString(value.sha256, value.hash),
  });
}

function parseRef(ref) {
  const separator = ref.indexOf(':');
  if (separator > 0) {
    const prefix = ref.slice(0, separator);
    if (KNOWN_KINDS.has(prefix)) {
      return { kind: prefix, id: ref.slice(separator + 1) };
    }
  }
  return { kind: 'ref', id: ref };
}

function uriFor(kind, id) {
  if (typeof id !== 'string' || id === '') return undefined;
  if (kind === 'task') return `/v1/tasks/${encodeURIComponent(id)}`;
  if (kind === 'evidence') return `/v1/evidence/${encodeURIComponent(id)}`;
  return undefined;
}

/**
 * Compose the read reference for one pointer. Task and evidence pointers get
 * their API path; other pointers return their canonical `kind:id` ref, which a
 * caller can hand to the matching read adapter.
 */
export function drilldownRef(pointer, { fields = [] } = {}) {
  if (!isRecord(pointer)) {
    throw new TypeError('drilldownRef requires a pointer object');
  }
  const ref = firstString(pointer.ref);
  if (ref === null) {
    throw new TypeError('pointer.ref is required');
  }

  const fieldList = toArray(fields)
    .map((field) => (typeof field === 'string' ? field.trim() : ''))
    .filter((field) => field !== '');
  const uri = firstString(pointer.uri);
  if (uri === null) return ref;

  if (fieldList.length === 0) return uri;
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}fields=${fieldList.map(encodeURIComponent).join(',')}`;
}
