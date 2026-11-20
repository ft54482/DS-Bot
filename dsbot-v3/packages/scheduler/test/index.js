// Entry point for `node --test packages/scheduler/test`.
//
// Node resolves an explicit directory argument through the module loader, so
// this index imports every suite. No timers, no network, no filesystem.
import './dispatch.test.js';
import './concurrency.test.js';
import './backoff.test.js';
import './guards.test.js';
