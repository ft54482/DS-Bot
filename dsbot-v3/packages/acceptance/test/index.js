/**
 * Entry point for `node --test packages/acceptance/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` imports every suite; the directory traversal on Node 20/22
 * finds the `*.test.js` files and re-imports them from the module cache.
 */
import './execution.test.js';
import './business.test.js';
import './goal.test.js';
import './evidence.test.js';
import './purity.test.js';
