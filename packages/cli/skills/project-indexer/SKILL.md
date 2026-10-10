---
name: project-indexer
description: Generate and use a project index for quick codebase understanding in new sessions. Scans the workspace, extracts exported symbols, writes .claude-index/index.md plus config, and injects a Google-style Clean Code Guidelines section into CLAUDE.md. Use when the user says "explore the project", "generate index", "regenerate index", "更新索引", "生成索引", or presses Ctrl+I.
version: 1.1.0
license: MIT
keywords: [productivity, codebase, indexing, navigation, cleancode]
# The read-only tools (read_file, list_dir, glob, grep, ask_user, todo_write)
# are always available inside a skill frame via the tool floor; this ceiling
# adds exactly the two writers the generated files need.
allowed-tools:
  - write_file
  - edit_file
---

# Project Indexer

Generate a structured index of any codebase so a new session understands the
project with minimal context usage. The index is a **navigation map**, not a
code copy: enough to see the project globally (type, stack, architecture),
navigate on demand (feature map, file index), and know which symbols exist
without reading every file.

## Current request

$ARGUMENTS

## Step 1: Check for an existing index

- If `.claude-index/index.md` exists and has the key sections (Project
  Overview, Feature Map, File Index), go to "Using an existing index".
- If it exists but is empty or malformed, tell the user and regenerate
  (first-time flow), preserving `config.md` if intact.
- Otherwise run the first-time flow.

## Using an existing index

1. Read `.claude-index/index.md` and `CLAUDE.md` (if present).
2. Summarize in 3-5 bullets: structure, stack, feature areas, key entry
   points. Offer to help.
3. For later questions, navigate via the Feature Map / File Index and read
   real source only when detail is needed.

## First-time flow

### Step 2: Gather configuration (ask_user)

Ask with `ask_user`, defaults offered in every question:

1. **Exclusions** - A) defaults (node_modules, .git, dist, build,
   __pycache__, .venv, vendor, coverage, .next, .nuxt, .cache, target, bin,
   obj, .idea, .vscode) B) add more C) custom list.
2. **Priority directories** - A) auto-detect (recommended) B) specify C) all
   equally.
3. **Tech stack** - auto-detect unless the user names one.
4. **Clean Code Guidelines** (injected into CLAUDE.md) - A) Google strict
   (method 60, file 1000 - recommended) B) Google relaxed (method 600)
   C) custom D) skip.

If C: ask **one `ask_user` call per limit** showing default and range -
MAX_FILE_LINES 1000 (200-5000), MAX_METHOD_LINES 60 (20-600),
MAX_FUNCTION_PARAMS 5 (2-10), MAX_CYCLOMATIC 10 (5-25); fall back to the
default on an out-of-range answer and say so in the summary.
MAX_LINE_LENGTH (default 100, Python 80) and MAX_NESTING_DEPTH (4) are never
asked. If the user skips every question, use all defaults.

Treat the answer as `CleanCodeConfig.preset`: strict | relaxed | custom |
disabled. D (`disabled`) skips the Clean Code composition below, never adds
markers, and persists `Enabled: No`.

### Step 3: Scan and analyze

1. Traverse the tree with the exclusion rules (`glob`, never one giant read).
2. Detect project type (frontend/backend/fullstack/library/CLI/monorepo),
   languages with percentages, frameworks, entry points.
3. Group files by feature/domain and extract exported symbols - full support
   for JS/TS (.js/.jsx/.ts/.tsx/.mjs) and Python; best-effort for Java,
   Kotlin, Go, Rust, C/C++, C#, Ruby, PHP; unknown types are listed without
   symbols.
4. Analyze module-level dependencies (import graph).

Adaptive sizing: <50 files -> full detail; 50-200 -> full coverage with
concise descriptions; 200+ -> detail the priority directories, summarize the
rest, group similar utilities. Over 1000 files after exclusions: warn and
suggest more exclusions before continuing; sample representative files with
glob/grep rather than reading everything. Keep language/framework findings in
working memory - do NOT write an intermediate JSON file.

