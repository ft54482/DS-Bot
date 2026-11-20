import {
  DEFAULT_FORBIDDEN,
  DEFAULT_MIN_CASES,
  ERROR_CODES,
} from './constants.js';
import { goalError } from './errors.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalText(value, field, code = ERROR_CODES.invalidInput) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw goalError(code, `${field} must be a string`, { field });
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(value, field, code) {
  if (value === undefined || value === null) return null;
  const items = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(items) || items.length === 0) {
    throw goalError(code, `${field} must be a non-empty string or array of strings`, { field });
  }
  return items.map((item, index) => {
    if (!hasText(item)) {
      throw goalError(code, `${field}[${index}] must be a non-empty string`, { field, index });
    }
    return item.trim();
  });
}

/**
 * Accept a goal as a bare title string or as an object. An empty or
 * title-less goal is rejected, even when a background is supplied, because
 * there is then nothing dispatachable to decompose.
 */
export function normalizeGoal(goal) {
  if (goal === undefined || goal === null) {
    throw goalError(ERROR_CODES.emptyGoal, 'goal is required and must not be empty');
  }
  if (typeof goal === 'string') {
    const title = goal.trim();
    if (title.length === 0) {
      throw goalError(ERROR_CODES.emptyGoal, 'goal must not be empty');
    }
    return {
      id: 'goal',
      title,
      background: '',
      acceptance: [],
      milestones: [],
      baseSha: null,
    };
  }
  if (!isPlainObject(goal)) {
    throw goalError(ERROR_CODES.invalidInput, 'goal must be a string or an object', {
      received: typeof goal,
    });
  }

  const title = optionalText(goal.title ?? goal.name ?? goal.subject, 'goal.title');
  if (title === null) {
    throw goalError(ERROR_CODES.emptyGoal, 'goal.title must not be empty');
  }

  const background = optionalText(goal.background ?? goal.summary, 'goal.background') ?? '';
  const acceptance = stringList(
    goal.acceptance ?? goal.acceptanceCommands,
    'goal.acceptance',
    ERROR_CODES.invalidInput,
  ) ?? [];
  const baseSha = optionalText(goal.baseSha ?? goal.base_sha ?? goal.base, 'goal.baseSha');
  const milestones = normalizeMilestones(goal.milestones, title);

  return {
    id: optionalText(goal.id, 'goal.id') ?? 'goal',
    title,
    background,
    acceptance,
    milestones,
    baseSha,
  };
}

function normalizeMilestones(value, goalTitle) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw goalError(ERROR_CODES.invalidInput, 'goal.milestones must be an array', {});
  }
  const seen = new Set();
  return value.map((entry, index) => {
    let id;
    let title;
    if (typeof entry === 'string') {
      id = `m${index + 1}`;
      title = entry;
    } else if (isPlainObject(entry)) {
      id = entry.id ?? entry.key ?? `m${index + 1}`;
      title = entry.title ?? entry.name ?? goalTitle;
    } else {
      throw goalError(ERROR_CODES.invalidInput, `goal.milestones[${index}] must be a string or object`, {
        index,
      });
    }
    const idText = typeof id === 'number' ? String(id) : id;
    if (!hasText(idText)) {
      throw goalError(ERROR_CODES.invalidInput, `goal.milestones[${index}].id must not be empty`, { index });
    }
    if (!hasText(title)) {
      throw goalError(ERROR_CODES.invalidInput, `goal.milestones[${index}].title must not be empty`, { index });
    }
    const normalizedId = idText.trim();
    if (seen.has(normalizedId)) {
      throw goalError(ERROR_CODES.invalidInput, `duplicate milestone id "${normalizedId}"`, {
        milestone: normalizedId,
      });
    }
    seen.add(normalizedId);
    return { id: normalizedId, title: title.trim() };
  });
}

/**
 * Normalize a repository-relative directory: forward slashes, no leading
 * `./`, no trailing slash, no absolute paths and no `..` traversal.
 */
export function normalizeDir(value, lane) {
  if (!hasText(value)) {
    throw goalError(ERROR_CODES.invalidLane, `lane "${lane}" must declare a non-empty dir`, { lane });
  }
  let dir = value.trim().replace(/\\/g, '/');
  if (dir.startsWith('/') || /^[a-zA-Z]:/.test(dir)) {
    throw goalError(ERROR_CODES.invalidLane, `lane "${lane}" dir must be repository-relative`, {
      lane,
      dir,
    });
  }
  while (dir.startsWith('./')) dir = dir.slice(2);
  dir = dir.replace(/\/+/g, '/').replace(/\/+$/, '');
  const parts = dir.split('/');
  if (dir.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw goalError(ERROR_CODES.invalidLane, `lane "${lane}" dir is not a normalizable path`, {
      lane,
      dir,
    });
  }
  return dir;
}

