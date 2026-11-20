// Entry point for `node --test packages/cli/test`.
//
// Node 25 resolves an explicit directory argument to this index.js; the imports
// below register every case. On Node 20/22 directory traversal also discovers
// the *.test.js files, in which case these imports hit the module cache.
import './parse.test.js';
import './run-cli.test.js';
import './from-runtime.test.js';
import './main.test.js';
