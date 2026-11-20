// `node --test tests/e2e` resolves this directory through the module loader on
// Node 25, so the directory entry point imports every suite explicitly.
import './closed-loop.test.js';
import './stop.test.js';
