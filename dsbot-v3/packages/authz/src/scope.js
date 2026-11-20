/**
 * Authorization-scope subset gate.
 *
 * PRD: `docs/prd/02-api-contract.md` §4.1 and
 * `docs/prd/04-reliability-ops.md` §1.5/§1.6 (AR-1..AR-6).
 *
 * The child scope must be contained by the parent scope. A child may narrow a
 * parent dimension, but it may not add a project/path/tool, raise a cap, widen
 * the delegation level, enable a git capability the parent did not grant, or
 * introduce an unknown capability key.
 *
 * A dimension that is absent from the parent is treated as unconstrained, so a
 * child may still add a restriction (the PRD defines the effective scope as an
 * intersection). The result is pure: arguments are never mutated.
 */

import { AUTHZ_CODES, LEVEL_RANK } from './constants.js';
import { cloneValue, hasOwn, isPlainObject, isSubsetValue } from './values.js';

const LIST_KEYS = Object.freeze(['projects', 'paths', 'tools']);
const CAP_KEYS = Object.freeze(['spend_cny_cap', 'max_parallel_runs']);
const GIT_KEYS = Object.freeze(['branch_prefix', 'can_merge', 'can_push']);
const KNOWN_KEYS = new Set([
  ...LIST_KEYS,
  ...CAP_KEYS,
  'max_delegate_level',
  'git',
]);

function readScope(value, label) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function readStringList(scope, key, label) {
  const value = scope[key];
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${label}.${key} must be an array of non-empty strings`);
  }
  if (key === 'paths' && value.some((item) => item.split('/').includes('..'))) {
    throw new TypeError(`${label}.${key} must not contain '..' segments`);
  }
  return [...new Set(value)];
}

function readCap(scope, key, label) {
  const value = scope[key];
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label}.${key} must be a non-negative finite number`);
  }
  return value;
}

function readLevel(scope, label) {
  const value = scope.max_delegate_level;
  if (value == null) return undefined;
  if (!hasOwn(LEVEL_RANK, value)) {
    throw new TypeError(
      `${label}.max_delegate_level must be one of ${Object.keys(LEVEL_RANK).join(', ')}`,
    );
  }
  return value;
}

function readGit(scope, label) {
  const value = scope.git;
  if (value == null) return undefined;
  if (!isPlainObject(value)) {
    throw new TypeError(`${label}.git must be a plain object`);
  }
  if (value.branch_prefix != null && typeof value.branch_prefix !== 'string') {
    throw new TypeError(`${label}.git.branch_prefix must be a string`);
  }
  for (const key of ['can_merge', 'can_push']) {
    if (value[key] != null && typeof value[key] !== 'boolean') {
      throw new TypeError(`${label}.git.${key} must be a boolean`);
    }
  }
  return value;
}

/**
 * A parent path is a file or a directory prefix. Directory prefixes end with
 * `/`; anything below such a prefix is still inside the parent grant.
 */
function pathAllowed(path, parentPaths) {
  return parentPaths.some(
    (parentPath) => path === parentPath || (parentPath.endsWith('/') && path.startsWith(parentPath)),
  );
}

function pushViolation(violations, dimension, reason, details = {}) {
  violations.push({ dimension, reason, ...details });
}

function mergeGit(parentGit, childGit, violations) {
  if (parentGit === undefined && childGit === undefined) return undefined;

  const effective = {};

  const parentPrefix = parentGit?.branch_prefix;
  const childPrefix = childGit?.branch_prefix;
  if (childPrefix !== undefined) {
    if (parentPrefix !== undefined && !childPrefix.startsWith(parentPrefix)) {
      pushViolation(violations, 'git.branch_prefix', 'not_subset', {
        parent: parentPrefix,
        child: childPrefix,
      });
    }
    effective.branch_prefix = childPrefix;
  } else if (parentPrefix !== undefined) {
    effective.branch_prefix = parentPrefix;
  }

  // AR-6: merging is never delegated, even if an upstream scope says otherwise.
  if (childGit?.can_merge === true) {
    pushViolation(violations, 'git.can_merge', 'merge_not_allowed', {
      parent: parentGit?.can_merge ?? false,
      child: true,
    });
  }
  effective.can_merge = false;

  // Pushing must have been granted explicitly by the parent; default is false.
  const parentPush = parentGit?.can_push === true;
  const childPush = childGit?.can_push;
  if (childPush === true && !parentPush) {
    pushViolation(violations, 'git.can_push', 'not_subset', {
      parent: parentPush,
      child: true,
    });
  }
  effective.can_push = parentPush && childPush !== false;

  for (const [key, childValue] of Object.entries(childGit ?? {})) {
    if (GIT_KEYS.includes(key)) continue;
    if (parentGit === undefined || !hasOwn(parentGit, key)) {
      pushViolation(violations, `git.${key}`, 'unknown_key', { child: cloneValue(childValue) });
    } else if (!isSubsetValue(parentGit[key], childValue)) {
      pushViolation(violations, `git.${key}`, 'not_subset', {
        parent: cloneValue(parentGit[key]),
        child: cloneValue(childValue),
      });
    } else {
      effective[key] = cloneValue(childValue);
    }
  }

  for (const [key, parentValue] of Object.entries(parentGit ?? {})) {
    if (GIT_KEYS.includes(key) || hasOwn(childGit ?? {}, key)) continue;
    effective[key] = cloneValue(parentValue);
  }

  return effective;
}

