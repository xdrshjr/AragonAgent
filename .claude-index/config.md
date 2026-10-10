# Index Configuration

## Excluded Directories
- node_modules
- .git
- dist
- build
- __pycache__
- .venv
- vendor
- coverage
- .next
- .nuxt
- .cache
- target
- bin
- obj
- .agentmesh
- .bug-diagnosis

## Priority Directories
- packages/core/src/
- packages/cli/src/
- scripts/

## Tech Stack
- Frontend: React 18 + Ink 5 terminal UI
- Backend: Node.js 18+ TypeScript agent runtime
- Language: TypeScript

## Index Settings
- Generated: 2026-10-07
- Previously Generated: 2026-10-06
- Project Root: M:\takoAI\JRAgentMesh\aragon-agent-core
- Index Version: 1.0
- Environments Configured: No

## Clean Code Settings
- Enabled: Yes
- Preset: strict
- MAX_FILE_LINES: 1000
- MAX_METHOD_LINES: 60
- MAX_FUNCTION_PARAMS: 5
- MAX_CYCLOMATIC: 10
- MAX_LINE_LENGTH: 100
- MAX_NESTING_DEPTH: 4

## 本功能历史文件例外

2026-10-03，统一滚动条实施前基线：`packages/cli/src/ui/App.tsx` 为 2728 行，
`packages/cli/src/cli.tsx` 为 2096 行。本功能仅允许各净增最多 100 行用于布局及桥接接线；
历史大文件不作无关拆分，新机制独立成模块，新增模块与函数继续遵守默认阈值。

## TUI 输入与任务生命周期的历史文件例外

2026-10-03，终审以 `21da100d0` 为基线：`ui/App.tsx` 2713 行、
`agent/controller.ts` 2087 行、`commands/builtins.ts` 1336 行
（路径均相对 `packages/cli/src/`）。本功能允许 App 净增不超过 60 行，
Controller 净增不超过 20 行，builtins 净增不超过 5 行；仅限状态接线和参数传递。
这些历史文件的既有大函数与复杂度暂不作无关拆分；新增光标、手势和选项模块
仍遵守默认阈值。理由：本次只改变输入和启动边界，全面拆分会扩大回归范围。

## TUI right-edge scrollbar and run status row exception

2026-10-06, baseline `c3445fce7`: `ui/App.tsx` is 2582 lines and `cli.tsx` is 2016 lines
(paths relative to `packages/cli/src/`). The feature `tui-scrollbar-edge-and-run-row`
allows a net increase of at most 40 lines in `App.tsx` and 10 lines in `cli.tsx`, limited
to wiring: the run-row enable condition, the shared activity object, the `cols` option of
the frame differ and the lazy `/perf` scrollbar getter. New logic lives in
`ui/run-status-row.ts`, `ui/frame-differ.ts` and `commands/perf.ts`, which keep the default
thresholds. Reason: the change only moves one existing row and one escape sequence, and a
wholesale split of these historical files would widen the regression surface.

## TUI 输入、复制与队列终审的历史文件例外

2026-10-07，以 `50de29d0c` 为基线，`packages/cli/src/` 下 `ui/App.tsx`
2647 行、`agent/controller.ts` 2078 行、`agent/reducer.ts` 2091 行、
`commands/builtins.ts` 1385 行。本功能仅允许分别净增 40、10、0、20 行，
用于输入接管、消息 ID 回执和会话切换的既有入口接线；不增加新的大文件。
这些历史函数的既有尺寸和复杂度保留，避免终审时全面拆分造成额外回归。
输入事务、队列全文补全、固定行格式化、会话边界验证均独立到小模块，
新增算法函数仍执行默认阈值。验收与实际行数记录见
`docs/plans/tui-input-interaction-hardening/code-review.md`。

## Ctrl+I 项目索引触发（project-indexer bundled skill）的历史文件例外

2026-10-08，Ctrl+I 触发内置 project-indexer 技能。`ui/App.tsx` 仅允许
净增不超过 60 行，限于 useInput 分支守卫与 `requestIndexBuild` 的
确认-派发接线（复用 `closeConfirm` 同族的 confirm overlay 与
`executeSlashInput`）；确认文案、技能名、参数与 `.claude-index` 探测
全部位于新模块 `commands/index-build.ts`（默认阈值）。
`ui/Header.tsx`（47 行）为整文件改写，仅增加 `^I Index` / `^I build index`
提示与右侧宽度自适应，行数不超限。`input/win32-input-mode.ts`、
`input/csiu-keys.ts`、`input/limits.ts` 各净增不超过 16 行（INDEX 帧
翻译）；`ui/PromptInput.tsx` 净增不超过 12 行（帧剥离防御）。
理由：本功能只新增一个按键入口与提示，全面拆分历史大文件会扩大回归面。
