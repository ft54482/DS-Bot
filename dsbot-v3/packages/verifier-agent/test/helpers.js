/**
 * Fixtures for the verifier tests. The runner here is an in-memory fake: the
 * suite never clones, fetches or spawns a process.
 */

export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
export const MOVED = 'c'.repeat(40);

export const DEFAULT_DIRS = ['packages/verifier-agent'];

/** Deterministic Node-TAP-like output with `total` cases and `failed` fails. */
export function tap(total = 12, failed = 0) {
  const lines = ['TAP version 13'];
  for (let index = 1; index <= total; index += 1) {
    lines.push(
      index <= total - failed
        ? `ok ${index} - case ${index}`
        : `not ok ${index} - case ${index}`,
    );
  }
  lines.push(`1..${total}`, `# tests ${total}`, `# pass ${total - failed}`, `# fail ${failed}`);
  return `${lines.join('\n')}\n`;
}

export function makePr(overrides = {}) {
  return { number: 77, base: BASE, head: HEAD, ...overrides };
}

/**
 * Build a fake runner. Every call is recorded so tests can prove the verifier
 * asked for a fresh worktree and reran instead of trusting stale output.
 */
export function createRunner(config = {}) {
  const calls = {
    resolveHead: [],
    prepare: [],
    head: [],
    changedFiles: [],
    run: [],
  };

  let prepareIndex = 0;

  return {
    calls,

    async resolveHead(pr) {
      const index = calls.resolveHead.length;
      calls.resolveHead.push(pr);
      if (config.resolveHead) return config.resolveHead(index, pr);
      return HEAD;
    },

    async prepare(pr, options) {
      const index = prepareIndex;
      prepareIndex += 1;
      calls.prepare.push({ pr, ...options });
      if (config.prepare) return config.prepare(index, options, pr);
      return { worktree: `wt-${index + 1}` };
    },

    async head(worktree) {
      calls.head.push(worktree);
      if (config.head) return config.head(worktree, calls.head.length);
      return HEAD;
    },

    async changedFiles(pr, options) {
      calls.changedFiles.push({ pr, ...options });
      if (config.changedFiles) return config.changedFiles(pr, options);
      return config.files ?? ['packages/verifier-agent/src/verify.js'];
    },

    async run(args) {
      const index = calls.run.length;
      calls.run.push(args);
      if (config.run) return config.run(args, index);
      return {
        exit: config.exit ?? 0,
        output: config.output ?? tap(12),
      };
    },
  };
}
