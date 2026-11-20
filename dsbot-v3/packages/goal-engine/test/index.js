/**
 * Entry point for `node --test packages/goal-engine/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` imports every suite; directory traversal on Node 20/22 finds
 * the `*.test.js` files and re-imports them from the module cache.
 */
import './decompose.test.js';
import './taskbook.test.js';
import './errors.test.js';
import './purity.test.js';
