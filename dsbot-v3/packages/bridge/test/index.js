/**
 * Entry point for `node --test packages/bridge/test`.
 *
 * Node loads a directory argument as a module, so this file registers the
 * suite when the directory itself is named. The `*.test.js` glob does not
 * match this file, so the tests are not registered twice.
 */

import './env.test.js';
import './errors.test.js';
import './dispatch.test.js';
import './results.test.js';
