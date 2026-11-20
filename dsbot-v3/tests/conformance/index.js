// `node --test tests/conformance` resolves this directory through its module
// entry point on Node 25, so the entry imports every conformance suite.
import './states.test.js';
import './hierarchy.test.js';
import './acceptance.test.js';
import './stop.test.js';
import './authz.test.js';
