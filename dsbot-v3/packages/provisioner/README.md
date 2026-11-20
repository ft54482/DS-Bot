# `@dsbot/provisioner` — L35 SuperAgent instance provisioning

Creates one isolated SuperAgent instance record: allocates a port, generates the
profile configuration (`cordis.patch.yml`), the executor `prepare` script and
the GitHub policy whitelist, registers the instance and runs an injected health
probe. Idempotent by name and safe to roll back.

```sh
node --test packages/provisioner/test
```

The suite uses an in-memory fake fs; no test writes to a real `~/.dsh`.

## API

```js
import { provision } from '@dsbot/provisioner';

const result = await provision({
  name: 'superagent-lab',
  repo: 'ft54482/superagent-lab-smoke',
  port: 'auto',                 // or an integer
  model: 'orange-pro/DeepSeek-V4.1-flash-2.5',
  workRoot: '/home/me/.dsh/state/superagent-lab/work',
  account: 'yuxianghan-droid',  // policy whitelist (default: lab agent)
  fs,                           // required injected fs adapter
  probe,                        // optional injected health probe
});
```

Returns `{ profileDir, cordisPatch, prepareScript, settings, ... }`:

- `profileDir` — `<dshHome>/profiles/<name>`;
- `cordisPatch` — object written to `<profileDir>/cordis.patch.yml`
  (`webserver.port`, `dsh-superagent.stateDir/repository/account`, default model);
- `prepareScript` —
  `git fetch origin main && git worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" origin/main`;
- `settings` —
  `executor.{model,maxWorkers,directory,prepare,blockedCommands}` plus
  `policy.sources.github.{repository,owner,account,allowed}` (`account` defaults
  to `yuxianghan-droid`, the lab's executor account; `owner` is the repo owner).

A manifest is written to `<profileDir>/instance.json` and the allocation to
`<dshHome>/state/provisioner/registry.json`.

### Port allocation

`port: 'auto'` scans 3080–3099 and skips both registered/reserved ports and,
when `isPortFree` is injected, ports that are actually busy. Explicit conflicts
raise `port_taken`. An unmanaged profile directory is never overwritten
(`profile_exists`).

### Health check

`probe(context)` may return `true`, `{ok: true}` or `{ok: false, reason}`; a
thrown error is a failed check. Failure raises `not_ready` with `.reason`,
removes the profile directory and registry record, and leaves no half-install.
Omitting `probe` records `health: {checked: false, skipped: true}`.

The provisioner does **not** spawn the DSH process itself. An integration can
pass a probe that starts/waits for the instance before calling the overview
endpoint; the CLI's `--health-check` only checks an already-listening endpoint
(`/orchestrator/api/overview` with `x-orchestrator-request: 1`).

### Idempotency and removal

- Calling `provision` again with the same name returns the existing manifest
  (`created: false`) without probing, rewriting or registering a second time.
- `removeProvision({name, fs})` deletes the profile directory and registry
  entry. It refuses to delete an unmanaged directory. `removeState: true`
  (CLI `--remove-state`) additionally deletes `<dshHome>/state/<name>`, which
  may contain worktrees and is therefore not the default.
- Removing an unknown instance is a no-op (`removed: false`).

## Injected IO

Every file-system call goes through an adapter with seven synchronous methods:

```js
{ homedir, exists, readFile, writeFile, mkdir, remove, list }
```

`createNodeFs()` is the only real implementation; tests use
`test/support/fake-fs.js`. `isPortFree(port)` and `probe(context)` are also
injected (async allowed).

## CLI

```sh
node packages/provisioner/bin/provision.js \
  --name superagent-lab --repo ft54482/superagent-lab-smoke \
  --model orange-pro/DeepSeek-V4.1-flash-2.5 --port auto --json

node packages/provisioner/bin/provision.js --remove --name superagent-lab
```

`--blocked-commands <cmd>` is repeatable; each occurrence is one command
(commands may contain spaces). Exit codes: `0` success, `1` runtime failure,
`2` usage error.

## Error codes

`invalid_input`, `port_taken`, `port_exhausted`, `profile_exists`,
`profile_corrupt`, `registry_corrupt`, `not_ready`.
