/**
 * Result vocabulary for the self-media acceptance profile.
 *
 * The overall result and every item result use the same three values, so the
 * aggregate can never be better than its worst item:
 *   pass          - the item's evidence meets the profile threshold
 *   needs_rework  - fixable in scope (add a source, fix the rubric, add tags)
 *   blocked       - evidence cannot establish the claim (missing snapshot,
 *                   contradictory sources, stale source, high infringement risk)
 *
 * `class` follows the three item classes of docs/prd/03-acceptance-spec.md
 * (auto / independent / human); this package only produces `auto` and
 * `independent` items. It never produces `human` items and never substitutes
 * for a human decision.
 */
export const RESULT = Object.freeze({
  pass: 'pass',
  needsRework: 'needs_rework',
  blocked: 'blocked',
});

export const RESULT_RANK = Object.freeze({
  [RESULT.pass]: 0,
  [RESULT.needsRework]: 1,
  [RESULT.blocked]: 2,
});

export const ITEM_CLASS = Object.freeze({
  auto: 'auto',
  independent: 'independent',
});

/** Publish gate denial codes (docs/prd/15-status-matrix.md T-07, D-V3-23). */
export const PUBLISH_DENIALS = Object.freeze({
  acceptanceNotPassed: 'acceptance_not_passed',
  authorizationRequired: 'publish_authorization_required',
  invalid: 'publish_authorization_invalid',
  notGranted: 'publish_authorization_not_granted',
  expired: 'publish_authorization_expired',
  fingerprintMismatch: 'content_fingerprint_mismatch',
  targetMismatch: 'publish_target_mismatch',
});
