/**
 * Entry point for `node --test packages/demo/test`.
 *
 * Node 25 loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. It does not match the test-file
 * naming convention, so a glob run does not execute it twice.
 */
import './demo.test.js';
import './cli.test.js';
