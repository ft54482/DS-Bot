// Entry point for `node --test packages/context/test`.
// Node resolves an explicit directory argument through the module loader, so
// this index.js imports every suite.
import './pack.test.js';
import './trim.test.js';
import './pointers.test.js';
import './purity.test.js';
