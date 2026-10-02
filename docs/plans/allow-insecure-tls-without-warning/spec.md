# Allow Insecure TLS Without the Node Warning — Implementation Specification

> **Document version:** v2
>
> **For the downstream engineer:** use `superpowers:test-driven-development` while implementing this specification, and run `superpowers:verification-before-completion` before handing it off.

**Goal:** Honor an explicit `NODE_TLS_REJECT_UNAUTHORIZED=0` setting without blocking execution or printing Node's standard insecure-TLS warning, both for the installed `@aragon-agent/cli` command and for the repository's official npm release workflow.

**Architecture:** A small CommonJS preload owned by the CLI package wraps `process.emitWarning` once per process. It drops only Node's exact `NODE_TLS_REJECT_UNAUTHORIZED` warning while the environment variable is exactly `0`, and forwards every other warning unchanged. The installed CLI imports this preload before application startup. `publish-latest.ps1` reuses the same file through `NODE_OPTIONS=--require ...`, so npm and its Node lifecycle children receive identical behavior during an official package release.

**Tech stack:** Node.js 18+, TypeScript/ESM, a CommonJS Node preload, Vitest, npm workspaces, and Windows PowerShell 5.1+.

---

## 评审记录

| Severity | Section | Dimension | Concern found in v1 | Resolution in v2 |
| --- | --- | --- | --- | --- |
| P1 | CLI startup sequence | Feasibility / consistency | “First application import” did not unambiguously place the preload ahead of React, Ink, Commander, and every local runtime module. With ESM, textual dependency order is part of the startup guarantee. | The exact import block and ordering invariant are now specified: Node built-ins first, the preload next, then all third-party/local value imports. A metadata regression test freezes that order. |
| P1 | Official npm release sequence | Completeness | v1 did not precisely preserve the difference between an absent `NODE_OPTIONS` variable and a present empty value, and its existing `exit 0` dry-run path made same-process restoration hard to prove. | The script now records presence and exact value separately, restores or removes the variable accordingly, and replaces the dry-run `exit 0` with `return` so `finally` and in-process tests are observable. |
| P1 | Official npm release sequence / risks | Feasibility | Quoting and duplicate detection for a Windows preload path containing spaces were descriptive rather than executable, while the path-with-spaces test was optional. | The appended fragment is fixed as `--require "<forward-slash absolute path>"`; comparison and escaping rules are explicit, and every release fixture must contain a space in its path. The existing real-Node CLI smoke proves Node can parse the resulting value. |
| P1 | Release integration tests | Completeness | Asserting that the parent test process retained `NODE_OPTIONS` after launching a separate PowerShell process is a false-positive: child processes cannot mutate their parent environment even if cleanup is broken. | Dedicated call-operator tests now execute the release script in the same PowerShell process and verify restoration on success, dry-run return, and failure, for both present and absent original variables. |
| P1 | Preload tests | Completeness | Requiring the same `.cjs` path twice normally exercises only CommonJS caching, not the global-symbol idempotency contract. | The idempotency case now deletes the require-cache entry before the second load (and also calls the exported installer twice on an injected target), so a second module evaluation is real. |
| P2 | Shared warning preload | Consistency | v1 allowed `restore` to delete the global-symbol state even when a later dependency had replaced `process.emitWarning`, weakening ownership of the wrapper chain. | `restore` is now a no-op unless both the symbol state and current function still belong to this installation; it never removes another wrapper's coordination state. |
| P2 | User-facing boundary | Completeness / right-sizing | The direct-`npm publish` boundary was documented, but the equivalent parent-process boundary for `npm install` and `npx` was implicit. | The runbook and README scope now state that the installed `aragon` process is covered, while an npm/npx bootstrap parent must be launched through an owner-controlled preload if quiet output is required. No Core-wide patch or extra CLI flag is added. |

No P0 concern was found. All P1 concerns above are resolved in the normative design and test plan below.

## Overview

Users sometimes deliberately disable certificate verification with `NODE_TLS_REJECT_UNAUTHORIZED=0`, typically for a controlled development proxy, a private endpoint with a self-signed certificate, or a temporary diagnostic environment. Node honors that setting but emits a process warning on the first TLS request. The current repository also goes further and rejects a real release from `publish-latest.ps1` when the setting is `0`. The requested behavior is to accept the user's explicit choice, leave the environment setting effective, remove the release-time rejection, and avoid printing the specific warning shown in the requirement.

