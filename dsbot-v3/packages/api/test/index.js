// Entry point for `node --test packages/api/test`.
//
// Node 25 treats positional test paths as files, so a bare directory argument
// is resolved through this index.js (directory resolution); the cases below
// register with the test runner. On Node 22 the directory traversal discovers
// the *.test.js files directly and these imports simply hit the module cache.
import './api.test.js';
import './persistence.test.js';
