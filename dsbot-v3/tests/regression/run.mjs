#!/usr/bin/env node
// One-command regression for DS Bot V3.
//
// Runs every package test directory, the e2e / contract / conformance suites
// and the DDL verifier, then writes a machine-readable report.json to a fresh
// temporary directory.
//
// Usage:
//   node tests/regression/run.mjs
//   node tests/regression/run.mjs --report-dir <dir>
//   node tests/regression/run.mjs --report <file.json>
//
// Exit code:
//   0  every executed suite passed (slow suites do not change this)
//   1  at least one suite failed, crashed, or a required suite is missing.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const REPORT_SUITE = 'dsbot-v3-regression';
const NODE_TEST_SCRIPT = ['--test', '--test-reporter=tap'];
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_SLOW_MS = 30_000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'test',
  'src',
  'dist',
  'build',
  'coverage',
  '.cache',
]);

function usage() {
  return `DS Bot V3 one-command regression

Usage:
  node tests/regression/run.mjs [options]

Options:
  --report-dir <dir>   directory for report.json and logs
                       (default: <os tmpdir>/dsbot-v3-regression/<run id>)
  --report <file>      exact path of report.json; overrides --report-dir
  --timeout-ms <n>     hard timeout per suite (default ${DEFAULT_TIMEOUT_MS})
  --slow-ms <n>        mark a suite slow above this duration (default ${DEFAULT_SLOW_MS})
  --budget-ms <n>      overall runtime target used for the slow flag
                       (default ${DEFAULT_BUDGET_MS})
  --verbose            print every suite's full captured output
  --help, -h           show this help

Environment:
  REGRESSION_REPORT_DIR  same as --report-dir when the flag is absent

The runner discovers package suites from package.json + test/ under packages/
(including nested package roots such as packages/pipelines/content), then runs
tests/e2e, tests/contract, tests/conformance and tools/verify/verify.mjs.
Suites run sequentially so timings and failure attribution stay deterministic.
`;
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${flag} expects a value`);
  }
  return value;
}

function parseInteger(value, flag) {
  if (!/^\d+$/.test(String(value ?? ''))) {
    throw new Error(`${flag} expects a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const opts = {
    reportDir: process.env.REGRESSION_REPORT_DIR || null,
    reportPath: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    slowMs: DEFAULT_SLOW_MS,
    budgetMs: DEFAULT_BUDGET_MS,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--report-dir') {
      opts.reportDir = takeValue(argv, ++index, '--report-dir');
    } else if (arg.startsWith('--report-dir=')) {
      opts.reportDir = arg.slice('--report-dir='.length);
    } else if (arg === '--report') {
      opts.reportPath = takeValue(argv, ++index, '--report');
    } else if (arg.startsWith('--report=')) {
      opts.reportPath = arg.slice('--report='.length);
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = parseInteger(argv[++index], '--timeout-ms');
    } else if (arg.startsWith('--timeout-ms=')) {
      opts.timeoutMs = parseInteger(arg.slice('--timeout-ms='.length), '--timeout-ms');
    } else if (arg === '--slow-ms') {
      opts.slowMs = parseInteger(argv[++index], '--slow-ms');
    } else if (arg.startsWith('--slow-ms=')) {
      opts.slowMs = parseInteger(arg.slice('--slow-ms='.length), '--slow-ms');
    } else if (arg === '--budget-ms') {
      opts.budgetMs = parseInteger(argv[++index], '--budget-ms');
    } else if (arg.startsWith('--budget-ms=')) {
      opts.budgetMs = parseInteger(arg.slice('--budget-ms='.length), '--budget-ms');
    } else {
      throw new Error(`unknown option ${JSON.stringify(arg)} (use --help)`);
    }
  }

  if (!opts.help) {
    for (const [flag, value] of [
      ['--timeout-ms', opts.timeoutMs],
      ['--slow-ms', opts.slowMs],
      ['--budget-ms', opts.budgetMs],
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${flag} must be a non-negative number`);
      }
    }
  }

  return opts;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function lastMatch(text, pattern) {
  let found = null;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

function numberFromLastMatch(text, pattern) {
  const match = lastMatch(text, pattern);
  return match ? Number(match[1]) : null;
}

/**
 * Parse the TAP summary emitted by `node --test --test-reporter=tap`.
 * The last summary block wins; node itself prints one at the end.
 */
export function parseTapSummary(text) {
  const pass = numberFromLastMatch(text, /^\s*# pass (\d+)\s*$/gm);
  const fail = numberFromLastMatch(text, /^\s*# fail (\d+)\s*$/gm);
  const tests = numberFromLastMatch(text, /^\s*# tests (\d+)\s*$/gm);
  const skipped = numberFromLastMatch(text, /^\s*# skipped (\d+)\s*$/gm);
  const cancelled = numberFromLastMatch(text, /^\s*# cancelled (\d+)\s*$/gm);
  const durationMs = numberFromLastMatch(text, /^\s*# duration_ms ([\d.]+)\s*$/gm);
  const failedTests = [];
  for (const match of text.matchAll(/^\s*not ok \d+ - (.*)$/gm)) {
    failedTests.push(match[1].trim());
  }
  return {
    found: pass !== null && fail !== null,
    pass,
    fail,
    tests,
    skipped,
    cancelled,
    durationMs,
    failedTests,
  };
}

/**
 * Parse the flat `Summary: N passed, M failed` output of tools/verify.
 */
export function parseVerifySummary(text) {
  const match = lastMatch(text, /Summary:\s*(\d+)\s+passed,\s*(\d+)\s+failed/g);
  if (!match) return { found: false, pass: null, fail: null, failedTests: [] };
  const failedTests = [];
  for (const line of text.matchAll(/^\s*\[FAIL\]\s+(.*)$/gm)) {
    failedTests.push(line[1].trim());
  }
  return {
    found: true,
    pass: Number(match[1]),
    fail: Number(match[2]),
    failedTests,
  };
}

function readPackageRoots(packagesRoot) {
  if (!existsSync(packagesRoot) || !statSync(packagesRoot).isDirectory()) return [];

  const roots = [];
  const walk = (directory) => {
    if (existsSync(join(directory, 'package.json'))) {
      roots.push(directory);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(join(directory, entry.name));
    }
  };

  walk(packagesRoot);
  return roots.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

/**
 * Build the fixed, ordered suite list. Missing required paths are kept as
 * synthetic failing suites so a rename can never silently shrink coverage.
 */
export function discoverSuites(root) {
  const suites = [];

  for (const packageRoot of readPackageRoots(join(root, 'packages'))) {
    const testDir = join(packageRoot, 'test');
    if (!existsSync(testDir) || !statSync(testDir).isDirectory()) continue;
    const name = toPosix(relative(root, packageRoot));
    suites.push({
      name,
      kind: 'package',
      path: toPosix(relative(root, testDir)),
      cwd: packageRoot,
      command: `node ${NODE_TEST_SCRIPT.join(' ')} test`,
      args: [...NODE_TEST_SCRIPT, 'test'],
    });
  }

  for (const name of ['tests/e2e', 'tests/contract', 'tests/conformance']) {
    const directory = join(root, name);
    if (existsSync(directory) && statSync(directory).isDirectory()) {
      suites.push({
        name,
        kind: 'node-test',
        path: name,
        cwd: directory,
        // Node 25 rejects "." as a test path argument; the default discovery
        // from the suite's cwd is the supported form.
        command: `node ${NODE_TEST_SCRIPT.join(' ')}`,
        args: [...NODE_TEST_SCRIPT],
      });
    } else {
      suites.push(missingSuite(name, `${name}/ is missing`, root));
    }
  }

  const verifyName = 'tools/verify/verify.mjs';
  const verifyPath = join(root, verifyName);
  if (existsSync(verifyPath) && statSync(verifyPath).isFile()) {
    suites.push({
      name: verifyName,
      kind: 'script',
      path: verifyName,
      cwd: root,
      command: `node ${verifyName}`,
      args: [verifyName],
    });
  } else {
    suites.push(missingSuite(verifyName, `${verifyName} is missing`, root));
  }

  if (!suites.some((suite) => suite.kind === 'package')) {
    suites.unshift(
      missingSuite('packages/*/test', 'no package test directory found under packages/', root),
    );
  }

  return suites;
}

function missingSuite(name, error, cwd = ROOT) {
  return {
    name,
    kind: 'missing',
    path: name,
    cwd,
    command: '(not found)',
    args: [],
    missing: true,
    error,
  };
}

function slugify(name) {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'suite';
}

function commandLine(args) {
  return ['node', ...args].join(' ');
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return current + chunk.slice(0, MAX_CAPTURE_BYTES - current.length);
}

/**
 * Execute one suite and return the raw measurement. Never throws: spawn
 * failures become failed measurements.
 */
export function executeSuite(suite, options) {
  if (suite.missing) {
    return Promise.resolve({
      suite,
      exit: 1,
      signal: null,
      pass: 0,
      fail: 1,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      failedTests: [],
      error: suite.error,
    });
  }

  return new Promise((resolvePromise) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let timer = null;

    let child;
    try {
      child = spawn(process.execPath, suite.args, {
        cwd: suite.cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({
        suite,
        exit: 1,
        signal: null,
        pass: 0,
        fail: 1,
        durationMs: Math.round(performance.now() - started),
        timedOut: false,
        stdout,
        stderr,
        failedTests: [],
        error: error.message,
      });
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk);
    });

    const finish = (exit, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      const combined = `${stdout}\n${stderr}`;
      const parsed =
        suite.kind === 'script' ? parseVerifySummary(combined) : parseTapSummary(stdout);
      let pass = parsed.pass ?? 0;
      let fail = parsed.fail ?? 0;

      if (!timedOut) {
        if (!parsed.found) {
          // A suite that exited without a summary is a crash, not a pass.
          if (exit === 0) pass = Math.max(pass, 1);
          else fail = Math.max(fail, 1);
        }
        if (exit !== 0 && fail === 0) fail = 1;
      }

      resolvePromise({
        suite,
        exit: timedOut ? 124 : typeof exit === 'number' ? exit : 1,
        signal: signal ?? null,
        pass,
        fail,
        durationMs,
        timedOut,
        stdout,
        stderr,
        failedTests: parsed.failedTests ?? [],
        error: spawnError ? spawnError.message : null,
      });
    };

    child.on('error', (error) => {
      spawnError = error;
      finish(1, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The close/error handler records the failure.
      }
    }, Math.max(1, options.timeoutMs));
    timer.unref?.();
  });
}

function gitOutput(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function buildRunTarget(options) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const reportPath = options.reportPath
    ? resolve(options.reportPath)
    : join(
        options.reportDir ? resolve(options.reportDir) : join(tmpdir(), 'dsbot-v3-regression', runId),
        'report.json',
      );
  const reportDir = dirname(reportPath);
  const logDir = join(reportDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  return { runId, reportPath, reportDir, logDir };
}

function writeLog(logPath, suite, measurement) {
  const lines = [
    `$ ${commandLine(suite.args)}`,
    `# suite: ${suite.name}`,
    `# cwd: ${toPosix(relative(ROOT, suite.cwd))}`,
    `# exit: ${measurement.exit}`,
    `# signal: ${measurement.signal ?? ''}`,
    `# duration_ms: ${measurement.durationMs}`,
    `# timed_out: ${measurement.timedOut}`,
    '',
    '--- stdout ---',
    measurement.stdout,
    '',
    '--- stderr ---',
    measurement.stderr,
  ];
  writeFileSync(logPath, lines.join('\n'), 'utf8');
}

function tail(text, lineCount) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-lineCount)
    .join('\n');
}

