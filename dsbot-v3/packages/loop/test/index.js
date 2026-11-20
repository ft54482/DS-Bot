// Entry point for `node --test packages/loop/test`.
//
// Node resolves an explicit directory argument through the module loader, so
// this index imports every suite. No timers, no network, no filesystem use in
// the implementation under test.
import './yaml.test.js';
import './loader.test.js';
import './stop-loss.test.js';
import './purity.test.js';
