/**
 * Hard-rule gate.
 *
 * PRD: `docs/prd/02-api-contract.md` §1/§5.1 and `docs/prd/03-acceptance-spec.md`
 * §4.1. Rules are versioned; only the newest version of each rule identity is
 * evaluated, then inactive/out-of-window/non-applicable rules are discarded.
 * A matching `kind: 'hard'` rule blocks the action with `rule_blocked`; soft
 * rules are reported but never block.
 *
 * Pure: no clock is read. Pass `action.at` (epoch ms, ISO-8601 or Date) to
 * evaluate `effective_from`/`effective_to`; without it, time windows are not
 * used so the result stays deterministic.
 */

import { AUTHZ_CODES } from './constants.js';
import { cloneValue, hasOwn, isPlainObject, isSubsetValue } from './values.js';

const IDENTITY_KEYS = ['key', 'rule_key', 'ruleKey', 'id'];
const MATCHER_KEYS = ['actions', 'applies_to', 'appliesTo', 'action'];

function readIdentity(rule, index) {
  for (const key of IDENTITY_KEYS) {
    if (rule[key] == null) continue;
    if (typeof rule[key] !== 'string' || rule[key].length === 0) {
      throw new TypeError(`rules[${index}].${key} must be a non-empty string`);
    }
    return rule[key];
  }
  return `__rule_${index}`;
}

function readVersion(rule, index) {
  const version = rule.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(`rules[${index}].version must be a positive integer`);
  }
  return version;
}

function readOptionalString(rule, keys, label) {
  for (const key of keys) {
    if (!hasOwn(rule, key) || rule[key] == null) continue;
    if (typeof rule[key] !== 'string' || rule[key].length === 0) {
      throw new TypeError(`${label} must be a non-empty string`);
    }
    return rule[key];
  }
  return undefined;
}

function readMatcher(rule, index) {
  for (const key of MATCHER_KEYS) {
    if (!hasOwn(rule, key) || rule[key] == null) continue;
    const raw = rule[key];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new TypeError(`rules[${index}].${key} must be a non-empty string or an array of them`);
    }
    return values;
  }
  return undefined;
}

function toTimestamp(value, label) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new TypeError(`${label} must be epoch milliseconds, an ISO-8601 string or a Date`);
}

function readWindow(rule, index) {
  const fromRaw = rule.effective_from ?? rule.effectiveFrom;
  const toRaw = rule.effective_to ?? rule.effectiveTo;
  const from = fromRaw == null ? undefined : toTimestamp(fromRaw, `rules[${index}].effective_from`);
  const to = toRaw == null ? undefined : toTimestamp(toRaw, `rules[${index}].effective_to`);
  if (from !== undefined && to !== undefined && to < from) {
    throw new TypeError(`rules[${index}] effective_to is before effective_from`);
  }
  return { from, to };
}

function normalizeRule(rule, index) {
  if (!isPlainObject(rule)) {
    throw new TypeError(`rules[${index}] must be a plain object`);
  }

  const kind = rule.kind;
  if (kind !== 'hard' && kind !== 'soft') {
    throw new TypeError(`rules[${index}].kind must be 'hard' or 'soft'`);
  }

  const scope = rule.scope ?? 'global';
  if (!['global', 'project', 'task'].includes(scope)) {
    throw new TypeError(`rules[${index}].scope must be 'global', 'project' or 'task'`);
  }

  const project = readOptionalString(rule, ['project'], `rules[${index}].project`);
  const taskId = readOptionalString(rule, ['task_id', 'taskId'], `rules[${index}].task_id`);
  if (scope === 'project' && project === undefined) {
    throw new TypeError(`rules[${index}] is project-scoped but has no project`);
  }
  if (scope === 'task' && taskId === undefined) {
    throw new TypeError(`rules[${index}] is task-scoped but has no task_id`);
  }

  const match = rule.match;
  if (match != null && !isPlainObject(match)) {
    throw new TypeError(`rules[${index}].match must be a plain object`);
  }

  const { from, to } = readWindow(rule, index);

  return {
    identity: readIdentity(rule, index),
    version: readVersion(rule, index),
    kind,
    scope,
    project,
    taskId,
    matcher: readMatcher(rule, index),
    match: match ?? undefined,
    from,
    to,
    active:
      rule.active !== false &&
      rule.active !== 0 &&
      rule.active !== '0' &&
      rule.active !== 'false',
    rule,
  };
}

