import {
  cloneValue,
  firstString,
  isRecord,
  toArray,
  toStringList,
  uniqueStrings,
} from './normalize.js';

/**
 * Render the task pack the service is allowed to hand to a layer.
 *
 * Only whitelisted task fields are copied. Recent run output, transcripts,
 * tool calls and other raw execution material never enter this object; run and
 * acceptance information is reduced to a conclusion plus an evidence pointer.
 */
export function buildTaskPack(level, task) {
  const taskId = firstString(task.task_id, task.taskId, task.id);
  if (taskId === null) {
    throw new TypeError('buildContextPack requires task.task_id');
  }

  const goal = firstString(task.goal, task.objective, task.title, task.summary);
  if (goal === null) {
    throw new TypeError('buildContextPack requires task.goal or task.title');
  }

  const pack = {
    task_id: taskId,
    level,
    goal,
  };

  const title = firstString(task.title);
  if (title !== null && title !== goal) pack.title = title;

  const state = firstString(task.state, task.status);
  if (state !== null) pack.state = state;

  const owner = firstString(task.owner, task.owner_ref, task.ownerRef);
  if (owner !== null) pack.owner = owner;

  const scope = normalizeScope(task);
  if (scope !== undefined) pack.scope = scope;

  const baseSha = firstString(
    task.base_sha,
    task.baseSha,
    task.baseline_sha,
    task.baselineSha,
  );
  if (baseSha !== null) pack.base_sha = baseSha;

  const acceptance = normalizeAcceptance(level, task);
  if (acceptance !== undefined) pack.acceptance = acceptance;

  const delivery = normalizeDelivery(task);
  if (delivery !== undefined) pack.delivery = delivery;

  const budget = normalizeBudget(task);
  if (budget !== undefined) pack.budget = budget;

  const dueAt = task.due_at ?? task.dueAt;
  if (dueAt !== undefined && dueAt !== null) pack.due_at = cloneValue(dueAt);

  const stopConditions = normalizeStopConditions(task);
  if (stopConditions.length > 0) pack.stop_conditions = stopConditions;

  const idempotencyKey = firstString(task.idempotency_key, task.idempotencyKey);
  if (idempotencyKey !== null) pack.idempotency_key = idempotencyKey;

  const outcome = firstString(task.outcome, task.result?.outcome);
  if (outcome !== null) pack.outcome = outcome;

  const conclusions = normalizeConclusions(task);
  if (conclusions.length > 0) pack.conclusions = conclusions;

  const risks = uniqueStrings(toStringList(task.risks ?? task.result?.risks));
  if (risks.length > 0) pack.risks = risks;

  const latestRun = normalizeLatestRun(task);
  if (latestRun !== undefined) pack.latest_run = latestRun;

  const latestAcceptance = normalizeLatestAcceptance(task);
  if (latestAcceptance !== undefined) pack.latest_acceptance = latestAcceptance;

  const latestReport = normalizeLatestReport(task);
  if (latestReport !== undefined) pack.latest_report = latestReport;

  return pack;
}

