#!/usr/bin/env node
// Executable goal Definition-of-Done checks.
//
// One command runs ten checks. Every check executes a real `node --test`
// subprocess and derives its verdict from that subprocess's exit code and
// summary output; no assertion is copied from the suites under test.
//
// Usage:
//   node tests/dod/run.mjs [--out <path>] [--timeout <ms>]
//
// Exit code: 0 when every check passes, 1 otherwise.
// The JSON report defaults to <os.tmpdir()>/dod-report.json, never the repo.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NODE_TEST_FLAGS = ['--test', '--test-reporter=spec'];

// The ten DoD items, in the order the goal lists them. `paths` are repository
// relative test directories; `exactTests` / `stepPattern` add integrity checks
// on top of a zero exit code (a suite that silently runs zero or fewer cases
// is not a pass).
const CHECKS = [
  {
    id: 'full-regression',
    name: '全量回归（全部包与测试套件）',
    paths: () => discoverTestDirs(),
  },
  {
    id: 'e2e-10-steps',
    name: 'e2e 10 步最小闭环',
    paths: () => ['tests/e2e'],
    exactTests: 10,
    stepPattern: 10,
  },
  {
    id: 'contract',
    name: '跨包契约',
    paths: () => ['tests/contract'],
  },
  {
    id: 'conformance',
    name: 'PRD 硬规则一致性',
    paths: () => ['tests/conformance'],
  },
  {
    id: 'metrics',
    name: '北极星指标',
    paths: () => ['packages/metrics/test'],
  },
  {
    id: 'scheduler',
    name: '调度器',
    paths: () => ['packages/scheduler/test'],
  },
  {
    id: 'recovery',
    name: '重启恢复',
    paths: () => ['packages/recovery/test'],
  },
  {
    id: 'authz',
    name: '授权门禁',
    paths: () => ['packages/authz/test'],
  },
  {
    id: 'events',
    name: '事件可靠投递',
    paths: () => ['packages/events/test'],
  },
  {
    id: 'selfmedia',
    name: '自媒体闭环',
    paths: () => ['packages/pipelines/selfmedia/test'],
  },
];

// ---------------------------------------------------------------------------
// Test-directory discovery: full regression follows the tree instead of a
// hand-maintained list, so a newly added package suite is picked up. tests/dod
// is excluded so the checker never invokes itself.
// ---------------------------------------------------------------------------
function discoverTestDirs() {
  const found = [];

  const packagesRoot = join(REPO_ROOT, 'packages');
  if (existsSync(packagesRoot)) {
    walk(packagesRoot, (dir, name) => {
      if (name === 'test' && looksLikeTestDir(dir)) found.push(toRepoPath(dir));
    });
  }

  const testsRoot = join(REPO_ROOT, 'tests');
  if (existsSync(testsRoot)) {
    for (const entry of readdirSync(testsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'dod') continue;
      const dir = join(testsRoot, entry.name);
      // Only directory-style node:test suites: an index.js entry point or at
      // least one *.test.js file. A plain helper/runner directory (for example
      // a future tests/<tooling>) is not a regression suite.
      if (!looksLikeTestDir(dir)) continue;
      found.push(toRepoPath(dir));
    }
  }

  return [...new Set(found)].sort();
}

function looksLikeTestDir(dir) {
  if (existsSync(join(dir, 'index.js'))) return true;
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) => entry.isFile() && /\.test\.(?:mjs|cjs|js)$/u.test(entry.name),
  );
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    visit(full, entry.name);
    walk(full, visit);
  }
}

function toRepoPath(absPath) {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    out: join(tmpdir(), 'dod-report.json'),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usageError('--out requires a path');
      options.out = value;
      index += 1;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) usageError('--out requires a path');
      options.out = value;
    } else if (arg === '--timeout') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usageError('--timeout requires milliseconds');
      options.timeoutMs = parseTimeout(value);
      index += 1;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parseTimeout(arg.slice('--timeout='.length));
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }

  options.out = resolve(process.cwd(), options.out);
  return options;
}

function parseTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    usageError(`--timeout must be a positive number of milliseconds, got "${value}"`);
  }
  return Math.floor(parsed);
}

function usageError(message) {
  console.error(`error: ${message}`);
  console.error('usage: node tests/dod/run.mjs [--out <path>] [--timeout <ms>]');
  process.exit(1);
}

