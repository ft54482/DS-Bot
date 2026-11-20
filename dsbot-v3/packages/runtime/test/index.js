// Entry point for `node --test packages/runtime/test`.
//
// Node 25 resolves an explicit directory argument through the module loader, so
// this index.js is what makes the directory itself runnable; it imports every
// suite. No timers, no network beyond loopback HTTP inside one test.
import './composition.test.js';
import './delegation.test.js';
import './dispatch.test.js';
import './claim.test.js';
import './completion.test.js';
import './rework.test.js';
import './cost.test.js';
import './api.test.js';
import './restart.test.js';
import './stop.test.js';
