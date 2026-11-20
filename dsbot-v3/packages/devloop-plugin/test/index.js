/**
 * Entry point for `node --test packages/devloop-plugin/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` imports every suite; directory traversal on Node 20/22 finds
 * the `*.test.js` files and re-imports them from the module cache.
 */
import './tools.test.js';
import './lifecycle.test.js';
import './composition.test.js';
import './plugin.test.js';
import './purity.test.js';
import './bundle.test.js';
