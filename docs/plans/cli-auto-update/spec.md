# CLI auto-update — design specification

- **Feature slug**: `cli-auto-update`
- **Package**: `@aragon-agent/cli` (`packages/cli`), bin `aragon`
- **Status**: designed, not implemented
- **Version**: **v2** (v1 → v2 after the design review recorded in **评审记录** below;
  every P0 and P1 is fixed in the body, not merely noted)

---

## 评审记录 (Review notes)

Reviewed section by section against the tree at `packages/cli` @ `0.5.9`, on the four
dimensions the review brief names — feasibility, completeness, consistency,
right-sizing. Every row below cites the file and line that decides it, because half
of these are cases where the design is *right about the principle* and wrong about
the mechanism the package actually provides.

The headline: **the shape of this feature is correct and should be built.** Sharing
the bottom row, the manifest-pins-us eligibility rule, the detached installer, the
apply-on-next-launch policy and the silence-by-default failure policy all survive
review unchanged, and several of them are better reasoned than the code they imitate.
What did not survive is the *wiring*: three of the P0/P1 findings are places where a
faithful implementer would land on a compile error or on a silent misbehaviour,
because the design assumed a seam this package does not have.

### P0

**P0-1 — `UpdateLine` rendering `null` collapses the budgeted row; §6.1 and §6.2
contradicted each other.** §6.2's last table row said `UpdateLine` "renders `null`" for
`idle` / `checking` / `up-to-date` / sub-threshold `failed`, while §6.1 decided the row
with `if (update)` — the truthiness of a **React node**. `<UpdateLine …/>` is a truthy
element even when its own `render` returns `null`, so in full-screen the row became
`<Box flexShrink={0}>{nothing}</Box>`, which is **zero rows**, and the one-row
invariant this whole file exists to protect is broken in the single most common phase.
The failure is exactly the one `BottomStatusRow.tsx`'s header and
`__tests__/bottom-status-row.test.tsx:64-75` ("holds one row in all four states") were
written for, and it would present as a transcript that silently gains and loses a row
as the updater changes phase. The precedent is unambiguous and was available:
`ActivityLine` **always** returns an element (`ui/ActivityLine.tsx:62`), and the
*caller* decides nullness (`ui/App.tsx:1764-1765`, `running && !overlayNode ? … : null`).
*Fixed*: §5.3 gains the pure predicate `shouldRenderUpdateLine(snapshot)`, §6.1 states
that the decision belongs to the caller, §6.2 states that `UpdateLine` returns
`React.ReactElement` and never `null`, and AC-25 pins the row at exactly one row across
every phase.

**P0-2 — `/update` had no route from `commands/builtins.ts` to the service.**
`CommandContext` (`commands/registry.ts:12-70`) carries `controller`, `state`,
`dispatch`, `notify`, `toast`, `persistConfig`, `followBudget?`, `refreshSkills` and
`applyAgentMode` — and nothing that can reach an `UpdateService`. `/fast`, `/team` and
`/todo` reach their subsystems through `controller` (`builtins.ts:326`), but §3.1
forbids `update/` from importing `agent/`, so this feature cannot use that seam; and
§7's Modified-files table did not list `commands/registry.ts` at all. As written,
`/update`, `/update now` and `/update skip` are unimplementable, and the omission is
the *guaranteed reporting surface* half of C-12.
*Fixed*: §4.4 and §5.3 define a narrow `UpdateCommandPort`, declared in
`update/types.ts` and consumed as an **optional** `update?:` field on `CommandContext`
(optional because the service is legitimately absent under `mode:'off'`, non-TTY and
CI, and because a required field would break every existing `CommandContext` fixture at
compile time). `commands/registry.ts` and the `CommandContext` construction in
`ui/App.tsx:978-994` are added to §7.

