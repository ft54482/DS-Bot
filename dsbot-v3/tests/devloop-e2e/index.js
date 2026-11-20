// `node --test tests/devloop-e2e` resolves this directory through the module
// loader on Node 25, so the directory entry point imports every suite
// explicitly.
import './scenario-a.test.js';
import './scenario-b.test.js';
import './scenario-c.test.js';
import './scenario-d.test.js';
import './scenario-e.test.js';
import './observability.test.js';
