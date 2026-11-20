/**
 * Entry point for `node --test packages/adapters/test`.
 *
 * Node 25 loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. Glob runs (`node --test
 * "packages/adapters/test/*.test.js"`) do not execute this file twice because
 * it does not match the test-file naming convention.
 */
import './contract.test.js';
import './mock.test.js';
import './tool_chain.test.js';
import './dsh_session.test.js';
import './superagent.test.js';
