# 诊断：启动即出现 "Frame diffing lost sync with the terminal and fell back to a full repaint"

- **症状（bug）**: `frame-diff-lost-sync-at-startup`
- **日期**: 2026-10-07
- **范围**: `packages/cli` 交互式 TUI（`aragon`），默认配置即触发，全平台
- **结论先行**: 这不是渲染真的失步，而是 **Ink 5.2.1 在挂载时把光标隐藏序列
  `\x1b[?25l` 直接写进了交给 `render()` 的 stdout**（即 frame-writer 代理），被
  `frame-differ.ts` 判定为"外来写入"，从而把 `fallbacks` 从 0 计到 1，触发一次性的
  `FRAME_FALLBACK_NOTICE`。**每次启动必然触发一次**，与终端类型、是否缩放窗口无关。
  另有一个次要触发路径：终端高度缩小时 Ink 走 `ink.js:121` 的 `clearTerminal` 写法，
  同样被判定为外来写入（见 §3.3）。

---

## 1. 问题描述

用户报告：运行 `aragon`，启动后界面顶部（转录区第一屏）出现警告卡片：

```
▲ Frame diffing lost sync with the terminal and fell back to a full repaint. If the display looks  │
  wrong, restart with `--no-diff-render`.
```

TUI 其余功能正常（光标、输入、流式输出、滚动均可用），但每次启动都会看到这条
"报错"，且无法通过正常操作消除。用户诉求是"修复，使其能够正常使用"。

该文案来自 `packages/cli/src/cli.tsx:470-472`（`FRAME_FALLBACK_NOTICE`），由
`packages/cli/src/cli.tsx:688` 的 `onFirstFallback: () => console.warn(...)` 在
differ 的 `fallbacks` 计数器 0→1 边沿触发；全屏模式下 `console.warn` 被
`packages/cli/src/ui/App.tsx:1107-1110` 的 console bridge 转成转录区的 warn 通知
（所以它渲染在带 `│` 边框的转录区里，换行样式与用户贴图一致）。

## 2. 复现步骤

### 2.1 手动复现（任意用户可执行）

1. 在任意终端（Windows Terminal / conhost / VS Code / PTY 均可）运行 `aragon`
   （从本仓库：`npm install`、`npm run build -w packages/cli`、`node packages/cli/dist/cli.js`）。
2. 等待首屏渲染完成（1 秒内）。
3. 观察转录区第一屏：横幅与"鼠标滚轮"提示附近出现
   `▲ Frame diffing lost sync … restart with --no-diff-render`。
4. 对照组：`aragon --no-diff-render` 启动 → 无该警告（此时根本不构建 frame writer）。

### 2.2 脚本复现（本目录 `repro/`）

```bash
# A. 端到端：真实 PTY 里跑真实 aragon（需要 node-pty，仓库已装）
node docs/diagnoses/frame-diff-lost-sync-at-startup/repro/repro-real-cli.mjs
#   期望输出: notice text present   : YES  <-- the reported bug
#   原始字节流存 repro/pty-capture.txt

# B. 机制级：真实 Ink + 真实 differ/writer/observer 栈，最小 AppShell 形状帧
node docs/diagnoses/frame-diff-lost-sync-at-startup/repro/repro-fallback.mjs
#   期望: "no resize" 场景 fallbacks: at-startup=1，拒绝的 chunk 归因为 cursor-hide

# C. 归因：打印每个流经代理 chunk 的写入方调用栈
node docs/diagnoses/frame-diff-lost-sync-at-startup/repro/trace-writers.mjs
```

### 2.3 复现输出（证据摘录）

端到端（真实 CLI、真实 PTY，`repro/pty-capture.txt`，字节转义后）：

```
=== real aragon CLI in a PTY (24 rows x 100 cols) ===
bytes captured        : 15967
notice text present   : YES  <-- the reported bug
cursor-hide (ESC[?25l): written at startup
...
ESC[?1049h ESC[2J ESC[?2004h ESC[?25l ...        ← 进入备用屏后，光标隐藏写到了 stdout
▲ Frame diffing lost sync with the terminal and fell back to a full repaint. If the display looks  │
  wrong, restart with `--no-diff-render`. ... │
```

机制级（`repro-fallback.mjs`，三种场景）：

