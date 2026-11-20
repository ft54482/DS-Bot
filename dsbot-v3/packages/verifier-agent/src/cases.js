/**
 * Count executed test cases from a rerun's stdout/stderr.
 *
 * The verifier counts what the lane actually printed; it never accepts a case
 * count supplied by the PR author. The parser understands Node's TAP summary
 * (`# tests`, falling back to `# pass` + `# fail`), top-level TAP result lines
 * and the TAP plan. Anything else counts as zero, which the case floor then
 * fails instead of silently passing.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const TOP_LEVEL_RESULT = /^(?:not ok|ok)\s+\d+\b/;

function lastNumber(text, pattern) {
  let value = null;
  for (const match of text.matchAll(pattern)) {
    value = Number(match[1]);
  }
  return value;
}

export function countCases(output) {
  if (typeof output !== 'string' || output.length === 0) return 0;

  const text = output.replace(ANSI, '');

  // A Node TAP run ends with a single summary block; subtests do not emit it.
  const total = lastNumber(text, /^#\s*tests\s+(\d+)\s*$/gm);
  if (total !== null) return total;

  const passed = lastNumber(text, /^#\s*pass\s+(\d+)\s*$/gm);
  const failed = lastNumber(text, /^#\s*fail\s+(\d+)\s*$/gm);
  if (passed !== null || failed !== null) return (passed ?? 0) + (failed ?? 0);

  // Node's spec reporter (a TTY) ends every run with "ℹ tests N".
  const specTotal = lastNumber(text, /^\u2139\uFE0F?\s+tests\s+(\d+)\s*$/gm);
  if (specTotal !== null) return specTotal;

  // Count real top-level TAP results, not indented subtest lines, so a
  // truncated run cannot borrow a plan's optimistic count.
  let cases = 0;
  for (const line of text.split(/\r?\n/)) {
    if (TOP_LEVEL_RESULT.test(line)) cases += 1;
  }
  if (cases > 0) return cases;

  const plan = lastNumber(text, /^1\.\.(\d+)\s*$/gm);
  return plan ?? 0;
}
