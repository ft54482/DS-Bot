/**
 * Test entry point.
 *
 * Required acceptance command: `node --test packages/service/test`.
 *
 * Node 25 resolves an explicit directory argument through the module loader, so
 * this `index.js` is what makes the directory itself runnable; it imports every
 * suite. On Node 20/22 the directory traversal also finds the `*.test.js` files,
 * in which case this file simply re-imports cached modules.
 */
import './states.test.js';
import './transitions.test.js';
import './claim.test.js';
import './completion.test.js';
import './acceptance.test.js';
import './idempotency.test.js';
import './stop.test.js';
