// Entry point for `node --test tests/contract`.
//
// Node 25 resolves an explicit directory argument through the module loader, so
// this index.js is what makes the directory itself runnable. Every contract
// suite is imported here.
//
// Contract ids are stable: CONTRACT-01..CONTRACT-06. A failing assertion always
// starts with its id, the expectation and the actual value so the first line of
// the failure is enough to locate the broken cross-package promise.
import './contracts.test.js';
