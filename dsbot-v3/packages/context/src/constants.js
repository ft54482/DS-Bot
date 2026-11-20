/**
 * Fixed context-assembly vocabulary.
 *
 * The hard caps come straight from `docs/prd/00-PRD.md` G9 (goal <= 60k
 * tokens, business <= 80k tokens). The execution layer has no PRD-wide cap, so
 * its budget must be supplied by the caller through `budgets.execution`.
 */

export const LEVELS = Object.freeze(['goal', 'business', 'execution']);

/** Absolute upper bounds; a caller may configure a smaller budget, never a larger one. */
export const HARD_CAPS = Object.freeze({
  goal: 60_000,
  business: 80_000,
});

/** Defaults for the layers the PRD fixes. Execution has no default on purpose. */
export const DEFAULT_BUDGETS = Object.freeze({
  goal: HARD_CAPS.goal,
  business: HARD_CAPS.business,
});

/**
 * Over-budget trim order required by the ticket and `04-reliability-ops.md`
 * §1.7: recent dialogue first, then open questions, then the task pack.
 * The task pack's core fields are never removed.
 */
export const CONTEXT_TRIM_ORDER = Object.freeze([
  'recent',
  'open_questions',
  'task_pack',
]);

/**
 * Task-pack fields dropped, in this order, only after recent dialogue and open
 * questions are empty. Every listed field is optional: the task id, level,
 * goal, scope, acceptance criteria, delivery contract, baseline SHA, stop
 * conditions, idempotency key and conclusions always survive.
 */
export const TASK_PACK_TRIM_ORDER = Object.freeze([
  'latest_run',
  'latest_acceptance',
  'latest_report',
  'title',
  'state',
  'owner',
  'budget',
  'due_at',
]);

/**
 * What each layer may see in its own prompt. These are the visibility rules
 * from `04-reliability-ops.md` §1.7, kept as stable labels so an assembler or
 * test can assert isolation without copying prose into the prompt.
 */
export const LEVEL_CONFIG = Object.freeze({
  goal: Object.freeze({
    role: 'chief',
    principal: 'chief',
    visible: Object.freeze([
      'goal_task',
      'business_reports',
      'pending_decisions',
      'recent_dialogue',
    ]),
    hidden: Object.freeze([
      'execution_logs',
      'tool_calls',
      'per_run_events',
    ]),
  }),
  business: Object.freeze({
    role: 'business_bot',
    principal: 'bot',
    visible: Object.freeze([
      'own_task_pack',
      'business_conclusions',
      'open_questions',
    ]),
    hidden: Object.freeze([
      'other_bot_tasks',
      'chief_dialogue',
      'execution_logs',
    ]),
  }),
  execution: Object.freeze({
    role: 'executor',
    principal: 'executor',
    visible: Object.freeze([
      'task_pack',
      'baseline_sha',
      'write_scope',
      'acceptance_criteria',
      'delivery_format',
      'checkpoint',
    ]),
    hidden: Object.freeze([
      'history_chat',
      'other_task_context',
      'bot_notes',
    ]),
  }),
});

/** Question/escalation states that are no longer open. */
export const CLOSED_QUESTION_STATES = Object.freeze([
  'answered',
  'resolved',
  'closed',
  'cancelled',
  'canceled',
  'done',
]);
