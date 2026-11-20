import { RESULTS, STAGES } from './constants.js';

const PASS_VERDICTS = new Set(['pass', 'passed', 'ok', 'true']);
const REWORK_VERDICTS = new Set(['fail', 'failed', 'revise', 'rework', 'needs_rework', 'rejected']);
const BLOCKED_VERDICTS = new Set(['blocked', 'block', 'pending', 'void', 'invalid', 'missing', 'unknown']);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Map an external verdict spelling onto the engine's result vocabulary.
 * Unknown non-empty verdicts are blocked, never silently treated as pass.
 */
export function classifyVerdict(value) {
  const verdict = normalizeText(value).toLowerCase();
  if (verdict === '') return null;
  if (PASS_VERDICTS.has(verdict)) return RESULTS.pass;
  if (REWORK_VERDICTS.has(verdict)) return RESULTS.rework;
  return RESULTS.blocked;
}

/**
 * Normalise a rubric. Both `{stage, evaluator, items:[...]}` and a bare item
 * array are accepted so callers can pass a minimal domain rubric. `null` and
 * malformed values become `null`; the stage-specific gate reports the reason.
 */
export function normalizeRubric(rubric) {
  if (rubric === null || rubric === undefined) return null;
  if (Array.isArray(rubric)) {
    return { id: null, stage: null, evaluator: null, items: rubric };
  }
  if (typeof rubric !== 'object') return null;
  return {
    id: normalizeText(rubric.id) || null,
    stage: normalizeText(rubric.stage).toLowerCase() || null,
    evaluator: rubric.evaluator ?? null,
    items: Array.isArray(rubric.items) ? rubric.items : [],
  };
}

/**
 * A goal may only be decided by a goal-level evaluator (docs/prd
 * 03-acceptance-spec.md §4.1 `G2`/`G5`): the rubric must declare
 * `stage: 'goal'` and an evaluator whose stage/level is `goal`. This is what
 * makes a child `pass` insufficient to complete its parent.
 */
export function readGoalEvaluator(rubric) {
  if (rubric === null) {
    return {
      ok: false,
      detail: "no goal-level evaluator: pass rubric {stage:'goal', evaluator:'goal', items:[...]}",
    };
  }
  if (rubric.stage !== STAGES.goal) {
    return {
      ok: false,
      detail: `rubric.stage is ${rubric.stage === null ? 'missing' : `"${rubric.stage}"`}, not "goal"; a business/execution rubric cannot decide a goal`,
    };
  }
  const evaluator = rubric.evaluator;
  const evaluatorStage =
    typeof evaluator === 'string'
      ? normalizeText(evaluator).toLowerCase()
      : normalizeText(evaluator?.stage ?? evaluator?.level).toLowerCase();
  if (evaluatorStage !== STAGES.goal) {
    const label =
      typeof evaluator === 'string'
        ? normalizeText(evaluator)
        : normalizeText(evaluator?.id ?? evaluator?.name);
    return {
      ok: false,
      detail: `goal rubric evaluator ${label === '' ? '(missing)' : `"${label}"`} is not goal-level; only a goal-level evaluator may decide a goal`,
    };
  }
  const label =
    typeof evaluator === 'string'
      ? evaluator
      : normalizeText(evaluator?.id ?? evaluator?.name) || 'goal evaluator';
  return { ok: true, detail: `goal-level evaluator "${label}" declared` };
}

function classifyEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { status: RESULTS.blocked, reason: 'invalid rubric entry (must be an object)' };
  }
  if (entry.blocked === true) {
    return { status: RESULTS.blocked, reason: 'rubric entry is blocked' };
  }
  if (entry.pending === true) {
    return { status: RESULTS.blocked, reason: 'rubric entry is pending' };
  }

  const rawVerdict = entry.verdict ?? entry.result ?? entry.state ?? entry.status;
  const verdict = normalizeText(rawVerdict).toLowerCase();
  const fromVerdict = classifyVerdict(verdict);
  const okStatus = typeof entry.ok === 'boolean' ? (entry.ok ? RESULTS.pass : RESULTS.rework) : null;

  if (okStatus !== null && fromVerdict !== null && okStatus !== fromVerdict) {
    return {
      status: RESULTS.blocked,
      reason: `conflicting rubric entry: ok=${entry.ok} but verdict="${verdict}"`,
    };
  }
  if (okStatus !== null) return { status: okStatus };
  if (fromVerdict !== null) {
    return {
      status: fromVerdict,
      reason: fromVerdict === RESULTS.blocked ? `verdict "${verdict}" cannot be judged` : undefined,
    };
  }
  return { status: RESULTS.blocked, reason: 'no verdict/ok supplied; rubric item is pending' };
}

/**
 * Turn rubric entries into required/optional acceptance items. A failing
 * required entry is `rework`; a missing/blocked entry is `blocked` because
 * unavailable evidence must never become a pass (PRD 03 §0 rule 11).
 */
export function evaluateRubricEntries(rubric, fallbackPrefix = 'rubric.item') {
  const seen = new Set();
  return rubric.items.map((entry, index) => {
    const entryObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    let id = normalizeText(entryObject?.id) || `${fallbackPrefix}.${index + 1}`;
    if (seen.has(id)) id = `${id}#${index + 1}`;
    seen.add(id);

    const required = entryObject?.required !== false;
    const classified = classifyEntry(entry);
    const suppliedDetail = normalizeText(entryObject?.detail);
    const detail =
      suppliedDetail ||
      (classified.status === RESULTS.pass
        ? `rubric item "${id}" passed`
        : classified.status === RESULTS.rework
          ? `rubric item "${id}" failed; rework required`
          : `rubric item "${id}" cannot be judged${classified.reason ? `: ${classified.reason}` : ''}`);

    return { id, required, status: classified.status, detail };
  });
}