This feature must be narrow. It must not set `NODE_NO_WARNINGS`, add `--no-warnings`, replace `stderr.write`, suppress deprecation warnings, or silently rewrite `NODE_TLS_REJECT_UNAUTHORIZED`. The connection remains insecure because that is what the user requested. Only the standard Node warning with the exact message below is removed:

```text
Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
```

The executable package owns the process output policy, so `@aragon-agent/cli` applies the behavior automatically in source runs and in the npm tarball. The official PowerShell release command also owns the npm child processes it launches and applies the same filter to them. The `@aragon-agent/core` library must not automatically patch a consuming application's global `process.emitWarning`: Core is dependency-injected, advertises zero host coupling, and declares `sideEffects: false`. Core users control their own process policy. No Core source, export, or package metadata is changed by this feature.

## Approaches considered

### 1. Shared exact-match `process.emitWarning` preload — selected

Node routes this warning through `process.emitWarning`. A preload can wrap that function before any network call, inspect the original warning object or string, and return only for the exact TLS message when the current environment value is `0`. The wrapper delegates all other calls to the saved original function with the original receiver and arguments. A `.cjs` file is deliberately used because Node can load it synchronously through `--require` before npm's own entry point, while the ESM CLI can import the same file for its side effect.

This is the only option that is selective, reusable by the installed CLI and npm release children, independent of terminal formatting, and testable without an external network.

### 2. `NODE_OPTIONS=--no-warnings` or `NODE_NO_WARNINGS=1` — rejected

This removes the target warning, but it also hides deprecations, experimental API notices, memory warnings, and warnings from dependencies. It creates a much broader behavioral change than requested and could conceal actionable release failures. It is not an acceptable fallback.

### 3. Filter warning text from stderr — rejected

Filtering the rendered two-line text in `process.stderr.write` or PowerShell output is fragile because Node adds a process id, may include trace text, and may split output into different chunks. The CLI's Ink console bridge and the release script's JSON-capture paths also rely on faithful stderr behavior. Intercepting the warning before rendering is safer.

Registering `process.on('warning')` is also insufficient: a listener observes the warning but does not stop Node's default stderr output.

## Technical design

### Shared warning preload

Create `packages/cli/runtime/insecure-tls-warning.cjs`. It is a CommonJS file outside `src/` so it can be required directly by Node without a TypeScript build. It must have no dependency other than globals provided by Node. The module exports its message constant and installer for testability, then calls the installer at module evaluation time.

The internal contract is:

```js
const INSECURE_TLS_WARNING =
  "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' " +
  'makes TLS connections and HTTPS requests insecure by disabling ' +
  'certificate verification.';

function installInsecureTlsWarningFilter(target = process) {
  // Returns an idempotent restore function.
}

module.exports = {
  INSECURE_TLS_WARNING,
  installInsecureTlsWarningFilter,
};

installInsecureTlsWarningFilter();
```

The implementation algorithm is fixed as follows:

1. Use `Symbol.for('@aragon-agent/cli.insecure-tls-warning-filter')` as a property key on the target process. If state already exists at that key, return its existing `restore` function. This prevents double wrapping when the release process preloads the module and the CLI later imports it.
2. Save `target.emitWarning` without binding it. Create a normal function wrapper rather than an arrow so Node's call receiver is not accidentally altered.
3. On every call, derive the warning message as follows: use the value directly when it is a string; use `.message` when it is an `Error`; otherwise do not treat it as a match.
4. Suppress the call only when both predicates are true at emission time: `target.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'` and the derived message is strictly equal to `INSECURE_TLS_WARNING`. Checking at emission time is load-order critical: the CLI may import the preload first and load `NODE_TLS_REJECT_UNAUTHORIZED=0` from a project `.env` later.
5. For every non-match, call `Reflect.apply(originalEmitWarning, target, argumentsArray)`. Forward all overload fields, including warning type, code, constructor, and options. Never reconstruct a warning.
6. Store `{ originalEmitWarning, wrappedEmitWarning, restore }` at the symbol key. `restore` is ownership-safe and idempotent: it restores the original and deletes the symbol state only when the state still equals this installation object **and** `target.emitWarning` still equals this module's wrapper. If either check fails, it does nothing; it must not overwrite a later wrapper or delete another installation's coordination state. Production does not call restore, but isolated tests may.
7. Do not read or write stdout/stderr, do not change the environment variable, and do not emit a replacement security notice.

