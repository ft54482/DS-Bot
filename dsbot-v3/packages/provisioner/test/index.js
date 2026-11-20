// Entry point for `node --test packages/provisioner/test`.
//
// Node 25 resolves an explicit directory argument through the module loader, so
// this index.js makes the directory itself runnable; it imports every suite.
// Every test uses the in-memory fs adapter, so no test writes to a real ~/.dsh.
import './provision.test.js';
import './ports.test.js';
import './idempotency.test.js';
import './health.test.js';
import './remove.test.js';
import './cli.test.js';
import './yaml.test.js';
