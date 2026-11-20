/**
 * Observable in-memory store for the L41 dev-loop e2e.
 *
 * The store is the loop's crash-recovery port: `load()` returns the last
 * persisted snapshot and `save()` is called after every state. On top of that
 * contract it records two queryable streams:
 *
 *   - `saves()`: every persisted snapshot, tagged with its iteration (round);
 *   - `steps()`: one entry per executed state, with the returned actions and
 *     the state snapshot taken after that state.
 *
 * `rounds()` groups the step stream by iteration so a test can assert what a
 * whole round did instead of rebuilding it from raw saves. Nothing here is
 * product code; it is a deterministic fake that survives a driver restart.
 */

function clone(value) {
  return structuredClone(value);
}

/** Project the driver's terminal `done` state into the ticket's `completed`. */
export function statusOf(snapshot) {
  if (snapshot === null || snapshot === undefined) return 'empty';
  if (snapshot.state === 'done') return 'completed';
  if (snapshot.state === 'stop') return 'stopped';
  return snapshot.state;
}

export function createFakeStore(initial = null) {
  let latest = initial === null ? null : clone(initial);
  const saves = [];
  const steps = [];

  function roundsOf() {
    const grouped = new Map();
    for (const entry of steps) {
      const list = grouped.get(entry.iteration) ?? [];
      list.push(entry);
      grouped.set(entry.iteration, list);
    }
    return [...grouped.entries()].map(([iteration, entries]) => ({
      iteration,
      states: entries.map((entry) => entry.state),
      actions: entries.flatMap((entry) => entry.actions),
      snapshots: entries.map((entry) => entry.snapshot),
      final: entries[entries.length - 1].snapshot,
    }));
  }

  return {
    async load() {
      return latest === null ? null : clone(latest);
    },

    async save(snapshot) {
      const copy = clone(snapshot);
      latest = copy;
      saves.push({
        iteration: copy.round,
        state: copy.state,
        at: copy.updatedAt,
        snapshot: clone(copy),
      });
    },

    recordStep(entry) {
      steps.push(clone(entry));
    },

    latest() {
      return latest === null ? null : clone(latest);
    },

    status() {
      return statusOf(latest);
    },

    saves() {
      return clone(saves);
    },

    steps() {
      return clone(steps);
    },

    journal() {
      return { saves: clone(saves), steps: clone(steps) };
    },

    rounds() {
      return roundsOf();
    },

    round(iteration) {
      return roundsOf().find((entry) => entry.iteration === iteration) ?? null;
    },
  };
}