Add `packages/cli/runtime/insecure-tls-warning.d.cts` beside the preload. It declares the message constant and installer/restore signature so the strict NodeNext TypeScript build accepts the side-effect import without an implicit-`any` module. This declaration is internal package plumbing, not a documented public subpath export.

### CLI startup sequence

Add the preload immediately after the existing `node:*` value imports and before React, Ink, Commander, or any local value import in `packages/cli/src/cli.tsx`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import '../runtime/insecure-tls-warning.cjs';

import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
```

This ordering is normative. Type-only imports may appear later with their owning module; no third-party or local runtime dependency may move above the preload. The relative path is intentional. From source, it resolves from `src/cli.tsx` to `runtime/`; after TypeScript emits `dist/cli.js`, the unchanged specifier resolves from `dist/cli.js` to the same package-level `runtime/` directory. The package's `files` allowlist must therefore include `runtime` in addition to `dist`, `skills`, `README.md`, and `CHANGELOG.md`.

The import evaluates before the CLI module body. Existing static dependencies do not perform TLS at module evaluation, and all provider, model discovery, and skill-download requests happen after command parsing/config loading. Because the wrapper checks the environment on each warning rather than only during installation, values loaded by `loadDotenv()` remain covered. No changes are needed in the Anthropic, OpenAI, Google, sandbox HTTP, or skill-fetch call sites.

### Official npm release sequence

`publish-latest.ps1` currently throws after release checks when the real npm command is used and `NODE_TLS_REJECT_UNAUTHORIZED` equals `0`. Delete that guard. Also update the nearby `$registryProbeEnabled` comment so it no longer refers to the removed guard.

Before the outer `try`, record environment ownership without collapsing absent and empty values:

```powershell
$nodeOptionsWasPresent = Test-Path Env:NODE_OPTIONS
$originalNodeOptions = if ($nodeOptionsWasPresent) { $env:NODE_OPTIONS } else { $null }
$nodeOptionsChanged = $false
```

Add `Enable-InsecureTlsWarningFilterForNodeChildren` near the npm command setup. It performs no action unless the environment value is exactly `0`. When active, it resolves `packages/cli/runtime/insecure-tls-warning.cjs` relative to `$PSScriptRoot`, verifies the file exists **before mutating the environment**, converts the canonical absolute path to forward slashes, and escapes any literal `"` for Node's option parser. The fragment placed in the environment is exactly this shape (the quotes are part of the value):

```text
--require "M:/absolute path with spaces/packages/cli/runtime/insecure-tls-warning.cjs"
```

When `NODE_OPTIONS` is non-empty, append one ASCII space and the fragment; otherwise set only the fragment. Before appending, normalize backslashes in the existing value and compare the complete `--require "<canonical path>"` fragment case-insensitively on Windows (ordinally on other platforms), with whitespace or string boundaries on both sides. If that complete fragment already occurs, leave the caller's value untouched; a bare path substring inside another option does not count. Set `$nodeOptionsChanged = $true` only after assignment succeeds. This deliberately avoids attempting to re-tokenize or rewrite unrelated caller options.

Add `Restore-NodeOptions` as a small companion. If this script changed the variable, restore the exact original string when `$nodeOptionsWasPresent` is true; otherwise remove `Env:NODE_OPTIONS`. If no change was made, do nothing.

Call the enable function as the first statement inside the existing outer `try`, before `Assert-RepositoryState` and therefore before every npm or direct Node invocation. Call the restore function in the existing `finally`, before `Pop-Location`. Replace the dry-run branch's `exit 0` with `return`; a script invoked with `-File` still exits successfully, while a script invoked with PowerShell's call operator returns to the caller and permits a real same-process restoration assertion. `finally` must run on normal completion, dry-run return, and exceptions.

npm, npm's lifecycle scripts, Vitest, TypeScript, the direct CLI smoke, and any other Node process launched by the release script inherit the preload. The preload suppresses only the exact TLS warning; other warnings still reach stderr and the existing JSON parsing logic.

The direct `Invoke-WebRequest` registry fallback is a PowerShell request, not a Node request, and is unchanged. If it cannot validate a certificate, its current catch path returns no usable fallback and npm's result remains authoritative.

