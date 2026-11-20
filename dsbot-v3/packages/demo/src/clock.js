/**
 * Deterministic clock and id factory for the demo.
 *
 * The runtime and the mock executor share the clock so a scripted completion is
 * reached by explicit `advance()` calls instead of real timers. Ids are
 * deterministic and unique across every service record type.
 */

export const DEMO_CLOCK_START = Date.UTC(2026, 10, 20, 12, 0, 0);

export function createDemoClock(start = DEMO_CLOCK_START) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError('clock.advance requires a non-negative number of milliseconds');
      }
      current += ms;
      return current;
    },
  };
}

export function createDemoIds(start = 0) {
  let counter = start;
  return {
    next: (prefix) => `${prefix}-${++counter}`,
  };
}
