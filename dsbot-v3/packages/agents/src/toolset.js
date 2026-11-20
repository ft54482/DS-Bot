/**
 * Build one frozen tool set.
 *
 * Only the role's own tools are enumerable. Every other known tool name is
 * installed as a non-enumerable denial so a caller that reaches for
 * `chief.dispatch(...)` receives a structured `not_allowed` instead of a
 * TypeError (and still cannot reach the runtime). `invoke(name, input)` is the
 * uniform entry point for a model-driven tool loop.
 */

import { ALL_AGENT_TOOLS } from './constants.js';
import { notAllowed, validationError } from './result.js';

export function buildToolset({ role, allowed, implementations }) {
  const allowedSet = new Set(allowed);
  const tools = {};

  for (const name of allowed) {
    const implementation = implementations[name];
    if (typeof implementation !== 'function') {
      throw new TypeError(`${role} tool ${name} has no implementation`);
    }
    tools[name] = implementation;
  }

  for (const name of ALL_AGENT_TOOLS) {
    if (allowedSet.has(name)) continue;
    Object.defineProperty(tools, name, {
      value: () => notAllowed(role, name),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  Object.defineProperty(tools, 'role', {
    value: role,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  Object.defineProperty(tools, 'toolNames', {
    value: Object.freeze([...allowed]),
    enumerable: false,
    configurable: false,
    writable: false,
  });

  Object.defineProperty(tools, 'invoke', {
    value: (name, input) => {
      if (typeof name !== 'string' || name === '') {
        return validationError('tool name must be a non-empty string', { name });
      }
      if (allowedSet.has(name)) return tools[name](input);
      return notAllowed(role, name, `unknown or unauthorized ${role} tool: ${name}`);
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return Object.freeze(tools);
}