The supported quiet release path is `./publish-latest.ps1`. A user who bypasses it and invokes the npm CLI directly is running a separate Node application owned by npm; this repository cannot patch that parent process from a package lifecycle child. The same boundary applies while `npm install` or `npx` is bootstrapping the CLI: once the installed `aragon` entry starts, its own preload is active, but the earlier npm/npx parent is outside the package's control. The runbook must state these boundaries and recommend the official script for releases when the setting is `0`; callers that require quiet npm/npx bootstrap output must preload the filter in the parent process themselves.

### Pack and publish behavior

The CLI package remains ESM and keeps `dist/cli.js` as its only bin. Add `runtime` to `packages/cli/package.json#files`; do not add a package export for the preload. `npm pack -w packages/cli --dry-run --json` must list both `dist/cli.js` and `runtime/insecure-tls-warning.cjs`. The `.d.cts` file may ship as part of the directory and has negligible size.

The Core package manifest, Core runtime exports, Core public API snapshot, lockfile dependency graph, and workspace versions do not change. No new dependency is introduced. Normal version bumps remain the responsibility of the existing release script.

## Sequence of operations

### Installed or locally built CLI

1. Node resolves `dist/cli.js` (installed) or the TypeScript entry (development).
2. The entry imports `runtime/insecure-tls-warning.cjs`; the module installs the idempotent wrapper.
3. The CLI parses commands. A command that needs configuration calls `loadConfig`, which may populate the environment from `.env`.
4. A provider or skill request starts a TLS connection.
5. If Node attempts to emit the exact insecure-TLS warning and the current environment value is `0`, the wrapper returns without delegating.
6. All networking behavior remains controlled by Node's environment setting. All unrelated warnings delegate unchanged.

### Official package release

1. PowerShell records the caller's original `NODE_OPTIONS`.
2. If `NODE_TLS_REJECT_UNAUTHORIZED` is `0`, it appends the shared preload using an absolute path.
3. Every npm command inherits the preload before npm's JavaScript entry point executes.
4. Release tests, builds, pack checks, registry probes performed by npm, and publish calls continue instead of hitting the former hard block.
5. npm's exact insecure-TLS warning is suppressed; unrelated child warnings remain visible.
6. The existing success, rollback, and resume paths remain unchanged.
7. `finally` restores `NODE_OPTIONS` and the working directory.

## File / module change plan

| File | Action | Intent |
| --- | --- | --- |
| `packages/cli/runtime/insecure-tls-warning.cjs` | Create | Define and auto-install the shared, exact-match, idempotent Node warning filter used by the CLI and release subprocesses. |
| `packages/cli/runtime/insecure-tls-warning.d.cts` | Create | Provide strict TypeScript declarations for the side-effect CommonJS import and test-visible installer. |
| `packages/cli/src/cli.tsx` | Modify | Import the preload before CLI application startup; do not change command behavior or provider call sites. |
| `packages/cli/src/__tests__/insecure-tls-warning.test.ts` | Create | Exercise the preload in isolated Node child processes, including a hermetic local TLS attempt, warning controls, real second evaluation, and ownership-safe restoration. |
| `packages/cli/src/__tests__/package-metadata.test.ts` | Modify | Assert the package allowlist ships `runtime` and the CLI source places the preload after Node built-ins but before every third-party/local value import. |
| `packages/cli/package.json` | Modify | Add `runtime` to `files`; do not add dependencies, bins, or public exports. |
| `packages/cli/README.md` | Modify | Document automatic behavior, the exact opt-in condition, security implications, and `.env` support. |
| `packages/cli/CHANGELOG.md` | Modify | Add an `Unreleased` fix entry stating that the explicit insecure-TLS setting is honored and only its standard Node warning is hidden. |
| `publish-latest.ps1` | Modify | Remove the insecure-TLS hard block, preload the shared filter for npm/Node children, preserve exact `NODE_OPTIONS` presence/value, restore it in `finally`, and make dry-run return instead of terminating a calling shell. |
| `scripts/tests/fake-npm.ps1` | Modify | Record the inherited `NODE_OPTIONS` beside each argument list so release tests can prove the preload reaches child commands without contacting npm. |
| `scripts/tests/publish-latest.tests.ps1` | Modify | Copy the runtime preload into mandatory path-with-spaces fixtures; verify publishing, Node parsing, inheritance, and same-process environment restoration on success/return/failure. |
| `npm-publish.md` | Modify | Replace the instruction to unset the environment variable with the allowed official-script workflow, a strong security caveat, and the direct npm/npx parent-process boundary. |

