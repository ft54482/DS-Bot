// Entry point for `node --test packages/events/test`.
//
// Node 25 resolves an explicit directory argument through the module loader, so
// this index.js is what makes the directory itself runnable; it imports every
// suite. No timers, no files, no network.
import './keys.test.js';
import './watermark.test.js';
import './outbox.test.js';
import './inbox.test.js';
