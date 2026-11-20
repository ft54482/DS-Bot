/**
 * Assertion helpers for the PRD conformance suite.
 *
 * Every check carries the PRD section it enforces so a failure points at the
 * rule instead of only at a line number. The formatted block is intentionally
 * stable: `[PRD <section>] <rule>`, then `expected` and `actual`.
 *
 * This module is test glue only. It contains no task/run/acceptance logic; the
 * behaviour under test always comes from `packages/runtime` or `packages/api`.
 */

import { isDeepStrictEqual } from 'node:util';

function render(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function failure(section, rule, expected, actual) {
  return new Error(
    `[PRD ${section}] ${rule}\n  expected: ${render(expected)}\n  actual:   ${render(actual)}`,
  );
}

export function expectEqual(section, rule, actual, expected) {
  if (!Object.is(actual, expected)) throw failure(section, rule, expected, actual);
}

export function expectNotEqual(section, rule, actual, forbidden) {
  if (Object.is(actual, forbidden)) throw failure(section, rule, `anything but ${render(forbidden)}`, actual);
}

export function expectTrue(section, rule, actual) {
  if (actual !== true) throw failure(section, rule, true, actual);
}

export function expectFalse(section, rule, actual) {
  if (actual !== false) throw failure(section, rule, false, actual);
}

export function expectDeepEqual(section, rule, actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw failure(section, rule, expected, actual);
}

export function expectOneOf(section, rule, actual, allowed) {
  if (!allowed.includes(actual)) {
    throw failure(section, rule, `one of ${JSON.stringify(allowed)}`, actual);
  }
}

/**
 * Assert that `fn` throws a service error with `code`. The first error is
 * returned so the caller can inspect `details.guard`/`status` as well.
 */
export function expectCode(section, rule, fn, code) {
  let returned;
  try {
    returned = fn();
  } catch (error) {
    if (error?.code !== code) {
      throw failure(section, rule, `rejection with code ${JSON.stringify(code)}`, {
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      });
    }
    return error;
  }
  throw failure(section, rule, `rejection with code ${JSON.stringify(code)}`, {
    returned,
    message: 'operation succeeded',
  });
}

/** Assert the HTTP status of a fetch response and return its parsed body. */
export async function expectStatus(section, rule, response, status) {
  const body = await response.json();
  if (response.status !== status) {
    throw failure(section, rule, `HTTP ${status}`, {
      status: response.status,
      body,
    });
  }
  return body;
}
