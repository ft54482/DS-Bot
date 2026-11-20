/**
 * Public vocabulary for the DS Bot command adapter (L49).
 *
 * The adapter is deliberately thin: it parses chat commands, maps each one to
 * one Chief/runtime tool call, and formats an auditable receipt. The action
 * names below are the real composition points, so a log line and a test can
 * tell which layer was asked to do the work.
 */

export const DSBOT_CODES = Object.freeze({
  /** A required command argument was not supplied. */
  MISSING_ARGUMENT: 'missing_argument',
  /** The caller is outside the allowlist, or the command crosses a level. */
  NOT_ALLOWED: 'not_allowed',
  /** The slash command is not part of this adapter's command surface. */
  UNKNOWN_COMMAND: 'unknown_command',
  /** An argument was present but malformed (for example a negative budget). */
  INVALID_ARGUMENT: 'invalid_argument',
  /** `/stop` was used without a runtime that exposes `stop.request`. */
  RUNTIME_UNAVAILABLE: 'runtime_unavailable',
  /** Unexpected failure from an injected dependency. */
  TOOL_ERROR: 'tool_error',
});

/**
 * Commands that would dispatch execution work. The Chief owns goal
 * coordination only (PRD §3, §5); execution dispatch belongs to a business
 * BOT, so the adapter rejects these by name instead of treating them as a
 * typo.
 */
export const LEAPFROG_COMMANDS = Object.freeze([
  'exec',
  'dispatch',
  'run',
  'shell',
  'plan',
  'rework',
]);

/**
 * Public command surface. `action` is the injected tool the command maps to,
 * which is what the receipt audits.
 */
export const COMMANDS = Object.freeze([
  Object.freeze({
    command: '/goal new',
    action: 'openGoal',
    usage: '/goal new <标题> [--budget 30]',
  }),
  Object.freeze({
    command: '/goal status',
    action: 'status',
    usage: '/goal status <id>',
  }),
  Object.freeze({
    command: '/delegate',
    action: 'delegate',
    usage: '/delegate <goalId> <bot> <简要>',
  }),
  Object.freeze({
    command: '/deliver',
    action: 'deliver',
    usage: '/deliver <goalId>',
  }),
  Object.freeze({
    command: '/stop',
    action: 'stop.request',
    usage: '/stop <id>',
  }),
  Object.freeze({
    command: '/help',
    action: null,
    usage: '/help',
  }),
]);

export const HELP_TEXT = [
  'DS Bot 命令：',
  '/goal new <标题> [--budget 30]   新建目标（预算可选）',
  '/goal status <id>               查看目标状态',
  '/delegate <goalId> <bot> <简要>  派给专业 BOT',
  '/deliver <goalId>               生成交付包（需全部业务验收通过）',
  '/stop <id>                      请求停止任务',
  '/help                           显示本帮助',
  '',
  '执行派发类命令（/exec、/dispatch、/run、/shell、/plan、/rework）不属于 Chief，会被拒绝。',
  '所有已识别命令都会在回执中给出 action 名与参数摘要（密钥类值会被脱敏）。',
].join('\n');

export const USAGE = Object.freeze({
  goal: '/goal new <标题> [--budget 30] | /goal status <id>',
  'goal.new': '/goal new <标题> [--budget 30]',
  'goal.status': '/goal status <id>',
  delegate: '/delegate <goalId> <bot> <简要>',
  deliver: '/deliver <goalId>',
  stop: '/stop <id>',
  input: '请发送 /help 查看可用命令',
});
