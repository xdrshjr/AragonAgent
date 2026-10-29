# @aragon-agent/tui

The terminal runtime behind the `aragon` command: [Ink](https://github.com/vadimdemedes/ink)
components, terminal input protocols, the scrollback renderer, and the view model they draw from.

```
@aragon-agent/core   engine: LLM adapters, streaming, tools, skills, sandbox
        ▲
@aragon-agent/tui    this package: terminal rendering, terminal input, view model
        ▲
@aragon-agent/cli    the `aragon` binary, the session container, config, commands, headless `exec`
```

Most people want [`@aragon-agent/cli`](https://www.npmjs.com/package/@aragon-agent/cli), which
depends on this package. Install this one directly only to build your own terminal front end on
the same components.

## Using it

There is deliberately **no barrel**. Import a module by its path:

```ts
import { renderTui } from '@aragon-agent/tui/ui/ink-runtime';
import { viewReducer } from '@aragon-agent/tui/model/agent/reducer';
```

The package entry (`@aragon-agent/tui`) exports only `TUI_API_VERSION` and has no side effects.
Ink caches its CI detection the first time it is imported, and `ui/ink-runtime` must be evaluated
before any other module that imports Ink; a barrel would make that depend on import order.

`react` and `ink` are **peer dependencies**. Install them yourself, at the same range this
package declares, so your process holds exactly one copy of each.

### Layout

| Path | Contents |
| --- | --- |
| `ui/` | components, layout, scrollback, selection, frame differ, overlays, theme and glyphs |
| `input/` | stdin filter and the keyboard / mouse / paste protocols |
| `model/` | the view model and the pure domain helpers it needs (`agent/reducer`, `config/schema`, `todo/`, `team/`, `governance/`, `tools/patch`, `update/semver`, ...) |
| `testing/` | terminal test harness and virtual-terminal helpers (test support, not a stable API) |

`model/` holds more than view state: pure, I/O-free helpers such as the config schema, the patch
parser and the semver comparison live there because the components need their values and types.
Splitting them into a separate domain package is a possible later step.

### Logging

The package never imports the host's logger. Install one at startup:

```ts
import { setTuiLogger } from '@aragon-agent/tui/model/logging/log-port';

setTuiLogger(myLogger); // { error, warn, info, debug, child }; default is a no-op
```

## Stability

Subpaths are an **internal contract** between the AragonAgent packages, released together and
pinned exactly (`@aragon-agent/cli` depends on one exact `@aragon-agent/tui` version). Do not
assume a subpath survives a minor release. The `testing/` helpers carry no stability promise.

## Layering rules

Held by the compiler here, and by a layering check in the private repository the CLI ships from:

1. This package never imports `@aragon-agent/cli`.
2. `@aragon-agent/core` never imports this package or the CLI.
3. The CLI reaches this package only through `@aragon-agent/tui/<subpath>`.
4. Code here logs through the port, never through the CLI's logger.

Rules 2 and 3 describe the other two packages, neither of which is developed in this repository;
the compiler enforces rule 1 by refusing any import of a package this one does not depend on.

## Building from source

This repository is a small npm workspace: `packages/tui` (this package) and `packages/desktop`.
Clone it, then:

```bash
npm install                     # at the repository root, once
npm run build -w packages/tui   # tsc to packages/tui/dist
npm test -w packages/tui        # vitest
```

The runtime engine `@aragon-agent/core` is a published npm dependency of this repository, not part
of it: `npm install` fetches it from the registry, and the source of the engine is not here.

Use npm 11 or newer for that first `npm install`. npm 10.9.x, the version bundled with Node 22,
fails to resolve the test toolchain's optional peer dependencies and stops with
`Cannot read properties of null (reading 'edgesOut')`; on that npm run
`npm install --legacy-peer-deps` instead. Both paths then build and test as above.

## Development

```bash
npm run build -w packages/tui        # tsc to dist/
npm run dev   -w packages/tui        # tsc --watch (restart the host process to pick changes up)
npm test      -w packages/tui
npm run typecheck -w packages/tui
```

## License

MIT
