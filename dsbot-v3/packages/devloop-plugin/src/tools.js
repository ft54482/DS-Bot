/**
 * Model-facing tool definitions.
 *
 * Each factory is a pure function of its injected manager and returns exactly
 * `{ name, description, inputSchema, handler }`. No factory reads the ambient
 * clock, the file system or the environment; all effects belong to the
 * manager's injected seams.
 *
 * The JSON Schemas stay inside DSH's supported subset
 * (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 * annotations), so `ctx.tools.register` accepts them without going through
 * `defineTool`'s argument-spec compiler. Range and length rules live in the
 * manager, which returns structured devloop errors.
 */

const SHA_DESCRIPTION = 'Full 40-character hexadecimal commit sha.';

const GOAL_SCHEMA = {
  description: 'Goal title string, or a goal object carrying title/baseSha/milestones.',
  oneOf: [
    {
      type: 'string',
      description: 'Goal title; pass baseSha separately when using a bare title.',
    },
    {
      type: 'object',
      additionalProperties: true,
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Non-empty goal title.' },
        background: { type: 'string' },
        acceptance: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        baseSha: { type: 'string', description: SHA_DESCRIPTION },
        milestones: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                additionalProperties: true,
                required: ['id', 'title'],
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
  ],
};

const LANE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['lane', 'dir'],
  properties: {
    lane: { type: 'string', description: 'Unique lane name.' },
    dir: {
      type: 'string',
      description: 'Repository-relative directory this lane owns.',
    },
    milestone: { type: 'string' },
    cost: { type: 'number', description: 'Estimated CNY/point cost, non-negative.' },
    minCases: { type: 'integer', description: 'Minimum executed test cases, >= 1.' },
    allowedPaths: { type: 'array', items: { type: 'string' } },
    acceptanceCommands: {
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    prd: {
      oneOf: [
        { type: 'string' },
        { type: 'number' },
        { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      ],
    },
    baseSha: { type: 'string', description: SHA_DESCRIPTION },
    baseRef: { type: 'string' },
  },
};

/** JSON Schema for `loop_start` arguments. */
export const LOOP_START_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'lanes', 'budgetCny'],
  properties: {
    goal: GOAL_SCHEMA,
    lanes: {
      type: 'array',
      description: 'Non-empty lanes handed to goal-engine; each lane becomes one task book.',
      items: LANE_SCHEMA,
    },
    budgetCny: {
      type: 'number',
      description: 'Whole-loop budget in CNY; must be positive. Lane cost sum above it is rejected.',
    },
    maxWorkers: {
      type: 'integer',
      description: 'Maximum concurrent work orders, 1..64. Defaults to 4.',
      default: 4,
    },
    baseSha: {
      type: 'string',
      description: 'Optional full base commit when the goal object omits baseSha.',
    },
    prdIndex: {
      description: 'Optional goal-engine PRD index (array, or id -> path object).',
      oneOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'path'],
            properties: {
              id: { type: 'string' },
              path: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: true,
          description: 'Map of PRD id to path or { path, title }.',
        },
      ],
    },
  },
};

/** JSON Schema for `loop_status` arguments. */
export const LOOP_STATUS_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['loopId'],
  properties: {
    loopId: { type: 'string', description: 'Non-empty id returned by loop_start.' },
  },
};

/** JSON Schema for `loop_stop` arguments. */
export const LOOP_STOP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['loopId'],
  properties: {
    loopId: { type: 'string', description: 'Non-empty id returned by loop_start.' },
    reason: {
      type: 'string',
      default: 'manual',
      description: 'Human-readable stop reason recorded irreversibly.',
    },
  },
};

/**
 * Build the `loop_start` definition.
 *
 * @param {{ manager: object }} options
 * @returns {{ name: string, description: string, inputSchema: object, handler: Function }}
 */
export function createLoopStartTool({ manager } = {}) {
  requireManager(manager, 'start');
  return {
    name: 'loop_start',
    description:
      'Start an autonomous development loop: goal-engine decomposes the goal into lane task books, autoloop dispatches them, and the returned loopId is used by loop_status/loop_stop. Rejects a duplicate goal (loop_exists) and an over-budget plan (budget_exceeded).',
    inputSchema: LOOP_START_INPUT_SCHEMA,
    handler: (input) => manager.start(input),
  };
}

/**
 * Build the `loop_status` definition.
 *
 * @param {{ manager: object }} options
 * @returns {{ name: string, description: string, inputSchema: object, handler: Function }}
 */
export function createLoopStatusTool({ manager } = {}) {
  requireManager(manager, 'status');
  return {
    name: 'loop_status',
    description:
      'Read one loop: state, completed iteration (plan round), whether it is still running, and the recorded stop reason after a stop or stop-loss. Unknown loopId fails with not_found.',
    inputSchema: LOOP_STATUS_INPUT_SCHEMA,
    handler: (input) => manager.status(input?.loopId),
  };
}

/**
 * Build the `loop_stop` definition.
 *
 * @param {{ manager: object }} options
 * @returns {{ name: string, description: string, inputSchema: object, handler: Function }}
 */
export function createLoopStopTool({ manager } = {}) {
  requireManager(manager, 'stop');
  return {
    name: 'loop_stop',
    description:
      'Stop one loop and record the reason as an irreversible marker. The loop cannot be resumed; loop_status afterwards reports state "stopped" with stoppedReason. Unknown loopId fails with not_found.',
    inputSchema: LOOP_STOP_INPUT_SCHEMA,
    handler: (input) => manager.stop(input?.loopId, input?.reason ?? 'manual'),
  };
}

/**
 * Build all three definitions in declaration order.
 *
 * @param {{ manager: object }} options
 * @returns {Array<object>}
 */
export function createDevloopTools(options = {}) {
  return [
    createLoopStartTool(options),
    createLoopStatusTool(options),
    createLoopStopTool(options),
  ];
}

/** Tool-name-to-factory table, useful for a host that registers selectively. */
export const TOOL_FACTORIES = Object.freeze({
  loop_start: createLoopStartTool,
  loop_status: createLoopStatusTool,
  loop_stop: createLoopStopTool,
});

function requireManager(manager, method) {
  if (!manager || typeof manager[method] !== 'function') {
    throw new TypeError(`devloop tool factory requires a manager with ${method}()`);
  }
}
