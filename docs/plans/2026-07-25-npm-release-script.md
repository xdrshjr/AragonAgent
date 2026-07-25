# Automated npm Release and `aragon` Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a tested PowerShell command that versions, verifies, and publishes Core then CLI, and make `aragon` the CLI's only installed executable.

**Architecture:** `publish-latest.ps1` owns release orchestration and runs from its own directory against the two npm workspaces. It delegates all registry operations to an overridable npm executable so a PowerShell integration test can exercise versioning, rollback, dry-run, and resume behavior without contacting npm. Package metadata and CLI help use one canonical executable name: `aragon`.

**Tech Stack:** PowerShell 5.1+, npm workspaces, Node.js/TypeScript, Vitest, Git.

---

### Task 1: Specify and implement the `aragon` executable contract

**Files:**
- Create: `packages/cli/src/__tests__/package-metadata.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/cli.tsx`
- Modify: `packages/cli/README.md`
- Modify: `README.md`

**Step 1: Write the failing metadata test**

Read `packages/cli/package.json` from the test and assert:

```ts
expect(packageJson.bin).toEqual({ aragon: './dist/cli.js' });
```

Also export or inspect the Commander program name in the least invasive way needed to assert that help identifies the command as `aragon`.

**Step 2: Run the test to verify it fails**

Run:

```powershell
npm test -w packages/cli -- --run src/__tests__/package-metadata.test.ts
```

Expected: FAIL because `bin` currently contains `argon` and `argon-agent` and the program is named `argon`.

**Step 3: Implement the minimal command rename**

Change the package metadata to:

```json
"bin": {
  "aragon": "./dist/cli.js"
}
```

Set Commander to `.name('aragon')`. Replace installation and invocation examples that refer to the old executable while retaining the npm package name `@argon-agent/cli` and the ArgonAgent product name.

**Step 4: Run the focused and workspace tests**

Run the focused test, then:

```powershell
npm test -w packages/cli
```

Expected: all CLI tests pass.

**Step 5: Commit**

```powershell
git add argon-agent-core/packages/cli/package.json argon-agent-core/packages/cli/src/cli.tsx argon-agent-core/packages/cli/src/__tests__/package-metadata.test.ts argon-agent-core/packages/cli/README.md argon-agent-core/README.md
git commit -m "feat(cli): install the aragon command"
```

### Task 2: Specify the automated release workflow

**Files:**
- Create: `scripts/tests/fake-npm.ps1`
- Create: `scripts/tests/publish-latest.tests.ps1`

**Step 1: Build a temporary release fixture**

The test creates a temporary Git repository containing minimal root, Core, CLI, and lockfile package metadata. It copies the release script under test into the fixture and supplies a fake npm executable that records every invocation and emulates `version`, `pkg set`, `install`, `view`, and `publish`.

**Step 2: Write failing dry-run tests**

Assert that the wished-for command:

```powershell
.\publish-latest.ps1 -DryRun -NpmCommand .\scripts\tests\fake-npm.ps1
```

- defaults Core `0.1.0 -> 0.1.1` and CLI `0.2.0 -> 0.2.1`;
- supports `-Bump minor`;
- sets CLI Core dependency to the new caret range;
- synchronizes the workspace lock entries;
- runs tests, build, consumer smoke, and both pack checks;
- never calls `publish` in dry-run mode;
- restores all version files before exit.

**Step 3: Write a failing resume test**

Prepare local bumped versions with Core marked as published and CLI absent. Run `-Resume`, then assert Core is not republished, CLI is published, and neither workspace version is bumped again.

**Step 4: Run tests to verify RED**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\publish-latest.tests.ps1
```

Expected: FAIL because `publish-latest.ps1` does not exist.

**Step 5: Commit the failing test contract**

```powershell
git add argon-agent-core/scripts/tests
git commit -m "test(release): specify npm publish automation"
```

### Task 3: Implement versioning, validation, publishing, and recovery

**Files:**
- Create: `publish-latest.ps1`
- Modify: `package-lock.json`

**Step 1: Add parameters and guarded command execution**

Implement:

```powershell
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',
  [switch]$DryRun,
  [switch]$Resume,
  [Parameter(DontShow)]
  [string]$NpmCommand = 'npm'
)
```

Use `$PSScriptRoot`, strict mode, explicit native exit-code checks, and the fixed official registry. Reject `-DryRun -Resume`, dirty normal releases, and unrelated dirty files during resume.

**Step 2: Implement automatic versions and rollback**

Before the first publish, snapshot `package-lock.json` and both workspace manifests. For normal runs, call `npm version` for each workspace, set CLI's Core dependency to `^<newCoreVersion>`, and synchronize the lockfile. Restore snapshots on dry-run completion or any failure before publishing starts.

**Step 3: Implement the release gates**

Validate manifest/lock consistency and the CLI `bin` contract, then run:

```powershell
npm test
npm run build
npm run verify:dist -w packages/core
npm pack -w packages/core --dry-run --json
npm pack -w packages/cli --dry-run --json
node packages/cli/dist/cli.js --version
```

For real publishing, verify `npm whoami`, reject exact versions already in the registry, publish Core, wait until its exact version is queryable, publish CLI, and verify CLI metadata including `bin.aragon`.

**Step 4: Implement resume behavior**

In `-Resume`, do not bump. Query both exact versions; skip an existing Core, publish only missing packages in dependency order, and treat an already published CLI as successful completion. If an error occurs after Core publication may have started, preserve version files and print the exact resume command.

**Step 5: Run the release integration tests to verify GREEN**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\publish-latest.tests.ps1
```

Expected: all release tests pass without contacting npm.

**Step 6: Commit**

```powershell
git add argon-agent-core/publish-latest.ps1 argon-agent-core/package-lock.json
git commit -m "feat(release): automate npm workspace publishing"
```

### Task 4: Document and fully verify the release entry point

**Files:**
- Modify: `npm-publish.md`
- Modify: `packages/cli/CHANGELOG.md`
- Modify: `packages/core/CHANGELOG.md`

**Step 1: Document the one-command workflow**

Put the automated workflow before the manual reference:

```powershell
.\publish-latest.ps1
.\publish-latest.ps1 -Bump minor
.\publish-latest.ps1 -DryRun
.\publish-latest.ps1 -Resume
```

Explain prerequisites, exact side effects, partial-failure recovery, and that this command rename is a breaking `0.x` CLI change for which the next release should use `-Bump minor`.

**Step 2: Update changelogs**

Add Unreleased entries for the `aragon` executable contract and release automation without inventing a released version or date.

**Step 3: Run fresh full verification**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\publish-latest.tests.ps1
npm test
npm run build
npm run verify:dist -w packages/core
npm pack -w packages/core --dry-run --json
npm pack -w packages/cli --dry-run --json
node .\packages\cli\dist\cli.js --version
git diff --check
```

Inspect the CLI tarball JSON to confirm the `bin` entry is `aragon`, and check `git status --short` for only intended files.

**Step 4: Commit documentation**

```powershell
git add argon-agent-core/npm-publish.md argon-agent-core/packages/core/CHANGELOG.md argon-agent-core/packages/cli/CHANGELOG.md argon-agent-core/docs/plans/2026-07-25-npm-release-script.md
git commit -m "docs: add one-command npm release workflow"
```
