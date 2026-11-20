/**
 * DSH bundle entry for the dev loop.
 *
 * `package.json` declares `dsh.bundle.patch = ./cordis.patch.yml`; the patch
 * inserts this module as the `devloop-plugin` row. The module is a normal
 * Cordis plugin: it injects the `tools` service and registers the three
 * model-facing definitions.
 *
 * The exported factories are plain functions (no ambient IO) so hosts and
 * tests can compose them without loading a DSH runtime.
 */

import { createDevloopManager } from './manager.js';
import {
  createDevloopTools,
  createLoopStartTool,
  createLoopStatusTool,
  createLoopStopTool,
} from './tools.js';

/** Cordis plugin name. */
export const name = 'devloop-plugin';

/** Services required before `apply` runs. */
export const inject = ['tools'];

/** Success values are returned as compact JSON text blocks. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

/**
 * Adapt one pure definition to the shape `ctx.tools.register` accepts.
 *
 * The definition's JSON Schema is already in the registry-ready `parameters`
 * form, so this bypasses `defineTool`'s argument-spec compiler and keeps the
 * bundle dependency-free.
 *
 * @param {{ name: string, description: string, inputSchema: object,
 *   handler: Function }} definition
 * @returns {object}
 */
export function toCordisTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => definition.handler(args, { exec }),
    presentCall: (args) => ({
      card: 'generic',
      title: definition.name,
      kind: 'other',
      rawInput: args,
    }),
  };
}

/**
 * Cordis entry point: create one manager and register the three tools.
 *
 * @param {{ tools: { register: Function } }} ctx
 * @param {object} [config] manager options (or `{ manager }` / `{ deps }`)
 * @returns {object} the manager, for host code that wants `advance()`/`get()`
 */
export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.tools?.register !== 'function') {
    throw new Error('devloop-plugin requires a ctx.tools.register() service');
  }
  const manager = config.manager ?? createDevloopManager(config.deps ?? config);
  for (const definition of createDevloopTools({ manager })) {
    ctx.tools.register(toCordisTool(definition));
  }
  return manager;
}

export {
  createDevloopManager,
  DEFAULT_BASE_SHA,
  DEFAULT_MAX_WORKERS,
} from './manager.js';
export {
  createDevloopTools,
  createLoopStartTool,
  createLoopStatusTool,
  createLoopStopTool,
};
export {
  LOOP_START_INPUT_SCHEMA,
  LOOP_STATUS_INPUT_SCHEMA,
  LOOP_STOP_INPUT_SCHEMA,
  TOOL_FACTORIES,
} from './tools.js';
export { DevloopError, devloopError, ERROR_CODES } from './errors.js';
