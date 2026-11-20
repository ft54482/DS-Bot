/**
 * Aggregator for `node --test tools/selfmedia-run/test`.
 *
 * Node 25.2.0 treats a directory argument as a single module entry point
 * instead of discovering `*.test.mjs` below it (the same pattern is used by
 * tools/migrate/test). This module registers every suite in one process.
 */

import './cli.test.mjs';
import './attribution.test.mjs';
import './review.test.mjs';
import './review-json.test.mjs';
import './retrieval.test.mjs';
import './model.test.mjs';
import './real.test.mjs';
import './bridge-gateway.test.mjs';