function formatCount(value) {
  return value === null || value === undefined ? '?' : String(value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const target = buildRunTarget(options);
  const startedAt = new Date().toISOString();
  const overallStart = performance.now();
  const suites = discoverSuites(ROOT);
  const results = [];

  if (options.verbose) {
    console.log(`DS Bot V3 regression: ${suites.length} suites`);
    console.log(`Report directory: ${target.reportDir}`);
    console.log('');
  }

  for (let index = 0; index < suites.length; index += 1) {
    const suite = suites[index];
    const label = `[${String(index + 1).padStart(2, '0')}/${suites.length}]`;
    if (!options.verbose) process.stdout.write(`${label} ${suite.name} ... `);

    const measurement = await executeSuite(suite, options);
    const logName = `${slugify(suite.name)}.log`;
    const logPath = join(target.logDir, logName);
    writeLog(logPath, suite, measurement);

    const failed = measurement.fail > 0 || (!measurement.timedOut && measurement.exit !== 0);
    const status = measurement.timedOut
      ? measurement.fail > 0
        ? 'failed'
        : 'timed_out'
      : failed
        ? 'failed'
        : 'passed';
    const slow =
      measurement.timedOut ||
      measurement.durationMs > options.slowMs;

    const result = {
      suite,
      measurement,
      status,
      slow,
      failed,
      log: toPosix(relative(target.reportDir, logPath)),
    };
    results.push(result);

    if (options.verbose) {
      console.log(`${label} ${suite.name} ... ${status.toUpperCase()} (${measurement.durationMs} ms)`);
      if (measurement.stdout) console.log(measurement.stdout.trimEnd());
      if (measurement.stderr) console.error(measurement.stderr.trimEnd());
    } else {
      const detail = failed
        ? `FAIL exit=${measurement.exit} pass=${formatCount(measurement.pass)} fail=${formatCount(measurement.fail)}`
        : `${status.toUpperCase()} ${formatCount(measurement.pass)} passed, ${formatCount(measurement.fail)} failed`;
      console.log(`${detail} (${measurement.durationMs} ms)${slow ? ' [slow]' : ''}`);
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);
  const items = results.map((result) => {
    const { suite, measurement } = result;
    return {
      name: suite.name,
      kind: suite.kind,
      path: suite.path,
      command: suite.command,
      exit: measurement.exit,
      pass: measurement.pass,
      fail: measurement.fail,
      duration_ms: measurement.durationMs,
      slow: result.slow,
      timed_out: measurement.timedOut,
      status: result.status,
      log: result.log,
      ...(measurement.failedTests.length > 0 ? { failed_tests: measurement.failedTests } : {}),
      ...(measurement.error ? { error: measurement.error } : {}),
    };
  });

  const failedItems = results.filter((result) => result.failed);
  const slowItems = results.filter((result) => result.slow);
  const timedOutItems = results.filter((result) => result.measurement.timedOut);
  const totals = {
    items: items.length,
    pass: items.reduce((sum, item) => sum + item.pass, 0),
    fail: items.reduce((sum, item) => sum + item.fail, 0),
    duration_ms: durationMs,
    slow: slowItems.length,
  };
  const overBudget = durationMs > options.budgetMs;
  const report = {
    suite: REPORT_SUITE,
    run_id: target.runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: durationMs,
    base_commit: gitOutput(ROOT, ['rev-parse', 'origin/main']),
    head_commit: gitOutput(ROOT, ['rev-parse', 'HEAD']),
    dirty: Boolean(gitOutput(ROOT, ['status', '--porcelain'])),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    budget_ms: options.budgetMs,
    within_budget: !overBudget,
    items,
    totals,
    failed: failedItems.map((result) => result.suite.name),
    slow: slowItems.map((result) => result.suite.name),
    timed_out: timedOutItems.map((result) => result.suite.name),
    incomplete: timedOutItems.length > 0,
    ok: failedItems.length === 0,
  };

  writeFileSync(target.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(
    `Regression ${report.ok ? 'PASS' : 'FAIL'}: ${items.length} suites, ` +
      `${totals.pass} tests passed, ${totals.fail} tests failed, ` +
      `${(durationMs / 1000).toFixed(1)}s` +
      `${overBudget ? ` [slow: above ${options.budgetMs} ms budget]` : ''}`,
  );

  if (slowItems.length > 0) {
    console.log(`Slow suites: ${slowItems.map((result) => result.suite.name).join(', ')}`);
  }
  if (timedOutItems.length > 0) {
    console.log(
      `Timed-out suites (marked slow, not counted as failures): ` +
        timedOutItems.map((result) => result.suite.name).join(', '),
    );
  }

  if (failedItems.length > 0) {
    console.log('Failed suites:');
    for (const result of failedItems) {
      const measurement = result.measurement;
      console.log(
        `  - ${result.suite.name}: exit=${measurement.exit} ` +
          `pass=${formatCount(measurement.pass)} fail=${formatCount(measurement.fail)} ` +
          `(${measurement.durationMs} ms)`,
      );
      for (const failedTest of measurement.failedTests.slice(0, 10)) {
        console.log(`      not ok: ${failedTest}`);
      }
      const excerpt = tail(`${measurement.stdout}\n${measurement.stderr}`, 12);
      if (excerpt) {
        console.log(
          excerpt
            .split(/\r?\n/)
            .map((line) => `      ${line}`)
            .join('\n'),
        );
      }
    }
  }

  console.log(`Report: ${target.reportPath}`);
  return report.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error);
      console.error(`regression runner failed: ${message}`);
      if (process.env.DEBUG) console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
}
