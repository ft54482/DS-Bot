/**
 * Entry point for `node --test packages/agents/test`.
 *
 * Node loads a directory argument as a module, so naming the directory runs the
 * suites registered here. Glob runs do not execute this file twice because it
 * does not match the test-file naming convention.
 */
import './surface.test.js';
import './chief.test.js';
import './business.test.js';
