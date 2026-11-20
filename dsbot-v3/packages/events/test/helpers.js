export function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      return now;
    },
    set(value) {
      now = value;
      return now;
    },
  };
}