function normalizeScope(task) {
  const rawScope = task.scope;
  const raw = isRecord(rawScope) ? rawScope : {};

  const allowedPaths = toStringList(
    raw.allowed_paths ??
      raw.allowedPaths ??
      raw.paths ??
      (Array.isArray(rawScope) ? rawScope : task.allowed_paths),
  );
  const forbiddenPaths = toStringList(
    raw.forbidden_paths ??
      raw.forbiddenPaths ??
      raw.denied_paths ??
      task.forbidden_paths,
  );
  const projects = toStringList(raw.projects ?? task.projects);
  const botScope = firstString(
    raw.bot_scope,
    raw.botScope,
    task.bot_scope,
    task.botScope,
  );

  const scope = {};
  if (allowedPaths.length > 0) scope.allowed_paths = allowedPaths;
  if (forbiddenPaths.length > 0) scope.forbidden_paths = forbiddenPaths;
  if (projects.length > 0) scope.projects = projects;
  if (botScope !== null) scope.bot_scope = botScope;

  if (Object.keys(scope).length === 0 && typeof rawScope === 'string') {
    return { summary: rawScope.trim() };
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function normalizeAcceptance(level, task) {
  const raw = task.acceptance ?? task.acceptance_spec ?? task.acceptanceSpec;

  if (raw === undefined || raw === null) {
    const criteria = toArray(task.acceptance_criteria ?? task.criteria);
    if (criteria.length === 0) return undefined;
    return { stage: level, criteria: criteria.map(cloneValue) };
  }
  if (typeof raw === 'string') {
    return { stage: level, criteria: [raw] };
  }
  if (Array.isArray(raw)) {
    return { stage: level, criteria: raw.map(cloneValue) };
  }
  if (!isRecord(raw)) return undefined;

  const acceptance = cloneValue(raw);
  acceptance.stage = firstString(raw.stage, level);
  const criteriaSource = raw.criteria ?? raw.items ?? raw.checks ?? raw.acceptance_criteria;
  if (criteriaSource !== undefined) {
    acceptance.criteria = toArray(criteriaSource).map(cloneValue);
    delete acceptance.items;
    delete acceptance.checks;
    delete acceptance.acceptance_criteria;
  }
  return acceptance;
}

function normalizeDelivery(task) {
  const raw =
    task.delivery ??
    task.delivery_format ??
    task.deliveryFormat ??
    task.output_format;

  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return { format: raw };
  if (Array.isArray(raw)) return { format: raw.map(cloneValue) };
  if (isRecord(raw)) return cloneValue(raw);
  return undefined;
}

function normalizeBudget(task) {
  const raw = task.budget ?? task.budget_cny ?? task.budgetCny;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return { cny: raw };
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return { cny: Number(raw) };
  }
  if (isRecord(raw)) return cloneValue(raw);
  return undefined;
}

function normalizeStopConditions(task) {
  const raw = task.stop_conditions ?? task.stopConditions;
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.map(cloneValue);
  if (isRecord(raw)) return [cloneValue(raw)];
  return [];
}

function normalizeConclusions(task) {
  const collected = [];
  const push = (value) => {
    if (typeof value === 'string') {
      if (value.trim() !== '') collected.push(value.trim());
      return;
    }
    if (isRecord(value)) {
      const text = firstString(
        value.text,
        value.summary,
        value.conclusion,
        value.outcome,
      );
      if (text !== null) collected.push(text);
    }
  };

  const sources = [
    task.conclusions,
    task.conclusion,
    task.summary,
    task.result?.conclusions,
    task.result?.summary,
  ];
  for (const source of sources) {
    if (Array.isArray(source)) source.forEach(push);
    else push(source);
  }
  return uniqueStrings(collected);
}

function lastEntry(value) {
  if (Array.isArray(value)) return value[value.length - 1];
  if (value instanceof Map) return [...value.values()].at(-1);
  return undefined;
}

function normalizeLatestRun(task) {
  const raw = task.latest_run ?? task.latestRun ?? lastEntry(task.runs);
  if (!isRecord(raw)) return undefined;

  const run = {};
  const runId = firstString(raw.run_id, raw.runId, raw.id);
  if (runId !== null) run.run_id = runId;

  const runNo = raw.run_no ?? raw.runNo;
  if (typeof runNo === 'number' && Number.isFinite(runNo)) run.run_no = runNo;

  const attempt = raw.attempt;
  if (typeof attempt === 'number' && Number.isFinite(attempt)) run.attempt = attempt;

  const state = firstString(raw.state, raw.status);
  if (state !== null) run.state = state;

  const summary = firstString(
    raw.summary,
    raw.result_summary,
    raw.resultSummary,
    raw.conclusion,
  );
  if (summary !== null) run.summary = summary;

  const commit = firstString(
    raw.commit,
    raw.commit_sha,
    raw.commitSha,
    raw.target_commit,
  );
  if (commit !== null) run.commit = commit;

  const evidenceRef = firstString(raw.evidence_ref, raw.evidenceRef);
  if (evidenceRef !== null) run.evidence_ref = evidenceRef;

  return Object.keys(run).length > 0 ? run : undefined;
}

function normalizeLatestAcceptance(task) {
  const raw =
    task.latest_acceptance ??
    task.latestAcceptance ??
    task.acceptance_result ??
    lastEntry(task.acceptances);
  if (!isRecord(raw)) return undefined;

  const acceptance = {};
  const acceptanceId = firstString(
    raw.acceptance_id,
    raw.acceptanceId,
    raw.id,
  );
  if (acceptanceId !== null) acceptance.acceptance_id = acceptanceId;

  const stage = firstString(raw.stage);
  if (stage !== null) acceptance.stage = stage;

  const result = firstString(raw.result, raw.verdict);
  if (result !== null) acceptance.result = result;

  const evidenceRef = firstString(raw.evidence_ref, raw.evidenceRef);
  if (evidenceRef !== null) acceptance.evidence_ref = evidenceRef;

  return Object.keys(acceptance).length > 0 ? acceptance : undefined;
}

function normalizeLatestReport(task) {
  const raw = task.latest_report ?? task.latestReport ?? lastEntry(task.reports);
  if (!isRecord(raw)) return undefined;

  const report = {};
  const reportId = firstString(raw.report_id, raw.reportId, raw.id);
  if (reportId !== null) report.report_id = reportId;

  const stage = firstString(raw.stage);
  if (stage !== null) report.stage = stage;

  const summary = firstString(raw.summary);
  if (summary !== null) report.summary = summary;

  const evidenceRef = firstString(raw.evidence_ref, raw.evidenceRef);
  if (evidenceRef !== null) report.evidence_ref = evidenceRef;

  return Object.keys(report).length > 0 ? report : undefined;
}
