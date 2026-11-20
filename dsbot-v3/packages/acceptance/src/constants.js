/**
 * Vocabulary of the three-stage acceptance engine.
 *
 * The result vocabulary is intentionally the ticket contract, not the wider
 * PRD `pass/revise/fail/blocked/void` set:
 *   pass    - every required item of this stage is satisfied
 *   rework  - the stage was judged, but a required item failed in a way that
 *             can be fixed and re-submitted
 *   blocked - the stage cannot be judged: evidence is missing, invalid or
 *             pending, a parent stage rubric is absent, or the caller tries to
 *             let a child stage decide a parent stage
 *
 * See docs/prd/03-acceptance-spec.md §4.1, §4.7 and §4.8 for the underlying
 * rules (`G1`, `G2`, `G4`, `G30`, `INV-15`).
 */
export const STAGES = Object.freeze({
  execution: 'execution',
  business: 'business',
  goal: 'goal',
});

export const RESULTS = Object.freeze({
  pass: 'pass',
  rework: 'rework',
  blocked: 'blocked',
});

/** An aggregate can never be better than its worst item. */
export const RESULT_RANK = Object.freeze({
  [RESULTS.pass]: 0,
  [RESULTS.rework]: 1,
  [RESULTS.blocked]: 2,
});
