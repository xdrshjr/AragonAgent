# Clean Code — Language Override Table

> Read by `project-indexer` at Step 5. The skill intersects the rows below
> with the **primary languages** detected during the scan (any language whose
> source files account for >= 10% of the post-exclusion total).
>
> When two or more rows apply, the skill **takes the minimum** for every
> numeric column. Notes from each matching row are concatenated and rendered
> as bullets in the `{{LANGUAGE_HINTS}}` placeholder of
> `cleancode-template.md`.
>
> Defaults (used when no row matches, i.e. the `Other` row) live in the last
> row. Numeric units: `MAX_FILE_LINES` and `MAX_METHOD_LINES` are physical
> lines of source. `MAX_LINE_LENGTH` is columns. `MAX_FUNCTION_PARAMS` is the
> count of positional + keyword parameters in a single signature.

| Language    | MAX_FILE_LINES | MAX_METHOD_LINES | MAX_LINE_LENGTH | MAX_FUNCTION_PARAMS | Notes |
|-------------|----------------|------------------|-----------------|---------------------|-------|
| TypeScript  | 1000           | 60               | 100             | 5                   | Prefer `interface` over `type` for public APIs. |
| JavaScript  | 1000           | 60               | 100             | 5                   | Avoid `any`; use JSDoc when no TS. |
| Python      | 800            | 50               | 80              | 5                   | PEP 8 + Google docstrings. |
| Go          | 800            | 60               | 120             | 4                   | Errors as values; no panic in library code. |
| Java        | 1500           | 40               | 100             | 5                   | Google Java Style. |
| Kotlin      | 1500           | 40               | 100             | 5                   | KtLint defaults. |
| Rust        | 1000           | 60               | 100             | 5                   | `clippy::pedantic` recommended. |
| C / C++     | 1000           | 50               | 100             | 5                   | Google C++ Style. |
| Other       | 1000           | 60               | 100             | 5                   | Generic fallback. |

## Merge Rules

1. **Detection threshold** — only languages with >= 10% of source files (after
   exclusions) contribute. If no language clears 10%, use the `Other` row.
2. **Numeric merge** — `min()` across every matching row, per column.
3. **Note merge** — collect each matching row's `Notes` cell, dedupe by exact
   string match, render as a bullet list. Example for TypeScript + Python:
   - `- TypeScript: Prefer interface over type for public APIs.`
   - `- Python: PEP 8 + Google docstrings.`
4. **Fixed defaults (not in the table, applied unconditionally)** —
   `MAX_CYCLOMATIC = 10`, `MAX_NESTING_DEPTH = 4`. These can still be
   overridden by the user via the Custom preset.

## Adding a Language

When extending this table, keep the column order identical and use the
strictest reasonable value for each cell so the `min()` merge stays
meaningful for polyglot repos.
