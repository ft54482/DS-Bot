/**
 * CLI surface for `node packages/demo/run.mjs --out <dir>`.
 *
 * The parser is exported separately so tests can cover argument handling
 * without spawning a process; `runCli` is the shared implementation used by the
 * executable entry point.
 */

import { runDemo } from './demo.js';

export const USAGE = `Usage: node packages/demo/run.mjs --out <dir>

Runs the L29 end-to-end self-media demo with every external dependency stubbed.
Writes article.md, publish-package.json and demo-report.json under <dir>.

Options:
  --out <dir>   Output directory (required; created when missing)
  --help, -h    Show this help
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv = []) {
  const options = { outDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--out') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new UsageError('--out requires a directory');
      }
      options.outDir = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--out=')) {
      const value = argument.slice('--out='.length);
      if (value.trim() === '') throw new UsageError('--out requires a directory');
      options.outDir = value;
      continue;
    }
    throw new UsageError(`unknown argument: ${argument}`);
  }
  return options;
}

function formatSummary({ report }) {
  const passedSteps = report.steps.filter((step) => step.status === 'passed').length;
  const checks = report.verify.checks.filter((check) => check.ok).length;
  return [
    `L29 self-media demo: ${report.verify.ok ? 'PASSED' : 'FAILED'}`,
    `out: ${report.out_dir}`,
    `report: ${report.artifacts.report}`,
    `steps: ${passedSteps}/${report.steps.length} passed`,
    `ids: goal=${report.ids.goal} business=${report.ids.business} execution=${report.ids.execution}` +
      ` run=${report.ids.run} acceptance=${report.ids.acceptance}`,
    `publish package: ${report.publish_package.status}` +
      ` (license=${report.publish_package.license_status},` +
      ` published=${report.publish_package.publish.executed})`,
    `verify: ${report.verify.summary}`,
    '',
  ].join('\n');
}

/**
 * Execute the CLI.
 *
 * @param {string[]} argv arguments without the node/script prefix
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [io]
 * @returns {Promise<{exitCode: number, result?: object}>}
 */
export async function runCli(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${USAGE}`);
      return { exitCode: 2 };
    }
    throw error;
  }

  if (options.help) {
    stdout.write(USAGE);
    return { exitCode: 0 };
  }
  if (options.outDir === null) {
    stderr.write(`missing required --out <dir>\n\n${USAGE}`);
    return { exitCode: 2 };
  }

  try {
    const result = await runDemo({ outDir: options.outDir });
    stdout.write(formatSummary(result));
    return { exitCode: result.report.verify.ok ? 0 : 1, result };
  } catch (error) {
    stderr.write(`demo failed: ${error?.message ?? String(error)}\n`);
    return { exitCode: 1 };
  }
}