```
=== no resize (24 -> 24 rows) ===
  fallbacks: at-startup=1 after-resize=0
  notice raised: YES  <-- user-visible bug
  chunks the differ refused (2):
    - other: "header\nviewport tick=0\n"            ← 会话种子帧（P1-1，不计入）
    - cursor-hide ESC[?25l  (ink App.componentDidMount -> cliCursor.hide(stdout))  ← 根因

=== SHRINK by 1 row (24 -> 23 rows) ===            ← 次要触发路径
  fallbacks: at-startup=1 after-resize=1
    - clearTerminal ESC[2J ESC[3J ESC[H + frame (ink.js:121 tall-frame path)

=== GROW by 6 rows (control) (24 -> 30 rows) ===
  fallbacks: at-startup=1 after-resize=0           ← 放大不触发；缩小才触发
```

> **评审注**：评审已重跑 `repro-fallback.mjs`，输出与上文一致。harness 中
> `at-startup=1`；在**真实 CLI** 里因 §3.1 所述的重入级联，启动稳态为
> `fallbacks === 2`（退出再 +1）。另注意 `pty-capture.txt` 的字节是经 **ConPTY
> 重编码**后的终端侧流，只能证明症状与光标序列的存在，**不能**证明应用层的
> chunk 顺序——顺序由评审的两层插桩（真实流 write 钩子 + differ 决策日志）确立。

归因调用栈（`trace-writers.mjs`）：

```
#2 REJECTED(pass-through) "ESC[?25l"
    at cliCursor.hide (node_modules/cli-cursor/index.js:24:17)
    at App.componentDidMount (node_modules/ink/build/components/App.js:92:19)   ← Ink 内部 <App>
```

> **评审注**：该栈证明的是"挂载期确有 `\x1b[?25l` 经代理写入"，真实 CLI 中同样成立
> （write 钩子实证同一路径）；但"`#2`"这一序号只对 harness 成立——真实 CLI 里它是
> `#1`（见 §3.1 勘误）。

## 3. 根因分析

### 3.1 写入链路（谁写了什么）

交互式启动时 `cli.tsx::runInteractive()` 把 stdout 包成三层后交给 Ink：

```
Ink(render) → frameObserver.stdout  → frameWriter.stdout(含 frame-differ) → 真实 process.stdout
              (ui/frame-observer.ts:62)  (ui/stdout-frame-writer.ts:139, cli.tsx:672-710)
```

differ 的设计前提（`ui/frame-differ.ts:1-45`）是：**流经这层代理的 chunk 只有 Ink
log-update 的帧写入**（`eraseLines(N) + frame + '\n'`，见
`node_modules/ink/build/log-update.js:12-18`）。任何别的写法都按"外来写入"处理：

- `packages/cli/src/ui/frame-differ.ts:430-432` — chunk 不以 erase 前缀开头 →
  `passThrough(!firstChunk)`；
- `packages/cli/src/ui/frame-differ.ts:435` — 帧体不以 `\n` 结尾（`log.clear()` 等）→
  `passThrough(true)`；
- `packages/cli/src/ui/frame-differ.ts:300-307` — `passThrough(counted=true)` 会
  `counters.fallbacks += 1`，且在 **0→1 边沿**调用 `options.onFirstFallback?.()`，
  即 `cli.tsx:688` 的 `console.warn(FRAME_FALLBACK_NOTICE)`。

而 **Ink 5.2.1 的内部根组件 `<App>` 在 `componentDidMount` 里把"隐藏光标"写进了
render 所用的 stdout**：

- `node_modules/ink/build/components/App.js:91-93`

  ```js
  componentDidMount() {
      cliCursor.hide(this.props.stdout);      // ← this.props.stdout 就是 differ 代理
  }
  ```

- `node_modules/cli-cursor/index.js:17-25`（`hide(writableStream)`，第 24 行
  `writableStream.write('\u001B[?25l')`）：光标序列写进了**调用方传入的流**，而不是
  默认的 `process.stderr`。

于是启动时的时序是（**经评审修正**，见下）：

