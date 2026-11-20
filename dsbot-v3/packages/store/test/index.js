// Entrypoint for `node --test packages/store/test`.
//
// Node 25 treats positional test paths as files, so a bare directory argument
// is resolved through this index.js (CommonJS-style directory resolution) and
// the cases below register with the test runner.
import './schema.test.js';
import './dao.test.js';
import './guards.test.js';
