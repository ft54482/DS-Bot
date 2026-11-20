/**
 * Entry point for `node --test packages/pipelines/sources/test`.
 *
 * Node 25 loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. Glob runs do not execute this file
 * twice because it does not match the test-file naming convention.
 */
import './client.test.js';
import './cross-check.test.js';
import './integration.test.js';
import './source-discipline.test.js';