function normalizeIdList(value, field, lane) {
  if (value === undefined || value === null) return [];
  const items = typeof value === 'string' || typeof value === 'number' ? [value] : value;
  if (!Array.isArray(items)) {
    throw goalError(ERROR_CODES.invalidLane, `${field} must be an id or an array of ids`, { lane });
  }
  return items.map((item, index) => {
    if ((typeof item !== 'string' && typeof item !== 'number') || String(item).trim().length === 0) {
      throw goalError(ERROR_CODES.invalidLane, `${field}[${index}] must be a non-empty id`, {
        lane,
        index,
      });
    }
    return String(item).trim();
  });
}

function normalizeLane(raw, index) {
  if (!isPlainObject(raw)) {
    throw goalError(ERROR_CODES.invalidLane, `lanes[${index}] must be an object`, { index });
  }
  const rawLane = raw.lane ?? raw.name ?? raw.id;
  if (!hasText(rawLane)) {
    throw goalError(ERROR_CODES.invalidLane, `lanes[${index}].lane must not be empty`, { index });
  }
  const lane = rawLane.trim();
  const dir = normalizeDir(raw.dir ?? raw.directory, lane);
  const allowedPaths = stringList(
    raw.allowedPaths ?? raw.allowed_paths ?? raw.allowed,
    `lane "${lane}" allowedPaths`,
    ERROR_CODES.invalidLane,
  ) ?? [`${dir}/**`];
  const forbidden = stringList(
    raw.forbidden ?? raw.prohibited,
    `lane "${lane}" forbidden`,
    ERROR_CODES.invalidLane,
  ) ?? [...DEFAULT_FORBIDDEN];
  const acceptanceCommands = stringList(
    raw.acceptanceCommands ?? raw.acceptance ?? raw.verify,
    `lane "${lane}" acceptanceCommands`,
    ERROR_CODES.invalidLane,
  ) ?? [`node --test ${dir}/test`];
  const minCases = raw.minCases ?? raw.minimumCases ?? raw.min_cases ?? DEFAULT_MIN_CASES;
  if (!Number.isInteger(minCases) || minCases < 1) {
    throw goalError(ERROR_CODES.invalidLane, `lane "${lane}" minCases must be a positive integer`, {
      lane,
      minCases,
    });
  }
  const cost = raw.cost ?? raw.weight ?? 1;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    throw goalError(ERROR_CODES.invalidLane, `lane "${lane}" cost must be a non-negative finite number`, {
      lane,
      cost,
    });
  }

  return {
    lane,
    dir,
    milestone: optionalText(raw.milestone ?? raw.milestoneId ?? raw.milestone_id, `lane "${lane}" milestone`, ERROR_CODES.invalidLane),
    allowedPaths,
    forbidden,
    acceptanceCommands,
    minCases,
    cost,
    prd: normalizeIdList(raw.prd ?? raw.prdRefs ?? raw.prd_refs, `lane "${lane}" prd`, lane),
    baseSha: optionalText(raw.baseSha ?? raw.base_sha ?? raw.base, `lane "${lane}" baseSha`, ERROR_CODES.invalidLane),
    baseRef: optionalText(raw.baseRef ?? raw.base_ref ?? raw.ref, `lane "${lane}" baseRef`, ERROR_CODES.invalidLane) ?? 'origin/main',
    background: optionalText(raw.background ?? raw.notes, `lane "${lane}" background`, ERROR_CODES.invalidLane) ?? '',
  };
}

export function normalizeLanes(lanes) {
  if (lanes === undefined || lanes === null) {
    throw goalError(ERROR_CODES.invalidInput, 'lanes is required');
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw goalError(ERROR_CODES.invalidInput, 'lanes must be a non-empty array', {});
  }
  const normalized = lanes.map(normalizeLane);
  const names = new Set();
  for (const lane of normalized) {
    if (names.has(lane.lane)) {
      throw goalError(ERROR_CODES.duplicateLane, `duplicate lane name "${lane.lane}"`, {
        lane: lane.lane,
      });
    }
    names.add(lane.lane);
  }
  return normalized;
}

/**
 * Two lanes may not share a directory, and neither may one contain another:
 * both break the promise that a task book has an exclusive work area.
 */
export function assertMutuallyExclusive(lanes) {
  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const left = lanes[i];
      const right = lanes[j];
      if (left.dir === right.dir) {
        throw goalError(
          ERROR_CODES.laneDirConflict,
          `lanes "${left.lane}" and "${right.lane}" share directory "${left.dir}"`,
          { lanes: [left.lane, right.lane], dirs: [left.dir, right.dir], conflict: 'same' },
        );
      }
      if (left.dir.startsWith(`${right.dir}/`) || right.dir.startsWith(`${left.dir}/`)) {
        throw goalError(
          ERROR_CODES.laneDirConflict,
          `lanes "${left.lane}" and "${right.lane}" have nested directories "${left.dir}" and "${right.dir}"`,
          { lanes: [left.lane, right.lane], dirs: [left.dir, right.dir], conflict: 'nested' },
        );
      }
    }
  }
}

