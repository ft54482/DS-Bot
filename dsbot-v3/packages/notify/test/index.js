// Entry point for `node --test packages/notify/test`.
//
// An explicit directory argument resolves through the module loader, so this
// index.js makes the directory runnable and imports every suite. No timers,
// files or network.
import './templates.test.js';
import './dedupe.test.js';
import './escalation.test.js';
import './config.test.js';
