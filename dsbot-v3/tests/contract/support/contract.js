/**
 * Assertion and failure-formatting helpers for the cross-package contracts.
 *
 * Every failure is prefixed with the contract id and prints `expected` next to
 * `actual`, so the first line of a red test already says which cross-package
 * promise broke and how the real composition disagreed with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

const show = (value) =>
  inspect(value, { depth: 8, breakLength: 120, compact: true, sorted: true });

function contractError(id, label, detail) {
  return new Error(`[${id}] ${label}\n${detail}`);
}

export function expectEqual(id, label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
  } catch {
    throw contractError(
      id,
      label,
      `  expected: ${show(expected)}\n  actual:   ${show(actual)}`,
    );
  }
}

export function expectDeepEqual(id, label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw contractError(
      id,
      label,
      `  expected: ${show(expected)}\n  actual:   ${show(actual)}`,
    );
  }
}

export function expectTrue(id, label, condition, { expected = true, actual } = {}) {
  if (condition !== true) {
    throw contractError(
      id,
      label,
      `  expected: ${show(expected)}\n  actual:   ${show(actual ?? condition)}`,
    );
  }
}

/** Assert that `fn` (sync or async) rejects with the expected code/status. */
export async function expectRejects(id, label, fn, { code, status } = {}) {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) {
    throw contractError(
      id,
      label,
      `  expected: rejection${code ? ` code=${code}` : ''}${status ? ` status=${status}` : ''}\n  actual:   resolved successfully`,
    );
  }
  if (code !== undefined) expectEqual(id, `${label} (code)`, error.code, code);
  if (status !== undefined) expectEqual(id, `${label} (status)`, error.status, status);
  return error;
}

/**
 * Register one contract test. The id and title are part of the test name, and
 * the diagnostic line makes the contract visible even when the test passes.
 */
export function contractTest(id, title, body) {
  test(`${id} ${title}`, async (t) => {
    t.diagnostic(`${id} ${title}`);
    try {
      await body(t);
      t.diagnostic(`${id} PASS`);
    } catch (error) {
      const message = error?.message ?? String(error);
      const wrapped = new Error(`${id} FAILED: ${title}\n${message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  });
}

/** Loopback HTTP helper: performs the request and returns status + parsed JSON. */
export async function requestJson(url, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, body: json, text };
}
