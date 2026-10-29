# Changelog

All notable changes to `@aragon-agent/tui` are documented here.

## 0.1.0

### Added
- **First release: the terminal runtime, split out of `@aragon-agent/cli`.** The Ink components,
  terminal input protocols (keyboard, mouse, bracketed paste, stdin filtering), the scrollback
  renderer and frame differ, every overlay, and the view model they draw from (`Entry`,
  `ViewState`, the reducer, panel row models) now live in their own package, published in
  lock-step with `@aragon-agent/core` and `@aragon-agent/cli`. Nothing a user can see or type
  changed: the moved files are byte-identical apart from their import paths, which is checked by
  a parity script before release.
- **Subpath exports, no barrel.** Import modules by path, for example
  `@aragon-agent/tui/ui/theme`. The package entry exports only `TUI_API_VERSION` and has no side
  effects, because `ui/ink-runtime` must be evaluated before any other module that imports Ink.
- **A logging port.** The package never reaches into the CLI's logger. Call
  `setTuiLogger(...)` from `@aragon-agent/tui/model/logging/log-port`; until then logging is a no-op.
- **`testing/` helpers** (`terminal-harness`, `mini-vt`, `vt-screen`, `render-at-width`,
  `governance-fixtures`) shipped for the CLI's own tests. Test support, not a stable API.

### Notes
- `react` and `ink` are peer dependencies. Install them at the same range as the CLI so the
  process has exactly one copy of each; two copies of React break hooks.
- Subpaths are an internal contract between the three AragonAgent packages. Pin an exact version
  if you depend on them directly.