function isEffectiveAt(info, at) {
  if (at === undefined) return true;
  if (info.from !== undefined && at < info.from) return false;
  if (info.to !== undefined && at > info.to) return false;
  return true;
}

function actionField(action, keys) {
  for (const key of keys) {
    if (action[key] != null) return action[key];
  }
  return undefined;
}

function applies(info, action, actionTaskId, at) {
  if (!info.active || !isEffectiveAt(info, at)) return false;

  if (info.scope === 'project' && action.project !== info.project) return false;
  if (info.scope === 'task' && actionTaskId !== info.taskId) return false;
  if (info.project !== undefined && action.project !== info.project) return false;
  if (info.taskId !== undefined && actionTaskId !== info.taskId) return false;

  if (info.matcher !== undefined) {
    const wildcard = info.matcher.includes('*');
    if (!wildcard && (action.type === undefined || !info.matcher.includes(action.type))) {
      return false;
    }
  }

  if (info.match !== undefined) {
    for (const [key, expected] of Object.entries(info.match)) {
      if (!hasOwn(action, key) || !isSubsetValue(expected, action[key])) return false;
    }
  }

  return true;
}

/**
 * Evaluate the newest version of every rule and block when a hard rule matches.
 *
 * @param {object[]} rules versioned rule rows (`id`/`key`, `kind`, `version`,
 *   `active`, `scope`, `project`, `task_id`, `action`/`actions`, `match`,
 *   `effective_from`, `effective_to`, `text`)
 * @param {string|object} action action type string, or
 *   `{ type, project, task_id, at, ... }`
 * @returns {{ok: true, applied: object[]} | {ok: false, code: 'rule_blocked', rule: object, blocked_by: object[], applied: object[]}}
 * @throws {TypeError} on malformed input
 */
export function gateRules(rules, action) {
  if (!Array.isArray(rules)) {
    throw new TypeError('rules must be an array');
  }

  let normalizedAction;
  if (typeof action === 'string' && action.length > 0) {
    normalizedAction = { type: action };
  } else if (isPlainObject(action)) {
    if (action.type != null && (typeof action.type !== 'string' || action.type.length === 0)) {
      throw new TypeError('action.type must be a non-empty string');
    }
    normalizedAction = action;
  } else {
    throw new TypeError('action must be a non-empty string or a plain object');
  }

  const at =
    normalizedAction.at == null ? undefined : toTimestamp(normalizedAction.at, 'action.at');
  const actionTaskId = actionField(normalizedAction, ['task_id', 'taskId']);

  const latest = new Map();
  rules.forEach((rule, index) => {
    const info = normalizeRule(rule, index);
    const current = latest.get(info.identity);
    if (
      current === undefined ||
      info.version > current.version ||
      (info.version === current.version && index > current.index)
    ) {
      latest.set(info.identity, { ...info, index });
    }
  });

  const evaluated = [...latest.values()]
    .filter((info) => applies(info, normalizedAction, actionTaskId, at))
    .sort((left, right) => {
      if (left.identity !== right.identity) return left.identity < right.identity ? -1 : 1;
      return left.version - right.version;
    });

  const blockers = evaluated.filter((info) => info.kind === 'hard');
  if (blockers.length > 0) {
    return {
      ok: false,
      code: AUTHZ_CODES.RULE_BLOCKED,
      rule: cloneValue(blockers[0].rule),
      blocked_by: blockers.map((info) => cloneValue(info.rule)),
      applied: evaluated.map((info) => cloneValue(info.rule)),
    };
  }

  return { ok: true, applied: evaluated.map((info) => cloneValue(info.rule)) };
}