> **评审勘误（重要）**：原稿依据 `trace-writers.mjs`（最小 harness）断言"种子帧是第 1 个
> chunk（豁免）、`\x1b[?25l` 是第 2 个（计入）"。评审在**真实 CLI** 上用两层独立插桩
> （① 环绕真实流的 write 钩子，记录每次 `process.stdout/stderr.write` 的调用序与来源栈；
> ② 对 `dist/ui/stdout-frame-writer.js` 副本内 `differ.transform` 前后计数器快照的决策日志，
> 在真实 PTY 中运行）复核后确认：**真实 CLI 的顺序与 harness 相反**。两种顺序都必然触发
> 一次计入的 fallback，症状结论不变，但"哪个 chunk 计入"的归因必须修正，因为它直接决定
> 修复方案 A 的因果论证和下一步要写的回归测试断言。

1. **harness 顺序**（`repro/trace-writers.mjs`，首 commit 即产出非空帧）：第 1 个 chunk
   是种子帧（`log-update.js:17`，`previousLineCount===0` 故无 erase 前缀）→
   `firstChunk=true`，`passThrough(false)`，**不计入**（frame-differ.ts:424-425 的 P1-1
   豁免）；第 2 个 chunk 是 `\x1b[?25l` → 无前缀、非首个 → `passThrough(true)` →
   **`fallbacks` 0→1 → `onFirstFallback` → 警告**。机制：react-reconciler 的
   `resetAfterCommit`（mutation 阶段末尾，`reconciler.js:83`）经 leading-edge 节流的
   `onRender`/`throttledLog`（`ink.js:37-50`，es-toolkit `throttle` 先行边同步执行）
   在 `componentDidMount`（layout 阶段）**之前**同步写出种子帧。
2. **真实 CLI 顺序**（插桩实测，`fallbacks` 计数器为证）：挂载 commit 不产生帧写
   （首帧经 `rootNode.onRender` 的 throttle 尾沿延后），故——
   - 第 1 个 chunk：`\x1b[?25l`（`App.componentDidMount`，经代理）→ 决策日志
     `#1 CURSOR_HIDE fallbacks 0->0`：**它吃掉了 firstChunk 豁免，不计入**；
   - 第 2 个 chunk：种子帧（无前缀、非首个）→ `passThrough(true)` →
     **`fallbacks` 0→1 → 警告在此触发**（真实二进制里报警的是种子帧，不是光标序列）；
   - 第 3 个 chunk（**评审新增发现**）：警告 → `console.warn` → console bridge
     （`App.tsx:1107-1110`）`dispatch({type:'notice'})` → **同步** React 重渲（Ink 容器
     为 legacy 同步模式，写路径外无批处理）→ 嵌套的 `Proxy.write`/`transform` 发生在
     外层 `transform` **内部**——决策日志出现一条嵌套条目（外层快照显示
     `fallbacks 0->2` 一次 +2），且该嵌套帧的帧体里**已经带着 ▲ 警告行**。稳态
     `fallbacks === 2`（harness 只见 1）。退出时 `App.componentWillUnmount` 的
     `\x1b[?25h` 经代理再 +1（write 钩子实证：`cliCursor.show ← App.componentWillUnmount
     ← Proxy.write`）。

两种顺序的共同不变量才是根因的准确表述：**启动经代理的无前缀写入有两个（光标隐藏 +
种子帧），而 differ 的 P1-1 豁免只覆盖第一个**——无论顺序如何，第二个必然被计入，
`fallbacks` 0→1 边沿必然触发警告；顺序只决定"哪一个"被计入。这也解释了为何
`--no-diff-render` 与 <12 行的终端（I-9 stand-down，`MIN_FULLSCREEN_ROWS=12`，
`frame.ts:9`→`frame-differ.ts:330-334` 返回 `passThrough(false)`）看不到警告。

- `log-update.js:8-10` 自己也调 `cliCursor.hide()`，但**不传参**，落到默认的
  `process.stderr`，对 differ 不可见；写 stdout 的那次来自 `App.js:92`。两处叠加
  解释了 PTY 捕获里出现两次 `ESC[?25l`（stderr 与 stdout 在 PTY 中合流）。
- 退出时 `App.componentWillUnmount`（`App.js:94-95`）对称地写 `\x1b[?25h`，同样被
  拒绝并再次累加 `fallbacks`（此时警告已闩锁，无新增可见症状）。

### 3.2 为什么光标序列会被判成"外来写入"却并不真的失步

