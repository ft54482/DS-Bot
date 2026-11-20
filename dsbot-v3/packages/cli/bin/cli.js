#!/usr/bin/env node
import { main } from '../src/main.js';

const exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