function printHelp() {
  console.log(`Executable goal DoD checks (10 items)

Usage:
  node tests/dod/run.mjs [--out <path>] [--timeout <ms>]

Options:
  --out <path>      Report path (default: <os.tmpdir()>/dod-report.json)
  --timeout <ms>    Per-check timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help        Show this help

Exit codes:
  0  every check passed
  1  at least one check failed, timed out, or could not run`);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function runCheck(check, options) {
  const paths = check.paths();
  const cmd = formatCommand(paths);
  const startedAt = Date.now();

  const result = spawnSync(process.execPath, [...NODE_TEST_FLAGS, ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
  });

  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exit = timedOut
    ? 124
    : result.status ?? (result.error ? 125 : 1);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;

  const summary = parseSummary(combined);
  const integrity = integrityProblem(check, exit, summary, combined);
  const pass = exit === 0 && integrity === null;

  let evidence;
  if (timedOut) {
    evidence = `timeout after ${options.timeoutMs}ms; ${summaryLine(summary)}`;
  } else if (result.error) {
    evidence = `spawn error (${result.error.code ?? 'unknown'}): ${result.error.message}; ${summaryLine(summary)}`;
  } else if (integrity !== null) {
    evidence = `${summaryLine(summary)}; ${integrity}`;
  } else if (!pass) {
    evidence = `${summaryLine(summary)}; ${firstFailure(combined) ?? 'no failure line captured'}`;
  } else {
    evidence = summaryLine(summary);
  }

  return {
    item: {
      id: check.id,
      name: check.name,
      cmd,
      exit,
      pass,
      evidence: truncate(evidence, 2000),
    },
    durationMs,
    output: pass ? null : rawExcerpt(combined),
  };
}

function formatCommand(paths) {
  return ['node', ...NODE_TEST_FLAGS, ...paths.map(quoteArg)].join(' ');
}

function quoteArg(value) {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function parseSummary(text) {
  const summary = {};
  const pattern = /^\s*[^\S\r\n]*ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/gmu;
  for (const match of text.matchAll(pattern)) {
    summary[match[1]] = match[2];
  }
  return summary;
}

function summaryLine(summary) {
  const keys = ['tests', 'pass', 'fail', 'skipped', 'duration_ms'];
  const present = keys.filter((key) => summary[key] !== undefined);
  if (present.length === 0) return 'no test summary in output';
  return present.map((key) => `${key}=${summary[key]}`).join(' ');
}

function integrityProblem(check, exit, summary, text) {
  if (exit !== 0) return null;

  const tests = Number(summary.tests ?? 0);
  const pass = Number(summary.pass ?? 0);
  const fail = Number(summary.fail ?? 0);
  const skipped = Number(summary.skipped ?? 0);

  if (!Number.isFinite(tests) || tests <= 0) {
    return 'no tests were executed';
  }
  if (fail > 0) {
    return `reported ${fail} failing test(s)`;
  }
  if (skipped > 0) {
    return `reported ${skipped} skipped test(s)`;
  }
  if (check.exactTests !== undefined && tests !== check.exactTests) {
    return `expected ${check.exactTests} tests, got ${tests}`;
  }
  if (check.exactTests !== undefined && pass !== check.exactTests) {
    return `expected ${check.exactTests} passing tests, got ${pass}`;
  }
  if (check.stepPattern !== undefined) {
    const steps = new Set(
      [...text.matchAll(/^\s*[✔✖﹣▶]\s+step(\d{2})\b/gmu)].map((match) => match[1]),
    );
    if (steps.size !== check.stepPattern) {
      return `expected ${check.stepPattern} stepNN cases, found ${steps.size}`;
    }
  }
  return null;
}

function firstFailure(text) {
  const lines = stripAnsi(text).replaceAll('\r\n', '\n').split('\n');
  return lines.find((line) => /^\s*(?:✖|not ok\b|Error:|AssertionError)/u.test(line))?.trim();
}

function rawExcerpt(text) {
  const lines = stripAnsi(text).replaceAll('\r\n', '\n').split('\n');
  const failureIndex = lines.findIndex((line) =>
    /^\s*(?:✖|not ok\b|Error:|AssertionError)/u.test(line),
  );
  const start = failureIndex >= 0 ? Math.max(0, failureIndex - 3) : Math.max(0, lines.length - 40);
  const excerpt = lines.slice(start, start + 40).join('\n').trimEnd();
  return truncate(excerpt, 8000);
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}\n... (truncated)`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (CHECKS.length !== 10) {
    console.error(`error: expected 10 DoD checks, found ${CHECKS.length}`);
    process.exit(1);
  }
  const ids = new Set(CHECKS.map((check) => check.id));
  if (ids.size !== CHECKS.length) {
    console.error('error: duplicate DoD check id');
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const items = [];

  console.log(`DoD checks: ${CHECKS.length} items`);
  console.log(`repo: ${REPO_ROOT}`);
  console.log(`node: ${process.version}`);
  console.log(`timeout: ${options.timeoutMs}ms per check`);
  console.log('');

  CHECKS.forEach((check, index) => {
    const { item, durationMs, output } = runCheck(check, options);
    items.push(item);

    const status = item.pass ? 'PASS' : 'FAIL';
    console.log(`[${index + 1}/${CHECKS.length}] ${item.id} — ${item.name}`);
    console.log(`  cmd: ${item.cmd}`);
    console.log(`  exit: ${item.exit}  (${durationMs}ms)`);
    console.log(`  evidence: ${item.evidence}`);
    console.log(`  ${status}`);
    if (output) {
      console.log('  raw output (excerpt):');
      for (const line of output.split('\n')) console.log(`    ${line}`);
    }
    console.log('');
  });

  const failed = items.filter((item) => !item.pass);
  const report = {
    schema: 'dod-report/v1',
    generatedAt: startedAt.toISOString(),
    node: process.version,
    platform: process.platform,
    root: REPO_ROOT,
    summary: {
      total: items.length,
      passed: items.length - failed.length,
      failed: failed.length,
    },
    items,
  };

  try {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`error: cannot write report to ${options.out}: ${error.message}`);
    process.exit(1);
  }

  console.log(`Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`);
  console.log(`Report: ${options.out}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
