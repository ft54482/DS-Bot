// Entry point for `node --test tests/m5-drill/test`.
//
// Node 25 resolves an explicit directory argument through the module loader, so
// this index imports every suite. No network and no writes inside the repo.
import './report.test.js';
import './failure.test.js';