`\x1b[?25l` 只切换光标可见性（DEC 私有模式 25），**不移动光标、不改动任何单元格**。
绝对寻址的缓存（`prev`）在这次写入后依然有效。也就是说这次 fallback 是**误报**：
differ 按 I-6"宁可多一次全量重绘"的保守策略处理（`frame-differ.ts:40-44`），代价是
`invalidate()` + 下一帧全量重绘 + 计数器被污染 + 用户看到警告。自愈成立（下一帧
fullRepaint），所以 TUI 仍可用——与用户"界面能用但有报错"的观感一致。

### 3.3 次要触发路径：终端缩小（ink.js:121）

`node_modules/ink/build/ink.js:121-125`：当 `outputHeight >= stdout.rows` 时，Ink
放弃 log-update，直接写 `ansiEscapes.clearTerminal + output`（实测字节
`\x1b[2J\x1b[3J\x1b[H` + 帧体，无 `\n` 结尾）。`useTerminalSize` 有 50 ms 防抖
（`ui/layout/useTerminalSize.ts:20,48-55`），而 Ink 在 `'resize'` 上**同步**重渲
（`ink.js:76-86`），防抖窗口内 React 树仍是旧高度：终端每缩小 ≥1 行，
`旧树高(rows_old-1) >= rows_new` 成立 → 走 clearTerminal 写法 → 被判外来写入。
`repro-fallback.mjs` 的 SHRINK 场景证明了这一点（`after-resize=1`）。放大不触发。
该路径与 `tui-input-flicker-fix` 规格中 I-8/K-11 的假设（"resize 只会 invalidate，
表现为 framesFull"）不完全一致：规格只考虑了帧仍经 log-update 的情形。

### 3.4 为什么既有测试没拦住

- `__tests__/frame-differ.test.ts` 全部用**本仓库自己构造的 chunk**（文件头注释自述）；
- `__tests__/frame-differ-ink-shape.test.ts`（K-2 tripwire）只驱动
  `ink/build/log-update.js`，而 5.2.1 里光标隐藏**并不在 log-update 的 stdout 写入
  路径上**（它在 `components/App.js:92`），tripwire 看不见；
- 没有任何测试把**真实 Ink render** 与 **真实 differ 代理栈**接在一起跑（本目录
  `repro/repro-fallback.mjs` 补上了这条缝隙，两个真实模块一接即现）。
- 规格的 AC-11（"10 分钟健康会话 `fallbacks === 0`"）若在当前锁定的 ink 5.2.1
  （`package-lock.json`）上执行，应当失败；仓库无 git 历史可查该断言最后一次人工
  验证时的 ink 版本。

## 4. 影响面

| 维度 | 影响 |
| --- | --- |
| 触发条件 | 交互式 `aragon`（`diffRender` 默认 `true`，`config/schema.ts:237`）**每次启动必现**，全平台（Windows/macOS/Linux、conhost/WT/VS Code/嵌入式 PTY） |
| 用户可见 | 转录区第一屏出现 warn 卡片（用户报告的"报错"）；随后一切功能正常（自愈机制成立） |
| 诊断失效 | `/perf` 的 `fallbacks` 从启动就 >0（真实 CLI 稳态 =2，退出 +1，评审插桩实测），永久失去"健康会话应为 0"的信号（`commands/perf.ts:141-154`、规格 K-1 缓解措施失效） |
| 渲染开销 | 挂载后多一次全量重绘（闪烁一次，肉眼基本不可察）；首警触发的一次**同步重渲发生在 stdout 写路径内部**（评审新增发现，见 §3.1），是潜在的重入隐患；退出时再计一次 fallback |
| 次级路径 | 任何"终端高度缩小"（拖拽、面板重排、宿主重同步）额外产生一次 fallback + 一次 `clearTerminal` 全清重绘（`ink.js:121`） |
| 不受影响 | `--no-diff-render`、`-p`/`exec`/`config` 等无头路径（不构建 writer）；`@aragon-agent/core` |

## 5. 候选修复（对比）

本节点按约束**不写修复代码**，以下为候选方案与权衡。