**P0-3 — U-4 (the lock carries the child's pid) is unimplementable in the order it was
stated.** The lock has to be held *before* the spawn, or two processes both start
`npm i -g`; but `child.pid` does not exist until *after* the spawn, and
`skills/lock.ts::tryCreate` (`lock.ts:126-145`) writes its payload at `wx`-create time.
A faithful mirror therefore necessarily writes the **parent's** pid, which is precisely
what U-4 forbids. The invariant was stated without its sequence, so the only way to
satisfy it as written was to lock after spawning — reopening the race the lock exists
to close.
*Fixed*: §3.7 now specifies the two-phase write — `wx`-create with the parent's pid
(that call **is** the mutual exclusion), then an in-place payload rewrite to the
child's pid preserving `uuid` and `startedAt` — and explains why the window between
them is safe rather than merely narrow: a crash in it leaves a parent-pid lock, which
the existing liveness probe (`lock.ts:104-111, 184-187`) reclaims correctly.

### P1

**P1-4 — `stdio: 'ignore'` and the `stderrTail` log record are mutually exclusive.**
§3.5 spawned with `stdio: 'ignore'`; §3.10 logged `update_install_failed` with a
`stderrTail`, and §5.4 budgeted `stderrTailChars: 500` for it. With `'ignore'` there is
no stream to tail, so the single most valuable diagnostic for a feature whose entire
contract is silence was unobtainable. Switching to a pipe is not the fix — D-10
requires the child to outlive the parent, and a piped child whose parent has exited
takes `EPIPE`.
*Fixed*: §3.5 redirects the child to a real file descriptor
(`stdio: ['ignore', fd, fd]` on a temp file under `<home>`), which survives parent exit
because it is a file and not a pipe; the parent reads and redacts the tail on `'exit'`
and unlinks.

**P1-5 — `timeout: 0` versus `UPDATE_LIMITS.installTimeoutMs`, with no stated
consumer.** §3.5 passed `timeout: 0` while §5.4 defined `installTimeoutMs: 300_000`.
An implementer resolving that contradiction the obvious way — wiring the limit into
`execFile`'s `timeout` — makes Node `SIGTERM` npm mid-write, which is the broken global
installation that D-10 and U-3 exist to prevent, and it fires on exactly the slow links
where a five-minute install is legitimate.
*Fixed*: §3.5 and §5.4 state that `installTimeoutMs` bounds the **UI phase and the lock
refresh only**, never the child; `timeout` stays `0` and `killSignal` is never set.

**P1-6 — `LogScope` is a closed union and `'update'` is not in it.**
`logging/logger.ts:34-53` declares `LogScope` as a closed union ("Closed set, not free
text"), and §7 did not list `logging/logger.ts`. Every `logger.info('update', …)` in
§3.10 is a compile error. This is byte-for-byte the trap `fast` fell into — recorded as
its own IF-2 in `docs/plans/fast-model-tier/spec.md`, shipped with the wrong scope, and
closed only by a later hardening round (W4).
*Fixed*: §3.10 and §7 add `| 'update'` to `LogScope`, with the same one-line rationale
the `'fast'` and `'history'` members carry.

**P1-7 — AC-1 is unsatisfiable while `cli.tsx` imports the service statically.**
`runOneShot` and `runInteractive` are in the **same module** (`cli.tsx:335`, `:488`), so
a static `import … from './update/service.js'` puts that module in `dist/cli.js`'s graph
and `aragon -p` evaluates it. The import-graph test AC-1 promises would fail, and the
honest reading of "executes zero lines" would be false. Note this is not merely a test
problem: the package builds with plain `tsc` (`package.json:47`, `tsconfig.json`
`rootDir: ./src`), so there is no bundler to tree-shake it away.
*Fixed*: §3.8 constructs the service through `await import('./update/service.js')`
inside the gate (and likewise in the `update` subcommand action); §3.1 requires
`ui/UpdateLine.tsx` to use `import type` for `update/types.js` so tsc erases the edge;
AC-1 is restated against the built `dist/` output, which is what the claim is actually
about.

**P1-8 — a successful install that does not update *this* root loops forever,
silently.** Classification finds the running root by path (§3.2), but the install is
`npm install --global`, whose destination comes from npm's own resolved `prefix`. A
user with `prefix=` set in `.npmrc`, or two Node installations, gets a **successful**
install into a different tree. §3.9 step 11's convergence then never happens: the local
version stays `0.5.9`, `pendingRestartVersion` stays `0.6.0`, and the next check
re-decides `install` — every interval, on every launch, forever. For a feature whose
contract is silence, an unbounded silent reinstall loop is the worst available failure
shape, and nothing in v1 could detect it.
*Fixed*: §3.5 adds post-install verification (re-read `<root>/package.json`; if the
version did not move, do **not** set `pendingRestartVersion`), a new
`reason: 'install-ineffective'` in §5.3 that latches `skippedVersion` so the version is
not retried, an advice line in §6.2, risk R-12, and AC-26.

**P1-9 — the install lock must not block the event loop, and §3.7 said it mirrors a
module that does.** `skills/lock.ts::acquireRootLock` busy-waits **synchronously** for
up to `LOCK_MAX_WAIT_MS = 5_000` through `Atomics.wait` (`lock.ts:93-95, 155-212`) and
**throws** when it gives up. That is right for a command a human typed and catastrophic
here: five seconds of frozen Ink render loop, triggered by a background timer, in a
feature that must be invisible. §3.7's own next sentence ("failure to acquire is not an
error … re-checks on the next tick") already implied a single attempt, so the section
disagreed with itself.
*Fixed*: §3.7 states that the update lock reuses the payload, TTL, liveness probe and
uuid-guarded release of `skills/lock.ts` but explicitly **not** its retry loop — one
`wx` attempt, no sleep, no throw — and C-9 in §2 is amended to say which half is being
inherited. AC-27 pins it.

### P2

| # | Finding | Disposition |
|---|---|---|
| P2-1 | §6.1 declared `update` as a **required** prop, but `__tests__/bottom-status-row.test.tsx:51-56` constructs `BottomStatusRow` without it, and `typecheck-scope.test.ts` proves the test tree is inside `tsconfig.test.json`. `npm run typecheck` would go red. | **Fixed** — `update?:`. |
| P2-2 | Glyph drift: §3.9 and DoD #10 quoted the literals `+ 0.6.0 installed …` and `~ updating …`, but §6.2 specifies `{check}` / `{arrowUp}`, which resolve to `✓`/`*` and `↑`/`^`. DoD #10 is a literal acceptance string and would be checked as written. `0.6.0...` likewise hardcodes what `{ellipsis}` owns (`ActivityLine.tsx:72` is the precedent). | **Fixed** in §3.9, §6.2 and DoD #10. |
| P2-3 | §3.8 claimed `aragon config …` executes zero update code, but bare `aragon config` calls `runInteractive(…, { initialOverlay: 'settings' })` (`cli.tsx:995-998`) and therefore *does* construct the service. | **Fixed** — the claim is narrowed to `config <subcommand>`, which is the form AC-1 can actually assert. |
| P2-4 | `ARAGON_UPDATE` had no stated behaviour for an unrecognised value. `config/env.ts` states the invariant three times (`:86-87`, `:177-180`, `:243-245`): an unparseable value is left **absent** so the config file underneath still wins. `ARAGON_TODO_FOLLOW` (`env.ts:219-224`) is the tri-state precedent — written through unvalidated, with the clamp as the single gate. | **Fixed** in §4.2. |
| P2-5 | `UPDATE_LIMITS.statusCompactCols: 60` sits next to `FAST_LIMITS.statusCompactCols: 100` (`fast/limits.ts:93-95`) with no stated reason for the difference, inviting a later "unification" that would truncate the update line early. | **Fixed** — §5.4 now says why (one short clause versus a multi-part chip). |
| P2-6 | §3.6's `dispose()` must be called on **both** teardown branches (`cli.tsx:470-485` has a `.then` and a `.catch`), the way `controller.dispose()` is. | **Fixed** — stated in §3.6 and §7. |
| P2-7 | §1.2 cites `budget.ts:55` for the arithmetic that is on `:58`; `:55` is `viewportRows`'s own declaration. | **Recorded, not fixed** — the reference resolves to the right function and the C-1 range in §2 (`:28-58`) is exact. |
| P2-8 | The registry response shape in §3.3 is stated as "verified during design" but the document cannot re-verify itself later. | **Recorded** — `manual-test.md` row 1 exercises the live endpoint, which is the only honest place for that check. |

### What was reviewed and found correct (no action)

Worth recording, because each of these is a place where the obvious alternative is
wrong and a later reader may try to "simplify" it:

- **U-1's two-level ascent** is right, and depends on a fact the design did not name:
  the package builds with plain `tsc` (`rootDir: ./src` → `outDir: ./dist`), so
  `src/update/install-source.ts` really does land at `dist/update/install-source.js`.
  Had a bundler been introduced, `import.meta.url` would resolve to `dist/cli.js` and
  the ascent would be off by one. §3.2 now records the dependency.
- **D-4's "does a manifest pin us"** is correct on this package's real install
  surfaces, and the Windows argument holds.
- **The four glyphs §6.2 uses already exist** — `arrowUp`, `check`, `midDot`, `warn`
  are all present in both tiers (`ui/glyphs.ts:56-62, 173-177, 244-248`), so the claim
  that no new glyph field is needed is true.
- **The three theme fields** `muted`, `noticeWarn` and `toast.success` all exist
  (`ui/theme.ts:46-49, 67`).
- **C-2's `inScope` regex** is exactly as described (`glyphs.test.ts:186-189`); adding
  `update` is a one-word change to the alternation.
- **C-4's both-halves rule** is exact (`config/store.ts:129-167` and `:188-233`), and
  `update` really is the eighth section.
- **No `semver` dependency exists** (`package.json:54-67`), so §3.4's hand-written
  comparator is not reinventing an available wheel.
- **`engines.node: ">=18"`** matches the §3.3 example manifest.

---

## 0. Requirement trace (需求映射)

| # | Requirement (as given) | Where it is satisfied |
|---|---|---|
| R-a | 项目现在没有自动更新功能，添加自动更新机制 | §3 — new `packages/cli/src/update/**` subsystem, started from `runInteractive` |
| R-b | 识别 npm 上有对应这个软件的新版本 | §3.3 registry check + §3.4 semver/engine decision |
| R-c | 静默自动更新 | §3.5 detached `npm install -g` child, zero prompts, zero stdout writes |
| R-d | 最下方提示用户更新情况 | §6 — the bottom status row gains a third occupant, `UpdateLine` |
| R-e | 类似 Claude Code | §1.2 — check in background, install silently, apply on next launch, one quiet line near the composer |
| R-f | 美观、优雅、顶级设计，符合人机交互最佳实践 | §6 — one row, never steals a row from the transcript, precedence rules, degradation ladder, guaranteed reporting surface `/update` |
| R-g | 稳健、可靠、顶级 | §3.2 eligibility ladder, §3.7 cross-process lock + throttle, §9 risk table; every failure mode is silent-and-logged rather than user-facing |

---

## 1. Overview

### 1.1 What is being built

`aragon` is published to npm as `@aragon-agent/cli` and is normally installed with
`npm i -g @aragon-agent/cli`. Today the installed copy is frozen forever: nothing in the
CLI ever looks at the registry, so a user who installed 0.4.x eighteen releases ago is
still running it, and the only signal that anything moved is a README they will not
re-read. This feature adds a background updater that (1) asks the registry, at most once
every few hours and at most once per machine per interval, what the `latest` dist-tag
resolves to; (2) decides whether that version is genuinely newer, non-prerelease,
non-deprecated and runnable on this Node; (3) installs it silently into the same global
installation the user already has, using the same package manager they used; and (4)
reports the outcome on exactly one line at the bottom of the terminal, immediately above
the composer, in the row that is already budgeted for transient status.

The running process is never mutated in place in any way it can observe. The new version
lands on disk and takes effect on the **next** launch of `aragon`; the current session
keeps running the code it started with. That is both the safe choice and the Claude Code
behaviour the requirement points at: the user sees `0.6.0 installed - restart to apply`
and restarts when they are between tasks, not when the updater decides.

Everything about the feature is opt-outable and, when off, byte-identical to today. The
updater is constructed in exactly one place (`runInteractive`), so `aragon -p`, `aragon
config …`, `aragon skills …` and every piped/CI invocation execute **zero** lines of update
code — a property §8.2 asserts rather than promises.

### 1.2 Why this shape

Three decisions carry the design, and each of them is a response to something already
written down in this repository.

**The notice does not get its own row.** `ui/layout/budget.ts:55` computes the transcript
viewport as `frameHeight - header - toast - composer - status`. In full-screen the root
box is a fixed height with `overflow="hidden"` and the bottom chrome is `flexShrink={0}`,
so an extra chrome row does not make the frame taller — Yoga takes the row out of the
transcript while `viewportRows()` keeps handing the old number to `ScrollViewport`,
`selectWindow`, `overlayMaxRows`, `popupMaxRows` and `todoRailRows`. `BottomStatusRow.tsx`
was created for precisely this reason when the activity line needed a home, and its header
spells the argument out. The update line is the *third* occupant of that same row with the
same precedence discipline. `AppShell.tsx` and `budget.ts` come out of this feature
unmodified, and a test asserts that they did.

**Eligibility is decided before anything is installed, and the criterion is "does a
manifest pin us".** The dangerous version of this feature runs `npm i -g` on a machine
where `aragon` came from `npx`, from a pnpm store, from a project's `node_modules`, from
volta, or from a clone of this monorepo — in every one of those cases the global install
either does not exist, is not what is running, or is actively wrong to touch. §3.2 defines
a ladder that classifies the running installation from its own real path and only auto-
installs for the one classification where an upgrade is meaningful and safe. Everything
else degrades to a one-line notice carrying the correct command for *that* manager.

**Every failure is silent.** The requirement says 静默. A background updater that cannot
reach the registry behind a corporate proxy, or cannot write to `/usr/lib/node_modules`
without sudo, must not turn into a recurring interruption — it logs, backs off
exponentially, and stays quiet. The single exception is a failure the user can actually
fix: after `UPDATE_LIMITS.failuresBeforeNotice` consecutive failures the line switches to
a muted, actionable `update failed - run: npm i -g @aragon-agent/cli`, once.

### 1.3 Non-goals (v1)

1. **Restarting the process.** Never. A running agent turn, a live subagent dispatch and an
   open plan review are all state a restart destroys. The line says "restart to apply"; the
   human decides when.
2. **Downloading or verifying the tarball ourselves.** `npm` already verifies the registry's
   `dist.integrity` SRI hash. Re-implementing that would add a hash path we would then have
   to keep correct, for no gain (D-9).
3. **Auto-installing for pnpm / yarn / bun / volta.** Detected and reported with the right
   command, not executed. Each has different global semantics and none of them can be
   validated from this machine (D-6).
4. **Rollback / pinning to an older version.** `aragon update --to <version>` exists as an
   explicit escape hatch; there is no automatic downgrade.
5. **Updating `@aragon-agent/core`.** It is a dependency of the CLI package and moves with
   it. There is no separate check.
6. **Any update activity in headless / CI / non-TTY.** §3.8.

---

## 2. Constraints inherited from the existing code

These are not preferences; each one has a failure mode already recorded in the tree.

| # | Constraint | Source |
|---|---|---|
| C-1 | The bottom chrome row is budgeted. Do not add an `AppShell` slot. | `ui/BottomStatusRow.tsx` header, `ui/layout/budget.ts:28-58` |
| C-2 | A new source tree is **not** scanned for hardcoded non-ASCII until it is added to the hardcoded directory list in `__tests__/glyphs.test.ts`. `team/`, `todo/` and `fast/` each paid for this. Adding `update/` to that regex is part of the same commit as creating the tree. | `__tests__/glyphs.test.ts` `inScope` |
| C-3 | Every user-visible character comes from `pickGlyphs(caps)` / `theme.symbols`. `src/ui/**` and the new `src/update/**` are ASCII-only trees. | `ui/glyphs.ts`, C-2 |
| C-4 | A new nested config section must be merged **by hand in both halves** of `config/store.ts` (`loadPersistedConfig` *and* `updatePersistedConfig`) and clamped by one gate used on read and write. Omitting the write half silently erases the section on the next partial patch — this package has paid for it twice (`todo` P0-1, `fast` R-10). | `config/store.ts:129-233`, `config/schema.ts:860-1004` |
| C-5 | Sections are **one level deep, scalars only**. The hand-written merge is only correct while that holds. | `config/store.ts:174-187` |
| C-6 | `<home>/state.json` is for UI bookkeeping scalars **only**; anything else opens its own file. | `config/ui-state.ts:1-28` |
| C-7 | Subprocesses are started with `execFile(cmd, argv[], { shell: false })`. No `exec`, no `shell: true`, no string-concatenated command lines. | `skills/fetch-source.ts:1-28` |
| C-8 | HTTP: `AbortController` timeout, `redirect: 'manual'` with the allow-check repeated on every hop, a running byte ceiling, injectable `fetchImpl`. | `skills/fetch-source.ts:464-524` |
| C-9 | Cross-process mutual exclusion uses a `wx` lock file with a pid + host + startedAt payload, a TTL, a liveness probe, and `> 1` unreadable confirmations before a lock is presumed abandoned. **Its retry loop is NOT inherited** — `acquireRootLock` busy-waits synchronously through `Atomics.wait` for up to 5 s and then throws, which is correct for a command a human typed and would freeze the Ink render loop here (P1-9, §3.7). | `skills/lock.ts:1-90`, `:93-95`, `:155-212` |
| C-10 | With the TUI mounted, a toast or a transcript notice is the **only** legal user-visible channel. A direct `stdout`/`stderr` write shifts the fixed frame permanently (invariant I-4). | `ui/use-startup-notices.ts:1-13` |
| C-11 | A tri-state flag declares its **positive** form first, or commander defaults the negative-only option to `true` and it silently overwrites persisted config. | `cli.tsx:860-930` |
| C-12 | A readout that may be suppressed on a narrow terminal must have a second, **guaranteed** reporting surface. | `ui/StatusBar.tsx:38-138`, `fast/limits.ts:93-95` |
| C-13 | `LogScope` is a **closed union**, not free text. A new subsystem that logs must add its member in the same commit or it does not compile. `fast` shipped with the wrong scope for a whole release by missing this (its IF-2). | `logging/logger.ts:34-53` |
| C-14 | A slash command reaches its subsystem only through a field on `CommandContext`. `/fast`, `/team` and `/todo` ride on `controller`; a subsystem that (by its own design) must not import `agent/` therefore needs its own **optional** port field, added to `registry.ts` and supplied where the context is built. | `commands/registry.ts:12-70`, `ui/App.tsx:978-994` |
| C-15 | A row rendered into the fixed frame decides its own presence **at the call site**, never by returning `null` from the component. An element that renders nothing still satisfies a truthiness test but occupies zero rows, which silently unbalances the budget. | `ui/ActivityLine.tsx:62`, `ui/App.tsx:1764-1765`, `ui/ToastStack.tsx` |
| C-16 | The package is compiled by plain `tsc` (`rootDir: ./src` → `outDir: ./dist`), with **no bundler**. Module-graph claims are therefore claims about `dist/`, and a static `import` is evaluated by every entry point in its file. | `packages/cli/package.json:47`, `tsconfig.json` |

---

## 3. Technical design

### 3.1 Module map

```
packages/cli/src/update/
  types.ts           UpdatePhase | UpdateSnapshot | UpdateEvent | InstallSource | LatestManifest
                     | UpdateCommandPort | shouldRenderUpdateLine (pure predicate)
  limits.ts          UPDATE_LIMITS - the single authority on every structural bound
  semver.ts          pure: parseSemver, compareSemver, isPrerelease, satisfiesNodeRange
  install-source.ts  pure-ish: selfPackageRoot, readSelfManifest, classifyInstallSource
  registry.ts        fetchLatestManifest(name, distTag, deps) - one small GET
  state.ts           <home>/update-state.json - read/write, never throws
  install-lock.ts    cross-process wx lock: skills/lock.ts's payload discipline, NOT its retry loop
  installer.ts       resolveNpmCli(), runNpmInstall() via execFile(process.execPath, ...)
  service.ts         UpdateService - state machine, scheduler, event stream
packages/cli/src/ui/
  UpdateLine.tsx     the one-row renderer (no state of its own, never returns null)
```

Dependency direction: `service.ts` → everything else in `update/`; `ui/` → `update/types.ts`
only. Nothing in `update/` imports React, Ink, `ui/`, or `agent/`. `update/` has no
dependency on `@aragon-agent/core` at all — it is a host concern.

Two rules make that direction real in the **built output** rather than only on paper
(C-16, P1-7):

1. `ui/UpdateLine.tsx` and `commands/registry.ts` import from `update/types.js` with
   **`import type`**, so tsc erases the specifier and `dist/ui/UpdateLine.js` carries no
   runtime edge into `update/`. `types.ts` holds types and one pure predicate; the
   predicate is the only value it exports, and `UpdateLine.tsx` does not import it (the
   caller does — C-15).
2. `cli.tsx` reaches `service.ts` only through `await import('./update/service.js')`
   (§3.8). A static import there would put the whole subsystem in `dist/cli.js`'s graph
   and make AC-1 false for `aragon -p`, which shares that module.

### 3.2 The eligibility ladder (`install-source.ts`)

`selfPackageRoot()` resolves the package root from **this module's own** URL:

```ts
// dist/update/install-source.js  ->  ../..  ->  the package root
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
```

> **Invariant U-1 — the level count is load-bearing and the failure is silent.**
> The count is only correct because this package is compiled by plain `tsc` with
> `rootDir: ./src` and **no bundler** (C-16), so `src/update/install-source.ts` really
> does land at `dist/update/install-source.js`. If a bundler is ever introduced,
> `import.meta.url` collapses to `dist/cli.js` and this ascent becomes off-by-one — so
> that build property is a dependency of this module, not a background detail.
> `cli.tsx::readVersion()` goes up *one* level because it lives at `dist/cli.js`; this
> module lives at `dist/update/install-source.js` and goes up *two*. An off-by-one yields a
> directory whose `package.json` may still parse (the monorepo root's does), so the updater
> would check a package that is not us. `readSelfManifest()` therefore returns `null` unless
> the parsed manifest has a `name` **and** a `version`, and AC-3 asserts
> `readSelfManifest()!.name === '@aragon-agent/cli'`. The package name is read from that
> manifest and never hardcoded in the registry URL, so a fork keeps working.
> `realpathSync` is mandatory: nvm, volta and `npm link` all put symlinks on this path, and
> the classification below is path-shaped.

`classifyInstallSource(root, env)` returns exactly one of:

| `InstallSource` | Detection (first match wins) | Auto-install? | Advice line |
|---|---|---|---|
| `dev-monorepo` | `basename(root) === 'cli'` and `basename(dirname(root)) === 'packages'` and `<root>/../../package.json` has a `workspaces` array | no | *(silent — a developer's clone is not out of date, it is checked out)* |
| `npx` | any path segment equals `_npx` | no | *(silent — npx already resolves `latest` on every run)* |
| `pnpm` | any path segment equals `.pnpm`, or `<root>/../../.pnpm` exists | no | `pnpm add -g @aragon-agent/cli` |
| `yarn` | path contains a `.yarn` or `yarn/global` segment | no | `yarn global add @aragon-agent/cli` |
| `bun` | path contains a `.bun` segment | no | `bun add -g @aragon-agent/cli` |
| `volta` | path contains a `.volta` segment, or `env.VOLTA_HOME` is a prefix of `root` | no | `volta install @aragon-agent/cli` |
| `npm-local` | the nearest ancestor `node_modules` **has a sibling `package.json`** | no | *(silent — a project manifest pins us; see D-4)* |
| `npm-global` | the nearest ancestor `node_modules` has **no** sibling `package.json` | **yes**, if writable | `npm i -g @aragon-agent/cli` |
| `unknown` | no ancestor `node_modules` at all | no | `npm i -g @aragon-agent/cli` |

> **D-4 — the global/local criterion is "does a manifest pin us", not "is this the npm
> prefix".** The obvious implementation derives the global prefix from `process.execPath`.
> That is wrong on Windows, where the bundled npm's default prefix is `%APPDATA%\npm` and
> has nothing to do with `C:\Program Files\nodejs`. It is also semantically weaker than what
> we actually need to know: auto-update is legitimate exactly when **no project manifest
> pins our version**. A `node_modules` with a sibling `package.json` is a project; one
> without is a global root (`%APPDATA%\npm\node_modules`, `/usr/local/lib/node_modules`,
> `~/.nvm/versions/node/vX/lib/node_modules` — none of them has a sibling manifest). The
> rule needs no subprocess, no prefix arithmetic and no platform branch.

Classification is followed by one runtime probe, because a path can look global and still
be unwritable: `fs.accessSync(dirname(root), constants.W_OK)`. On failure the source is
downgraded to notify-only with `reason: 'not-writable'` (the EACCES-on-Linux case, §9 R-2).

### 3.3 The check (`registry.ts`)

One `GET`, one small JSON document:

```
<registry>/@aragon-agent%2Fcli/<distTag>
```

The scope separator **must** be percent-encoded (`%2F`) — that is the documented registry
path form for scoped packages. `<registry>` resolves as
`config.update.registry` → `env.ARAGON_UPDATE_REGISTRY` → `env.npm_config_registry` →
`https://registry.npmjs.org`, and a value that does not parse as an `https:` (or
`http:` for a LAN mirror) URL falls back to the default rather than throwing.

Verified response shape (probed against the live registry during design):

```jsonc
{ "name": "@aragon-agent/cli", "version": "0.5.9",
  "engines": { "node": ">=18" },
  "dist": { "tarball": "…/cli-0.5.9.tgz", "integrity": "sha512-…" },
  "deprecated": "…"            // present only when the version is deprecated
}
```

Transport rules follow C-8 verbatim: `AbortController` at `UPDATE_LIMITS.checkTimeoutMs`,
`redirect: 'manual'` with at most `UPDATE_LIMITS.maxRedirects` hops, a running byte ceiling
of `UPDATE_LIMITS.manifestMaxBytes`, `User-Agent: aragon-agent-cli/<version>`, and an
injectable `fetchImpl` so every test is offline. Any non-2xx, any parse failure, any
timeout resolves to `null` — `fetchLatestManifest` **never throws**.

### 3.4 The decision (`semver.ts`)

`decideUpdate(local, manifest, nodeVersion)` returns
`{ action: 'install' | 'notify' | 'none', reason }`. It installs only when **all** hold:

1. `compareSemver(manifest.version, local) > 0` — strictly newer. (Numeric core compare;
   a prerelease sorts below its release, per semver §11.)
2. `!isPrerelease(manifest.version)` **or** `isPrerelease(local)` — a stable install is
   never moved onto a prerelease, even if someone points `latest` at one.
3. `manifest.deprecated === undefined` — never auto-install a version its own author
   deprecated.
4. `satisfiesNodeRange(manifest.engines?.node, process.versions.node)` — see below.
5. `manifest.version !== state.skippedVersion`.

`satisfiesNodeRange` handles the forms that appear in practice (`>=X`, `>=X.Y.Z`, `>X`,
`^X`, `X.x`, and `||`-joined unions of those) and **fails open** on anything it cannot
parse, matching npm's own default of warning rather than refusing. Failing *closed* here
would mean a syntax we did not anticipate silently freezes every user's updates forever —
the worse of the two errors. When the check fails closed on a range it *did* understand,
the action is `notify` with `reason: 'node-too-old'`, so the user is told to upgrade Node
rather than being left wondering.

### 3.5 The install (`installer.ts`)

```ts
// `logFd` is an fd on <home>/update-install.log, opened 'w' before the spawn.
execFile(process.execPath, [npmCliJs, 'install', '--global', `${name}@${version}`,
                            '--no-fund', '--no-audit', '--loglevel=error'],
         { detached: true, stdio: ['ignore', logFd, logFd], env: cleanEnv, timeout: 0 })
```

> **Invariant U-5 — the child's output goes to a FILE, and its lifetime is never
> bounded by us.** Two halves, and each closes a v1 contradiction (P1-4, P1-5).
>
> *A file, not `'ignore'` and not a pipe.* `'ignore'` leaves nothing to put in
> `update_install_failed`'s `stderrTail`, which is the one diagnostic a feature whose
> contract is silence actually needs; a **pipe** would break D-10, because a detached
> child whose parent has exited takes `EPIPE` on its next write. A real file descriptor
> is inherited across the detach and keeps working after the parent is gone. The parent
> reads the tail on `'exit'`, caps it at `UPDATE_LIMITS.stderrTailChars`, passes it
> through the existing redactor, logs it, and unlinks the file. If the parent died
> first, the next launch unlinks a stale log before opening a new one.
>
> *`timeout: 0`, and `killSignal` is never set.* `UPDATE_LIMITS.installTimeoutMs` bounds
> **the `installing` phase and the lock's refresh**, not the child: it decides when the
> UI stops saying "updating" and when the lock is treated as abandoned. Wiring it into
> `execFile`'s `timeout` would make Node `SIGTERM` npm mid-write — the broken global
> installation U-3 and D-10 exist to prevent — and it would fire precisely on the slow
> links where a five-minute install is the correct outcome.

> **Invariant U-2 — invoke npm's JS entry through `process.execPath`, never the `npm`
> shim.** On Windows `npm` is `npm.cmd`, and since the CVE-2024-27980 fix Node refuses to
> `execFile` a `.cmd` without `shell: true` — which C-7 forbids. `resolveNpmCli()` therefore
> probes, in order, `<dirname(process.execPath)>/node_modules/npm/bin/npm-cli.js` (Windows,
> nvm4w — verified present on the design machine) and
> `<dirname(process.execPath)>/../lib/node_modules/npm/bin/npm-cli.js` (POSIX). If neither
> exists, POSIX may fall back to a bare `npm` on `PATH` with `shell: false`; **Windows may
> not**, and the source degrades to notify-only. Running node's own binary also guarantees
> the update is installed by the same runtime that will execute it.

The `version` interpolated into the spec is the one that came back from the registry and
has already been through `parseSemver`; a value that does not match
`/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/` never reaches argv. With
`shell: false` and a validated argv this is not an injection surface, and the leading-`-`
rejection of `fetch-source.ts` rule 3 is satisfied by construction.

**`detached: true` with `stdio: 'ignore'`, then `child.unref()`.** The parent still receives
the `'exit'` event for as long as it is alive, so the UI transitions to `ready` normally;
but if the user quits mid-install the install *completes* rather than leaving a global
package half-written. The next launch's check then finds local === remote and does nothing.
Convergence, not bookkeeping.

`cleanEnv` is `process.env` minus `NODE_OPTIONS` (a `--require` hook inherited into npm is
an unnecessary surface) and with `npm_config_yes=true`, `ADBLOCK=1`, `DISABLE_OPENCOLLECTIVE=1`
to keep npm's postinstall banners from spawning anything interactive.

#### 3.5.1 Post-install verification — the exit code is not the outcome

> **Invariant U-6 — `npm` exiting 0 does not mean THIS installation moved.** §3.2
> classifies the running copy by **path**; `npm install --global` writes to the prefix
> **npm's own config** resolves. Those are the same directory on an ordinary machine and
> different directories on a machine with `prefix=` in `.npmrc`, or with two Node
> installations, or with a global root inherited from a version manager the user has
> since switched away from. In that case npm succeeds, the running root is untouched,
> and the state machine reaches `ready` on a lie.
>
> Left there, the consequence is not a one-off cosmetic error: the next launch reads
> `0.5.9` locally, `pendingRestartVersion` is `0.6.0` and never matches, so §3.9 step 11
> never clears it and the decision gate re-answers `install` — an unbounded silent
> reinstall, once per check interval, forever. That is the worst failure shape available
> to a feature that has promised to be invisible.

On the child's `'exit'` with code 0, and **before** any success is recorded, the
installer re-reads `<root>/package.json` through `readSelfManifest()` — the same
function, the same path arithmetic, no second notion of where we live:

- `manifest.version === target` → the install landed here. Set
  `pendingRestartVersion`, reset `consecutiveFailures`, release the lock, `phase: 'ready'`.
- `manifest.version !== target` → the install landed **somewhere else**. Do *not* set
  `pendingRestartVersion`. Record `reason: 'install-ineffective'`, set
  `skippedVersion = target` so the same version is never retried, log
  `update_install_ineffective { target, observed, root }`, and render the §6.2 advice
  line once. A newer release later clears `skippedVersion` in the normal way, so the
  user is not opted out permanently — only out of the loop.

The check costs one `readFileSync` of a file we already know how to parse, and it is the
only thing standing between this design and R-12.

### 3.6 The state machine (`service.ts`)

```
        idle ──check()──> checking ──none──> idle
                             │
                             ├─notify──> available        (terminal for the session)
                             └─install─> installing ──ok──> ready   (terminal)
                                              └─err──> failed ──backoff──> idle
```

`UpdateService` owns: the phase, the resolved `InstallSource`, the target version, a
listener set, and two `unref()`ed timers. Its public surface:

```ts
class UpdateService {
  constructor(deps: UpdateServiceDeps);       // clock, fetchImpl, execFileImpl, logger, config
  start(): void;                              // schedules the first check; idempotent
  snapshot(): UpdateSnapshot;
  subscribe(fn: (s: UpdateSnapshot) => void): () => void;
  checkNow(opts?: { force?: boolean }): Promise<UpdateSnapshot>;   // /update, aragon update
  installNow(version?: string): Promise<UpdateSnapshot>;
  skip(version: string): void;                // persists state.skippedVersion
  dispose(): void;                            // clears timers, drops listeners; NEVER kills the child
}
```

Scheduling: the first check fires `UPDATE_LIMITS.startupDelayMs` (3 s) after `start()` so it
can never contend with first paint; subsequent checks fire every
`config.update.checkIntervalMs` with ±15 % jitter (D-12, thundering-herd). Both timers are
`unref()`ed so a pending check never keeps `aragon` from exiting.

`dispose()` deliberately does **not** kill the installer child (U-3): killing a running
`npm install -g` is the one action in this feature that can leave the user's global
installation broken, and it would be triggered by the most ordinary event there is — the
user pressing Ctrl+C.

`dispose()` is called on **both** of `runInteractive`'s teardown branches — the
`.then()` and the `.catch()` of `instance.waitUntilExit()` (`cli.tsx:470-485`) — exactly
as `controller.dispose()` is, and it is idempotent for the same reason. The timers are
`unref()`ed, so a missed call cannot hold the process open; what it would leak is a
listener set and a subscription on a torn-down tree. The signal path
(`cli.tsx:430-433`) calls `process.exit()` and reaches neither branch, which is correct
and is *why* U-3 matters: the detached child survives that exit and completes.

### 3.7 Cross-process throttle and lock

Two separate mechanisms, for two separate races.

**Throttle** (`state.ts`): `lastCheckAt` in `<home>/update-state.json` is consulted before
every scheduled check. Ten terminals opened at once produce one registry request, not ten.
`checkNow({ force: true })` — i.e. a human typing `/update` — bypasses it.

**Lock** (`install-lock.ts`): inherits `skills/lock.ts`'s *payload discipline* (C-9) —
`wx` create, `{ pid, host, startedAt, uuid }`, `UPDATE_LIMITS.lockTtlMs` staleness,
liveness probe via `process.kill(pid, 0)`, `LOCK_UNREADABLE_CONFIRMATIONS = 2`, and the
uuid-guarded release that keeps a preempted holder from deleting its successor's lock
(`lock.ts:232-248`). It does **not** inherit that module's acquisition loop. Three rules
are specific to this feature:

> **Invariant U-4 — the pid in the lock is the INSTALLER CHILD's, and it gets there in
> TWO PHASES.** The child is detached and outlives the parent by design (§3.5), so a
> lock carrying the parent's pid is released — or judged stale by the liveness probe —
> while npm is still writing, and a second `aragon` starts a concurrent global install
> of the same package.
>
> The ordering constraint is real and v1 did not state it: the lock must be held
> **before** the spawn (or the race it exists to close is wide open), but `child.pid`
> does not exist **until after** it. `skills/lock.ts::tryCreate` writes its payload at
> create time (`lock.ts:126-145`), so a literal mirror can only ever write the parent's
> pid. Therefore:
>
> 1. `wx`-create the file with `{ pid: process.pid, host, startedAt, uuid }`. **This
>    call is the mutual exclusion** and nothing about it is advisory.
> 2. Immediately after `execFile` returns, rewrite the payload in place with
>    `pid: child.pid`, preserving `uuid` and `startedAt` (the uuid is what `release()`
>    matches on, and `startedAt` is what the TTL measures).
>
> The window between them is safe rather than merely narrow: a crash inside it leaves a
> lock naming a **dead parent**, which is exactly the case `lock.ts:184-187`'s liveness
> probe already reclaims. The lock is released on the child's `'exit'`, or reclaimed by
> TTL/liveness by whoever comes next.

> **Invariant U-5b — acquisition is a SINGLE non-blocking attempt.**
> `acquireRootLock` busy-waits synchronously through `Atomics.wait` for up to
> `LOCK_MAX_WAIT_MS = 5_000` and then throws (`lock.ts:93-95, 155-212`). That is right
> for `aragon skills install`, where a human is waiting and there is nothing else to do.
> Here it would freeze the Ink render loop for five seconds, from a background timer, in
> the feature whose entire requirement is 静默. So: one `wx` attempt, no sleep, no
> retry, no throw — `tryAcquireInstallLock()` returns `null` on `EEXIST` after the
> staleness/liveness check, and the caller treats that as information, not failure.

Failure to acquire is not an error: it means another process is already doing the work, so
this one records `phase: 'idle'`, `reason: 'locked'`, and re-checks on the next tick, at
which point the version is already installed.

### 3.8 Where the service is constructed — and where it is not

`runInteractive()` (`cli.tsx:335`) is the **only** construction site, gated by:

```ts
const updateEligible =
  !!process.stdout.isTTY && !!process.stdin.isTTY &&
  !process.env.CI && cfg.update.mode !== 'off';

if (updateEligible) {
  // DYNAMIC, and that is the whole of AC-1 (C-16 / P1-7). `runOneShot` lives in this
  // same module, so a static import would put `update/service.js` in `dist/cli.js`'s
  // graph and `aragon -p` would evaluate every module under `update/` — there is no
  // bundler here to shake it out. Fire-and-forget after `render()`: the service must
  // never be able to delay or fail the first frame.
  void import('./update/service.js').then(({ UpdateService }) => { /* construct, start */ });
}
```

`runOneShot()` / `runHeadless()` never construct it, so `aragon -p` executes zero update
code and its stdout is byte-identical to today (AC-1). `aragon config <subcommand>`,
`aragon logs …`, `aragon skills …` and `aragon --version` likewise.

Two deliberate exceptions, and both are named here rather than left for a reader to
discover:

- **`aragon update`** (§4.3) constructs the service directly — through the same dynamic
  import — and prints to **stdout**, because there the update *is* the command's output.
- **Bare `aragon config`** (no subcommand) is an interactive TUI: it calls
  `runInteractive(…, { initialOverlay: 'settings' })` (`cli.tsx:995-998`) and therefore
  *does* construct the service, exactly as a bare `aragon` does. That is correct — it is
  a full session with a settings overlay on top — but it means the AC-1 claim is about
  `config <subcommand>`, not about the word `config`.

`CI` is excluded on top of the TTY test because a CI runner with a pty allocated is
otherwise a machine that silently mutates its own global toolchain mid-pipeline (D-11).

### 3.9 End-to-end sequence (happy path)

1. `main()` → `buildProgram().parseAsync` → default action → `runInteractive(flags)`.
2. `makeController` resolves config; `cfg.update` is fully populated by §4.1's clamp.
3. Ink renders; the service is constructed and `start()`ed **after** `render()` so the first
   frame is never behind it. `phase: 'idle'`, nothing on screen.
4. +3 s: `checkNow()`. `state.lastCheckAt` is within `checkIntervalMs` → return `none`. (On a
   cold machine it is not, so:)
5. `classifyInstallSource` → `npm-global`, writable.
6. `fetchLatestManifest` → `{ version: '0.6.0', engines: { node: '>=18' } }`.
7. `decideUpdate('0.5.9', …, process.versions.node)` → `install`.
8. `tryAcquireInstallLock()` → held (parent pid), spawn, lock rewritten to the child's
   pid (U-4). `phase: 'installing'` → `UpdateLine` renders
   `{arrowUp} updating to 0.6.0{ellipsis}` (muted) in the bottom row whenever a toast and
   the activity line are not using it.
9. npm exits 0 → `readSelfManifest()` re-read: `version === '0.6.0'`, so the install
   landed **here** (U-6). `state.pendingRestartVersion = '0.6.0'`,
   `consecutiveFailures = 0`, the install log is tailed (empty on success), lock
   released, `phase: 'ready'`.
10. `UpdateLine` renders `{check} 0.6.0 installed {midDot} restart aragon to apply`
    (success colour) and the App pushes **one** toast at the same level. The line persists
    for the rest of the session; the toast expires on the normal TTL.
11. Next launch: `readSelfVersion()` is `0.6.0`, `pendingRestartVersion` matches → the state
    file clears it and logs `update_applied`. Nothing is shown.

Glyph names, not literals, from step 8 onward: `{arrowUp}` is `↑` or `^`, `{check}` is
`✓` or `*`, `{midDot}` is `·` or `-`, `{ellipsis}` is `…` or `...`, entirely according to
`pickGlyphs(caps)` (C-3). v1 spelled these steps with `~` and `+`, which are in neither
tier.

### 3.10 Logging

Scope `update`, through the existing `getLogger()` (`logging/logger.ts`).

> **`LogScope` is a CLOSED UNION and this feature must extend it in the same commit
> (C-13).** `logging/logger.ts:34-53` declares `LogScope` as an explicit union — "Closed
> set, not free text: a typo'd scope is a record nobody can filter on" — so
> `logger.info('update', …)` does not compile until `| 'update'` is added there, with the
> one-line rationale its `'fast'` and `'history'` neighbours carry. This is not a
> hypothetical: `fast` shipped an entire release logging under the wrong scope because
> the same line was missed (`docs/plans/fast-model-tier/spec.md`, IF-2), and it took a
> hardening round to close. `logging/logger.ts` is listed in §7 for exactly this word.

Records: `update_check_start`, `update_check_result`
(`{ local, remote, action, reason, source }`), `update_install_start`
(`{ version, cmd }`), `update_install_done` (`{ version, ms }`), `update_install_failed`
(`{ version, code, stderrTail }`), `update_install_ineffective`
(`{ target, observed, root }` — U-6), `update_skipped`, `update_applied`. `stderrTail`
comes from the install log file (U-5), is capped at `UPDATE_LIMITS.stderrTailChars` and
passes through the existing redactor — an npm error can echo a registry URL carrying an
auth token.

---

## 4. Interface design

### 4.1 Config keys — `config.json`, section `update`

The **eighth** nested section, after `apiKeys`, `skills`, `log`, `team`, `todo`, `retry`,
`fast`. Scalars only, one level deep (C-5).

| Key | Type | Default | Clamp | Meaning |
|---|---|---|---|---|
| `update.mode` | `'auto' \| 'notify' \| 'off'` | `'auto'` | unknown → `'auto'` | `auto` installs; `notify` only reports; `off` disables the subsystem entirely |
| `update.checkIntervalMs` | number | `14_400_000` (4 h) | `[900_000, 604_800_000]` | Minimum wall-clock between registry checks, machine-wide |
| `update.registry` | string | `''` | trimmed; non-`http(s)` → `''` | `''` = derive (§3.3) |
| `update.distTag` | string | `'latest'` | `/^[a-z0-9][a-z0-9._-]{0,63}$/i`, else `'latest'` | The dist-tag to track |

`clampUpdateConfig(raw)` is the single gate used on **both** read and write (C-4), and both
halves of `config/store.ts` gain the merge line. `aragon config set update.mode notify`
routes through `UPDATE_CONFIG_SET_KEYS` / `applyUpdateConfigSet` in `config/cli-commands.ts`,
mirroring `applyFastConfigSet` exactly.

### 4.2 CLI flags and environment

| Surface | Effect |
|---|---|
| `--update` / `--no-update` | Session-only override of `update.mode` (`auto` / `off`). **Positive form declared first** (C-11): `update.mode` is persisted, and a negative-only option would make commander default `opts.update` to `true` and silently overwrite a stored `off` on every run. |
| `ARAGON_UPDATE` | `0`/`off`/`false` → `off`; `notify` → `notify`; `1`/`on`/`true` → `auto`. **Anything else is left ABSENT**, so the config file underneath still wins — the invariant `config/env.ts` states three times (`:86-87`, `:177-180`, `:243-245`), and the reason a value like `ARAGON_UPDATE=disable` must not resolve to a default that looks permanently supplied. Parsed by the **positive list**, like `ARAGON_FULLSCREEN` / `ARAGON_MOUSE` — not by `envBool`, whose negative list disagrees on exactly those values. `ARAGON_TODO_FOLLOW` (`env.ts:219-224`) is the tri-state precedent: the recognised string is written through and `clampUpdateConfig` stays the single gate, so there is never a second validator that can disagree with the first. |
| `ARAGON_UPDATE_REGISTRY` | Registry base URL, below `config.update.registry` in precedence. |
| `npm_config_registry` | Read-only fallback; makes `aragon` inherit an enterprise mirror with no configuration. |
| `CI` | Any truthy value disables the subsystem (D-11). |

Precedence follows the existing chain in `config/load.ts`: **flags > env > config file >
defaults**.

### 4.3 `aragon update` — the subcommand

```
aragon update [--check] [--to <version>] [--json]
  --check          Report only; never install (equivalent to mode=notify for this run)
  --to <version>   Install an exact version (an explicit escape hatch, incl. downgrade)
  --json           Machine-readable result on stdout
```

Exit codes: `0` = up to date, or installed; `1` = check or install failed;
`2` = ineligible install source (the advice line is printed). Human output is three lines
at most; `--json` emits one `UpdateSnapshot` object. This is the **guaranteed reporting
surface** required by C-12 for a bottom-row readout that can be preempted, and the only
update path available to headless users.

### 4.4 `/update` — the slash command

Registered in `commands/builtins.ts` alongside `/fast`, `/team`, `/todo`:

| Input | Behaviour |
|---|---|
| `/update` | `notify(...)` a transcript block: current version, latest known, install source, phase, next check time |
| `/update now` | `checkNow({ force: true })`, bypassing the throttle; installs if eligible |
| `/update skip` | Persist `skippedVersion` = the currently offered version; the line disappears for good until a newer one appears |
| `/update off` | `persistConfig({ update: { mode: 'off' } })` + toast |

**The command needs a port, and `CommandContext` does not have one (C-14, P0-2).**
`/fast`, `/team` and `/todo` reach their subsystems through `ctx.controller`
(`builtins.ts:326`), because those subsystems live on `AgentController`. This one does
not, and by §3.1 it must not — so it needs its own field:

```ts
// commands/registry.ts — one added, OPTIONAL member on CommandContext.
  /**
   * The updater, when this session has one. `undefined` under `update.mode: 'off'`,
   * a non-TTY, or CI (§3.8), which is why it is optional rather than required: a
   * required field would also break every existing CommandContext fixture at compile
   * time. `/update` reports "updates are disabled for this session" when it is absent.
   */
  update?: UpdateCommandPort;
```

`UpdateCommandPort` is declared in `update/types.ts` and imported here with
**`import type`**, so `commands/` gains a type edge and no runtime edge (§3.1 rule 1):

```ts
export interface UpdateCommandPort {
  snapshot(): UpdateSnapshot;
  checkNow(opts?: { force?: boolean }): Promise<UpdateSnapshot>;
  skip(version: string): void;
  nextCheckAt(): number | null;
}
```

`UpdateService` satisfies it structurally, so nothing implements it explicitly and there
is no adapter to keep in sync. `ui/App.tsx:978-994` supplies the field where it builds
the context, next to `followBudget` — which is the precedent for an optional,
read-at-command-time member.

### 4.5 The registry contract

Request: `GET <registry>/<urlencoded-name>/<distTag>`, `Accept: application/json`,
`User-Agent: aragon-agent-cli/<version>`, no credentials ever attached (D-13 — an updater
that reads `_authToken` out of `.npmrc` becomes a credential-exfiltration surface the
moment `update.registry` is mis-set; private-registry users configure `update.registry` to
a mirror they can read anonymously, or set `update.mode: off`).

---

## 5. Data model

### 5.1 `PersistedConfig.update` / `CliConfig.update`

```ts
export interface UpdateConfig {
  mode: 'auto' | 'notify' | 'off';
  checkIntervalMs: number;
  registry: string;
  distTag: string;
}
export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  mode: 'auto', checkIntervalMs: 14_400_000, registry: '', distTag: 'latest',
};
```

### 5.2 `<home>/update-state.json`

A new file, a direct child of the home root, sibling of `state.json` and
`skill-usage.json`; `getUpdateStatePath()` is added to `config/app-paths.ts` and to the
LAYOUT comment at the top of that file.

> **Why not `state.json`.** C-6: that file is documented as UI bookkeeping scalars only, and
> its header names itself "the most inviting drawer in the codebase". This is cross-process
> coordination state with a completely different lifetime and failure policy. The rule
> exists precisely to stop the merge that looks convenient today.

```ts
export interface UpdateState {
  schema: 1;
  lastCheckAt: number;            // epoch ms; 0 = never
  lastKnownVersion: string;       // '' = unknown
  pendingRestartVersion: string;  // installed, awaiting a relaunch; '' = none
  skippedVersion: string;         // '' = none
  consecutiveFailures: number;
  lastFailureAt: number;
}
```

Failure policy copies `ui-state.ts` verbatim: per-field tolerance, whole-object fallback on
a wrong `schema`, atomic temp-file + rename + `chmod 0600` write, **never throws**. Losing
the file costs one extra registry request.

### 5.3 Runtime shapes (`update/types.ts`)

```ts
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'failed';

export interface UpdateSnapshot {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  source: InstallSource;
  /** Why we are not installing, when we are not. Drives the advice line. */
  reason?: 'up-to-date' | 'prerelease' | 'deprecated' | 'node-too-old' | 'skipped'
         | 'not-writable' | 'source-ineligible' | 'network' | 'install-failed' | 'locked'
         /** npm exited 0 but THIS root did not move — see U-6. */
         | 'install-ineffective';
  /** Copy-pasteable command for an ineligible source. */
  advice?: string;
  nextCheckAt: number | null;
  consecutiveFailures: number;
}

export type UpdateEvent =
  | { type: 'phase'; snapshot: UpdateSnapshot }
  | { type: 'log'; level: 'info' | 'warn'; msg: string };

/** The narrow surface `/update` sees (§4.4 / C-14). `UpdateService` satisfies it structurally. */
export interface UpdateCommandPort {
  snapshot(): UpdateSnapshot;
  checkNow(opts?: { force?: boolean }): Promise<UpdateSnapshot>;
  skip(version: string): void;
  nextCheckAt(): number | null;
}
```

`UpdateSnapshot` is a value object: the service replaces it wholesale on every transition,
so the React hook can use referential equality and never diff fields.

### 5.3a `shouldRenderUpdateLine` — the presence decision, and why it is not `null`

```ts
/**
 * Whether the bottom row has anything to say. PURE, and deliberately NOT expressed as
 * `UpdateLine` returning `null` (C-15 / P0-1).
 *
 * A component that returns `null` still satisfies `if (update)` at the call site — the
 * prop is a React ELEMENT, and an element is truthy however it renders. The row would
 * become `<Box flexShrink={0}>{nothing}</Box>`, which in full-screen is ZERO rows, and
 * the transcript silently gains a row for as long as the updater is idle and loses it
 * again the moment it has news. That is precisely the layout shift `BottomStatusRow`
 * exists to prevent, and `bottom-status-row.test.tsx`'s "holds one row in all four
 * states" is the assertion it would defeat.
 *
 * `ActivityLine` already settles the pattern: it ALWAYS returns an element, and
 * `App.tsx:1764-1765` decides presence at the call site with `running && !overlayNode`.
 */
export function shouldRenderUpdateLine(s: UpdateSnapshot): boolean {
  if (s.phase === 'available' || s.phase === 'installing' || s.phase === 'ready') return true;
  if (s.phase === 'failed') return s.consecutiveFailures >= UPDATE_LIMITS.failuresBeforeNotice;
  return false; // idle | checking
}
```

### 5.4 `UPDATE_LIMITS` (`update/limits.ts`)

Structural bounds, distinct from the four user-facing `update.*` policy keys — the same
split `TEAM_LIMITS` / `TODO_LIMITS` / `FAST_LIMITS` document.

| Key | Value | Why |
|---|---|---|
| `startupDelayMs` | `3_000` | Never contend with first paint |
| `checkTimeoutMs` | `8_000` | A background check has no user waiting; below `HTTP_TIMEOUT_MS` (15 s) on purpose |
| `installTimeoutMs` | `300_000` | A cold npm cache on a slow link is minutes, not seconds. **Bounds the `installing` PHASE and the lock refresh only — never the child.** It is not `execFile`'s `timeout` (that stays `0`, U-5): a `SIGTERM` here is the broken global install U-3 and D-10 exist to prevent, and it would fire on exactly the slow links where the wait is legitimate |
| `manifestMaxBytes` | `256 * 1024` | The `/latest` document is ~2 KB; this is the C-8 ceiling |
| `maxRedirects` | `3` | Matches `fetch-source.ts` |
| `lockTtlMs` | `600_000` | Longer than `skills`' 60 s: the holder is an npm install, not a file rename |
| `backoffBaseMs` | `1_800_000` (30 min) | First retry after a failure |
| `backoffMaxMs` | `86_400_000` (24 h) | Ceiling of the exponential |
| `failuresBeforeNotice` | `3` | Below this, failure is silent (§1.2) |
| `jitterRatio` | `0.15` | Thundering-herd spread |
| `stderrTailChars` | `500` | Bounded, redacted npm error tail, read from the install log file (U-5) |
| `statusCompactCols` | `60` | Below this the line renders its short form (§6.2). **Deliberately not `FAST_LIMITS.statusCompactCols`' 100** (`fast/limits.ts:93-95`): that governs a multi-part status chip competing with the context gauge for the same row, while this is one short clause that owns its row outright. Two numbers about two different things — do not unify them |

---

## 6. UI design

### 6.1 The third occupant of the bottom row

`ui/BottomStatusRow.tsx` gains one optional prop and one precedence rule. The whole change:

```tsx
export interface BottomStatusRowProps {
  mode: RenderMode;
  toasts: Toast[];
  activity: React.ReactNode;
  /**
   * `<UpdateLine>` when the updater has something to say, else `null` — and THE CALLER
   * DECIDES WHICH (C-15). OPTIONAL, because `bottom-status-row.test.tsx` and the
   * `App.tsx` fixtures construct this component without it and the test tree is inside
   * `tsconfig.test.json` (`typecheck-scope.test.ts`); a required prop turns
   * `npm run typecheck` red for a reason unrelated to this feature.
   */
  update?: React.ReactNode;
  theme: Theme;
}

export function BottomStatusRow({ mode, toasts, activity, update, theme }) {
  // A toast still wins: a transient ack is a RESPONSE TO THE USER.
  if (toasts.length > 0) return <ToastStack toasts={toasts} theme={theme} mode={mode} />;
  if (activity) return <Box flexShrink={0}>{activity}</Box>;
  if (update) return <Box flexShrink={0}>{update}</Box>;
  // The blank full-screen row that IS the budget must keep being emitted.
  return <ToastStack toasts={toasts} theme={theme} mode={mode} />;
}
```

> **`if (update)` tests a REACT ELEMENT, so `UpdateLine` may never return `null`
> (C-15 / P0-1).** An element whose render returns `null` is still truthy, so this branch
> would be taken and would emit a box of **zero rows** — the frame keeps its fixed
> height, Yoga hands the row to the transcript, and `viewportRows()` goes on reporting
> the old number to `ScrollViewport`, `selectWindow`, `overlayMaxRows`, `popupMaxRows`
> and `todoRailRows`. The transcript would gain a row while the updater is idle and lose
> it the moment it has news: the same shift-on-submit failure this file was created to
> prevent, on a slower clock.
>
> So `App` decides presence, exactly as it does for the activity line
> (`App.tsx:1764-1765`):
>
> ```tsx
> update={shouldRenderUpdateLine(updateSnapshot) ? <UpdateLine … /> : null}
> ```
>
> and `UpdateLine` is typed `React.ReactElement`, not `React.ReactElement | null`, so the
> compiler refuses the shortcut.

**Precedence: toast > activity > update > blank.** The update line is last because it is the
only one of the three that is *persistent*: it loses nothing by waiting for the run to end,
whereas an activity line deferred is an activity line that never renders. This also means a
user who is actively working never sees the updater at all until they stop — which is the
whole of 静默.

`AppShell.tsx`, `layout/budget.ts` and `viewportRows()` are **unmodified**; AC-2 asserts it.

### 6.2 The lines

Every character comes from `pickGlyphs(caps)` / `theme.symbols` (C-3). No new glyph field is
needed — `arrowUp`, `check`, `midDot` and `warn` already exist.

| Phase / reason | `cols >= 60` | `cols < 60` | Colour |
|---|---|---|---|
| `available` (notify mode, or ineligible source) | `{arrowUp} 0.6.0 available {midDot} npm i -g @aragon-agent/cli` | `{arrowUp} 0.6.0` | `theme.muted` |
| `installing` | `{arrowUp} updating to 0.6.0{ellipsis}` | `{arrowUp} 0.6.0{ellipsis}` | `theme.muted` |
| `ready` | `{check} 0.6.0 installed {midDot} restart aragon to apply` | `{check} 0.6.0 ready` | `theme.toast.success` |
| `failed`, `consecutiveFailures >= 3` | `{warn} update failed {midDot} npm i -g @aragon-agent/cli` | `{warn} update failed` | `theme.noticeWarn` |
| `node-too-old` | `{warn} 0.6.0 needs Node >=20 (running 18.19.0)` | `{warn} needs newer Node` | `theme.noticeWarn` |
| `install-ineffective` (U-6) | `{warn} 0.6.0 installed elsewhere {midDot} npm i -g @aragon-agent/cli` | `{warn} check npm prefix` | `theme.noticeWarn` |
| `idle` / `checking` / `up-to-date` / `failed` below threshold | *(`shouldRenderUpdateLine` is `false`, so the CALLER passes `null` and the row falls through to blank — see §5.3a and §6.1; the component itself never returns `null`)* | — | — |

Five glyph fields, all of which already exist in both tiers (`ui/glyphs.ts:56-62`,
`:170-177`, `:241-248`): `arrowUp`, `check`, `midDot`, `warn`, `ellipsis`. No new field is
needed, and no literal `...`, `+` or `~` may be spelled inline — `ActivityLine.tsx:72` is
the precedent for routing even the ellipsis through `pickGlyphs`.

`UpdateLine` is a pure function of `UpdateSnapshot + theme + caps + cols`, holds no state
and starts no timer. Its return type is `React.ReactElement` — never `null` (C-15). It
renders `<Text wrap="truncate">`, so a narrow terminal degrades by truncation rather than
by wrapping into a second row (which the fixed frame cannot afford).

### 6.3 The one toast

On the `installing → ready` transition **only**, `App` pushes exactly one toast:
`0.6.0 installed - restart aragon to apply` at level `info`. It exists because the moment of
completion may arrive while the user is reading the transcript with the row occupied; the
toast wins the row for its TTL and then hands it back to the persistent line. `App` guards
it with a `useRef` so a re-render can never push a second one.

### 6.4 Where it is *not*

Not in `StatusBar` (its left cluster is `flexShrink={0}` and every column it takes comes out
of the context gauge; an update chip is not run state). Not in the header (that row is
model + cwd + brand and is already width-critical). Not in the transcript (a `notice` would
scroll away and be re-emitted, and this is not part of the conversation).

---

## 7. File / module change plan

### New files

| File | Intent |
|---|---|
| `packages/cli/src/update/types.ts` | `UpdatePhase`, `UpdateSnapshot`, `UpdateEvent`, `InstallSource`, `LatestManifest`, `UpdateCommandPort` (§4.4), `shouldRenderUpdateLine` (§5.3a). |
| `packages/cli/src/update/limits.ts` | `UPDATE_LIMITS` — the single authority on every structural bound (§5.4). |
| `packages/cli/src/update/semver.ts` | Pure `parseSemver` / `compareSemver` / `isPrerelease` / `satisfiesNodeRange`; no dependency added. |
| `packages/cli/src/update/install-source.ts` | `selfPackageRoot`, `readSelfManifest`, `classifyInstallSource`, `probeWritable` (§3.2). |
| `packages/cli/src/update/registry.ts` | `fetchLatestManifest(name, distTag, deps)` — timeout, byte cap, manual redirects, injectable `fetchImpl`; never throws. |
| `packages/cli/src/update/state.ts` | `<home>/update-state.json` load/update; atomic, `0600`, never throws. |
| `packages/cli/src/update/install-lock.ts` | `wx` lock with `skills/lock.ts`'s payload discipline but **not** its retry loop: single non-blocking attempt (U-5b), two-phase write to the **child's** pid (U-4). |
| `packages/cli/src/update/installer.ts` | `resolveNpmCli()`, `runNpmInstall()` via `execFile(process.execPath, …)`, detached + unref (U-2, §3.5). |
| `packages/cli/src/update/service.ts` | `UpdateService` — state machine, throttle, scheduler, subscriptions, `dispose()`. |
| `packages/cli/src/ui/UpdateLine.tsx` | The one-row renderer; pure, ASCII-gated, truncating. |
| `packages/cli/src/__tests__/update-semver.test.ts` | Ordering, prerelease, engine ranges, fail-open. |
| `packages/cli/src/__tests__/update-install-source.test.ts` | The whole ladder on synthetic trees under `os.tmpdir()`; U-1's name assertion. |
| `packages/cli/src/__tests__/update-registry.test.ts` | Injected `fetchImpl`: 200 / 404 / 500 / timeout / oversize / redirect chain / bad JSON. |
| `packages/cli/src/__tests__/update-service.test.ts` | Fake clock + injected deps: every transition, throttle, backoff, lock contention, `dispose()` does not kill the child. |
| `packages/cli/src/__tests__/update-state.test.ts` | Round-trip, corrupt file, wrong schema, unwritable home. |
| `packages/cli/src/__tests__/update-line.test.tsx` | `ink-testing-library`: every phase × both glyph tiers × both width tiers. |
| `packages/cli/src/__tests__/update-bottom-row.test.tsx` | The precedence table, and that the blank full-screen row survives. |
| `docs/plans/cli-auto-update/manual-test.md` | Authored with the implementation (§8.3). |

### Modified files

| File | Change |
|---|---|
| `packages/cli/src/config/schema.ts` | `UpdateConfig`, `DEFAULT_UPDATE_CONFIG`, `clampUpdateConfig`; `update` added to `PersistedConfig`, `DEFAULT_CONFIG` and `CliConfig`. |
| `packages/cli/src/config/store.ts` | **Both** merge halves gain the `update` line (C-4). |
| `packages/cli/src/config/load.ts` | Resolve `update` across flags > env > file > defaults. |
| `packages/cli/src/config/env.ts` | `ARAGON_UPDATE`, `ARAGON_UPDATE_REGISTRY`; header comment list updated. |
| `packages/cli/src/config/cli-commands.ts` | `UPDATE_CONFIG_SET_KEYS` + `applyUpdateConfigSet`, mirroring the `fast` pair. |
| `packages/cli/src/config/app-paths.ts` | `getUpdateStatePath()` + the LAYOUT comment. |
| `packages/cli/src/cli.tsx` | `--update` / `--no-update` (positive first), `RawOpts`/`toFlags` entries **(site three of three — six features have paid for missing this line; see `cli.tsx:196-237`)**, the `update` subcommand, service construction via **dynamic `import()`** + `start()` inside `runInteractive` behind the §3.8 gate, `dispose()` on **both** teardown branches (`:470-485`). |
| `packages/cli/src/logging/logger.ts` | **Add `\| 'update'` to `LogScope`** (C-13). Without this word nothing in §3.10 compiles; `fast` shipped a release with the wrong scope by missing exactly this (its IF-2). |
| `packages/cli/src/commands/registry.ts` | One added **optional** member on `CommandContext`: `update?: UpdateCommandPort`, imported with `import type` (C-14 / §4.4). |
| `packages/cli/src/ui/App.tsx` | Subscribe to the service, hold the snapshot in local state, pass `update={shouldRenderUpdateLine(s) ? <UpdateLine …/> : null}` to `BottomStatusRow` (C-15), supply `update` on the `CommandContext` it builds at `:978-994`, push the one toast. |
| `packages/cli/src/ui/BottomStatusRow.tsx` | The third occupant + precedence (§6.1); the new prop is **optional**. |
| `packages/cli/src/commands/builtins.ts` | `/update` (+ `now` / `skip` / `off`), reading `ctx.update` and reporting "updates are disabled for this session" when it is absent. |
| `packages/cli/src/__tests__/glyphs.test.ts` | **Add `update` to the `inScope` regex.** Mandatory, same commit (C-2). |
| `packages/cli/README.md` | Auto-update section: what it does, the four config keys, how to turn it off. |
| `packages/cli/CHANGELOG.md` | New entry. |

**Explicitly unmodified**: `ui/layout/AppShell.tsx`, `ui/layout/budget.ts`, `ui/ToastStack.tsx`,
`agent/headless.ts`, `agent/controller.ts`, and everything under `packages/core/`.

---

## 8. Testing & acceptance criteria

### 8.1 Unit tests (Vitest, fully offline)

Every network call goes through an injected `fetchImpl`; every subprocess through an
injected `execFileImpl`; every clock through an injected `now()`. No test spawns npm, opens
a socket, or writes outside `os.tmpdir()` — and none deletes a directory returned by a
function (the `app-paths.ts` test-isolation contract).

Coverage highlights: `compareSemver` ordering incl. prerelease; `satisfiesNodeRange` for
`>=18`, `>=20.10.0`, `^20`, `18.x`, `>=18 || >=20`, and fail-open on garbage; the full
install-source ladder built as real directory trees; registry failures (404, 500, timeout,
oversize body, redirect loop, HTML instead of JSON); state-file corruption; lock contention
between two service instances; backoff growth and reset; and the `UpdateLine` matrix.

### 8.2 Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | `aragon -p "hi"`, `aragon --version` and `aragon config <subcommand>` execute zero lines from `src/update/**`. Asserted against the **built output** (C-16): `dist/cli.js` contains no *static* `import` specifier under `update/` — only the dynamic `import('./update/service.js')` — and `dist/ui/UpdateLine.js` contains no runtime specifier into `update/` at all (the type import is erased). A source-level import-graph test would pass while the claim was false, because `runOneShot` and `runInteractive` share a module. |
| AC-2 | `ui/layout/AppShell.tsx` and `ui/layout/budget.ts` are byte-identical to their pre-feature contents, and `viewportRows(rows)` returns the same value for every `rows` in `[10, 200]`. |
| AC-3 | `readSelfManifest()!.name === '@aragon-agent/cli'` (U-1). |
| AC-4 | With `update.mode: 'off'`, no timer is created, no file is read, no socket opened, and `BottomStatusRow` receives `update={null}`. |
| AC-5 | With `CI=1` or a non-TTY stdout, the service is never constructed. |
| AC-6 | A `dev-monorepo` install never installs and never renders a line. |
| AC-7 | An `npx` install never installs and never renders a line. |
| AC-8 | A `pnpm` / `yarn` / `bun` / `volta` install renders `available` with that manager's command and never spawns npm. |
| AC-9 | A non-writable `npm-global` root downgrades to notify with `reason: 'not-writable'`. |
| AC-10 | A prerelease `latest` is never auto-installed onto a stable local version. |
| AC-11 | A `deprecated` manifest is never auto-installed. |
| AC-12 | A manifest whose `engines.node` excludes the running Node yields `notify` + `node-too-old`, never `install`. |
| AC-13 | An unparseable `engines.node` fails **open** (installs). |
| AC-14 | Two service instances sharing a home: exactly one acquires the lock; the other reports `locked` and installs nothing. |
| AC-15 | `lastCheckAt` within `checkIntervalMs` suppresses the scheduled check; `checkNow({force:true})` does not. |
| AC-16 | Three consecutive failures back off to `backoffBaseMs · 2^n`, capped at `backoffMaxMs`; one success resets the counter. |
| AC-17 | Precedence: with a toast present the row shows the toast; with no toast and a run in flight, the activity line; with neither, the update line; with nothing, the blank budgeted row. |
| AC-18 | Every `UpdateLine` string in the ASCII glyph tier contains no byte outside `\x00-\x7f`, and `glyphs.test.ts` scans `src/update/**`. |
| AC-19 | The `installing → ready` transition pushes exactly one toast, even across ten re-renders. |
| AC-20 | `config set update.checkIntervalMs 5` writes the clamped `900000`, not `5` (both halves of the gate). |
| AC-21 | `/update skip` persists `skippedVersion`; the line disappears and does not return for that version. |
| AC-22 | `aragon update --check --json` prints one `UpdateSnapshot` on stdout and exits 0 without installing. |
| AC-23 | `dispose()` clears both timers and does **not** signal the installer child (U-3). |
| AC-24 | The version interpolated into argv always matches the strict semver regex; a manifest with `version: "1.0.0; rm -rf /"` never reaches `execFile`. |
| AC-25 | **(P0-1)** In full-screen, `BottomStatusRow` renders **exactly one row** for every `UpdatePhase` — including `idle` and `checking` — when `update` is supplied by the §6.1 call-site rule. Separately: `UpdateLine`'s return value is never `null` for any snapshot (`expect(render(...).lastFrame()).not.toBe('')`), so the guard cannot be satisfied by a component that renders nothing. Extends the existing "holds one row in all four states" case rather than replacing it. |
| AC-26 | **(P1-8 / U-6)** When the injected `execFileImpl` exits 0 but the target root's `package.json` still reports the old version, the service does **not** set `pendingRestartVersion`, reports `reason: 'install-ineffective'`, sets `skippedVersion` to the target, and a second check on the same version decides `none` — i.e. it does not reinstall. |
| AC-27 | **(P1-9 / U-5b)** Acquiring a held lock returns `null` **synchronously and without sleeping**: with a fake clock advanced by zero, `tryAcquireInstallLock` completes, returns `null`, and never throws. (A test that merely asserts the return value would pass against a five-second busy-wait; the clock assertion is the point.) |
| AC-28 | **(P0-3 / U-4)** After the spawn, the lock file's `pid` equals the child's pid while `uuid` and `startedAt` are unchanged from the `wx` write; and a lock left carrying a **dead parent's** pid is judged stale by the liveness probe. |
| AC-29 | **(P0-2)** `/update` with `ctx.update === undefined` reports that updates are disabled and touches nothing; with the port present, `/update skip` calls `port.skip(latestVersion)` exactly once. |
| AC-30 | **(P1-4 / P1-5)** `runNpmInstall` passes `stdio: ['ignore', fd, fd]` and `timeout: 0`, sets no `killSignal`, and on a non-zero exit logs a `stderrTail` that is non-empty, `<= UPDATE_LIMITS.stderrTailChars`, and redacted. |
| AC-31 | **(P1-6 / C-13)** `'update'` is a member of `LogScope`. Asserted by a type-level test (`const s: LogScope = 'update'`), so the guard cannot rot into a string comparison. |

### 8.3 Manual test pointers (`manual-test.md`, authored with the implementation)

Ten rows, of which four cannot be skipped: (1) a real global npm install on Windows and on
Linux, downgraded first with `npm i -g @aragon-agent/cli@0.5.8` so the check has something
to find; (2) an unwritable global prefix on Linux without sudo; (3) two terminals started
within a second of each other, verifying one registry request and one install; (4) quitting
the TUI mid-install and confirming the next launch reports the new version.

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Supply chain.** Auto-update widens the trust window: a compromised release reaches users without a human decision. | npm verifies `dist.integrity` end-to-end; we track only the `latest` dist-tag; `update.mode: 'off'` and `ARAGON_UPDATE=0` are documented kill switches; enterprises point `update.registry` at a mirror they control. This is an honest trade the README states plainly. |
| R-2 | **EACCES on a root-owned global prefix** (the common Linux case). | `probeWritable` catches it *before* spawning npm; the line becomes actionable advice. We never suggest `sudo`: the advice names the command, and the README points at a Node version manager as the durable fix. |
| R-3 | **EPERM / EBUSY on Windows** (antivirus, or a second `aragon` mid-launch holding a handle). | Treated as an ordinary install failure: logged, backed off, silent until three failures. Node closes module file handles after load, so the running session is unaffected. |
| R-4 | **The package directory is replaced while this process is running.** Bundled skills (`skills/skill-creator/SKILL.md`) are read lazily from that directory. | Node's ESM graph is fully loaded at startup, so no code page is re-read; the only exposure is a lazy bundled-skill read inside npm's rename window (sub-second). `SkillService` already surfaces a read failure as a normal error, and the next launch is clean. Accepted, documented, not mitigated further. |
| R-5 | **Corporate proxy.** Node's `fetch` (undici) ignores `HTTP_PROXY`. | The check fails, silently, forever, with a log record. This is the designed behaviour; `aragon update` gives such users an explicit path, and `update.registry` an internal mirror. |
| R-6 | **Thundering herd** on the registry from many machines. | ±15 % jitter plus the machine-wide `lastCheckAt` throttle. |
| R-7 | **A detached installer outliving its lock.** | The lock carries the **child's** pid, is released on the child's exit, and is otherwise reclaimed by liveness probe or the 10-minute TTL (U-4). |
| R-8 | **Notification fatigue** — the classic auto-updater failure. | Failure is silent below three occurrences; `ready` renders once and persists without re-announcing; the toast fires at most once per session; `/update skip` is one command. |
| R-9 | **A bad release bricks every user at once.** | Prerelease, `deprecated` and `engines.node` gates; `aragon update --to <version>` downgrades; the offending release can be `npm deprecate`d, which the gate then honours on the next check. |
| R-10 | **Config-section omission** in one half of `store.ts` silently erases `update`. | C-4 + AC-20; the failure is a named, twice-paid-for bug in this package. |
| R-11 | **The glyph scanner silently stops guarding** the new tree. | C-2 + AC-18, shipped in the same commit. |
| R-12 | **An install that succeeds into a different prefix loops forever** (P1-8). npm's `--global` destination comes from its own resolved `prefix`, which a user's `.npmrc` or a second Node installation can point away from the root §3.2 classified. | U-6's post-install verification: the version is re-read from the classified root, `pendingRestartVersion` is not set on a mismatch, and `skippedVersion` latches so the same version is never retried. AC-26. Without it, the failure is an unbounded silent reinstall once per interval — the worst shape available to a feature whose contract is silence. |
| R-13 | **The bottom row collapses to zero rows** and the transcript silently gains and loses a row (P0-1). | C-15: presence is decided at the call site, `UpdateLine` is typed to forbid `null`, AC-25 pins the row at exactly one row in every phase. |
| R-14 | **A background timer freezes the render loop** by inheriting `skills/lock.ts`'s 5-second synchronous busy-wait (P1-9). | U-5b: one non-blocking attempt, no sleep, no throw. AC-27 asserts against a fake clock, so a regression cannot pass by returning the right value slowly. |

---

## 10. Decisions

| # | Decision | Rationale |
|---|---|---|
| D-1 | The update notice shares the existing bottom row rather than adding an `AppShell` slot. | `budget.ts` would keep reporting the old viewport height; the transcript would silently draw one row short. `BottomStatusRow` exists for exactly this. |
| D-2 | Precedence is toast > activity > update. | The update line is the only persistent one of the three; deferring it costs nothing and keeps the working user undisturbed. |
| D-3 | Apply on next launch; never restart. | A restart destroys a live turn, a dispatch, and an open review. |
| D-4 | "Global" means *no project manifest pins us*, not *matches the npm prefix*. | Prefix arithmetic is wrong on Windows and answers a weaker question. |
| D-5 | Auto-install only for `npm-global`. | It is the only classification where the install target is unambiguous and verifiable from this machine. |
| D-6 | Other managers get advice, not execution. | Their global semantics differ and cannot be validated here; a wrong `pnpm add -g` is worse than a notice. |
| D-7 | Silent by default; visible only after three consecutive failures. | 静默 is a requirement; an unactionable recurring warning is the standard way updaters become hated. |
| D-8 | Invoke `node <npm-cli.js>`, never the `npm` shim. | `.cmd` cannot be `execFile`d without `shell: true` since CVE-2024-27980, and C-7 forbids the shell. |
| D-9 | Do not download or hash the tarball ourselves. | npm already verifies SRI; a second implementation is a second thing to get wrong. |
| D-10 | The installer child is detached and survives the parent. | Quitting mid-install must not leave a half-written global package; state converges on the next check. |
| D-11 | Inert under `CI` and under any non-TTY. | A pipeline that silently mutates its own toolchain is a worse bug than a stale CLI. |
| D-12 | ±15 % jitter on the check interval. | Machine fleets started by the same automation otherwise arrive together. |
| D-13 | Never read registry credentials from `.npmrc`. | An updater that attaches a token to a user-configurable URL is a credential-exfiltration primitive. |
| D-14 | `update-state.json` is its own file. | `state.json` is documented as UI bookkeeping scalars only (C-6). |
| D-15 | `satisfiesNodeRange` fails open. | An unparsed range must not freeze updates forever; npm itself only warns. |
| D-16 | Four config keys, no more. | `mode` covers on/notify/off; a fifth key (`autoInstall`) would be a second way to say the same thing. |
| D-17 | `checkIntervalMs`, not `checkIntervalHours`. | Every other duration in this config is in ms (`toolTimeout`, `idleTimeout`, `team.dispatchTimeoutMs`, `retry.initialDelayMs`); one unit per file. |
| D-18 | `/update` exists even though the line is usually enough. | C-12: a readout that can be preempted needs a guaranteed surface, and headless users need any surface at all. |
| D-19 | Presence of the update row is decided at the **call site**, not by `UpdateLine` returning `null`. | An element that renders nothing is still truthy, so the row would silently become zero rows. `ActivityLine` already settles the pattern (C-15 / P0-1). |
| D-20 | `/update` reaches the service through an **optional** `UpdateCommandPort` on `CommandContext`, not through `AgentController`. | The controller is how `/fast` and `/team` do it, but §3.1 forbids `update/ → agent/`; optional because the service is legitimately absent under `off` / non-TTY / CI, and because a required field breaks every existing context fixture (C-14 / P0-2). |
| D-21 | The install lock is written in **two phases** (parent pid at `wx`, child pid immediately after spawn). | The lock must precede the spawn and the child's pid must follow it; a crash in between leaves a dead-parent lock, which the existing liveness probe already reclaims (U-4 / P0-3). |
| D-22 | The lock is acquired with a **single non-blocking attempt**, not `skills/lock.ts`'s retry loop. | That loop is a synchronous 5-second busy-wait written for a human-typed command; from a background timer it is a frozen TUI (U-5b / P1-9). |
| D-23 | The installer child writes to a **file descriptor**, not to `'ignore'` and not to a pipe. | `'ignore'` leaves no diagnostic for the one feature that is silent by contract; a pipe dies with the parent and breaks D-10. A file survives both (U-5 / P1-4). |
| D-24 | A successful `npm` exit is **verified against the classified root** before success is recorded. | The exit code reports what npm did, not where; the two differ whenever npm's prefix is not the path we classified, and the untreated failure is an infinite silent reinstall (U-6 / R-12 / P1-8). |
| D-25 | `cli.tsx` reaches the service through a **dynamic** `import()`. | `runOneShot` shares that module and there is no bundler, so a static import makes AC-1 false for `aragon -p` (C-16 / P1-7). |

---

## 11. Definition of done

1. Every file in §7 exists with the stated intent; `AppShell.tsx`, `budget.ts`,
   `ToastStack.tsx`, `agent/headless.ts` and `packages/core/**` are untouched.
2. `npm run build`, `npm run typecheck` (**both** tsconfigs — `tsconfig.json` and
   `tsconfig.test.json`; the second is what catches the required-prop and closed-union
   regressions P2-1 and P1-6 describe) and `npm test` are green in `packages/cli`.
3. All 31 acceptance criteria in §8.2 have a named test.
4. `update` appears in the `inScope` regex of `__tests__/glyphs.test.ts`, and the scan is
   green over `src/update/**` and `ui/UpdateLine.tsx`.
5. Both halves of `config/store.ts` merge and clamp `update`; AC-20 proves it.
6. `getUpdateStatePath()` is listed in the `app-paths.ts` LAYOUT comment.
7. `packages/cli/README.md` documents the feature, the four keys, `ARAGON_UPDATE=0`, and the
   R-1 trade-off in plain language.
8. `docs/plans/cli-auto-update/manual-test.md` exists with the ten rows of §8.3, and the four
   unskippable rows have been run on Windows and on Linux.
9. `CHANGELOG.md` carries the entry.
10. A fresh `npm i -g @aragon-agent/cli@<previous>` followed by `aragon` produces, within one
    check interval, a silent install and the single line
    `{check} <new> installed {midDot} restart aragon to apply` — where `{check}` and
    `{midDot}` are whatever `pickGlyphs(caps)` resolves them to on that terminal
    (`✓` / `·` in the Unicode tier, `*` / `-` in the ASCII one). No literal `+` or `~`
    appears anywhere in the rendered output.
11. `'update'` is a member of `LogScope` and every §3.10 record compiles against it
    (C-13); `commands/registry.ts` carries the optional `update?` port and `/update`
    degrades cleanly when it is absent (C-14).
12. The two failure paths that v1 could not observe are exercised: an install that
    lands in a different prefix reports `install-ineffective` and does **not** retry
    (U-6 / AC-26), and a contended lock returns without sleeping (U-5b / AC-27).

---

## 实施过程发现的方案缺陷 (Issues found during implementation)

Six findings, recorded here rather than silently worked around. Three are real
defects in the design (IF-1, IF-3, IF-5); two are consequences the design did not
follow through (IF-2, IF-4); one is a small scope addition. Each names what was
implemented instead.

### IF-1 — `UpdateLine` cannot take `cols` AND stay type-only

§6.2 says `UpdateLine` is "a pure function of `UpdateSnapshot + theme + caps +
cols`", and §5.4 puts the width threshold in `UPDATE_LIMITS.statusCompactCols`.
Resolving `cols` against that threshold *inside* the component requires importing
`UPDATE_LIMITS` — a **value** — which contradicts §3.1 rule 1 and the second
clause of AC-1, both of which require `dist/ui/UpdateLine.js` to carry no runtime
edge into `update/`.

The three ways out are: duplicate the number in the component (which breaks
"`UPDATE_LIMITS` is the single authority"), import it (which breaks AC-1), or let
the caller resolve it. **Implemented: the caller resolves it.** `UpdateLine` takes
`compact: boolean`, and `ui/App.tsx` passes
`cols < UPDATE_LIMITS.statusCompactCols`. This is the same rule C-15 already
establishes for *presence* — the call site decides — so the component now takes
both of its decisions from one place instead of one from each.

### IF-2 — AC-1's "executes zero lines from `src/update/**`" is not literally true

`shouldRenderUpdateLine` lives in `update/types.ts` (§5.3a, §7) and is called by
`ui/App.tsx` (§6.1), which is **statically imported by `cli.tsx`**. So
`dist/update/types.js` — and `dist/update/limits.js`, which it needs for
`failuresBeforeNotice` — are in `dist/cli.js`'s graph regardless of what
`UpdateLine.tsx` does, and `aragon -p` evaluates both. The design cannot have all
three of: the predicate in `types.ts`, the caller deciding presence, and zero
`update/` modules in the headless graph.

**Implemented: the substantive half of AC-1, asserted precisely.** `dist/cli.js`
carries no *static* specifier under `update/`, so `service.ts`, `registry.ts`,
`installer.ts`, `install-lock.ts`, `state.ts`, `install-source.ts` and `semver.ts`
— every module that opens a socket, spawns a process or touches the filesystem —
are never loaded by `-p`. The two that are loaded are pure: `limits.ts` imports
nothing at all and `types.ts` imports only `limits.js`, with no I/O, no timers and
no side effects. `update-wiring.test.ts` asserts all of that, including the purity
of those two modules, so the exemption cannot quietly widen.

### IF-3 — `execFile` forwards neither `stdio` nor `detached`, so §3.5 is unimplementable as written

§3.5 spells the spawn as
`execFile(process.execPath, [...], { detached: true, stdio: ['ignore', fd, fd], timeout: 0 })`.
`execFile` builds its **own** pipes so it can buffer the output it hands to its
callback, and it passes only `cwd`, `env`, `gid`, `uid`, `shell`, `signal`,
`windowsHide` and `windowsVerbatimArguments` through to `spawn`. Measured on this
package's own Node: with `stdio: ['ignore', fd, fd]` the log file stays **empty**
and the bytes arrive in the callback's `stdout` instead.

Written as designed, **U-5 silently loses its `stderrTail`** (the one diagnostic a
feature whose contract is silence actually needs) **and D-10 silently loses the
detach** (so quitting mid-install can leave a half-written global package — the
exact outcome U-3 exists to prevent). Both failures are silent and platform-
independent.

**Implemented: `spawn` with an argv array and an explicit `shell: false`.** That
satisfies C-7's actual requirement — "argv array, never a shell, never a
concatenated command line" — and it has no `timeout` option at all, so P1-5's
"the limit must never become the child's bound" now holds **structurally** rather
than by remembering to leave a field at `0`. `update-service.test.ts` asserts
`detached`, `shell: false`, the fd pair, and the absence of both `timeout` and
`killSignal`.

### IF-4 — the service arrives after `App` mounts, so it cannot be a prop

§3.8 constructs the service through a dynamic `import()` fired **after**
`render()`, and §6.1/§7 have `App` subscribing to it. Those cannot both hold with
an ordinary prop: the service does not exist when `App` mounts, and on a cold
module cache it may not exist for several frames.

**Implemented: `UpdateBridge`**, a mutable `{ service, onAttach }` object created
before `render()` — byte-for-byte the shape `ConfirmBridge` and `HumanInputBridge`
already use for the same reason. It is a plain interface in `update/types.ts`, so
`cli.tsx` builds one with an object literal and needs no runtime import. `App`
reads `bridge.service` first and installs `onAttach` second, because **both
arrival orders happen** and a version that only handled one would work on a warm
cache and fail on a cold one.

### IF-5 — AC-25's proposed assertion cannot discriminate

AC-25 says `UpdateLine`'s return value is never `null`, "asserted by
`expect(render(...).lastFrame()).not.toBe('')`". That assertion **fails on the
correct implementation and cannot detect the incorrect one**: for `idle` and
`checking` the component returns a legitimately blank one-row element, Ink trims
trailing whitespace, and the frame is `''` — exactly what a `null` return also
renders as.

**Implemented: the assertion is on the return value.** `update-line.test.tsx`
calls `UpdateLine(...)` directly and checks `React.isValidElement`, across every
phase × both glyph tiers × both width tiers; the one-row property is asserted
separately on the frame. The compiler enforces the same thing statically through
the `React.ReactElement` return type, and `update-bottom-row.test.tsx` exercises
the real §6.1 call-site rule.

### IF-6 — three `app-paths.ts` accessors, not one

§5.2 adds `getUpdateStatePath()`. §3.5 also needs a path for the install log
("a temp file under `<home>`") and §3.7 one for the `wx` lock, and `app-paths.ts`'s
header states that path arithmetic lives there and nowhere else — "two copies of a
name is exactly the shape that lets a rename land in one of them and not the
other". **Implemented: `getUpdateStatePath()`, `getUpdateLockPath()` and
`getUpdateInstallLogPath()`**, all three listed in that file's LAYOUT comment.

### Smaller notes

- **Two extra test files.** §7 names seven; the implementation adds
  `update-config.test.ts` (AC-20 — both `store.ts` merge halves, the clamp, and
  the four resolution layers) and `update-wiring.test.ts` (AC-1's import graph,
  AC-29's `/update` port). Those two ACs have no natural home in the seven, and
  AC-20 guards a bug this package has shipped twice.
- **`UpdateSnapshot` gains `requiredNode?` / `runningNode?`.** §6.2 specifies the
  row as `<warn> 0.6.0 needs Node >=20 (running 18.19.0)`; neither number is
  derivable from anything else on the object. The line degrades to "needs a newer
  Node" when they are absent.
- **`--to` is validated in `cli.tsx` as well as in the installer.** `runNpmInstall`
  rejects a malformed version (AC-24), but by then it has been written into the
  snapshot and the lock has been taken and released — so `aragon update --to
  "1.0.0; rm -rf /"` would render the attacker's string in the bottom row and burn
  a consecutive-failure. Validated up front, it exits 1 with a usage message.
- **`satisfiesNodeRange('18.x', …)` was wrong on the first implementation** and
  the unit test caught it: a bare partial has no operator, so it lands on `=`, and
  zero-padding it turns "any 18.y.z" into "exactly 18.0.0". The failure direction
  is the bad one — a Node that *does* satisfy the range is told it does not. Fixed
  with a `specified` count on the clause.
- **14 existing test fixtures build a `CliConfig` by hand** and needed
  `update: DEFAULT_UPDATE_CONFIG`, exactly as they carry `fast: DEFAULT_FAST_CONFIG`.
  That is the `fast` precedent, not a new burden.

---

## 评审结论 (Review verdict)

### 有条件通过 — approved with conditions

The design is sound and should be implemented. Its three load-bearing judgements — share
the budgeted bottom row instead of adding an `AppShell` slot, decide eligibility by "does
a project manifest pin us" rather than by npm-prefix arithmetic, and apply on the next
launch rather than restarting — are each correct, each better reasoned than the obvious
alternative, and each traceable to a failure this package has already paid for. The
right-sizing is good: four config keys, one row, one new state file, no new dependency,
and an explicit non-goals list that declines the three things (self-restart, tarball
verification, multi-manager installs) that would have tripled the surface for no user
benefit. Nothing in it is over-engineered, and the one place it was under-specified —
what happens when npm succeeds but nothing changed — is now the most valuable paragraph
in §3.5.

All nine P0/P1 findings are **fixed in this v2**, not deferred: the collapsing row (P0-1),
the missing `/update` port (P0-2), the unimplementable lock ordering (P0-3), the
unobtainable `stderrTail` (P1-4), the `timeout` contradiction (P1-5), the closed `LogScope`
(P1-6), the unsatisfiable AC-1 (P1-7), the infinite silent reinstall (P1-8), and the
event-loop-freezing lock acquisition (P1-9). Six of eight P2s are fixed; the two that are
not are recorded with the reason.

Approval carries four conditions, all discharged during implementation rather than by
further design work:

1. **The four one-word wiring edits ship in the same commit as the tree they serve.**
   `| 'update'` in `LogScope`, `update` in `glyphs.test.ts`'s `inScope` alternation,
   `update?:` on `CommandContext`, and the `update` line in `cli.tsx::toFlags`. Each is a
   single token whose omission is silent or near-silent, and this package has an
   unbroken record of paying for exactly these: `fast`'s IF-2 for the log scope, three
   features for the glyph regex, and six for the `toFlags` line (`cli.tsx:196-237`).
   Verified by DoD #4 and #11.

2. **AC-25, AC-26 and AC-27 are written before the code they cover**, because all three
   guard failures that a manual test cannot see: a row that is one short, an install that
   succeeded into the wrong tree, and a lock that returns the right answer five seconds
   late. Each is trivially made vacuous by a test that asserts the return value alone,
   which is why each names the *mechanism* it must assert against — the frame's row
   count, a second check on the same version, and a fake clock that never advances.

3. **The first real end-to-end run is the one in DoD #10, and it is done on both
   Windows and Linux** before the feature is considered done — with the Linux run
   performed against an unwritable global prefix at least once (`manual-test.md` row 2).
   Everything else in this document is verifiable offline with injected `fetchImpl` /
   `execFileImpl` / `now()`; the prefix-resolution behaviour at the heart of R-12 is the
   one thing that is not, because it depends on the machine's own npm configuration.

4. **`manual-test.md` gains an eleventh row for the `install-ineffective` path** — set
   `prefix` in a scratch `.npmrc`, let one install run, and confirm the second check
   decides `none` rather than reinstalling. This is the only condition that adds scope
   to §8.3, and it is worth it: it is the single failure mode in this design that is both
   invisible to the user and unbounded in time.

One judgement is recorded without being made a condition, for whoever revisits this. The
supply-chain widening in R-1 is real, and the mitigation ("npm verifies SRI, and there
are kill switches") is honest about being a trade rather than a fix. Defaulting
`update.mode` to `'auto'` is the right call for a CLI whose users are overwhelmingly on
a stale version they did not choose — but it is a *product* decision, not a technical
one, and it deserves to be re-confirmed by a human before the first release rather than
inherited silently from this document.
