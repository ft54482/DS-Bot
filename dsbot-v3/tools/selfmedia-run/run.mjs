#!/usr/bin/env node
/**
 * selfmedia-run — one-command self-media article run harness (M2).
 *
 * Default (--fake) is fully offline and deterministic. --offline reads a local
 * source pack and blocks when none exists. --real uses DSBOT_MODEL_* plus a
 * real retrieval provider and never prints the API key.
 *
 * Usage: node tools/selfmedia-run/run.mjs --topic "测试选题" --out <dir>
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseArgs,
  requireRunInputs,
  USAGE,
} from './src/args.mjs';
import {
  ConfigError,
  EXIT_CONFIG,
  EXIT_INTERNAL,
  EXIT_OK,
  errorMessage,
} from './src/errors.mjs';
import { runHarness } from './src/harness.mjs';
import { redactSecrets } from './src/report.mjs';

function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

function configFailure(stream, error) {
  writeLine(stream, `[selfmedia-run] ${error.message}`);
  if (error.hint) writeLine(stream, `[selfmedia-run] hint: ${error.hint}`);
  return EXIT_CONFIG;
}

function artifactPath(outDir, name) {
  return resolve(outDir, name);
}

function printSummary(stdout, result) {
  const { articlePack, review, report, status, exitCode } = result;
  writeLine(stdout, `[selfmedia-run] status: ${status} (exit ${exitCode})`);
  writeLine(stdout, `[selfmedia-run] article-pack: ${artifactPath(result.outDir, result.artifacts.article_pack)}`);
  writeLine(stdout, `[selfmedia-run] review: ${artifactPath(result.outDir, result.artifacts.review)}`);
  writeLine(stdout, `[selfmedia-run] report: ${artifactPath(result.outDir, result.artifacts.report)}`);
  writeLine(stdout, `[selfmedia-run] article.md: ${artifactPath(result.outDir, result.artifacts.article_md)}`);
  writeLine(
    stdout,
    `[selfmedia-run] titles=${articlePack.title_candidates.length} words=${articlePack.word_count} ` +
      `sources=${articlePack.source_list.length} license=${articlePack.license_status}`,
  );
  writeLine(stdout, `[selfmedia-run] review=${review.verdict} score=${review.score}`);
  writeLine(
    stdout,
    `[selfmedia-run] model_calls=${report.model_calls.total} fake_model_calls=${report.fake_model_calls.total} ` +
      `cost_cny=${report.cost.estimated_cny} (${report.cost.pricing_source})`,
  );
  if (articlePack.injection?.enabled) {
    writeLine(
      stdout,
      `[selfmedia-run] injected_fact_error: caught=${articlePack.injection.caught} ` +
        `claim=${articlePack.injection.detected_claim ?? articlePack.injection.claim ?? 'n/a'}`,
    );
  }
  if (status === 'blocked') {
    const reasons = articlePack.blocks.map((block) => block.message ?? block.code).join('; ');
    writeLine(stdout, `[selfmedia-run] blocked: ${reasons}`);
  }
}

/**
 * Programmatic CLI entry. Returns an exit code; never calls process.exit.
 *
 * @param {{argv?: string[], env?: NodeJS.ProcessEnv, cwd?: string, stdout?: {write: Function}, stderr?: {write: Function}, fetchImpl?: Function}} input
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl,
} = {}) {
  let options;
  try {
    options = parseArgs(argv, { cwd, env });
  } catch (error) {
    if (error instanceof ConfigError) return configFailure(stderr, error);
    writeLine(stderr, `[selfmedia-run] internal error: ${redactSecrets(errorMessage(error), env)}`);
    return EXIT_INTERNAL;
  }

  if (options.help) {
    stdout.write(USAGE);
    return EXIT_OK;
  }

  try {
    requireRunInputs(options);
  } catch (error) {
    if (error instanceof ConfigError) return configFailure(stderr, error);
    throw error;
  }

  try {
    const result = await runHarness({ ...options, env, cwd, fetchImpl });
    printSummary(stdout, result);
    if (result.status === 'blocked') {
      writeLine(stderr, '[selfmedia-run] run blocked; no source was fabricated');
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof ConfigError) return configFailure(stderr, error);
    writeLine(stderr, `[selfmedia-run] internal error: ${redactSecrets(errorMessage(error), env)}`);
    return EXIT_INTERNAL;
  }
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[selfmedia-run] fatal: ${errorMessage(error)}\n`);
      process.exitCode = EXIT_INTERNAL;
    });
}
