import { formatAuditLine, sanitizeText, summarize } from './audit.js';
import { COMMANDS, DSBOT_CODES, HELP_TEXT } from './constants.js';
import { parseInvocation } from './parse.js';

/**
 * L49 DS Bot command adapter.
 *
 * This module is the "command -> action -> receipt" seam between a DS Bot chat
 * surface and the existing coordination layers. It owns no goal, task, budget
 * or stop implementation:
 *
 *   /goal new      -> chief.openGoal(...)
 *   /goal status   -> chief.status(...)
 *   /delegate      -> chief.delegate(...)
 *   /deliver       -> chief.deliver(...)
 *   /stop          -> runtime.stop.request(...)
 *
 * `chief` and `runtime` are injected so the DS Bot can require this package
 * directly and so tests can use fakes. `handle` never throws for domain or
 * parsing failures; it returns `{reply, action?, data?, ok, code?}`.
 */

const ACTION_NAMES = Object.freeze({
  goal: 'goal',
  'goal.new': 'openGoal',
  'goal.status': 'status',
  delegate: 'delegate',
  deliver: 'deliver',
  stop: 'stop.request',
  input: 'input',
});

const REQUIRED_CHIEF_METHODS = Object.freeze(['openGoal', 'status', 'delegate', 'deliver']);

function normalizeUserId(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeChannel(value) {
  if (value == null) return 'unknown';
  const text = String(value).trim();
  return text === '' ? 'unknown' : text;
}

function normalizeAccess({ allowlist, allowedUsers, allowedUserIds, authorize }) {
  if (authorize != null && typeof authorize !== 'function') {
    throw new TypeError('createDsBotAdapter authorize must be a function');
  }
  if (typeof authorize === 'function') {
    return (userId, context) => {
      try {
        return authorize(userId, context) === true;
      } catch {
        // An authorization predicate that cannot decide must not grant access.
        return false;
      }
    };
  }

  const source = allowlist ?? allowedUsers ?? allowedUserIds;
  // No allowlist means the host has not configured user gating; the adapter
  // stays open so a single-user DS Bot can start without extra configuration.
  if (source == null) return () => true;

  let entries;
  if (typeof source === 'string' || typeof source === 'number') {
    entries = [source];
  } else if (Array.isArray(source)) {
    entries = source;
  } else if (source instanceof Set) {
    entries = [...source];
  } else if (typeof source === 'object') {
    entries = Object.entries(source)
      .filter(([, value]) => value === true)
      .map(([name]) => name);
  } else {
    throw new TypeError('createDsBotAdapter allowlist must be a string, array, Set or map');
  }

  const allowed = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      throw new TypeError('createDsBotAdapter allowlist entries must be strings');
    }
    const id = String(entry).trim();
    if (id === '') throw new TypeError('createDsBotAdapter allowlist entries must not be empty');
    allowed.add(id);
  }
  return (userId) => allowed.has(userId);
}

function makeAction(name, command, args, context, extra = {}) {
  const action = {
    name,
    command,
    args: summarize(args ?? {}),
    executed: extra.executed !== false,
    userId: context.userId,
    channel: context.channel,
    at: context.at,
  };
  if (extra.denied === true) {
    action.denied = true;
    action.reason = extra.reason ?? 'not_allowed';
  }
  return action;
}

function build({ ok, code, reply, action, data }) {
  const result = { ok, reply };
  if (code) result.code = code;
  if (action) result.action = action;
  if (data !== undefined) result.data = data;
  return result;
}

function withAudit(body, action) {
  return `${body}\n\n${formatAuditLine(action)}`;
}

function codeOf(value) {
  return typeof value?.code === 'string' && value.code !== '' ? value.code : DSBOT_CODES.TOOL_ERROR;
}

function blockersText(blockers) {
  return blockers
    .slice(0, 5)
    .map((entry) => {
      const code = entry?.code;
      const message = entry?.message;
      if (code != null && message != null) {
        return `${sanitizeText(code)}：${sanitizeText(message)}`;
      }
      return sanitizeText(message ?? code ?? String(entry));
    })
    .join('；');
}

