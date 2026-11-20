/**
 * Public surface of `@ds-bot/demo` (L29).
 */

export {
  BUSINESS_PROFILE,
  BUSINESS_SCOPE,
  CHIEF_SCOPE,
  DEMO_STEP_GAP_MS,
  DEMO_VERSION,
  EXECUTION_PROFILE,
  GOAL_PROFILE,
  MOCK_COMPLETE_AT_MS,
  MOCK_USAGE,
  runDemo,
} from './demo.js';
export { parseArgs, runCli, UsageError, USAGE } from './cli.js';
export {
  DEMO_ACCOUNT,
  DEMO_FETCHED_AT,
  DEMO_PLATFORM,
  DEMO_PROJECT,
  DEMO_TICKET,
  DEMO_TOPIC,
  SOURCE_ALPHA,
  SOURCE_BETA,
  createStubs,
} from './fixtures.js';
export { createDemoClock, createDemoIds, DEMO_CLOCK_START } from './clock.js';
export { FLOW_STEP_IDS, verifyDemo } from './verify.js';
