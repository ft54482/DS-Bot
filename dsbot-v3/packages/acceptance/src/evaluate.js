import { RESULT_RANK, RESULTS, STAGES } from './constants.js';
import { describeRecord, latestEvidence, normalizeEvidence, verifyEvidence } from './evidence.js';
import {
  classifyVerdict,
  evaluateRubricEntries,
  normalizeRubric,
  readGoalEvaluator,
} from './rubric.js';

const COMMIT_KINDS = new Set(['commit', 'git_commit', 'execution_commit']);
const TEST_KINDS = new Set([
  'test',
  'tests',
  'test_output',
  'test_result',
  'test_report',
  'execution_tests',
  'execution_test_output',
]);
const COMMIT_SHA = /^[a-f0-9]{40}$/i;

function entry(id, required, status, detail) {
  return { id, required, status, detail };
}

function toItem(current) {
  return {
    id: current.id,
    required: current.required,
    ok: current.status === RESULTS.pass,
    detail: current.detail,
  };
}

function normalizeLevel(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

/**
 * `stage` must equal the task level: an execution rubric can never stand in
 * for a business review, and a business review can never stand in for a goal
 * (PRD 03 §4.1 `G1`, `G29`). A missing `task.level` is allowed because the
 * explicit `stage` argument is authoritative; a contradictory one is blocked.
 */
function evaluateStageAlignment(stage, task) {
  const level = normalizeLevel(task.level);
  if (level !== null && level !== stage) {
    return entry(
      'stage.alignment',
      true,
      RESULTS.blocked,
      `stage "${stage}" cannot evaluate a "${level}" task; acceptance.stage must equal task.level`,
    );
  }
  if (level === null) {
    return entry('stage.alignment', true, RESULTS.pass, `task.level not declared; stage "${stage}" is authoritative`);
  }
  return entry('stage.alignment', true, RESULTS.pass, `stage "${stage}" matches task.level`);
}

/** Every declared sha256 binding must match its own content. */
function evaluateEvidenceIntegrity(records) {
  const invalid = [];
  for (const record of records) {
    const check = verifyEvidence(record);
    if (!check.valid) invalid.push(`${describeRecord(record)}: ${check.reason}`);
  }
  if (invalid.length > 0) {
    return entry('evidence.integrity', true, RESULTS.blocked, `invalid evidence: ${invalid.join('; ')}`);
  }
  return entry(
    'evidence.integrity',
    true,
    RESULTS.pass,
    records.length === 0
      ? 'no evidence supplied; nothing to verify'
      : `${records.length} evidence record(s) verified; declared sha256 values match content`,
  );
}

function evaluateCommit(records) {
  const record = latestEvidence(records, COMMIT_KINDS);
  if (record === null) {
    return entry(
      'execution.commit',
      true,
      RESULTS.blocked,
      'missing commit evidence: supply {kind:"commit", content:"<40-hex sha>"}',
    );
  }
  const integrity = verifyEvidence(record);
  if (!integrity.valid) {
    return entry('execution.commit', true, RESULTS.blocked, `commit evidence ${integrity.reason}`);
  }
  const sha = typeof record.content === 'string' ? record.content.trim() : '';
  if (!COMMIT_SHA.test(sha)) {
    return entry(
      'execution.commit',
      true,
      RESULTS.blocked,
      `invalid commit sha "${sha}"; commit evidence content must be 40 hexadecimal characters`,
    );
  }
  return entry('execution.commit', true, RESULTS.pass, `commit ${sha} bound to the acceptance`);
}

function evaluateTestOutput(records) {
  const record = latestEvidence(records, TEST_KINDS);
  if (record === null) {
    return entry(
      'execution.tests',
      true,
      RESULTS.blocked,
      'missing test output: supply {kind:"test_output", content:"<test output>", exitCode:0}',
    );
  }
  const integrity = verifyEvidence(record);
  if (!integrity.valid) {
    return entry('execution.tests', true, RESULTS.blocked, `test evidence ${integrity.reason}`);
  }
  if (typeof record.content !== 'string' || record.content.trim() === '') {
    return entry('execution.tests', true, RESULTS.blocked, 'test output content is empty; acceptance cannot judge it');
  }

  if (record.exitCode !== undefined && record.exitCode !== null && record.exitCode !== '') {
    const exitCode = typeof record.exitCode === 'number' ? record.exitCode : Number(String(record.exitCode).trim());
    if (!Number.isInteger(exitCode)) {
      return entry(
        'execution.tests',
        true,
        RESULTS.blocked,
        `invalid test exit code "${String(record.exitCode)}"; must be an integer`,
      );
    }
    if (exitCode !== 0) {
      return entry('execution.tests', true, RESULTS.rework, `test output reports non-zero exit code ${exitCode}; rework required`);
    }
  }

  const verdictStatus = classifyVerdict(record.verdict);
  if (record.ok === false || record.passed === false || verdictStatus === RESULTS.rework) {
    return entry('execution.tests', true, RESULTS.rework, 'test output is marked as failed; rework required');
  }
  if (verdictStatus === RESULTS.blocked) {
    return entry('execution.tests', true, RESULTS.blocked, 'test output is marked as blocked/invalid; acceptance cannot judge it');
  }
  return entry('execution.tests', true, RESULTS.pass, 'test output evidence present and passing');
}

function evaluateRubricStage(stage, rubric) {
  if (rubric === null || rubric.stage === null) return null;
  if (rubric.stage === stage) {
    return entry('rubric.stage', true, RESULTS.pass, `rubric stage "${stage}" matches the acceptance stage`);
  }
  return entry(
    'rubric.stage',
    true,
    RESULTS.blocked,
    `rubric stage "${rubric.stage}" cannot decide a "${stage}" stage; a child-level rubric must not be promoted`,
  );
}

function evaluateBusinessRubric(rubric) {
  if (rubric === null || rubric.items.length === 0) {
    return entry(
      'business.rubric',
      true,
      RESULTS.blocked,
      'domain rubric missing: business acceptance requires at least one rubric entry',
    );
  }
  return entry(
    'business.rubric',
    true,
    RESULTS.pass,
    `${rubric.items.length} domain rubric entr${rubric.items.length === 1 ? 'y' : 'ies'} supplied`,
  );
}

function evaluateGoalRubric(rubric) {
  if (rubric === null || rubric.items.length === 0) {
    return entry(
      'goal.rubric',
      true,
      RESULTS.blocked,
      'goal rubric missing: only a goal-level evaluator rubric with entries can decide a goal',
    );
  }
  return entry('goal.rubric', true, RESULTS.pass, `${rubric.items.length} goal rubric entr${rubric.items.length === 1 ? 'y' : 'ies'} supplied`);
}

function appendRubricItems(target, rubric) {
  if (rubric === null) return;
  target.push(...evaluateRubricEntries(rubric));
}

/**
 * Decide one acceptance stage from explicitly supplied evidence and rubric.
 *
 * @param {object} input
 * @param {'execution'|'business'|'goal'} input.stage acceptance stage; must
 *   equal `task.level` when that field is present
 * @param {object} [input.task] task metadata; only `level` is read. Author
 *   self-reports (claims, `.commit`, `.tests`) are deliberately ignored
 * @param {Array<object>} [input.evidence] evidence records; see
 *   `normalizeEvidence` for the accepted shape
 * @param {object|Array<object>|null} [input.rubric] domain acceptance rubric.
 *   Business requires entries; goal additionally requires
 *   `stage:'goal'` plus a goal-level `evaluator`
 * @returns {{result:'pass'|'rework'|'blocked', items:Array<{id:string, required:boolean, ok:boolean, detail:string}>}}
 *
 * Pure function: no filesystem, network, process or clock access, no input
 * mutation, no third-party dependencies. Invalid evidence is reported as
 * `blocked` with `ok:false` items because acceptance cannot be judged on
 * evidence whose hash does not match its content.
 */
export function evaluate(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('evaluate expects a single options object');
  }
  const { stage, task = {}, evidence = [], rubric = null } = input;
  if (typeof stage !== 'string' || !Object.hasOwn(STAGES, stage)) {
    throw new TypeError(`stage must be one of: ${Object.keys(STAGES).join(', ')}`);
  }
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('task must be an object');
  }

  const records = normalizeEvidence(evidence);
  const normalizedRubric = normalizeRubric(rubric);
  const entries = [evaluateStageAlignment(stage, task), evaluateEvidenceIntegrity(records)];
  const rubricStage = evaluateRubricStage(stage, normalizedRubric);

  if (stage === STAGES.execution) {
    entries.push(evaluateCommit(records), evaluateTestOutput(records));
    if (rubricStage !== null) entries.push(rubricStage);
    appendRubricItems(entries, normalizedRubric);
  } else if (stage === STAGES.business) {
    entries.push(evaluateBusinessRubric(normalizedRubric));
    if (rubricStage !== null) entries.push(rubricStage);
    appendRubricItems(entries, normalizedRubric);
  } else {
    entries.push(
      entry('goal.evaluator', true, ...goalEvaluatorEntry(normalizedRubric)),
      evaluateGoalRubric(normalizedRubric),
    );
    if (rubricStage !== null) entries.push(rubricStage);
    // Child acceptance results are intentionally never read here: a goal
    // pass requires the goal-level evaluator's own rubric to pass. `task` is
    // not consulted beyond `level`, and child evidence records are inert.
    appendRubricItems(entries, normalizedRubric);
  }

  let result = RESULTS.pass;
  for (const current of entries) {
    if (!current.required) continue;
    if (RESULT_RANK[current.status] > RESULT_RANK[result]) result = current.status;
  }
  return { result, items: entries.map(toItem) };
}

function goalEvaluatorEntry(rubric) {
  const evaluator = readGoalEvaluator(rubric);
  return [evaluator.ok ? RESULTS.pass : RESULTS.blocked, evaluator.detail];
}
