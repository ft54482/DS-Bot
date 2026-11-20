#!/usr/bin/env node
import { runCli } from '../src/cli.js';
import { createHttpProbe, nodeIsPortFree } from '../src/health.js';
import { createNodeFs } from '../src/node-fs.js';

const deps = {
  fs: createNodeFs(),
  probe: createHttpProbe(),
  isPortFree: nodeIsPortFree,
  stdout: process.stdout,
  stderr: process.stderr,
};

process.exitCode = await runCli(process.argv.slice(2), deps);
