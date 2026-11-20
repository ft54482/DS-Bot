import { LEVEL_CONFIG } from './constants.js';
import { firstString, isRecord, toStringList } from './normalize.js';

/**
 * Fixed "who am I / what may I see" header for a layer. It carries labels,
 * not prompt prose, so a renderer can map them to the deployment's wording.
 */
export function buildIdentity(level, task) {
  const config = LEVEL_CONFIG[level];
  const scope = normalizeIdentityScope(task);

  return {
    role: config.role,
    level,
    principal: firstString(
      task.principal,
      task.owner,
      task.owner_ref,
      task.executor_id,
      task.bot_id,
      isRecord(task.scope) ? task.scope.bot_scope ?? task.scope.botScope : undefined,
      task.bot_scope,
      task.botScope,
      config.principal,
    ),
    scope,
    rules_version: firstString(task.rules_version, task.rulesVersion, 'v1'),
    visible: [...config.visible],
    hidden: [...config.hidden],
  };
}

function normalizeIdentityScope(task) {
  const raw = isRecord(task.scope) ? task.scope : {};
  const scope = {};

  const projects = toStringList(raw.projects ?? task.projects);
  if (projects.length > 0) scope.projects = projects;

  const botScope = firstString(
    raw.bot_scope,
    raw.botScope,
    task.bot_scope,
    task.botScope,
  );
  if (botScope !== null) scope.bot_scope = botScope;

  return scope;
}