### Step 4: Write `.claude-index/`

1. `config.md` - exclusions, priorities, tech stack, plus an Index Settings
   block (Generated date, Project Root, Index Version) and a Clean Code
   Settings block (Enabled / Preset / the six limits; when the user picked
   skip, write `Enabled: No`, `Preset: disabled` and the strict numbers so a
   later "enable cleancode" can flip it back).
2. `index.md` - follow `templates/index-template.md` in this skill's
   directory: Project Overview, Feature Map (per area: entry file, one-line
   description, key exports with signatures), Module Dependencies, File Index
   (per-directory tables, one line per file).

### Step 5: Compose the Clean Code Guidelines (skip when disabled)

Read `templates/cleancode-template.md` and `templates/cleancode-overrides.md`
from this skill's directory, then:

1. Primary languages = every language with >= 10% of post-exclusion source
   files; if none clears 10%, use the `Other` row.
2. Take the **minimum** across all matching rows for each numeric column.
3. Apply the user preset: strict/relaxed values intersect with the language
   minimum (never looser than the baseline); custom numbers are honoured
   verbatim with divergence noted.
4. Substitute every placeholder: `{{MAX_FILE_LINES}}`, `{{MAX_METHOD_LINES}}`,
   `{{MAX_FUNCTION_PARAMS}}`, `{{MAX_CYCLOMATIC}}`, `{{MAX_LINE_LENGTH}}`,
   `{{MAX_NESTING_DEPTH}}`, `{{PRIMARY_LANGUAGES}}` (comma-joined languages)
   and `{{LANGUAGE_HINTS}}` (one `- Language: note` bullet per matching row,
   deduped by exact string).
5. Verify no `{{...}}` placeholder remains. Do not count characters at
   runtime.

### Step 6: Update CLAUDE.md

- `## Project Index` section: upsert (replace when present, else append at
  end; create the file when missing). Contents: Location
  `.claude-index/index.md`, Last Updated (YYYY-MM-DD), Contents line, a
  Usage line, and "Regenerate: say 'regenerate index' / '更新索引'".
- `## Clean Code Guidelines` section (unless disabled): wrap the rendered
  body in `<!-- project-indexer:cleancode:begin v1.1.0 -->` and
  `<!-- project-indexer:cleancode:end -->`. Locate an existing block with
  the version-agnostic regex `<!-- project-indexer:cleancode:begin
  v\d+\.\d+\.\d+ -->` (NEVER a literal-version match) plus the literal end
  marker; fallback: the region from a `## Clean Code Guidelines` heading to
  the next `## ` heading or EOF. Replace the found block; if none, insert
  after the Project Index section (first-insert only; when both sections
  already exist preserve the user's ordering and everything between them).
  Write UTF-8; add a trailing newline when missing.

### Step 7: Report

List what was created/updated, the feature-area count, files indexed and
symbols extracted. Offer to start work.

## Regeneration ("regenerate index" / "更新索引")

1. Read `config.md` and preserve exclusions, priorities, stack.
2. Clean Code handling: if CLAUDE.md has markers or the heading, ask
   A) refresh B) keep C) remove; honour `Enabled: No` from config.md by
   skipping silently with one reminder line. When no block exists and
   Enabled is Yes/absent, compose and inject (announce before writing).
3. Confirm the plan (exclusions, priorities, cleancode decision) with the
   user, then re-run Steps 3-7.

Special triggers: "disable cleancode" removes the block and sets
`Enabled: No`; "enable cleancode" re-composes it and sets `Enabled: Yes` -
both without a full rescan.

## Edge cases

- Inaccessible directories: list them under a "Skipped Directories" note and
  continue; never fail the whole run for one unreadable path.
- No recognizable source files: generate a minimal index (overview + file
  listing) and say so.
- The user pressed Ctrl+I: they already confirmed once - do not re-ask the
  global "proceed?" question, but still ask the configuration questions
  above (or reuse `.claude-index/config.md` when it exists).