No other files are in scope. In particular, do not modify `packages/core/src/**`, `packages/core/package.json`, `package-lock.json`, provider fetch code, or the CLI config schema.

## Interface design

There is no REST, WebSocket, database, or persisted configuration interface.

### User-facing environment contract

```text
NODE_TLS_REJECT_UNAUTHORIZED=0
```

- Exact string `0`: Node certificate verification remains disabled, and the exact standard warning is suppressed by the CLI/official release flow.
- Missing, empty, `1`, `false`, or any other value: no warning is suppressed and existing Node behavior is preserved.
- The CLI must not create, delete, normalize, or persist this variable.
- A value from project `.env` has the same CLI runtime behavior because matching occurs when a warning is emitted.

No new CLI flag or config key is added. A second way to opt into insecure TLS would create conflicting precedence and is intentionally out of scope.

### Internal CommonJS interface

```ts
export const INSECURE_TLS_WARNING: string;

export function installInsecureTlsWarningFilter(
  target?: NodeJS.Process,
): () => void;
```

The zero-argument call is the production path. The injectable target and returned restore function exist for isolation and are not exported through `@aragon-agent/cli` package `exports`.

### Release CLI interface

The existing signature remains unchanged:

```powershell
./publish-latest.ps1 [-Bump patch|minor|major] [-DryRun] [-Resume]
```

