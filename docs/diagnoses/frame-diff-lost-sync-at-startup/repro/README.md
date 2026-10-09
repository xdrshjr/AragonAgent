# Repro — Frame diffing lost sync（启动即报错）

三个脚本，从轻到重。都在仓库根目录运行；B/C 需要 `node-pty`（仓库已装）。

| 脚本 | 证明什么 | 依赖 |
| --- | --- | --- |
| `repro-fallback.mjs` | 机制级复现：按 `cli.tsx::runInteractive()` 原样搭建 differ→writer→observer→Inh 栈，渲染一个 AppShell 形状的固定高度帧，分类统计每一个被 differ 拒绝的 chunk。三种场景：不缩放 / 缩 1 行 / 放大 6 行。 | `npm run build -w packages/cli` |
| `trace-writers.mjs` | 归因：对每一个流经代理的 chunk 打印写入方调用栈（证明 `\x1b[?25l` 来自 `ink/build/components/App.js:92` → `cli-cursor/index.js:24`）。 | 同上 |
| `repro-real-cli.mjs` | 端到端：用 node-pty 在真实 PTY 里启动真实的 `aragon` TUI，捕获全部输出字节；.notice 文本按用户所见样式（转录区内、带 `│` 边框换行）出现即复现。原始字节流存 `pty-capture.txt`。 | `node-pty` |

手动复现（无需脚本）：任意终端运行 `aragon`（或 `npm run dev:cli`），横幅之下立刻出现
`▲ Frame diffing lost sync … restart with --no-diff-render`；对照 `aragon --no-diff-render`
则没有该警告（writer 未构建）。

`repro-real-cli.mjs` 用 `ARAGON_HOME=repro/.aragon-home`、`ARAGON_UPDATE=off` 隔离真实
用户配置并保持离线，运行后会在本目录重建 `.aragon-home/`，可随时删除。
