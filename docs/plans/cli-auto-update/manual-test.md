# cli-auto-update — manual test script

Everything in `spec.md` is verifiable offline with an injected `fetchImpl`,
`spawnImpl` and `now()` — **except the things that depend on the machine's own
npm configuration and on a real global directory**. That is what this file is
for. The automated suite (`src/__tests__/update-*.test.{ts,tsx}`, 9 files) covers
the rest; do not re-do here what a unit test already pins.

**Four rows cannot be skipped**: 1, 2, 4 and 11. Row 11 is the one the review
verdict added as a condition, and it is the only failure mode in this design that
is both invisible to the user and unbounded in time.

Rows **12–16** were added by the hardening round (`cli-auto-update-hardening`)
and are at the end of this file; three more of those cannot be skipped either.
Rows 1, 2, 4 and 11 remain **unrun** as of that round and are a gate on it.

## Setup

```bash
# A scratch home, so nothing here touches your real config, sessions or skills.
export ARAGON_HOME="$(mktemp -d)/aragon-manual"
mkdir -p "$ARAGON_HOME"

# Watch what the updater is doing. It is silent by contract, so the log is the
# only place its behaviour is observable.
aragon config set log.level debug
tail -f "$ARAGON_HOME/logs/"aragon-*.log | grep '"scope":"update"'
```

Records to expect: `update_check_start`, `update_check_result`,
`update_install_start`, `update_install_done`, `update_install_failed`,
`update_install_ineffective`, `update_skipped`, `update_applied`.

---

