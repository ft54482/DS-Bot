/**
 * L36 independent PR verification.
 *
 * `verify()` decides one PR from evidence it collects itself: the pinned head
 * sha, the changed-file list, and the rerun output of an injected runner. It
 * does not read the PR body, commit messages or author claims, and it refuses
 * to return PASS when the commit under test moved.
 *
 * The runner is the only I/O seam. Tests inject a fake executor, so the suite
 * never clones or fetches. A production runner implements:
 *
 *   resolveHead(pr) -> full sha
 *   prepare(pr, {expectedHead, fresh}) -> { worktree }
 *   head(worktree) -> full sha
 *   changedFiles(pr, {base, head}) -> string[]
 *   run({pr, worktree, command, lane}) -> { exit, output }
 *
 * `prepare` may reuse a checkout on the first attempt. A runner that sees its
 * shared clone switched to another branch may throw an error with
 * `isolation: true` (or `code: 'E_ISOLATION'`), or return
 * `{contaminated: true}` from `run`; the verifier then asks for a fresh
 * worktree and reruns from scratch. A worktree whose head moves while the PR
 * tip stays put is treated the same way. A moved PR tip is not retried: it
 * voids the conclusion with `headStable: false`.
 */

import { countCases } from './cases.js';
import {
  DEFAULT_MIN_CASES,
  MAX_ISOLATION_ATTEMPTS,
  VERDICTS,
} from './constants.js';
import { isFullSha, normalizeAllowedDir, outOfScope } from './paths.js';

const RUNNER_METHODS = Object.freeze([
  'resolveHead',
  'prepare',
  'head',
  'changedFiles',
  'run',
]);

function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isIsolationError(error) {
  if (error === null || typeof error !== 'object') return false;
  return (
    error.isolation === true ||
    error.contaminated === true ||
    error.code === 'E_ISOLATION' ||
    error.code === 'E_WORKTREE_CONTAMINATED'
  );
}

function makeResult({
  verdict = VERDICTS.FAIL,
  scopeOk = false,
  outside = [],
  exit = null,
  cases = 0,
  headStable = false,
  reason,
}) {
  return { verdict, scopeOk, outside, exit, cases, headStable, reason };
}

function runnerFailure(step, error, { scopeOk, headStable }) {
  return makeResult({
    scopeOk,
    headStable,
    reason: `runner_error: ${step}: ${errorMessage(error)}`,
  });
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object') {
    return { error: 'options must be an object' };
  }

  const { pr, lane, allowedDirs, command, minCases, runner } = options;

  if (pr === null || typeof pr !== 'object') {
    return { error: 'pr must be an object with base and head' };
  }
  if (!isFullSha(pr.base)) {
    return { error: 'pr.base must be a complete 40-hex commit sha' };
  }
  if (!isFullSha(pr.head)) {
    return { error: 'pr.head must be a complete 40-hex commit sha' };
  }
  if (lane !== undefined && (typeof lane !== 'string' || lane.trim() === '')) {
    return { error: 'lane must be a non-empty string when provided' };
  }
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    return { error: 'allowedDirs must be a non-empty array of directories' };
  }

  let dirs;
  try {
    dirs = allowedDirs.map(normalizeAllowedDir);
  } catch (error) {
    return { error: `invalid allowedDirs: ${errorMessage(error)}` };
  }

  if (typeof command !== 'string' || command.trim() === '') {
    return { error: 'command must be a non-empty string' };
  }
  if (
    minCases !== undefined &&
    (!Number.isInteger(minCases) || minCases < 0)
  ) {
    return { error: 'minCases must be a non-negative integer when provided' };
  }
  if (runner === null || typeof runner !== 'object') {
    return { error: 'runner must be an object' };
  }
  for (const method of RUNNER_METHODS) {
    if (typeof runner[method] !== 'function') {
      return { error: `runner.${method} must be a function` };
    }
  }

  return {
    pr,
    lane: lane ?? 'default',
    dirs,
    command,
    minCases: minCases ?? DEFAULT_MIN_CASES,
    runner,
  };
}