/**
 * Validate that `child` does not exceed `parent` and return their intersection.
 *
 * @param {object|null|undefined} parent parent/principal authorization scope
 * @param {object|null|undefined} child requested child scope
 * @returns {{ok: true, scope: object} | {ok: false, code: 'authorization_exceeded', violations: object[]}}
 * @throws {TypeError} when either scope is malformed
 */
export function effectiveScope(parent, child) {
  const parentScope = readScope(parent, 'parent');
  const childScope = readScope(child, 'child');
  const violations = [];
  const effective = {};

  for (const key of LIST_KEYS) {
    const parentList = readStringList(parentScope, key, 'parent');
    const childList = readStringList(childScope, key, 'child');

    if (childList === undefined) {
      if (parentList !== undefined) effective[key] = parentList;
      continue;
    }

    if (parentList !== undefined) {
      const denied = childList.filter((item) =>
        key === 'paths' ? !pathAllowed(item, parentList) : !parentList.includes(item),
      );
      if (denied.length > 0) {
        pushViolation(violations, key, 'not_subset', {
          parent: parentList,
          child: childList,
          offending: denied,
        });
      }
    }
    effective[key] = childList;
  }

  for (const key of CAP_KEYS) {
    const parentCap = readCap(parentScope, key, 'parent');
    const childCap = readCap(childScope, key, 'child');

    if (childCap === undefined) {
      if (parentCap !== undefined) effective[key] = parentCap;
      continue;
    }

    if (parentCap !== undefined && childCap > parentCap) {
      pushViolation(violations, key, 'cap_exceeds_parent', {
        parent: parentCap,
        child: childCap,
      });
    }
    effective[key] = parentCap === undefined ? childCap : Math.min(parentCap, childCap);
  }

  const parentLevel = readLevel(parentScope, 'parent');
  const childLevel = readLevel(childScope, 'child');
  if (childLevel === undefined) {
    if (parentLevel !== undefined) effective.max_delegate_level = parentLevel;
  } else {
    if (parentLevel !== undefined && LEVEL_RANK[childLevel] > LEVEL_RANK[parentLevel]) {
      pushViolation(violations, 'max_delegate_level', 'level_exceeds_parent', {
        parent: parentLevel,
        child: childLevel,
      });
      effective.max_delegate_level = parentLevel;
    } else {
      effective.max_delegate_level = childLevel;
    }
  }

  const git = mergeGit(readGit(parentScope, 'parent'), readGit(childScope, 'child'), violations);
  if (git !== undefined) effective.git = git;

  // Extra keys are only carried when the parent already defines the capability,
  // and the child value must be a narrowing of it.
  for (const [key, childValue] of Object.entries(childScope)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (!hasOwn(parentScope, key)) {
      pushViolation(violations, key, 'unknown_key', { child: cloneValue(childValue) });
      continue;
    }
    if (!isSubsetValue(parentScope[key], childValue)) {
      pushViolation(violations, key, 'not_subset', {
        parent: cloneValue(parentScope[key]),
        child: cloneValue(childValue),
      });
      continue;
    }
    effective[key] = cloneValue(childValue);
  }

  for (const [key, parentValue] of Object.entries(parentScope)) {
    if (KNOWN_KEYS.has(key) || hasOwn(childScope, key)) continue;
    effective[key] = cloneValue(parentValue);
  }

  if (violations.length > 0) {
    return { ok: false, code: AUTHZ_CODES.AUTHORIZATION_EXCEEDED, violations };
  }
  return { ok: true, scope: effective };
}
