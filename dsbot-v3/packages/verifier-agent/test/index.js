/**
 * Entry point for `node --test packages/verifier-agent/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` imports every suite; the directory traversal on Node 20/22
 * finds the `*.test.js` files and re-imports them from the module cache.
 */
import './paths.test.js';
import './cases.test.js';
import './verify.test.js';
