// Entry point for `node --test packages/taskpack/test`.
// Node resolves an explicit directory argument through the module loader, so
// this index.js imports every suite.
import './build.test.js';
import './validate.test.js';
import './route.test.js';
import './purity.test.js';