| # | What | How | Expected |
|---|---|---|---|
| **1** | **A real global install upgrades itself — Windows AND Linux.** Cannot be skipped. | `npm i -g @aragon-agent/cli@<previous>` then run `aragon` and wait out `startupDelayMs` (3 s) plus the check. Use `update.checkIntervalMs` at its floor (`aragon config set update.checkIntervalMs 900000`) and delete `<home>/update-state.json` between attempts so the throttle does not suppress it. | Within one check: `update_install_start` then `update_install_done` in the log; the bottom row shows `<glyph> <new> installed <dot> restart aragon to apply` where the glyphs are whatever `pickGlyphs` resolved for that terminal — `✓` / `·` in the Unicode tier, `*` / `-` in the ASCII one. **No literal `+` or `~` anywhere.** One toast, once. Restart: the line is gone and the log carries `update_applied`. |
| **2** | **An unwritable global prefix on Linux, without sudo.** Cannot be skipped. | On a box where `/usr/lib/node_modules` is root-owned and you are not root: `aragon`, wait for the check. | The line reads `<version> available <dot> npm i -g @aragon-agent/cli`, `reason: 'not-writable'` in `/update status`. **npm is never spawned** — no `update_install_start` record. The probe happens before the spawn, so there is no EACCES buried in npm output. |
| **3** | **Two terminals started within a second of each other.** | Delete `<home>/update-state.json`, then start `aragon` in two terminals as close together as you can manage. | **One** registry request across both (one `update_check_start` pair at most, and only one that proceeds), **one** `update_install_start`. The loser records `reason: 'locked'` and installs nothing. `<home>/update-install.lock` is gone afterwards. |
| **4** | **Quit the TUI mid-install.** Cannot be skipped. | Start a run that will install (row 1's setup), and press `Ctrl+C` while the row says `updating to <version>`. | `aragon` exits immediately. **The install completes anyway** — watch `npm ls -g @aragon-agent/cli` settle on the new version a few seconds later. The next launch finds local === remote and does nothing. This is D-10 and U-3: `dispose()` must never signal the child, because killing a running `npm i -g` is the one action here that can leave a global installation broken. |
| **5** | **`mode: notify` reports and never installs.** | `aragon config set update.mode notify`, then row 1's setup. | The line reads `<version> available <dot> npm i -g @aragon-agent/cli`. No `update_install_start`. `npm ls -g` is unchanged. |
| **6** | **`mode: off` is inert.** | `aragon config set update.mode off`, then `aragon`. | **Zero** `"scope":"update"` records — not even `update_check_start`. No `<home>/update-state.json` is created. Same for `ARAGON_UPDATE=0 aragon` and `aragon --no-update`. |
| **7** | **`/update` is the guaranteed reporting surface.** | In a session: `/update`, then `/update now`, then `/update skip`, then `/update off`. | `/update` prints running / latest / source / phase / next check. `/update now` checks immediately even inside the throttle window. `/update skip` makes the line disappear and writes `skippedVersion` to `<home>/update-state.json`; it does **not** come back for that version. `/update off` persists `update.mode: off` and says it applies next launch. In a session started with `--no-update`, `/update` says updates are disabled and `/update off` still works. |
| **8** | **Narrow terminal.** | Resize below 60 columns with an update pending. | The line degrades to its short form (`<arrow> 0.6.0`, `<check> 0.6.0 ready`, `<warn> update failed`) and **truncates rather than wrapping**. The frame never gains a second row. Widen again: the full form returns. |
| **9** | **The row never steals a row from the transcript.** | With an update pending, submit a prompt and watch the bottom row through the whole run. | The row shows the toast when there is one, the working line while running, and the update line only when both are quiet. The transcript **does not shift** at any transition. This is the P0-1 failure; if the transcript gains or loses a row as the updater changes phase, stop and re-read §6.1. |
| **10** | **A non-npm manager gets advice, not a command run for it.** | Install through pnpm (`pnpm add -g @aragon-agent/cli`) and run `aragon`. Repeat with `npx @aragon-agent/cli` and inside a project that has it in `devDependencies`. | pnpm: the line names `pnpm add -g @aragon-agent/cli` and npm is never spawned. **npx and a monorepo checkout render nothing at all** — an npx run already resolved `latest` seconds ago, and a developer's clone is not out of date. A project-local install is silent for the same reason: its manifest pins the version. |
| **11** | **An install that succeeds into a DIFFERENT prefix (U-6 / R-12).** Cannot be skipped. | Point npm somewhere else and let one install run: `npm config set prefix "$(mktemp -d)"` (or write `prefix=` into a scratch `.npmrc` and `export npm_config_userconfig=` at it), keep `aragon` itself installed in the original global root, downgrade it there, and run `aragon`. | npm exits 0 and writes into the scratch prefix. The log carries **`update_install_ineffective`** with `target` and `observed`. The line reads `<version> installed elsewhere <dot> npm i -g @aragon-agent/cli`. `pendingRestartVersion` is **not** set. **Then check again** (`/update now`): the second check decides `none` / `skipped` and **does not reinstall**. Without the latch this reinstalls once per interval forever, silently — the worst shape available to a feature whose whole contract is silence. Restore with `npm config delete prefix`. |

---

## Rows 12–16 — the hardening round (`cli-auto-update-hardening`)

Rows 1, 2, 4 and 11 above are **still outstanding** and are a precondition for
these, not a duplicate of them. Row 13 in particular is the empirical input
§5.3.1 of the hardening spec depends on: it decides whether the `blocked-by-os`
path is the common case on Windows or an exotic one.

**Three of these cannot be skipped**: 12, 13 and 14.

| # | What | How | Expected |
| --- | --- | --- | --- |
| **12** | **A release that cannot start is rolled back.** Cannot be skipped. Run on **both** Windows and Linux. | Publish a deliberately broken build to a scratch registry (`npm publish --registry …`) or hand-corrupt `<global>/node_modules/@aragon-agent/cli/dist/cli.js` after an auto-update has armed the guard. Launch `aragon` three times. | Launches 1 and 2 print a stack and exit 1. Launch 3 prints `aragon <bad> failed to start twice; rolling back to <good>.` **before** anything else, and a few seconds later `npm ls -g` shows the old version. Launch 4 starts, and `/update status` shows a `rollback` line. **Launch 5 shows nothing** — the notice is one session. This is the only real proof H1 works: every unit test stubs the spawner, and nothing in the suite can tell you that a detached `npm i -g` launched from a process about to die of an import error actually completes. That is a property of the OS, not of the code. |
| **13** | **Windows: does `npm i -g` succeed while `aragon` is running?** Cannot be skipped. | On Windows, from `cmd.exe` and again from PowerShell, run row 1's setup and watch `update_install_*` in the log. | Record the answer **in this file**. If `update_install_blocked` appears, the bottom row must read `update blocked · close other aragon windows, …` and **not** the generic `update failed`. If the write turns out to succeed while `aragon` is running, the `blocked-by-os` path is rare and the classifier costs twenty lines; if it fails, this round has just fixed the commonest update failure on the package's primary platform. Either answer is a result — write it down. |
| **14** | **The latch survives the downgrade.** Cannot be skipped. | After row 12, inspect `<home>/update-state.json`, then let the rolled-back CLI run one full check (`/update now`). | `skippedVersion` equals the bad version. The check decides `none` / `skipped` and **does not reinstall**. The other four fields (`autoInstalledVersion`, `lastGoodVersion`, `bootFailures`, `rolledBackFrom`) are **present**, because the rollback target is itself a build that knows them — if they are missing, something wrote this file that should not have, and **that is a finding, not the expected result**. |
| **15** | **A newer release clears the latch.** | Publish `<bad>`+1 to the scratch registry and check again. | It installs normally. The user was never opted out of updates, only out of the loop. |
| **16** | **Proxy fallback.** | On a machine where the registry is reachable only through a proxy (`npm config set proxy …`, with no `HTTP_PROXY` that undici would honour), run `aragon` and watch the log. | `update_check_via_npm { ok: true }`, and the check completes. `/update status` shows `probe: npm`. Without this fallback the machine logs a network failure forever. |

### What rows 12–16 do **not** cover

- The guard's own import chain (`guard → update/state → config/app-paths →
  env-paths`) is not `node:*`-only, so a release broken by a `node_modules` that
  lost `env-paths` takes the guard down with it. The launcher's dynamic import
  contains the damage — the failure becomes "no guard, and the CLI reports its
  own crash normally" rather than `ERR_MODULE_NOT_FOUND` from the bin entry —
  but there is no manual row for it, because constructing it means breaking a
  dependency by hand. If a real bad release is ever traced to this, revisit the
  trade (verdict condition 5).
- A release that dies **without running exit handlers** (`SIGKILL`, a native
  segfault, `process.abort()`) is never counted and never rolled back. That is
  the stated cost of counting failed exits instead of attempted boots, and it is
  the right side of the trade for a pure-JS CLI whose target failure is a module
  that will not import.

---

## Cleanup

```bash
npm config delete prefix          # only if row 11 set it
npm config delete proxy           # only if row 16 set it
rm -rf "$ARAGON_HOME"
npm i -g @aragon-agent/cli        # back to the current release
```

## Notes for whoever runs this next

- **The registry contract (P2-8) is checked by row 1 and by `aragon update
  --check --json`**, which is the only honest place for it: the document cannot
  re-verify itself. As of implementation, a live
  `GET https://registry.npmjs.org/%40aragon-agent%2Fcli/latest` answers with
  `name`, `version`, `engines` and `dist` exactly as §3.3 describes, and
  `aragon update --check --json` prints one `UpdateSnapshot` and exits 0.
- **Rows 1 and 2 must both be run on Linux, and row 1 also on Windows**
  (verdict condition 3). The prefix-resolution behaviour at the heart of row 11
  depends on the machine's own npm configuration and cannot be simulated
  offline — that is exactly why it is a manual row and not a unit test.
- If a row fails, the log is the first place to look, not the screen. The screen
  is designed to be empty.
