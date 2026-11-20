import { ProfileError } from './errors.js';

/**
 * Item ids produced by `evaluateArticlePack` for `business.self_media_v1`.
 * They mirror the self-media acceptance rows of docs/prd/14-business-model.md
 * §2.1 and the acceptance classes of docs/prd/03-acceptance-spec.md §4.3.
 */
export const KNOWN_ITEM_IDS = Object.freeze([
  'auto.pack_schema',
  'independent.facts',
  'independent.freshness',
  'independent.quality.reviewer',
  'independent.quality.structure',
  'independent.quality.readability',
  'independent.quality.style',
  'auto.layout.titles',
  'auto.layout.tags',
  'auto.compliance.quote_ratio',
  'auto.compliance.risk_list',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * The pinned self-media acceptance profile (Phase 1, docs/prd/17 §2 S4).
 *
 * Thresholds are policy, not author claims:
 *  - a key fact needs two independent hosts whose snapshots are complete;
 *  - a key fact needs source time and its freshest source must not be older
 *    than `maxSourceAgeDays`; expired evidence blocks acceptance by default
 *    (a profile variant may ask for a replacement source instead);
 *  - quality is an independent reviewer's rubric on a 0-100 scale, one score
 *    per dimension, and every score must reach its threshold;
 *  - layout needs at least three title candidates and three tags;
 *  - quotes must stay at or below 15% of the body, with 30% as a hard block.
 *
 * The profile is versioned. Changing a threshold or deleting an item requires a
 * new version; old acceptance decisions are bound to the old version
 * (docs/prd/03-acceptance-spec.md §4.5, INV-07).
 */
export const selfMediaProfileV1 = deepFreeze({
  id: 'business.self_media_v1',
  version: 1,
  stage: 'business',
  requiredItems: [...KNOWN_ITEM_IDS],
  facts: {
    minIndependentSources: 2,
    requireSnapshot: true,
  },
  freshness: {
    maxSourceAgeDays: 180,
    expiredResult: 'blocked',
  },
  quality: {
    scale: { min: 0, max: 100 },
    thresholds: { structure: 70, readability: 70, style: 70 },
    requireIndependentReviewer: true,
  },
  layout: {
    minTitleCandidates: 3,
    minTags: 3,
  },
  compliance: {
    maxQuoteRatio: 0.15,
    hardQuoteRatio: 0.3,
    requireRiskList: true,
  },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function checkRatio(issues, name, value, { min = 0, max = 1 } = {}) {
  if (!isFiniteNumber(value) || value <= min || value > max) issues.push(`${name} must be in (${min}, ${max}]`);
}

/**
 * Reject a structurally invalid profile before it can silently weaken a gate.
 *
 * Documented invariants (docs/prd/03-acceptance-spec.md G06, §4.3):
 *  - the profile is versioned and pinned;
 *  - required items are declared and at least one is independent/human;
 *  - snapshot, independent reviewer and risk-list requirements cannot be
 *    waived (removing an item requires a new profile version, not a flag).
 */
export function assertProfile(profile) {
  if (!isPlainObject(profile)) throw new ProfileError('profile must be an object');
  const issues = [];

  if (typeof profile.id !== 'string' || profile.id.trim() === '') issues.push('id');
  if (!isPositiveInteger(profile.version)) issues.push('version');
  if (profile.stage !== 'business') issues.push('stage (business expected)');

  if (!Array.isArray(profile.requiredItems) || profile.requiredItems.length === 0) {
    issues.push('requiredItems');
  } else {
    profile.requiredItems.forEach((item, index) => {
      if (typeof item !== 'string' || item.trim() === '') issues.push(`requiredItems[${index}]`);
    });
    if (!profile.requiredItems.some((item) => typeof item === 'string' && item.startsWith('independent.'))) {
      issues.push('requiredItems (at least one independent item)');
    }
  }

  if (!isPlainObject(profile.facts)) {
    issues.push('facts');
  } else {
    if (!Number.isInteger(profile.facts.minIndependentSources) || profile.facts.minIndependentSources < 2) {
      issues.push('facts.minIndependentSources (>=2)');
    }
    if (profile.facts.requireSnapshot !== true) issues.push('facts.requireSnapshot (cannot be waived)');
  }

  if (!isPlainObject(profile.freshness)) {
    issues.push('freshness');
  } else {
    if (!isFiniteNumber(profile.freshness.maxSourceAgeDays) || profile.freshness.maxSourceAgeDays <= 0) {
      issues.push('freshness.maxSourceAgeDays');
    }
    if (!['blocked', 'needs_rework'].includes(profile.freshness.expiredResult)) {
      issues.push('freshness.expiredResult (blocked|needs_rework)');
    }
  }

  if (!isPlainObject(profile.quality)) {
    issues.push('quality');
  } else {
    const scale = profile.quality.scale;
    if (!isPlainObject(scale) || !isFiniteNumber(scale.min) || !isFiniteNumber(scale.max) || scale.min >= scale.max) {
      issues.push('quality.scale');
    }
    if (!isPlainObject(profile.quality.thresholds)) {
      issues.push('quality.thresholds');
    } else {
      for (const dimension of ['structure', 'readability', 'style']) {
        const threshold = profile.quality.thresholds[dimension];
        if (!isFiniteNumber(threshold)) {
          issues.push(`quality.thresholds.${dimension}`);
        } else if (isPlainObject(scale) && (threshold < scale.min || threshold > scale.max)) {
          issues.push(`quality.thresholds.${dimension} (outside scale)`);
        }
      }
    }
    if (profile.quality.requireIndependentReviewer !== true) {
      issues.push('quality.requireIndependentReviewer (cannot be waived)');
    }
  }

  if (!isPlainObject(profile.layout)) {
    issues.push('layout');
  } else {
    if (!isPositiveInteger(profile.layout.minTitleCandidates)) issues.push('layout.minTitleCandidates');
    if (!isPositiveInteger(profile.layout.minTags)) issues.push('layout.minTags');
  }

  if (!isPlainObject(profile.compliance)) {
    issues.push('compliance');
  } else {
    checkRatio(issues, 'compliance.maxQuoteRatio', profile.compliance.maxQuoteRatio);
    checkRatio(issues, 'compliance.hardQuoteRatio', profile.compliance.hardQuoteRatio);
    if (
      isFiniteNumber(profile.compliance.maxQuoteRatio) &&
      isFiniteNumber(profile.compliance.hardQuoteRatio) &&
      profile.compliance.hardQuoteRatio < profile.compliance.maxQuoteRatio
    ) {
      issues.push('compliance.hardQuoteRatio (must be >= maxQuoteRatio)');
    }
    if (profile.compliance.requireRiskList !== true) {
      issues.push('compliance.requireRiskList (cannot be waived)');
    }
  }

  if (issues.length > 0) throw new ProfileError('invalid acceptance profile', issues);
  return true;
}