/**
 * Verify one PR.
 *
 * @param {object} input
 * @param {{base: string, head: string, number?: number}} input.pr pinned full shas
 * @param {string} [input.lane] lane name passed to the runner
 * @param {string[]} input.allowedDirs repository-relative directories
 * @param {string} input.command command rerun in isolation
 * @param {number} [input.minCases=1] minimum executed case count
 * @param {object} input.runner injected executor (see file header)
 * @returns {Promise<{verdict: 'PASS'|'FAIL', scopeOk: boolean, outside: string[],
 *   exit: number|null, cases: number, headStable: boolean, reason: string}>}
 */
export async function verify(options) {
  try {
    return await runVerification(options);
  } catch (error) {
    return makeResult({ reason: `internal_error: ${errorMessage(error)}` });
  }
}

async function runVerification(options) {
  const validated = validateOptions(options);
  if (validated.error !== undefined) {
    return makeResult({ reason: `invalid_input: ${validated.error}` });
  }

  const { pr, lane, dirs, command, minCases, runner } = validated;
  const expected = pr.head.toLowerCase();
  const base = pr.base.toLowerCase();

  // 1. Pin the authoritative head before looking at any other evidence.
  let resolved;
  try {
    resolved = await runner.resolveHead(pr);
  } catch (error) {
    return runnerFailure('resolveHead', error, {
      scopeOk: false,
      headStable: false,
    });
  }
  if (!isFullSha(resolved)) {
    return runnerFailure(
      'resolveHead',
      new Error(`expected a full 40-hex sha, got ${String(resolved)}`),
      { scopeOk: false, headStable: false },
    );
  }
  if (resolved.toLowerCase() !== expected) {
    return makeResult({
      headStable: false,
      reason:
        `head_moved_before_verification: expected ${expected}, ` +
        `got ${resolved.toLowerCase()}`,
    });
  }

  // 2. Scope gate: only the PR diff may be present, and only in allowed dirs.
  let files;
  try {
    files = await runner.changedFiles(pr, { base, head: expected });
  } catch (error) {
    return runnerFailure('changedFiles', error, {
      scopeOk: false,
      headStable: true,
    });
  }
  if (!Array.isArray(files)) {
    return runnerFailure(
      'changedFiles',
      new Error('changedFiles must return an array of paths'),
      { scopeOk: false, headStable: true },
    );
  }

  let outside;
  try {
    outside = outOfScope(files, dirs);
  } catch (error) {
    return runnerFailure('changedFiles', error, {
      scopeOk: false,
      headStable: true,
    });
  }
  if (outside.length > 0) {
    return makeResult({
      scopeOk: false,
      outside,
      headStable: true,
      reason:
        `scope_violation: ${outside.length} file(s) outside allowed ` +
        `directories: ${outside.join(', ')}`,
    });
  }

  // 3. Rerun in isolation. A contaminated checkout is replaced with a fresh
  //    worktree and the whole lane is rerun; nothing from the stale run counts.
  //    A moved PR tip is different: it voids the conclusion instead.
  let worktree = null;
  let outcome = null;
  let lastIsolation = '';

  for (let attempt = 1; attempt <= MAX_ISOLATION_ATTEMPTS; attempt += 1) {
    const fresh = attempt > 1;

    let prepared;
    try {
      prepared = await runner.prepare(pr, { expectedHead: expected, fresh });
    } catch (error) {
      if (isIsolationError(error)) {
        lastIsolation = `prepare: ${errorMessage(error)}`;
        continue;
      }
      return runnerFailure('prepare', error, {
        scopeOk: true,
        headStable: true,
      });
    }

    const candidate =
      prepared !== null && typeof prepared === 'object'
        ? prepared.worktree
        : undefined;
    if (candidate === undefined || candidate === null) {
      return runnerFailure(
        'prepare',
        new Error('prepare must return { worktree }'),
        { scopeOk: true, headStable: true },
      );
    }

    let preparedHead;
    try {
      preparedHead = await runner.head(candidate);
    } catch (error) {
      return runnerFailure('head', error, {
        scopeOk: true,
        headStable: true,
      });
    }
    if (!isFullSha(preparedHead) || preparedHead.toLowerCase() !== expected) {
      lastIsolation =
        `worktree head ${String(preparedHead)} does not match ${expected}`;
      continue;
    }

    let result;
    try {
      result = await runner.run({
        pr,
        worktree: candidate,
        command,
        lane,
      });
    } catch (error) {
      if (isIsolationError(error)) {
        lastIsolation = `run: ${errorMessage(error)}`;
        continue;
      }
      return runnerFailure('run', error, {
        scopeOk: true,
        headStable: true,
      });
    }

    if (result !== null && typeof result === 'object' && result.contaminated === true) {
      lastIsolation = 'run reported a contaminated worktree';
      continue;
    }

    if (result === null || typeof result !== 'object') {
      return runnerFailure(
        'run',
        new Error('run must return { exit, output }'),
        { scopeOk: true, headStable: true },
      );
    }
    if (!Number.isInteger(result.exit)) {
      return runnerFailure(
        'run',
        new Error(`run returned a non-integer exit: ${String(result.exit)}`),
        { scopeOk: true, headStable: true },
      );
    }
    if (result.output !== undefined && typeof result.output !== 'string') {
      return runnerFailure(
        'run',
        new Error('run output must be a string when provided'),
        { scopeOk: true, headStable: true },
      );
    }

    // 4. The PR tip is authoritative. If it moved while the lane ran, the
    //    conclusion is void even when the rerun passed.
    let authoritativeHead;
    try {
      authoritativeHead = await runner.resolveHead(pr);
    } catch (error) {
      return runnerFailure('resolveHead', error, {
        scopeOk: true,
        headStable: false,
      });
    }
    if (
      !isFullSha(authoritativeHead) ||
      authoritativeHead.toLowerCase() !== expected
    ) {
      return makeResult({
        scopeOk: true,
        exit: result.exit,
        cases: countCases(result.output ?? ''),
        headStable: false,
        reason:
          `head_changed_during_verification: expected ${expected}, ` +
          `head ${String(authoritativeHead)}`,
      });
    }

    // 5. A local checkout that switched to another branch is contamination,
    //    not a PR update: replace it with a fresh worktree and rerun.
    let worktreeHead;
    try {
      worktreeHead = await runner.head(candidate);
    } catch (error) {
      return runnerFailure('head', error, {
        scopeOk: true,
        headStable: false,
      });
    }
    if (!isFullSha(worktreeHead) || worktreeHead.toLowerCase() !== expected) {
      lastIsolation =
        `worktree head moved to ${String(worktreeHead)} during the run`;
      continue;
    }

    worktree = candidate;
    outcome = result;
    break;
  }

  if (outcome === null || worktree === null) {
    const detail = lastIsolation === '' ? '' : ` (last: ${lastIsolation})`;
    return makeResult({
      scopeOk: true,
      headStable: false,
      reason:
        `isolation_failed: could not keep an isolated worktree at ` +
        `${expected} after ${MAX_ISOLATION_ATTEMPTS} attempts${detail}`,
    });
  }

  const exit = outcome.exit;
  const cases = countCases(outcome.output ?? '');

  // 6. Only real rerun evidence decides PASS.
  if (exit !== 0) {
    return makeResult({
      scopeOk: true,
      exit,
      cases,
      headStable: true,
      reason: `test_failed: exit ${exit}`,
    });
  }
  if (cases < minCases) {
    return makeResult({
      scopeOk: true,
      exit,
      cases,
      headStable: true,
      reason: `insufficient_cases: ${cases} < ${minCases}`,
    });
  }

  return {
    verdict: VERDICTS.PASS,
    scopeOk: true,
    outside: [],
    exit,
    cases,
    headStable: true,
    reason: 'ok',
  };
}