function round6(value) {
  return Number(value.toFixed(6));
}

export function normalizeBudget(budget) {
  let limit;
  let unit = 'points';
  if (isPlainObject(budget)) {
    limit = budget.limit ?? budget.total ?? budget.max;
    if (budget.unit !== undefined) {
      if (!hasText(budget.unit)) {
        throw goalError(ERROR_CODES.invalidBudget, 'budget.unit must be a non-empty string', {});
      }
      unit = budget.unit.trim();
    }
  } else {
    limit = budget;
  }
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw goalError(ERROR_CODES.invalidBudget, 'budget must be a positive finite number or {limit}>0', {
      limit,
    });
  }
  return { limit: round6(limit), unit };
}

/** Reject the whole decomposition before any task book is generated. */
export function checkBudget(lanes, budget) {
  const total = round6(lanes.reduce((sum, lane) => sum + lane.cost, 0));
  if (total > budget.limit) {
    throw goalError(ERROR_CODES.budgetExceeded, `lane cost ${total} exceeds budget ${budget.limit}`, {
      total,
      limit: budget.limit,
      unit: budget.unit,
    });
  }
  return total;
}

/**
 * Normalize the read-only PRD index. Accepted shapes:
 *   [{id, title?, path}, ...] or { [id]: path | {title?, path} }.
 */
export function normalizePrdIndex(prdIndex) {
  const entries = new Map();
  if (prdIndex === undefined || prdIndex === null) {
    return { entries, resolve: (ids, lane) => resolvePrd(entries, ids, lane) };
  }

  const add = (id, title, path, source) => {
    const idText = typeof id === 'number' ? String(id) : id;
    if (!hasText(idText) || !hasText(path)) {
      throw goalError(ERROR_CODES.invalidInput, `prdIndex entry ${source} must declare id and path`, {
        entry: source,
      });
    }
    const normalizedId = idText.trim();
    if (entries.has(normalizedId)) {
      throw goalError(ERROR_CODES.invalidInput, `duplicate prd index id "${normalizedId}"`, {
        id: normalizedId,
      });
    }
    entries.set(normalizedId, Object.freeze({
      id: normalizedId,
      title: hasText(title) ? title.trim() : normalizedId,
      path: path.trim(),
    }));
  };

  if (Array.isArray(prdIndex)) {
    prdIndex.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        throw goalError(ERROR_CODES.invalidInput, `prdIndex[${index}] must be an object`, { index });
      }
      add(entry.id ?? entry.key, entry.title, entry.path ?? entry.file, index);
    });
  } else if (isPlainObject(prdIndex)) {
    for (const [id, value] of Object.entries(prdIndex)) {
      if (typeof value === 'string') {
        add(id, id, value, id);
      } else if (isPlainObject(value)) {
        add(id, value.title, value.path ?? value.file, id);
      } else {
        throw goalError(ERROR_CODES.invalidInput, `prdIndex["${id}"] must be a path or object`, { id });
      }
    }
  } else {
    throw goalError(ERROR_CODES.invalidInput, 'prdIndex must be an array or object');
  }

  return { entries, resolve: (ids, lane) => resolvePrd(entries, ids, lane) };
}

function resolvePrd(entries, ids, lane) {
  return ids.map((id) => {
    const entry = entries.get(id);
    if (entry === undefined) {
      throw goalError(ERROR_CODES.unknownPrd, `lane "${lane}" references unknown prd "${id}"`, {
        lane,
        id,
      });
    }
    return entry;
  });
}

/**
 * Group normalized lanes into milestones in declared order, keeping only
 * milestones that received at least one lane. With no declared milestones a
 * single `m1` milestone titled after the goal is synthesized.
 */
export function groupLanesByMilestone(goal, lanes) {
  const definitions = goal.milestones.length > 0
    ? goal.milestones
    : [{ id: 'm1', title: goal.title }];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const groups = new Map(definitions.map((definition) => [
    definition.id,
    { id: definition.id, title: definition.title, lanes: [] },
  ]));

  for (const lane of lanes) {
    let definition;
    if (lane.milestone !== null) {
      definition = byId.get(lane.milestone);
      if (definition === undefined) {
        throw goalError(ERROR_CODES.unknownMilestone, `lane "${lane.lane}" references unknown milestone "${lane.milestone}"`, {
          lane: lane.lane,
          milestone: lane.milestone,
          declared: definitions.map((item) => item.id),
        });
      }
    } else {
      definition = definitions[0];
    }
    groups.get(definition.id).lanes.push(lane);
  }

  return [...groups.values()].filter((group) => group.lanes.length > 0);
}

export { FULL_SHA };
