/**
 * Aggregator for `node --test tools/migrate/test`.
 *
 * Node's test runner does not always expand a directory argument: Node 25.2.0
 * (verified on this machine) tries to execute `tools/migrate/test` as a single
 * entry point instead of discovering `*.test.mjs` below it. Giving this
 * directory a package.json + `main` makes that command resolve here, and this
 * module simply registers every test file in the current process.
 *
 * Discovery-based invocations keep working too:
 *   node --test tools/migrate/test
 *   node --test "tools/migrate/test/*.test.mjs"
 */

import './bundle.test.mjs';
import './verify.test.mjs';