| # | 方案 | 做法 | 侵入性 | 风险 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| A | **writer 层吸收 Ink 自带的光标模式序列**（推荐） | 在 `stdout-frame-writer.ts::write` 中，对**整串等于** `\x1b[?25l` / `\x1b[?25h` 的 chunk 直接 `writeReal`：不进 `transform`、不 `invalidate()`、不计数。光标可见性不改屏幕内容，缓存仍有效 | 低（一个文件数行 + 单测） | 极低：精确匹配，Ink 将来若把光标序列与内容混写同一 chunk，匹配不中即回落到今日行为（fail-safe 方向正确）；与既有 `writeForeign` 门（P1-6"是我们的但不是帧"）同一设计语言，只是这类写**无需**失效缓存 | 小 |
| B | **把通知改为"模式级"告警** | 保留计数器，`onFirstFallback` 不再即时 `console.warn`，改为窗口内 N 次（或 `/perf` 仍如实展示 + 仅记日志） | 极低（`cli.tsx` 一处接线） | 中：掩盖不了的是**真**外来写入的一次性事件（自愈但失去唯一信号，违背 §5.6 让"沉默失败可见"的初衷）；且 `/perf fallbacks>0` 的污染仍在，AC-11 依旧不可判 | 最小 |
| C | **让 differ 识别所有"纯模式设置" chunk** | `frame-differ.ts::transform` 前置分支：chunk 整体匹配 `^(?:\x1b\[[?0-9]*[hl])+$`（仅 DEC 模式 set/reset，无 CUP、无文本）则透传不计、不失效 | 中（改 differ 核心 + 补测试） | 中低：正则面更宽，需明确排除任何含光标移动（CUP/CUD/…）或文本的 chunk，否则会**漏报真失步**（比误报更糟） | 中 |
| D | fork/patch Ink，去掉 `App.js:92` 的 stdout 写 | patch-package 或 fork | 高 | 高：违背仓库非目标（规格 §9.2"不 fork/patch Ink"）；升级即冲突 | 大 |

（可选项 A+：顺带在 differ 中识别 `clearTerminal + 帧体` 的写法（§3.3 次级路径），
把 `\x1b[2J\x1b[3J\x1b[H` 前缀当作一种合法"全量重绘"帧处理，消除缩小窗口时的第二次
误报。独立于 A，可分开实施。）

> **评审注（A+ 定级上调）**：原稿将 A+ 标为"可选"。评审不同意：**只做 A** 时，
> 0→1 边沿被保留，而"终端缩小 ≥1 行"（拖小窗口、改字号、面板重排、宿主重同步）就会
> 成为新的首个 fallback 来源，用户会在一次普通的窗口缩放后看到同一条警告——对
> "正常使用"而言这仍是可复现的误报。要满足任务目标（不再出现该警告），A+ 应与 A
> 一并实施。实现上无需把该 chunk 解析成帧：`\x1b[2J\x1b[3J\x1b[H` 前缀的 chunk 走
> `passThrough(false)`（透传 + `invalidate()`、不计数）即可——chunk 本身会把整帧
> 画上屏，下一个经 log-update 的帧因缓存已失效自然全量重绘，视觉与计数同时正确，
> 且比"解析为全量重绘帧"改动更小。fail-safe 方向：任何以该前缀开头的写入都是
> "整屏已清 + 内容随后到达"，缓存失效后由下一帧修复，不存在被静默吞掉的真失步。）

## 6. 推荐修复与理由

**推荐方案 A**，理由：

1. **直击根因且范围最小**：误报的源头是"Ink 自己的两个一次性质短序列"被当作外来
   写入。在 writer 的无类型边界（`stdout-frame-writer.ts:104-133`，本来就是唯一
   处理"非帧写入"的地方，见其 `writeForeign` 先例）做整串精确匹配，语义清晰：
   "光标可见性不是帧、也不是失步"。
2. **不失效缓存是关键差别**：与 `writeForeign`（先 `invalidate()` 再写）不同，
   `\x1b[?25l/h` 不改变屏幕内容，透传即可，连那次多余的 full repaint 都省掉——
   修复后启动序列恢复设计意图：种子帧透传 → 第 2 帧全量 → 之后纯 diff，
   `fallbacks === 0`（AC-11 重新成立），警告自然消失。
3. **fail-safe 方向正确**：精确匹配意味着任何将来的偏差（Ink 改写法、序列与内容
   合并）都会退回今天的保守行为（多一次重绘 + 计数），绝不会把真失步静默吞掉。
4. **可测**：补一条"真实 Ink render + 真实 writer 栈"的集成测试（即
   `repro/repro-fallback.mjs` 的最小化版本：断言挂载后 `fallbacks === 0` 且
   `\x1b[?25l` 字节确实到达真实流），正好补上 §3.4 指出的测试缝隙，把 tripwire
   的覆盖面从 log-update 扩到"挂载期的全部 stdout 写入"。

