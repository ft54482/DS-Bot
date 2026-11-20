#!/usr/bin/env node
/**
 * CLI entry point for the M5 ten-step drill.
 *
 *   node tests/m5-drill/run.mjs --out <dir>
 *
 * Writes `<dir>/drill-report.json` and `<dir>/evidence/`, prints a short
 * summary and exits 0 only when every step and every report check passed.
 * Without `--out` the artifacts go to a fresh temporary directory; the drill
 * never writes inside the repository.
 */

import { runDrill } from './src/drill.js';
import { validateReport, verifyEvidence } from './src/report.js';

function parseArgs(argv) {
  const parsed = { outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out' || argument === '-o') {
      parsed.outDir = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith('--out=')) {
      parsed.outDir = argument.slice('--out='.length);
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true;
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  if (parsed.outDir === '') parsed.outDir = null;
  return parsed;
}

function printSummary(report, outDir, problems) {
  const lines = [];
  const okSteps = report.steps.filter((step) => step.ok).length;
  lines.push(`M5 drill: ${okSteps}/${report.steps.length} steps ok`);
  lines.push(`report:   ${outDir}/drill-report.json`);
  lines.push(`evidence: ${outDir}/${report.evidence?.manifest ?? 'evidence/manifest.json'}`);
  if (report.cost) {
    lines.push(
      `cost:     task ${report.cost.levels[0].costCny} CNY ` +
        `(run ${report.cost.levels[1].costCny} + acceptance ${report.cost.levels[2].costCny}), ` +
        `retry ${report.cost.retry.costCny} CNY`,
    );
  }
  if (report.restart) {
    lines.push(
      `restart:  restored ${report.restart.recovery.runCount} run, ` +
        `new runs ${report.restart.recovery.newRunsCreated}, ` +
        `duplicate replay ${report.restart.recovery.duplicateReplay}`,
    );
  }
  if (report.stop) {
    lines.push(
      `stop:     ${report.stop.request.state} -> ${report.stop.verification.stopState}, ` +
        `workspace stable ${report.stop.workspace.writesStable}, ` +
        `no new dispatch ${report.stop.noNewDispatch.rejectedCode}`,
    );
  }
  if (report.failureInjection?.stopUnknown) {
    lines.push(
      `fallback: stop_unknown ${report.failureInjection.stopUnknown.stopState} ` +
        `(ok ${report.failureInjection.stopUnknown.ok})`,
    );
  }
  if (problems.length > 0) {
    lines.push('problems:');
    for (const problem of problems) lines.push(`  - ${problem}`);
  }
  lines.push(report.result.ok && problems.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write('usage: node tests/m5-drill/run.mjs --out <dir>\n');
    return;
  }

  const report = await runDrill({ outDir: args.outDir });
  const structure = validateReport(report);
  const evidence = verifyEvidence(report.environment.outputDir, report);
  const problems = [...structure.errors, ...evidence.errors];
  printSummary(report, report.environment.outputDir, problems);
  process.exitCode = report.result.ok && problems.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`m5-drill failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