function goalNewReply(result, parsed) {
  const goalId = result.goalId ?? result.goal?.id ?? result.task?.id ?? '(未知 id)';
  const title = result.goal?.title ?? result.task?.title ?? parsed.args.title;
  const budget = parsed.args.budgetCny;
  const suffix = budget === undefined ? '' : `（预算 ${budget} CNY）`;
  return `✅ 已创建目标 ${goalId}：${sanitizeText(title)}${suffix}`;
}

function statusReply(result, parsed) {
  const goal = result.goal ?? {};
  const goalId = result.goalId ?? goal.id ?? parsed.args.goalId;
  const businesses = Array.isArray(result.businesses) ? result.businesses.length : 0;
  const acceptance = result.acceptance ?? {};
  const passed = acceptance.passed ?? 0;
  const total = acceptance.total ?? businesses;
  const cost = result.cost ?? {};
  const cap = cost.capCny == null ? '∞' : cost.capCny;
  const lines = [
    `📊 目标 ${goalId ?? '(未知 id)'}：${sanitizeText(goal.title ?? '(无标题)')}`,
    `状态：${sanitizeText(goal.state ?? 'unknown')}；业务任务：${businesses}；验收：${passed}/${total} 通过`,
    `成本：${cost.cny ?? 0}/${cap} CNY`,
  ];
  const blockers = Array.isArray(result.blockers) ? result.blockers : [];
  if (blockers.length > 0) lines.push(`阻塞：${blockersText(blockers)}`);
  return lines.join('\n');
}

function delegateReply(result, parsed) {
  const task = result.task ?? result.businessTask ?? {};
  const taskId = task.id ?? '(未知 id)';
  const title = task.title ?? parsed.args.brief;
  return `✅ 已派给 ${sanitizeText(result.bot ?? parsed.args.bot)}：${taskId} · ${sanitizeText(title)}`;
}

function deliverReply(result, parsed) {
  const title = result.title ?? result.goal?.title ?? parsed.args.goalId;
  const count = Array.isArray(result.deliverables) ? result.deliverables.length : 0;
  const lines = [`✅ 交付包已生成：${sanitizeText(title)}`];
  if (typeof result.summary === 'string' && result.summary !== '') {
    lines.push(sanitizeText(result.summary));
  }
  lines.push(`交付物：${count} 项`);
  return lines.join('\n');
}

function stopReply(result, parsed) {
  const requested = result.requested ?? result.task ?? {};
  const state = requested.state ?? result.stopState ?? 'stopping';
  const lines = [`⏹ 已请求停止 ${sanitizeText(parsed.args.taskId)}（状态：${sanitizeText(state)}）`];
  if (Array.isArray(result.blockers) && result.blockers.length > 0) {
    lines.push(`阻塞：${blockersText(result.blockers)}`);
  }
  return lines.join('\n');
}

/**
 * @param {object} options
 * @param {object} options.chief  `@dsbot/chief` surface (openGoal/status/delegate/deliver)
 * @param {object} options.runtime runtime facade; `/stop` uses `runtime.stop.request`
 * @param {() => number} [options.clock] injectable clock for the audit timestamp
 * @param {string[]|Set<string>|string|object} [options.allowlist] authorized user ids;
 *   omitted means "no user gating configured"
 * @param {string[]|Set<string>|string|object} [options.allowedUsers] alias of `allowlist`
 * @param {string[]|Set<string>|string|object} [options.allowedUserIds] alias of `allowlist`
 * @param {(userId: string, context: object) => boolean} [options.authorize] custom predicate
 * @param {object|string|string[]} [options.scope] goal auth scope passed to `chief.openGoal`;
 *   alias `defaultScope`. A deployment that enforces project scope must set it.
 */