不推荐 B 单独使用：它只是把警报静音，`/perf` 的诊断信号依旧被污染，且真外来写入
的一次性提示也没了；可作为 A 之外的**附加**策略讨论（例如把"首次 fallback"降为
日志、连续多次才升级为通知），但那属于产品取舍，不是本缺陷的修复。

> **评审注（对理由 1/2 的顺序无关化修正）**：在真实 CLI 顺序（§3.1 勘误）下，
> 被计入的是种子帧、被豁免的是 `\x1b[?25l`。方案 A 依然成立且更强：吸收光标序列后
> 它**不再消耗 firstChunk 豁免**，种子帧回到"会话第一个 chunk"的设计位置（P1-1），
> 两种启动顺序都归位为 `种子帧透传（豁免）→ 首个识别帧全量 → 之后纯 diff，
> fallbacks === 0`；同时首警不再触发，§3.1 的重入级联（写路径内的同步重渲 + 第二次
> 计入）整体消失。测试断言应以"挂载后 `fallbacks === 0` 且 `\x1b[?25l` 字节到达真实流"
> 为准，**不要**断言"chunk #2 是 `\x1b[?25l`"——该序号只对 harness 成立。

## 附：证据文件

- `repro/repro-fallback.mjs` / `trace-writers.mjs` / `repro-real-cli.mjs`、
  `repro/pty-capture.txt`（真实 PTY 字节流）、`repro/README.md`（运行说明）
- 关键代码位：
  - `packages/cli/src/cli.tsx:470-472`（通知文案）、`cli.tsx:672-710`（writer 构建）、
    `cli.tsx:688`（onFirstFallback 接线）
  - `packages/cli/src/ui/frame-differ.ts:300-307`（passThrough/counted）、
    `frame-differ.ts:423-438`（transform 的两条拒绝分支）
  - `packages/cli/src/ui/stdout-frame-writer.ts:104-133`（代理 write，
    建议的修复落点）、`:165-169`（writeForeign 先例）
  - `packages/cli/src/ui/App.tsx:1104-1110`（console bridge，警告为何落在转录区）
  - `node_modules/ink/build/components/App.js:91-95`（`cliCursor.hide/show(this.props.stdout)`）
  - `node_modules/cli-cursor/index.js:17-25`（向传入流写 `\x1b[?25l`）
  - `node_modules/ink/build/ink.js:121-125`（次要触发：clearTerminal 写法）
  - `packages/cli/src/config/schema.ts:237`（`DEFAULT_DIFF_RENDER = true`）

---

## 评审结论（Review Verdict）

**评审方法**：逐条核验原稿引用的全部代码位（src 与 node_modules 双侧共 15 处，全部属实）；
独立重跑 `repro/repro-fallback.mjs`（输出与原稿一致）与 `repro-real-cli.mjs`（PTY 中
警告复现）；针对原稿证据链的两个薄弱点补充插桩——① 真实流 write 钩子（记录每次
`process.stdout/stderr.write` 的调用序 + 来源栈，在真实 PTY 中运行真实 CLI）；②
differ 决策日志（对 `dist/ui/stdout-frame-writer.js` 的**仓库外副本**注入
`transform` 前后的 `fallbacks` 快照，真实 PTY 运行；仓库树未被改动）。

### 证据链审计

1. **引用代码全部在失败路径上真实执行**（含 `App.js:91-95`、`cli-cursor:24`、
   `log-update.js:9/17`、`ink.js:121-125`、`frame-differ.ts:300-307/423-438`、
   `stdout-frame-writer.ts:104-133`、`cli.tsx:688`、`App.tsx:1107-1110`）。
2. **症状解释成立但归因需勘误**（§3.1 已就地修正）：真实 CLI 中经代理的第 1 个
   chunk 是挂载期 `\x1b[?25l`（吃掉 firstChunk 豁免，`fallbacks 0->0`），被计入、
   触发警告的是第 2 个 chunk（种子帧）；首警经 console bridge 触发的**同步重渲**
   又在写路径内嵌套产生第 3 个 chunk（帧体内已含 ▲ 警告行），稳态 `fallbacks === 2`。
   harness 的顺序（种子帧在前）源于其首 commit 即产出非空帧，与真实 App 不同。
   根因的顺序无关表述：**启动经代理的无前缀写入有两个，而 P1-1 豁免只覆盖第一个**。
