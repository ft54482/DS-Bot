# @dsbot/verifier-agent — L36 independent PR verification

An independent verifier for one pull request. It does not read the PR body,
commit messages or an author's "tests pass" claim: the verdict is built from
the pinned commit sha, the changed-file list and a fresh rerun in an isolated
checkout supplied by an injected runner.

```js
import { verify } from '@dsbot/verifier-agent';

const verdict = await verify({
  pr: { number: 77, base: '<origin/main sha at start>', head: '<PR head sha>' },
  lane: 'fast',
  allowedDirs: ['packages/verifier-agent'],
  command: 'node --test packages/verifier-agent/test',
  minCases: 12,
  runner, // injected executor, see below
});
```

`verify` never throws for bad evidence or a broken runner; it returns:

```js
{
  verdict: 'PASS' | 'FAIL',
  scopeOk: boolean,      // every changed file is inside allowedDirs
  outside: string[],     // out-of-scope paths, sorted; [] when scopeOk
  exit: number | null,   // rerun process exit; null when the lane never ran
  cases: number,         // cases counted from the rerun output
  headStable: boolean,   // false when the PR tip moved and voided the result
  reason: string,        // 'ok' or a machine-readable failing reason
}
```

## Runner contract

The runner is the only I/O seam. Tests inject a fake runner, so the suite never
clones, fetches or spawns a process. A production runner performs real git and
process work behind the same five methods:

| method | returns | purpose |
|---|---|---|
| `resolveHead(pr)` | full 40-hex sha | authoritative PR tip, e.g. from `refs/pull/<n>/head`; not the shared clone's current branch |
| `prepare(pr, { expectedHead, fresh })` | `{ worktree }` | isolated checkout pinned at `expectedHead`; `fresh: true` means a brand-new worktree, never the shared clone |
| `head(worktree)` | full 40-hex sha | commit the worktree currently has |
| `changedFiles(pr, { base, head })` | `string[]` | repository-relative paths changed `base..head` |
| `run({ pr, worktree, command, lane })` | `{ exit, output }` | execute the lane inside that worktree |

`pr` is `{ number, base, head }`. `base` must be the complete `origin/main` sha
captured when work started, and `head` the complete sha under verification;
short or missing shas are rejected as invalid input.

## Decision rules

The checks run in this order, and the first failure is the reason:

1. **Pinned head** — `resolveHead(pr)` must equal `pr.head`. A moved tip before
   verification is `head_moved_before_verification`; the lane is not run.
2. **Scope gate** — every path from `changedFiles` must be inside one of
   `allowedDirs`. `packages/verifier-agent-other/x.js` is *not* inside
   `packages/verifier-agent`; `..` segments, absolute paths and non-string
   entries are always outside. A violation fails without running anything.
3. **Isolation** — prepare a worktree at the expected head, then rerun the
   command there.
4. **PR tip stability** — after the run, `resolveHead(pr)` must still equal
   `pr.head`. If the PR was updated while verifying, the conclusion is void:
   FAIL with `headStable: false` and `head_changed_during_verification`, even
   when the rerun passed.
5. **Exit code** — a nonzero rerun exit fails (`test_failed`).
6. **Case floor** — fewer executed cases than `minCases` fails
   (`insufficient_cases`). The default floor is 1; `0` disables the check.
7. Otherwise the verdict is `PASS` with `reason: 'ok'`.

A runner exception in any step becomes FAIL with a `runner_error: <step>: ...`
reason. It never becomes PASS.

## Concurrent branch switches

A shared clone may be switched to another branch while the lane runs. This is
isolation contamination, not a PR update, and is recovered automatically:

- `prepare` returning a worktree whose `head` is not `expectedHead`,
- `run` returning `{ contaminated: true }`,
- `run` throwing an error with `isolation: true` or `code: 'E_ISOLATION'`
  (also `E_WORKTREE_CONTAMINATED`),
- or the worktree's head changing during the run while the PR tip stayed put.

For any of these the verifier discards the run and retries with
`prepare(..., { fresh: true })`, up to 3 attempts total. Exhausting the retries
is `isolation_failed` (FAIL, `headStable: false`). A changed *PR tip* is never
retried; it voids the verdict as described above.

## Case counting

`countCases` reads the rerun's stdout/stderr, never a number supplied by the
PR author. It prefers Node's TAP summary (`# tests`), then `# pass` + `# fail`,
then the spec-reporter summary (`ℹ tests`), then top-level TAP result lines
(indented subtests are not double counted), then the TAP plan. Unparseable
output counts as zero and therefore fails any positive floor.

## Scope rules

`allowedDirs` entries are repository-relative directories. Backslashes,
`./` prefixes and trailing slashes are normalized; empty entries and `..`
escapes are invalid input. A file matches a directory when it is the directory
itself or starts with `<dir>/`.

## Test

```bash
node --test packages/verifier-agent/test
```

31 tests cover the scope gate, exit and case-floor failures, head moves before
and during verification, worktree switches and isolation retries, runner errors,
malformed runner results, case parsing and the exact result shape. All runners
are fakes; nothing in the suite clones or fetches.
