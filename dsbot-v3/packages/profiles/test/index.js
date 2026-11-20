/**
 * Test entry point.
 *
 * Required acceptance command: `node --test packages/profiles/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` is what makes the directory itself runnable; it imports every
 * suite. On Node 20/22 the directory traversal also finds the `*.test.js` files,
 * in which case this file simply re-imports cached modules.
 */
import './evaluate.test.js';
import './facts.test.js';
import './freshness.test.js';
import './quality.test.js';
import './layout.test.js';
import './compliance.test.js';
import './publish.test.js';
import './profile.test.js';
