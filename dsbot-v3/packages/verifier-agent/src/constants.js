/**
 * Constants of the L36 independent verifier.
 *
 * The verifier never trusts a PR author's self-report: every verdict is built
 * from the pinned commit sha, the changed-file list and the rerun output of an
 * injected runner.
 */

export const VERDICTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

/** Result fields, in contract order. */
export const RESULT_FIELDS = Object.freeze([
  'verdict',
  'scopeOk',
  'outside',
  'exit',
  'cases',
  'headStable',
  'reason',
]);

/**
 * A lane that executes fewer cases than this is failed by default. Callers
 * normally pass their own floor; a floor of 0 explicitly disables the check.
 */
export const DEFAULT_MIN_CASES = 1;

/**
 * How many isolated worktrees the verifier may try when a shared clone is
 * switched to another branch concurrently. The first attempt may reuse the
 * runner's prepared checkout; every retry asks for a brand-new worktree.
 */
export const MAX_ISOLATION_ATTEMPTS = 3;