3. **新增强证据**：退出路径 `App.componentWillUnmount → cliCursor.show → Proxy.write`
   实测存在（计入，与原稿一致）；`enterAltScreen`（`cli.tsx:759 → screen.ts` 的
   `safeWrite`）写的是**真实流**、不经 differ，不构成外来写入（排除了一个原稿未
   讨论的替代解释）；`pty-capture.txt` 属 ConPTY 重编码流，仅证明症状，不证明
   应用层顺序（已加注）。
4. **反例/边界核验**：`--no-diff-render`、无头路径、<12 行终端（I-9）、放大窗口
   均不触发；分类发生在进程内，与终端类型无关——"每次启动必现、全平台"成立；
   未发现其他候选根因（帧观测器 `frame-observer.ts` 是只读观察者，自身不写 stdout）。

### 候选方案边界审计

- **A（writer 吸收 `\x1b[?25l`/`\x1b[?25h` 整串）**：覆盖两种启动顺序（真实顺序下
  它把 firstChunk 豁免还给种子帧）；不吞任何真失步（精确整串匹配，不中即回落今日
  行为）；保持 `writeReal(chunk, encoding, cb)` 的回调/返回值契约；不触碰
  `writeForeign`/`repaint`/`dispose`/DEC 2026 包络；终端侧字节完全不变；顺带消除
  启动期 `passThrough → invalidate → onInvalidate` 对选区的一次误清与 §3.1 的
  重入级联。**无发现回归面**。
- **A+（clearTerminal 写法）**：原稿列为可选，**评审上调为必做**——只做 A 时，
  任意"缩小 ≥1 行"（拖小窗口/改字号/面板重排/宿主重同步）仍会以 0→1 边沿触发同一条
  警告，不满足"正常使用"的目标。最小实现：`transform` 中对以 `\x1b[2J\x1b[3J\x1b[H`
  开头的 chunk 走 `passThrough(false)`（透传 + `invalidate()`、不计数），无需解析成帧。
- **B（告警降级）**：不消除 `/perf` 污染，也不消除写路径内同步重渲的重入隐患，仅
  静音。否决为修复手段。
- **C（differ 内宽正则识别全部 DEC 模式串）**：覆盖面不及 A+（漏 clearTerminal），
  正则放宽方向上存在吞掉真失步的风险，改动面更大。否决。
- **D（fork/patch Ink）**：违反仓库非目标。否决。

### 最终推荐（单一方案，两个配套最小改动）

**采纳 A + A+，落点与验收如下**：

1. `packages/cli/src/ui/stdout-frame-writer.ts::write`：chunk 为字符串且**整串等于**
   `\x1b[?25l` 或 `\x1b[?25h` 时，直接 `writeReal(chunk, encoding, cb)`——不进
   `transform`、不 `invalidate()`、不计数、不消耗 firstChunk（置于非字符串/编码
   防御检查之后即可）。
2. `packages/cli/src/ui/frame-differ.ts::transform`：chunk 以 `\x1b[2J\x1b[3J\x1b[H`
   开头时 `passThrough(false)`（透传 + 失效缓存、不计数）。
3. 回归测试（补 §3.4 的缝隙）：真实 Ink render + 真实 writer/differ 栈的集成测试，
   断言 **a)** 挂载 + 若干次重渲后 `stats().fallbacks === 0`；**b)** `\x1b[?25l` 字节
   确实到达真实流（吸收≠丢弃）；**c)** 模拟缩小 ≥1 行的 resize 后 `fallbacks` 仍为 0
   且下一帧为全量重绘；**d)** `--no-diff-render` 路径字节流不变。断言不得依赖
   "chunk #2 是光标序列"这类 harness 特有序号。

**理由**：A 直击"两个无前缀启动写入 vs 一个豁免"的根因，且在真实与 harness 两种
顺序下都把启动序列恢复为设计意图（种子帧豁免透传 → 首个识别帧全量 → 之后纯 diff），
`fallbacks === 0` 重新可判（AC-11/`/perf` 信号修复），警告自然消失；A+ 以同类
fail-safe 手法关闭"缩窗误报"这最后一条用户可日常触发的路径；两者合计改动约两个
文件各数行 + 测试，均为"识别失败即回落今日保守行为"的方向，不引入新回归面。
B/C/D 因上述边界缺陷否决。
