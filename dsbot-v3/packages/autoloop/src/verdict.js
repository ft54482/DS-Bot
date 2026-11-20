/**
 * Verifier result parsing.
 *
 * The loop only accepts a subagent verdict that is JSON with a `verdict`
 * property: `{"verdict":"PASS"}` or `{"verdict":"FAIL","feedback":"..."}`.
 * Everything else fails closed as `FAIL` with `reason=invalid_verifier_output`:
 * a malformed or missing verdict must never be treated as a merge approval.
 *
 * Accepted shapes:
 *
 *   '{"verdict":"PASS"}'                    raw JSON string
 *   { verdict: 'PASS' }                     parsed object
 *   { output: '{"verdict":"FAIL"}' }        adapter envelope
 *   { result: { verdict: 'PASS' } }         adapter envelope
 *   '```json\n{"verdict":"PASS"}\n```'      fenced JSON (subagent habit)
 */

const PASS = 'PASS';
const FAIL = 'FAIL';

/**
 * @param {unknown} raw verifier return value
 * @returns {{
 *   verdict: 'PASS' | 'FAIL',
 *   ok: boolean,
 *   reason: string | null,
 *   feedback: string,
 * }}
 */
export function parseVerdict(raw) {
  let value = raw;

  if (typeof value === 'string') {
    const parsed = parseJsonText(value);
    if (parsed.error) return invalid(parsed.error);
    value = parsed.value;
  }

  if (!isPlainObject(value)) return invalid('verifier output must be a JSON object');

  if (value.verdict === undefined) {
    // Adapter envelopes are a common shape: { output: '<json>' } or
    // { result: { verdict } }. Unwrap one level, then parse normally.
    const envelope = value.output ?? value.raw ?? value.text ?? value.result;
    if (typeof envelope === 'string') {
      const parsed = parseJsonText(envelope);
      if (parsed.error) return invalid(parsed.error);
      if (!isPlainObject(parsed.value)) {
        return invalid('verifier output must be a JSON object');
      }
      return verdictOf(parsed.value);
    }
    if (isPlainObject(envelope)) return verdictOf(envelope);
    return invalid('verifier JSON has no verdict property');
  }

  return verdictOf(value);
}

function verdictOf(value) {
  const verdict = normalizeVerdict(value.verdict);
  if (verdict === null) {
    return invalid('verifier verdict must be PASS or FAIL');
  }

  const feedback = firstString(
    value.feedback,
    value.reason,
    value.message,
    value.notes,
  );

  return {
    verdict,
    ok: true,
    reason: firstString(value.reason),
    feedback: feedback ?? '',
  };
}

function invalid(message) {
  return {
    verdict: FAIL,
    ok: false,
    reason: 'invalid_verifier_output',
    feedback: message,
  };
}

function parseJsonText(text) {
  const trimmed = text.trim();
  if (trimmed === '') return { error: 'verifier output is empty' };

  // Tolerate a fenced block but never search for JSON inside arbitrary prose:
  // a verdict that cannot be parsed exactly is a failed verification.
  const unfenced = stripFence(trimmed);
  try {
    return { value: JSON.parse(unfenced) };
  } catch (error) {
    return { error: `verifier output is not JSON: ${error.message}` };
  }
}

function stripFence(text) {
  if (!text.startsWith('```')) return text;
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return text;
  const body = text.slice(firstBreak + 1);
  const closing = body.lastIndexOf('```');
  return closing === -1 ? body : body.slice(0, closing).trim();
}

function normalizeVerdict(value) {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === PASS) return PASS;
  if (upper === FAIL) return FAIL;
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