export function createDsBotAdapter({
  chief,
  runtime,
  clock = () => Date.now(),
  allowlist,
  allowedUsers,
  allowedUserIds,
  authorize,
  scope,
  defaultScope,
} = {}) {
  if (!chief || typeof chief !== 'object') {
    throw new TypeError('createDsBotAdapter requires { chief }');
  }
  for (const method of REQUIRED_CHIEF_METHODS) {
    if (typeof chief[method] !== 'function') {
      throw new TypeError(`createDsBotAdapter requires chief.${method}`);
    }
  }
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('createDsBotAdapter requires { runtime }');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createDsBotAdapter clock must be a function');
  }

  const isAllowed = normalizeAccess({ allowlist, allowedUsers, allowedUserIds, authorize });

  function missingResult(parsed, context) {
    const name = ACTION_NAMES[parsed.command] ?? parsed.command;
    const action = makeAction(name, parsed.command, parsed.args, context, { executed: false });
    const body = `❌ 缺参数：${parsed.argument}\n用法：${parsed.usage}`;
    return build({
      ok: false,
      code: DSBOT_CODES.MISSING_ARGUMENT,
      reply: withAudit(body, action),
      action,
      data: { argument: parsed.argument, usage: parsed.usage },
    });
  }

  function invalidResult(parsed, context) {
    const name = ACTION_NAMES[parsed.command] ?? parsed.command;
    const action = makeAction(name, parsed.command, parsed.args, context, { executed: false });
    const body = `❌ 参数无效：${parsed.argument}（${parsed.reason}）\n用法：${parsed.usage}`;
    return build({
      ok: false,
      code: DSBOT_CODES.INVALID_ARGUMENT,
      reply: withAudit(body, action),
      action,
      data: { argument: parsed.argument, value: parsed.value, reason: parsed.reason },
    });
  }

  function invoke({ parsed, context, actionName, call, format }) {
    try {
      const toolResult = call();
      if (toolResult == null || typeof toolResult !== 'object') {
        const action = makeAction(actionName, parsed.command, parsed.args, context, {
          executed: true,
        });
        return build({
          ok: false,
          code: DSBOT_CODES.TOOL_ERROR,
          reply: withAudit('⚠️ 命令未返回结果，未生成回执。', action),
          action,
          data: { reason: 'empty_result' },
        });
      }

      const action = makeAction(actionName, parsed.command, parsed.args, context, {
        executed: true,
      });

      if (toolResult.ok === false) {
        const code = codeOf(toolResult);
        const lines = [
          `❌ ${sanitizeText(toolResult.message ?? '命令未完成')}`,
          `代码：${code}`,
        ];
        if (Array.isArray(toolResult.blockers) && toolResult.blockers.length > 0) {
          lines.push(`阻塞：${blockersText(toolResult.blockers)}`);
        }
        if (Array.isArray(toolResult.pending) && toolResult.pending.length > 0) {
          lines.push(`待处理：${toolResult.pending.length} 项`);
        }
        return build({
          ok: false,
          code,
          reply: withAudit(lines.join('\n'), action),
          action,
          data: toolResult,
        });
      }

      return build({
        ok: true,
        reply: withAudit(format(toolResult), action),
        action,
        data: toolResult,
      });
    } catch (error) {
      const code = codeOf(error);
      const action = makeAction(actionName, parsed.command, parsed.args, context, {
        executed: true,
      });
      const message = sanitizeText(error?.message ?? String(error));
      return build({
        ok: false,
        code,
        reply: withAudit(`⚠️ 命令执行失败：${message}（${code}）`, action),
        action,
        data: { code, message },
      });
    }
  }

  function runCommand(parsed, context) {
    const actionName = ACTION_NAMES[parsed.command] ?? parsed.command;

    switch (parsed.command) {
      case 'goal.new': {
        const input = { title: parsed.args.title };
        if (parsed.args.budgetCny !== undefined) input.budgetCny = parsed.args.budgetCny;
        const goalScope = scope ?? defaultScope;
        if (goalScope !== undefined) input.scope = goalScope;
        return invoke({
          parsed,
          context,
          actionName,
          call: () => chief.openGoal(input),
          format: (result) => goalNewReply(result, parsed),
        });
      }
      case 'goal.status':
        return invoke({
          parsed,
          context,
          actionName,
          call: () => chief.status({ goalId: parsed.args.goalId }),
          format: (result) => statusReply(result, parsed),
        });
      case 'delegate':
        return invoke({
          parsed,
          context,
          actionName,
          call: () =>
            chief.delegate({
              goalId: parsed.args.goalId,
              bot: parsed.args.bot,
              brief: parsed.args.brief,
            }),
          format: (result) => delegateReply(result, parsed),
        });
      case 'deliver':
        return invoke({
          parsed,
          context,
          actionName,
          call: () => chief.deliver({ goalId: parsed.args.goalId }),
          format: (result) => deliverReply(result, parsed),
        });
      case 'stop': {
        if (!runtime.stop || typeof runtime.stop.request !== 'function') {
          const action = makeAction(actionName, parsed.command, parsed.args, context, {
            executed: false,
          });
          return build({
            ok: false,
            code: DSBOT_CODES.RUNTIME_UNAVAILABLE,
            reply: withAudit('⚠️ 运行时未提供 stop.request，命令未执行。', action),
            action,
            data: { reason: 'stop_unavailable' },
          });
        }
        return invoke({
          parsed,
          context,
          actionName,
          call: () =>
            runtime.stop.request({
              taskId: parsed.args.taskId,
              requestedBy: context.userId,
              reason: 'user_stop',
            }),
          format: (result) => stopReply(result, parsed),
        });
      }
      default:
        return build({
          ok: false,
          code: DSBOT_CODES.UNKNOWN_COMMAND,
          reply: `🤔 未识别命令。\n\n${HELP_TEXT}`,
          data: { command: parsed.command },
        });
    }
  }

  function dispatch(parsed, context) {
    switch (parsed.kind) {
      case 'help':
        return build({
          ok: true,
          reply: HELP_TEXT,
          data: { commands: COMMANDS },
        });
      case 'unknown_command': {
        const label = parsed.command === 'text' ? '（非命令文本）' : `/${sanitizeText(parsed.command)}`;
        return build({
          ok: false,
          code: DSBOT_CODES.UNKNOWN_COMMAND,
          reply: `🤔 未识别命令 ${label}。\n\n${HELP_TEXT}`,
          data: { command: parsed.command },
        });
      }
      case 'missing_argument':
        return missingResult(parsed, context);
      case 'invalid_argument':
        return invalidResult(parsed, context);
      case 'leapfrog': {
        const action = makeAction(parsed.command, parsed.command, parsed.args, context, {
          executed: false,
          denied: true,
          reason: 'execution_dispatch_belongs_to_business_bot',
        });
        return build({
          ok: false,
          code: DSBOT_CODES.NOT_ALLOWED,
          reply: withAudit(
            `⛔ 不允许执行 /${parsed.command}：执行派发属于业务 BOT，Chief 适配层只做目标级协调。`,
            action,
          ),
          action,
          data: {
            command: parsed.command,
            reason: 'execution_dispatch_belongs_to_business_bot',
          },
        });
      }
      case 'command':
        return runCommand(parsed, context);
      default:
        return build({
          ok: false,
          code: DSBOT_CODES.UNKNOWN_COMMAND,
          reply: `🤔 未识别命令。\n\n${HELP_TEXT}`,
        });
    }
  }

  /**
   * Handle one chat message. Synchronous by design: every composed call is a
   * synchronous Chief/runtime facade method. Failures are receipts, not throws.
   */
  function handle(input) {
    const request = input && typeof input === 'object' ? input : {};
    try {
      const userId = normalizeUserId(request.userId);
      const channel = normalizeChannel(request.channel);
      const context = { userId, channel, at: clock() };

      if (userId === '') {
        return build({
          ok: false,
          code: DSBOT_CODES.NOT_ALLOWED,
          reply: '⛔ 无法识别用户身份（缺少 userId），命令未执行。',
          data: { reason: 'missing_user' },
        });
      }
      if (!isAllowed(userId, { channel })) {
        return build({
          ok: false,
          code: DSBOT_CODES.NOT_ALLOWED,
          reply: '⛔ 当前用户不在 allowlist 中，命令未执行。',
          data: { userId },
        });
      }

      return dispatch(parseInvocation(request.text), context);
    } catch (error) {
      const message = sanitizeText(error?.message ?? String(error));
      return build({
        ok: false,
        code: DSBOT_CODES.TOOL_ERROR,
        reply: `⚠️ 命令处理失败：${message}`,
        data: { message },
      });
    }
  }

  return Object.freeze({
    handle,
    help: () => HELP_TEXT,
    commands: COMMANDS,
  });
}