The only behavioral change is that an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` no longer rejects a non-dry release and no longer causes the exact Node warning in npm children. Hidden test parameters retain their current meaning.

## Data model

No database or disk-backed state is added. The only in-memory state is stored on the Node process under a global symbol:

```ts
interface InstalledWarningFilterState {
  originalEmitWarning: NodeJS.Process['emitWarning'];
  wrappedEmitWarning: NodeJS.Process['emitWarning'];
  restore: () => void;
}
```

The state exists for the process lifetime unless restored. It contains no secrets and no environment snapshot. Reading the environment live is intentional. In PowerShell, two local variables hold the original `NODE_OPTIONS` string and whether it was changed; both are restored/discarded at script exit.

## Testing strategy

Implementation must start with failing tests.

### Preload tests

`insecure-tls-warning.test.ts` must use `spawnSync(process.execPath, ...)` so the test runner's own warning machinery and environment are never patched. Pass the absolute `.cjs` path through `--require` and use `encoding: 'utf8'` with a finite timeout.

The primary child script must be hermetic: start a local `node:net` server on `127.0.0.1` and an ephemeral port, issue an `node:https` request to it, close the server on response/error, and include a two-second forced cleanup. The raw server need not perform a TLS handshake; accepting the TCP connection is sufficient for Node to evaluate the environment setting and emit its built-in warning. The child also calls `process.emitWarning('control-warning')`.

Test cases:

1. Preload first, then set the environment to `0`, initiate the local TLS request, and assert exit `0`, target warning absent, and `control-warning` present. Setting the value after preload models `.env` loading.
2. With the environment unset, manually emit `INSECURE_TLS_WARNING`; assert it is present. This proves the filter does not hide a coincidentally equal warning without the explicit opt-in.
3. With value `0`, emit an `Error` whose message is exact; assert it is suppressed. Emit a near-match with one extra character and assert it is preserved.
4. Require the preload, delete only that file's entry from `require.cache`, then require it again before emitting a control warning. Assert the control appears exactly once. Also call the second module instance's exported installer twice on an injected process-shaped target and assert both calls return the same restore function. This exercises the global-symbol contract rather than CommonJS's ordinary one-evaluation cache.
5. On an injected target, install the filter, replace `emitWarning` with a later wrapper, call `restore`, and assert both the later wrapper and the installed symbol state remain untouched. In a separate clean target, assert restore returns the original function, deletes only its own state, and is idempotent.
6. Emit a warning using Node's type/code overload and assert the formatted type/code remains present, proving arguments are forwarded intact.

### Package metadata and tarball tests

Extend `package-metadata.test.ts` to parse `files` and assert it includes `runtime`. Parse the import region (do not rely on a loose whole-file `toContain`) and assert the preload import follows the four current `node:*` imports and precedes React, Ink, Commander, and every `./` value import. After building, inspect the dry-run pack JSON and require these paths:

```text
dist/cli.js
runtime/insecure-tls-warning.cjs
```

The check must fail if the runtime file is absent even when the package command itself exits `0`.

### Release integration tests

The fixture builder must copy the preload to `packages/cli/runtime/` in its temporary repository. Its generated base directory must contain a literal space on every platform (for example, `aragon release test <guid>`), rather than depending on the CI user's temp path. Extend the fake npm JSON line from `{ args }` to `{ args, nodeOptions }`, preserving the existing command-only reader and adding a full-record reader for the new assertions.

Add a resume fixture with a publishable CLI version. Around the invocation, save and restore the test process's `NODE_TLS_REJECT_UNAUTHORIZED` plus the presence and exact value of `NODE_OPTIONS` in `try/finally`; set the TLS variable to `0` and set an existing sentinel option such as `--trace-warnings`. Assert:

- the release result exits `0` and reaches the expected fake `publish` command;
- every fake npm record retains the sentinel and contains exactly one `--require` reference to `insecure-tls-warning.cjs`;
- the preload reference is quoted, absolute, uses forward slashes, and includes the fixture's space-containing segment;
- the existing direct `node packages/cli/dist/cli.js --version` smoke succeeds under that value, proving Node actually parses the option rather than merely proving that PowerShell propagated a string;
- output does not contain `Remove it before publishing` or the standard TLS warning;
- a static regression assertion confirms `publish-latest.ps1` no longer contains the former hard-block message.

Do **not** claim cleanup coverage by inspecting a parent after launching a separate PowerShell process. Add a same-process helper that invokes the fixture script with PowerShell's call operator (`&`) and captures success or a thrown error without terminating the test host. Use it for three focused lifecycle cases:

1. A successful `-Resume` run starts with a present sentinel value and ends with that exact value.
2. A `-DryRun` starts with no `NODE_OPTIONS` entry and, after the script returns, still has no entry. This test also freezes the required `return` behavior in place of `exit 0`.
3. An unauthenticated failure starts with a present sentinel value, throws, and still restores that exact value.

Each case restores the test suite's own environment in an outer `finally`. Together these cases exercise the release script's `finally` in the same process where it performed the mutation.

All existing dry-run, rollback, resume, scope, authentication, and publish-order assertions must remain green.

### Verification commands

Run these in order from the repository root:

```powershell
npm test -w packages/cli -- src/__tests__/insecure-tls-warning.test.ts src/__tests__/package-metadata.test.ts
npm run build -w packages/cli
npm pack -w packages/cli --dry-run --json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/publish-latest.tests.ps1
npm test
npm run build
```

Inspect pack JSON rather than relying only on exit status. No test may contact an external host or publish a real package.

## Acceptance criteria

1. With `NODE_TLS_REJECT_UNAUTHORIZED=0`, a local TLS attempt under the preload produces no standard insecure-TLS warning.
2. The same process still prints an unrelated control warning, including its warning type/code when supplied.
3. Setting the variable after preload installation is covered, so project `.env` loading works.
4. Any environment value other than the exact string `0` leaves all warnings untouched.
5. The locally built CLI and the npm tarball both resolve the side-effect preload successfully.
6. The CLI tarball contains `dist/cli.js` and `runtime/insecure-tls-warning.cjs`.
7. `publish-latest.ps1` does not reject the setting, and all npm/Node children inherit exactly one quoted exact-match preload even when the repository path contains spaces, while unrelated existing `NODE_OPTIONS` are preserved.
8. The release script restores the exact prior presence/value of `NODE_OPTIONS` on success, dry-run return, and failure, as observed by a caller in the same PowerShell process.
9. No provider request code, Core source, public API, lockfile dependency, or persisted config changes.
10. Documentation states clearly that TLS verification is genuinely disabled, recommends use only in a controlled environment, and distinguishes the covered installed CLI/official release processes from npm/npx parent bootstrap processes.
11. All focused, workspace, build, pack, and PowerShell integration checks pass.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Node changes the warning text in a future major version. | The warning becomes visible again. | Exact matching intentionally fails open: visibility is safer than suppressing the wrong warning. Cover supported Node versions in CI and update the constant only after observing a real upstream text change. |
| A broad match suppresses a user or dependency warning. | Diagnostics disappear unexpectedly. | Require both exact environment value and exact full message; do not use `includes`, prefix matching, regex, warning type alone, or stderr formatting. |
| The wrapper changes warning overload behavior. | Warning type, code, stack, or callsite could be corrupted. | Forward the untouched arguments with `Reflect.apply`; test string, `Error`, type/code, and near-match cases. |
| Two module instances wrap `process.emitWarning`. | Duplicate output or incorrect restoration. | Store installation state under `Symbol.for(...)` and make install/restore idempotent. |
| `.env` is loaded after the preload. | The filter could miss the user's setting. | Install early but evaluate `target.env` at each emission; include a late-setting child test. |
| The tarball omits the external runtime directory. | Installed `aragon` fails at startup with module-not-found. | Add `runtime` to the package allowlist, assert metadata, and inspect pack JSON for the exact path. |
| Quoting a preload path with spaces breaks `NODE_OPTIONS`. | Official release commands fail before npm starts. | Resolve an absolute path, normalize separators, quote it, preserve existing options, and force every release fixture path to contain a space; the direct real-Node smoke is the parsing oracle. |
| The release script leaks modified `NODE_OPTIONS`. | Later commands in a calling shell inherit unexpected behavior. | Preserve presence and value separately, use `return` for dry-run, restore in the outer `finally`, and test success/return/failure with the call operator in the same process. |
| Users infer that insecure TLS is now safe. | Credentials or package contents could be intercepted. | Keep a prominent README/runbook caveat. The feature respects the user's opt-in; it does not claim to mitigate the transport risk. |
| Automatic Core patching affects library consumers. | A dependency changes global process policy without host consent. | Keep the automatic import in CLI only and leave Core untouched. |
| Direct npm/npx commands still belong to their parent process. | Operators bypassing the official release script, or bootstrapping through npm/npx, may see Node's warning before the installed CLI starts. | Document the process boundary and direct release operators to `publish-latest.ps1`; callers owning another npm/npx process must preload the filter themselves. |

## Implementation order

1. Add the isolated child-process tests and metadata assertions; run them to confirm failure because the preload and package allowlist do not exist.
2. Create the `.cjs` preload and `.d.cts`, then add the CLI side-effect import and package allowlist entry. Run focused tests, build, and inspect pack JSON.
3. Add the failing path-with-spaces release-fixture and same-process lifecycle assertions, then replace the release guard with scoped `NODE_OPTIONS` preload setup/restoration and change dry-run `exit 0` to `return`. Run the full PowerShell integration suite.
4. Update CLI documentation, changelog, and npm runbook. Re-read the exact user requirement and this acceptance checklist.
5. Run every verification command above from a clean implementation diff. Do not weaken existing warning, release safety, or Core coupling tests to make the feature pass.

## 评审结论

**通过。** The selective preload is feasible with the current Node 18+/NodeNext/PowerShell stack, keeps Core's zero-host-coupling boundary intact, and is appropriately scoped to the installed CLI plus the repository-owned release process. The v2 changes resolve every identified P1 issue with normative implementation details and executable regression coverage; no P0 or unresolved P1 concern remains.

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

1. v2 的去重算法要求只要现有 `NODE_OPTIONS` 中出现规范化预加载路径就停止追加，
   但这会把 `--redirect-warnings="<preload>.log"` 等无关选项误判成已有预加载，
   与“恰好一个 `--require` 引用”的验收标准冲突。实现改为只识别带参数边界的完整
   `--require "<canonical path>"` 片段；路径只作为其他选项值的一部分时仍会正常追加。
2. Windows PowerShell 5.1 可以从父进程继承 `NODE_OPTIONS=` 并在首次检查时报告变量
   “存在且为空”，但启动任意子进程后，Env provider 都会把该条目归一化为“不存在”，
   即使调用方和发布脚本从未赋值。因此 v2 要求在执行 npm/Node 子进程后仍由同一
   PowerShell Env provider 观察到 present-empty，在该平台不可实现。修正后的实现于
   `finally` 使用 Win32 `SetEnvironmentVariableW` 重建底层空条目；当前 provider 仍受
   PowerShell 5.1 限制，但后续真实子进程会精确继承一个存在且为空的 `NODE_OPTIONS`。
   集成测试据此通过后续 Node 子进程验证底层环境合同，同时继续用同进程断言覆盖
   present-nonempty 和 absent 两种可观测状态。
