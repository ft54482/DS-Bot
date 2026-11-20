// Entry point for `node --test packages/autoloop/test`.
//
// Node resolves an explicit directory argument through the module loader, so
// this index imports every suite. No timers, network, processes or files.
import './happy-path.test.js';
import './dispatch.test.js';
import './collect.test.js';
import './verify.test.js';
import './merge.test.js';
import './stop-loss.test.js';
import './recovery.test.js';
import './adapters.test.js';
import './validation.test.js';
import './purity.test.js';
