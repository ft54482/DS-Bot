#!/usr/bin/env node
/**
 * L29 one-command demo entry point.
 *
 *   node packages/demo/run.mjs --out <dir>
 *
 * Everything is stubbed; the only files written are under <dir>.
 */

import { runCli } from './src/cli.js';

const { exitCode } = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
