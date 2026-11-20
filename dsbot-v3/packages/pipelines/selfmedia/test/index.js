/**
 * Entry point for `node --test packages/pipelines/selfmedia/test`.
 *
 * Node 25 loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. It does not match the test-file
 * naming convention, so a glob run does not execute it twice.
 */
import './pilot.test.js';
