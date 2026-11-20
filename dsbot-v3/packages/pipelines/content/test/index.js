/**
 * Entry point for `node --test packages/pipelines/content/test`.
 *
 * Node 25 loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. Glob runs do not execute this file
 * twice because it does not match the test-file naming convention.
 */
import './pipeline.test.js';
import './source-degradation.test.js';
import './review-rework.test.js';
import './tool-chain.test.js';
