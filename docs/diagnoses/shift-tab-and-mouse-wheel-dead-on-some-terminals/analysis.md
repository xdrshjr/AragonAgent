# `Shift+Tab` 不切换模式、鼠标滚轮不滚动历史 —— 只在**某些主机**上

**Bug slug**: `shift-tab-and-mouse-wheel-dead-on-some-terminals`
**版本**: v1（Subtask #0 · 问题定位与分析）
**日期**: 2026-08-08
**代码基线**: `M:/takoAI/JRAgentMesh` @ `fc8dba3d`，`packages/cli` v0.5.12（= npm `@aragon-agent/cli@latest`）

> **下游（评审 / 修复节点）阅读顺序**：先读 §3.1 的一张表 —— 两个症状**只有一个根因**，
> 而且这个根因**不在本仓库的代码里**，在用户装 CLI 时所用的 **Node.js 版本**里。
> 再读 §4「影响面」的第 2、3 条：`Shift+Tab` 在受影响主机上**不是没反应，是干了别的事**，
> 而滚轮的一次性提示还在**主动误导**这些用户。最后读 §6 的落地清单。

---

## 0. 代码位置声明（下游必读）

本任务图的工作目录是 `M:/takoAI/JRAgentMesh/aragon-agent-core`，**本次缺陷的可控部分确实在该子项目内**
（`packages/cli`），但**触发条件在子项目之外**：

1. `Shift+Tab` 的模式切换实现在 `packages/cli/src/ui/App.tsx:1341`，判据是 `key.tab && key.shift`。
2. 滚轮滚动实现在 `packages/cli/src/input/{mouse-events,stdin-mouse-filter}.ts`
   + `packages/cli/src/ui/use-wheel-routing.ts`，开关在 `packages/cli/src/cli.tsx:433`。
3. 两者都依赖终端把按键 / 滚轮编码成 **VT 转义序列**（`\x1b[Z` 与 `\x1b[<b;x;yM`）送进 stdin。
   在 Windows 上，这一步既不归本仓库管，也不归终端模拟器管，而是归 **Node.js 给 `process.stdin`
   设置的控制台输入模式**管 —— 而 Node 只在**足够新的版本**上设置对。

本文所有 `path/to/file.ts:NN` 引用，若无特别说明，**均以 `M:/takoAI/JRAgentMesh/aragon-agent-core/` 为根**。
第三方源码引用标注了仓库与 tag，便于核对。

---

## 1. 问题描述

用户在另一台主机上执行：

```bash
npm i -g @aragon-agent/cli@latest --prefer-online   # 0.5.12
aragon
```

安装成功、CLI 正常启动、能对话、能跑工具。但：

- **`Shift+Tab` 无法切换 `BUILD` / `PLAN` 模式** —— 底部 `shift+tab plan` 的提示还在，按了没用。
- **鼠标滚轮无法向上滚动查看之前的执行历史** —— 全屏（alt-screen）里滚轮完全不起作用。

同一个版本的 CLI，在**另外一些主机上一切正常**。用户没有改过任何配置，没有加 `--no-mouse`，
`~/.aragon-agent/config.json` 里 `mouse` 保持默认 `true`（`packages/cli/src/config/schema.ts:1288`）。

这两条恰好是 CLI 在 README 里明确承诺的能力：

- `packages/cli/README.md:141` —— `` `Shift+Tab` | Toggle **plan mode** (`BUILD` <-> `PLAN`) ``
- `packages/cli/README.md:149` —— `| Mouse wheel | Scroll the transcript (or the open overlay) |`

---

## 2. 复现步骤

### 2.1 最短复现（一句话）

**在 Windows 上，用 Node 18.x / 20.x / 22.0–22.16 / 24.0–24.1 启动 `aragon`，两个功能同时消失；
换成 Node ≥ 22.17.0（或 ≥ 24.2.0）再启动，两个功能同时回来。终端模拟器、`TERM`、
`WT_SESSION`、配置文件全都不用动。**

```powershell
# 坏的（任选其一）
nvm use 20.19.0 ; aragon        # Shift+Tab 无效，滚轮无效
# 好的
nvm use 22.18.0 ; aragon        # Shift+Tab 切换模式，滚轮滚动 transcript
```

### 2.2 不依赖人手的确定性复现（本次实际执行的）

「按一下 Shift+Tab、拨一下滚轮」这种手测无法回答"到底哪一层把键吃掉了"，
所以本次做了一个**把按键直接注入控制台输入缓冲区**的探针，放在
`docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-some-terminals/repro/`：

| 文件 | 作用 |
|---|---|
| `probe-stdin.mjs` | 以 Ink 的方式 `setRawMode(true)`，以 `ui/screen.ts` 的方式写 `\x1b[?1000h\x1b[?1006h`，把收到的每个字节按 hex 落盘 |
| `inject-console-input.ps1` | 在**自己的控制台**里拉起探针（共享同一个控制台），再用 `WriteConsoleInput` 注入 `a` / `Tab` / `Shift+Tab` / `↑` / `Shift+↑` / 滚轮；同时采样 `GetConsoleMode(stdin)` |
| `inject-wheel-only.ps1` | 只测滚轮，并在中途把 `ENABLE_MOUSE_INPUT` 强行打回去做对照 |
| `post-wheel-message.ps1` | 用 `PostMessage(WM_MOUSEWHEEL)` 走**真实窗口消息**路径（见 §7，本次结论不成立/不采信） |

运行方式（PowerShell，必须新开一个控制台窗口，因为探针要一个真 TTY）：

```powershell
$dir = 'M:\takoAI\JRAgentMesh\aragon-agent-core\docs\diagnoses\shift-tab-and-mouse-wheel-dead-on-some-terminals\repro'
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File',"$dir\inject-console-input.ps1",'-NodeExe','node','-Tag','node22' -Wait
Get-Content "$dir\probe-out-node22.jsonl"
Get-Content "$dir\inject-log-node22.txt"
```

把 `-NodeExe` 换成一份老 Node 的 `node.exe` 再跑一次（本次用
`https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip` 解压出来的那份），
就得到 §3.2 的对照结果。

### 2.3 本机环境

Windows 11 26200 / 默认终端。**唯一变量是 `node.exe`**，终端、控制台窗口、脚本、注入内容完全一致。

---

## 3. 根因分析

### 3.1 一句话结论

> **Windows 上 `Shift+Tab`（`CSI Z`）和 SGR 鼠标上报（`\x1b[<b;x;yM`）都只在控制台输入句柄处于
> `ENABLE_VIRTUAL_TERMINAL_INPUT` 时才存在。Node.js 只有从 v22.17.0 / v24.2.0 起才在
> `setRawMode(true)` 时打开这个位；在此之前 Node 走 libuv 自己的 INPUT_RECORD → ANSI 翻译，
> 那份翻译表既没有 `VK_TAB` 条目（Shift 被整个丢弃，`Shift+Tab` 与 `Tab` 输出同一个字节 `0x09`），
> 也会把所有非 `KEY_EVENT` 记录直接 `continue` 掉（鼠标事件永远到不了进程）。**

两个症状、一个根因、一个开关位。

### 3.2 证据一：同机同终端，只换 Node 版本的对照实验

注入完全相同的按键序列，`probe-*.jsonl` 原文（见附录 A）：

| 注入的键 | **Node 20.19.0**（libuv 1.46.0） | **Node 22.18.0**（libuv 1.51.0） |
|---|---|---|
| `a` | `61` | `61` |
| `Tab` | `09` | `09` |
| **`Shift+Tab`** | **`09`** ← 与 `Tab` 逐字节相同 | **`1b 5b 5a`** = `\x1b[Z` |
| `↑` | `1b 5b 41` | `1b 5b 41` |
| `Shift+↑` | `1b 5b 31 3b 32 41` | `1b 5b 31 3b 32 41` |
| 滚轮 ↑ / ↓ | *（无任何数据）* | *（无任何数据，见 §7）* |

同一次运行里采样到的控制台输入模式：

```
# Node 20.19.0
mode_before=0x01F7
mode_during_rawmode=0x0008          # ENABLE_WINDOW_INPUT only
ENABLE_VIRTUAL_TERMINAL_INPUT during raw mode: False

# Node 22.18.0
mode_before=0x01F7
mode_during_rawmode=0x0208          # ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT
ENABLE_VIRTUAL_TERMINAL_INPUT during raw mode: True
```

**这是决定性的**：`Shift+↑` 在两边都正确产出 `\x1b[1;2A`，说明"修饰键丢失"不是控制台或注入的问题；
唯独 `Shift+Tab` 在老 Node 上塌缩成裸 `Tab`。

### 3.3 证据二：Node 的 `SetRawMode` 在哪一版改的

`nodejs/node` `src/tty_wrap.cc`：

```cpp
// v18.20.8 / v20.20.0 / v21.7.3 / v22.0.0 … v22.16.x / v23.x / v24.0.0 / v24.1.x
int err = uv_tty_set_mode(&wrap->handle_, args[0]->IsTrue());       // -> UV_TTY_MODE_RAW
```

```cpp
// v22.17.0+ 与 v24.2.0+
// UV_TTY_MODE_RAW_VT is a variant of UV_TTY_MODE_RAW that
// enables control sequence processing on the TTY implementer side,
// rather than having libuv translate keypress events into
// control sequences, aligning behavior more closely with
// POSIX platforms. This is also required to support some control
// sequences at all on Windows, such as bracketed paste mode.
int err = uv_tty_set_mode(
    &wrap->handle_,
    args[0]->IsTrue() ? UV_TTY_MODE_RAW_VT : UV_TTY_MODE_NORMAL);
```

（核对方式：`curl -s https://raw.githubusercontent.com/nodejs/node/<tag>/src/tty_wrap.cc | grep UV_TTY_MODE_RAW_VT`，
本次逐个 tag 跑过，边界见 §3.6。Node 自己的注释就点名了"Windows 上有些控制序列**根本不存在**"。）

`libuv` `src/win/tty.c::uv_tty_set_mode`（v1.51.0:383-397）：

```c
    case UV_TTY_MODE_RAW_VT:
      try_set_flags = ENABLE_VIRTUAL_TERMINAL_INPUT;
      InterlockedExchange(&uv__tty_console_in_need_mode_reset, 1);
      /* fallthrough */
    case UV_TTY_MODE_RAW:
      flags = ENABLE_WINDOW_INPUT;
      break;
```

同一文件 v1.44.2（Node 18 内置）**没有 `UV_TTY_MODE_RAW_VT` 这个枚举值**，
只有 `case UV_TTY_MODE_RAW: flags = ENABLE_WINDOW_INPUT;`。
观测到的 `0x0008` / `0x0208` 与这两段逐位吻合。

### 3.4 证据三：为什么 `Shift+Tab` 恰好塌缩成 `Tab`

老路径下，libuv 亲自把 `INPUT_RECORD` 翻译成 ANSI。翻译分两支
（`libuv` v1.51.0 `src/win/tty.c:827` 起）：

```c
      if (KEV.uChar.UnicodeChar != 0) {
        /* Character key pressed */
        ...
        /* Prefix with \u033 if alt was held ... */
        ...   /* ← SHIFT_PRESSED 在这一支里从头到尾没有被读过 */
      } else {
        /* Function key pressed */
        vt100 = get_vt100_fn_key(KEV.wVirtualKeyCode,
                                 !!(KEV.dwControlKeyState & SHIFT_PRESSED), ...);
```

- Windows 控制台给 `Shift+Tab` 的记录是 `wVirtualKeyCode = VK_TAB`、
  **`uChar.UnicodeChar = 0x09`**、`dwControlKeyState = SHIFT_PRESSED`。
- `UnicodeChar != 0` ⇒ 走**字符支**，只输出这个字符（Alt 才加 ESC 前缀），**Shift 被丢弃**。
- 就算走到函数键支也没用：`get_vt100_fn_key`（v1.51.0:653-700）的表里有
  `VK_INSERT / VK_END / VK_DOWN / VK_LEFT / VK_UP / VK_HOME / VK_PRIOR / VK_DELETE / VK_NUMPAD* / VK_F1..`，
  **没有 `VK_TAB`**。

这解释了为什么 `Shift+↑` 好、`Shift+Tab` 坏：`VK_UP` 的 `UnicodeChar` 是 0，走函数键支，
表里有 `VK_CASE(VK_UP, "[A", "[1;2A", …)`，Shift 被正确编码。

### 3.5 证据四：为什么滚轮在老路径上**必然**无效

两道闸门，任意一道就足够：

1. **libuv 直接丢弃**（v1.51.0 `src/win/tty.c:786-789`）：

   ```c
      /* Ignore other events that are not key events. */
      if (handle->tty.rd.last_input_record.EventType != KEY_EVENT) {
        continue;
      }
   ```

   `MOUSE_EVENT` 记录连进程都进不了。

2. **控制台的"鼠标 → VT"翻译本身就要求 VT 输入模式**
   （`microsoft/terminal` `src/host/inputBuffer.cpp:603-607`）：

   ```cpp
   bool InputBuffer::WriteMouseEvent(til::point position, const unsigned int button,
                                     const short keyState, const short wheelDelta)
   {
       const auto wakeup = _wakeupReadersOnExit();
       if (IsInVirtualTerminalInputMode())
       {
   ```

   而 `src/interactivity/win32/windowio.cpp:580` 的 `HandleTerminalMouseEvent(...)` 正是它的唯一调用点，
   失败后才落到 `windowio.cpp:779` 那条 legacy 分支 —— 那条分支被 `ENABLE_MOUSE_INPUT` 门控，
   而 libuv 的 `UV_TTY_MODE_RAW` 只设 `ENABLE_WINDOW_INPUT`，**恰好把这个位清掉了**
   （实测 `0x0008`，不含 `0x0010`）。

也就是说：老 Node 上不但 `\x1b[?1000h` 白写，连"退化成 legacy 鼠标记录"这条路也是断的。
CLI 的失效表现因此是**彻底静默**：滚轮既不滚动、也不误触发历史回溯、也不在 composer 里吐乱码。
与用户描述完全一致。

### 3.6 受影响的 Node 版本边界（逐 tag 核对）

| Node 版本线 | `SetRawMode` 走的模式 | `Shift+Tab` / 滚轮 |
|---|---|---|
| 18.x（全部） | `UV_TTY_MODE_RAW` | ❌ 全废 |
| 20.x（全部，含最新的 20.20.0） | `UV_TTY_MODE_RAW` | ❌ 全废 |
| 22.0.0 – 22.16.x | `UV_TTY_MODE_RAW` | ❌ 全废 |
| **22.17.0+** | `UV_TTY_MODE_RAW_VT` | ✅ |
| 23.x（已 EOL） | `UV_TTY_MODE_RAW` | ❌ 全废 |
| 24.0.0 – 24.1.x | `UV_TTY_MODE_RAW` | ❌ 全废 |
| **24.2.0+** | `UV_TTY_MODE_RAW_VT` | ✅ |

**Node 20 是当前大量 Windows 开发机的默认 LTS，而它整条线都在受影响区间内** —— 这就是
"有的主机正常有的不正常"的分布来源，与终端模拟器无关。

### 3.7 本仓库这一侧的**放大器**：`engines` 与"能力检测"都没有守住

- `packages/cli/package.json` 声明 `"engines": { "node": ">=18" }`
  （`npm view @aragon-agent/cli engines` 同样返回 `{ node: '>=18' }`）。
  于是 `npm i -g @aragon-agent/cli@latest` 在 Node 18 / 20 上**安装成功、启动成功、
  两个已宣传的功能静默不存在**，用户没有任何线索。
- `cli.tsx:433` 的能力判据只看四件事，**没有一件与"终端会不会真的上报"有关**：

  ```ts
  const wantMouse =
    mode === 'fullscreen' && config.mouse && !!process.stdout.isTTY && !!process.stdin.isTTY;
  ```

- `tryCreateMouseFilter`（`input/stdin-mouse-filter.ts:164`）返回 `null` 的唯一条件是**构造抛异常**，
  而它只是包了一个 `PassThrough`，在受影响主机上照样构造成功。
  于是 `enterAltScreen(stdout, { mouse: mouseFilter !== null })` 照常写出 `\x1b[?1000h\x1b[?1006h`
  （`ui/screen.ts:34`），而这串序列在这些主机上是**纯粹的空操作**。
- 更糟的是这个假信号会一路传到用户脸上：`App.tsx:827` 把
  `enabled: !!mouseSource` 交给 `useStartupNotices`，于是受影响用户会看到

  > Mouse wheel scrolls the transcript. Hold Shift to select text, or turn it off with
  > `aragon config set mouse false`.

  —— 一条**关于一个根本没运行起来的模式的建议**。而 `use-startup-notices.ts:59-68` 的注释
  早就写明了这条不变量：

  > *Whether reporting is ACTUALLY in effect — i.e. a filter was installed, not merely that the
  > config asked for one. A user on a terminal where R-1 fires must never be given advice about
  > a mode that is not running.*

  **代码实现不满足它自己的注释**：`filter !== null` 并不蕴含"终端会上报"。

### 3.8 这是一个**被写进设计文档、然后没有关闭的发布闸门**

`docs/plans/mouse-wheel-region-routing/spec.md` 把这件事写得清清楚楚：

- §9 **R-1**：*"Node/libuv may not surface mouse reports on Windows consoles. …
  **Not a mitigation — a gate.**"*
- §11 Phase 0 要求在写任何一行代码之前先跑一个一次性探针，并给了判定表：
  *"arrives in Windows Terminal / VS Code, not in `conhost` | proceed, and adopt §13-Q1's `win32` gate
  with the observed env-var signature"*。
- 而 §12 的交付记录里，两行都是 **NOT RUN**：

  | `§8.4 manual matrix` | **NOT RUN** — needs a real terminal and a real wheel |
  | `§11 phase 0 probe`  | **NOT RUN** — see IF-1; this is the open release gate |

**本文的 §2.2 探针就是那个迟到的 Phase 0，结论是：R-1 成立，且它的真实自变量不是"终端"而是"Node 版本"。**
`§13-Q1` 当年设想的 `WT_SESSION` / `TERM_PROGRAM` 环境变量启发式**会是错的** —— 本机
`WT_SESSION` 之类环境变量在两次运行中完全一致，唯一差异是 `node.exe`。

`Shift+Tab` 一侧也有对应记录：`docs/plans/plan-mode/spec.md` §10 **R-P1**
*"Terminal eats Shift+Tab. Some multiplexers and remote-desktop stacks never send CSI Z."*
—— 缓解措施是 `/plan`。**方向对，归因不全**：真正吃掉 `CSI Z` 的最大一类不是多路复用器，
是用户机器上的 Node 版本，而 README（`packages/cli/README.md:461-465`）只写了前者。

---

## 4. 影响面

1. **平台**：仅 `win32`。macOS / Linux 走真 PTY，终端直接给出 `\x1b[Z` 与 SGR 上报，不受影响。
   WSL 内运行同理不受影响。
2. **`Shift+Tab` 不是"没反应"，是"做了别的事"** —— 这条比"功能缺失"更值得优先修：
   受影响主机上它到达 Ink 时是一个**普通 Tab**（`{tab: true, shift: false}`），于是
   - 开着 `/` 命令面板或 `@` 文件补全时，命中 `PromptInput.tsx:354` 的 `completeSelection()`，
     **直接改写用户正在写的草稿** —— 正是 `plan-mode` spec 的 R-P2 想防的失败，
     `PromptInput.tsx:341` 的守卫（`if (key.tab && key.shift) return;`）在这里形同虚设，
     因为 `key.shift` 恒为 `false`；
   - 在设置面板里命中 `ui/overlays/SettingsScreen.tsx:341` 的 `key.downArrow || (key.tab && !key.shift)`，
     **光标往下跳一格**；（评审更正：原文路径漏了 `ui/overlays/`，行号无误）
   - 其余情况下静默丢弃。
3. **滚轮**：全屏模式下彻底无效（alt-screen 没有原生 scrollback，滚轮既不滚 transcript 也不滚终端）。
   `PgUp` / `PgDn` / `Shift+↑` / `Shift+↓`（`App.tsx:1366-1382`，`fullscreen` 分支内）**不受影响，仍可用** ——
   这是给用户的即时可用绕行方案。
   **评审补注（证据强度不同，勿混为一谈）**：`Shift+↑` / `Shift+↓` 是**实测**结论 ——
   附录 A 两份 jsonl 里它在 Node 20 与 Node 22 上都是 `1b5b313b3241`，**逐字节相同**，
   故"好主机上能用"直接蕴含"受影响主机上也能用"，无需再测。
   而 `PgUp` / `PgDn` **本次未注入**，是从 libuv 函数键表含 `VK_PRIOR` / `VK_NEXT` 推出来的。
   两者都可写进给用户的答复，但若只保留一条，应保留 `Shift+↑` / `Shift+↓`（唯一被字节级证明的那条）。
   inline 模式（`--no-fullscreen`）不受影响，因为那里靠终端自己的 scrollback。
4. **误导性提示**：§3.7 的一次性 notice 会对受影响用户显示，并且被 `mouseNoticeSeen` 记成"已看过"，
   即使他们升级 Node 之后也不会再看到正确版本的提示。
5. **规模**：Node 20 是当前 Windows 上最常见的 LTS。按 §3.6 的表，**除 22.17+/24.2+ 之外的所有
   Node 版本都受影响**，而 `engines: >=18` 对它们全部放行。这不是长尾，是主流配置。

### 4.1 会产生**相同症状**但根因不同的情况（修复时不要一并宣称已解决）

| 情况 | 判据 | 归属 |
|---|---|---|
| 很老的 conhost 不接受 `ENABLE_VIRTUAL_TERMINAL_INPUT` | libuv 静默回退：`if (!SetConsoleMode(tty->handle, flags \| try_set_flags) && !SetConsoleMode(tty->handle, flags))`（v1.51.0 `src/win/tty.c:417-418`） | 环境，本次不修 |
| 渲染模式退化成 inline | `TERM=dumb` / `CI` 非空 / `rows < 12` / `cols < 40` / `--no-fullscreen`（`ui/layout/frame.ts:70-83`） | 设计如此 |
| `tmux` 开着 `mouse on` | spec R-2；`set -g mouse off` 交还 | 已文档化 |
| 多路复用器 / 远程桌面不转发 `CSI Z` | spec R-P1 | 已文档化，`/plan` 兜底 |
| 用户自己关了 | `--no-mouse` / `ARAGON_MOUSE=0` / `config set mouse false` | 设计如此 |

---

## 5. 候选修复对比

| # | 方案 | 侵入性 | 风险 | 工作量 | 能否真正恢复功能 |
|---|---|---|---|---|---|
| **F1** | **能力检测 + 说真话**：新增 `supportsWindowsVtInput(platform, nodeVersion)`，用它（a）参与 `cli.tsx:433` 的 `wantMouse`，不再对不支持的主机写 `?1000h`；（b）喂给 `useStartupNotices` 的 `enabled`，堵住误导提示；（c）在受影响主机上给一条一次性 notice，写明"需要 Node ≥ 22.17（Windows），当前 vX；请用 `/plan` 与 `PgUp/PgDn`，或升级 Node"；（d）README 补一段 | 低（新增 1 个纯函数 + 3 处接线） | 低。纯函数可单测；不改任何既有键位；对不受影响主机逐字节不变 | 小（半天） | ❌ 不恢复，但把"静默消失"变成"明确告知 + 可用绕行" |
| **F2** | **自己把 `ENABLE_VIRTUAL_TERMINAL_INPUT` 打开**：Node 无此 API，只能（a）加原生 addon，或（b）在 `setRawMode(true)` 之后 spawn 一次 `powershell -c SetConsoleMode` 对**共享控制台**改位 | 高 | 高。libuv 在 `tty->tty.rd.mode.mode` 里缓存模式，任何一次 raw 模式重设（Ink 卸载/重挂、`/` 面板、退出恢复）都会把位冲掉；(a) 破坏"纯 JS、`npx` 可跑"；(b) 每次启动多一次 PowerShell 进程（数百 ms + 杀软噪音），且 ConPTY 会话下语义未验证 | 中～大 | ✅ 理论上两个功能都回来（本次**未验证**，见 §7） |
| **F3** | **给模式切换加一个无修饰键的备用键位**（如 `Ctrl+P`），与 `Shift+Tab` 并存；同时把 `/plan` 提到 README/帮助层更显眼的位置 | 低（`App.tsx` 加一条分支 + 帮助覆盖层 + README） | 低～中。需确认不与既有 `Ctrl+C/L/T/O`（`App.tsx:1295/1347/1383/1397`）及 `input/keymap.ts` 的 `Ctrl+A/E/W/U/K` 冲突；`Ctrl+P` 当前空闲 | 小 | ✅ 恢复**模式切换**（对滚轮无效） |
| **F4** | **滚轮降级到 DEC 1007（alternate scroll）**：检测到无法上报时不再写 `SAVE_ALT_SCROLL_OFF`，让终端把滚轮翻译成方向键并路由到滚动 | 中 | **高**。方向键不带坐标，正是 `mouse-wheel-region-routing` 立项要消灭的那个 bug（滚轮改写草稿 / 误触发历史回溯，G1/G3）。等于把老缺陷请回来 | 中 | ⚠️ 恢复"能滚"，但代价是重开旧伤口 |
| **F5** | **把 `engines.node` 抬到 `>=22.17.0`** | 低（一行） | 高。CLI 的主体价值（agent 循环、工具、skills）在 Node 18/20 上完全正常，为两个 TUI 便利功能把这些用户挡在门外不成比例；`npm` 默认只 warn 不拦，实际拦截力也有限 | 极小 | ❌ 不恢复功能，只是拒绝服务 |

---

## 6. 推荐修复

**推荐 F1 + F3 一起落地，F2 只做可行性调研、不进本次交付，F4 / F5 拒绝。**

理由：

1. **F1 是唯一能把"静默"变成"可归因"的方案，而"静默"才是这个 bug 真正的伤害。**
   用户装完能跑、功能却不存在、还收到一条教他怎么用这个不存在功能的提示 ——
   他没有任何路径能自己走到"升级 Node"。F1 之后，同样的主机会在启动时读到一行明确的话，
   并被告知 `PgUp/PgDn` 与 `/plan` 立刻可用。这条修复对不受影响主机**逐字节不变**。
2. **F1 顺带修掉一个真实的不变量违反**：`use-startup-notices.ts:59-68` 的注释要求
   `enabled` 表示"上报确实在生效"，而 `App.tsx:827` 传的是"filter 对象存在"。
   这条注释与实现的背离本身就是缺陷，与本 bug 同源。
3. **F3 让"切换模式"这件事重新在所有终端上可用**，成本只有一条分支。
   `/plan` 虽然已经是等价物（`commands/builtins.ts:274-299`，其注释就是为 R-P1 写的），
   但它要求用户先知道 `Shift+Tab` 坏了 —— 而在 §4 第 2 条描述的场景里，用户看到的是"草稿被改写"，
   根本不会往"键位失效"上想。
4. **F2 被推迟而不是否决**：它是唯一能真正在老 Node 上恢复滚轮的方案，但
   "libuv 会在下一次 `uv_tty_set_mode` 时把我们改的位冲掉"这一点必须先用实验证伪或证实，
   否则会做出一个"时灵时不灵"的功能 —— 那比现在的"稳定不灵"更糟。
5. **F5 单独使用不可接受**：它把一个 TUI 便利功能的缺失升级成整个 CLI 的不可安装。
   但 F1 落地时**建议同步把 `engines.node` 保持 `>=18` 不动**，并在 README 的
   "Requirements" 里加一句"Windows 上 `Shift+Tab` 与鼠标滚轮需要 Node ≥ 22.17"。

### 6.1 落地清单（下游修复节点照此执行）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/cli/src/ui/win-vt-input.ts`（新增） | 纯函数 `supportsWindowsVtInput(platform: string, nodeVersion: string): boolean`：非 `win32` 恒 `true`；`win32` 时 `>=22.17.0 && <23` 或 `>=24.2.0` 为 `true`。**复用 `update/semver.ts::parseSemver`**，不要再写一个版本解析器 |
| 2 | `packages/cli/src/cli.tsx:433` | `wantMouse` 增加 `&& supportsWindowsVtInput(process.platform, process.versions.node)`。这样受影响主机走 `enterAltScreen(..., { mouse: false })` → 写 `SAVE_ALT_SCROLL_OFF` 而不是 `?1000h`，即 spec §4.4 fail-safe ladder 本来就设计好的那一级 |
| 3 | `packages/cli/src/ui/App.tsx:824-831` | 把真实能力（而非 `!!mouseSource`）传进 `useStartupNotices`；受影响时改为发一条 warn notice 说明原因与绕行方案 |
| 4 | `packages/cli/src/ui/App.tsx:1341` 附近 | 增加备用键位分支（建议 `Ctrl+P`），与 `Shift+Tab` 共用 `applyMode(nextMode(...))`；同样受 `stateRef.current.overlay` 早退保护 |
| 5 | `packages/cli/src/ui/overlays/HelpOverlay.tsx:27,43,76` | 帮助覆盖层补上新键位 |
| 6 | `packages/cli/README.md:141,149,461-465` | 键位表补新键位；"If `Shift+Tab` does nothing" 一节补 Node 版本这一类原因（目前只写了多路复用器 / 远程桌面）；滚轮一节补同样的前置条件 |
| 7 | `docs/plans/mouse-wheel-region-routing/spec.md` §9 R-1 / §11 / §12 | 把 Phase-0 的结论写回去并关闭这个闸门：自变量是 Node 版本而非环境变量，§13-Q1 设想的 `WT_SESSION` 启发式**作废** |
| 8 | 测试 | `win-vt-input.test.ts` 覆盖 §3.6 表里的每条边界（18/20/22.16/22.17/23/24.1/24.2 + 非 win32）；`app.test.tsx` 补一条"备用键位切换模式"；`use-startup-notices` 补一条"能力为 false 时不发鼠标 notice" |

### 6.2 给用户的即时答复（无需等修复）

> 请把 Node 升到 **22.17.0 或更高**（或 24.2.0+），然后重装 / 重启 `aragon`。
> 这两个功能在 Windows 上依赖 Node 从 22.17 起才启用的控制台 VT 输入模式，
> 与终端模拟器和 aragon 的配置无关。在升级之前：用 `/plan` 切换模式，
> 用 `PgUp` / `PgDn` / `Shift+↑` / `Shift+↓` 滚动历史。

---

## 7. 本次**未能**验证的部分（不要当成已验证）

诚实记录，避免下游据此过度宣称：

1. **"升级 Node 之后滚轮确实会动"这一条是代码路径论证，不是实测。**
   §3.5 的两处源码（libuv 丢弃非 KEY_EVENT、`InputBuffer::WriteMouseEvent` 要求 VT 输入模式）
   足以证明**老 Node 上必然无效**，但"新 Node 上必然有效"还差一次真实滚轮实验。
   本次尝试过两条替代路径，都不成立：
   - `WriteConsoleInput` 注入 `MOUSE_EVENT` —— 鼠标的 VT 翻译挂在**窗口消息**路径
     （`windowio.cpp::HandleMouseEvent` → `HandleTerminalMouseEvent`），直接塞进输入缓冲区会绕过它。
     所以 §3.2 表里"新 Node 滚轮也无数据"**不能**读作"新 Node 滚轮也坏"。
   - `PostMessage(WM_MOUSEWHEEL)` 到 `GetConsoleWindow()` —— 本机会话在 ConPTY 下运行
     （探针实测 `window_rect=(0,0)-(0,0)`，即伪控制台的隐藏窗口），窗口消息不是它的输入路径。
   **补齐方式**：跑 `docs/plans/mouse-wheel-region-routing/spec.md` §8.4 那张手测矩阵
   （`docs/plans/mouse-wheel-region-routing/manual-test.md`），在 Windows Terminal / conhost /
   VS Code 三处各拨一次真实滚轮，Node 版本各取 22.16 与 22.18。这件事本来就欠着。
2. **F2（自己改控制台模式）是否稳定**：未做实验。§5 里列的"libuv 缓存模式导致被冲掉"是推理，
   需要一次"改位 → 触发 Ink 重设 raw 模式 → 再采样 `GetConsoleMode`"的实验来定性。
3. **非 Windows 平台完全未测**，因为归因已明确指向 Windows 专有路径。

---

## 附录 A · 原始探针数据

`repro/probe-out-node20.jsonl`（Node 20.19.0 / libuv 1.46.0）：

```
{"event":"start","node":"v20.19.0","uv":"1.46.0","platform":"win32",...,"stdinIsTTY":true,"stdoutIsTTY":true}
{"event":"data","hex":"61","text":"\"a\""}
{"event":"data","hex":"09","text":"\"\\t\""}          ← Tab
{"event":"data","hex":"09","text":"\"\\t\""}          ← Shift+Tab（与上一行相同）
{"event":"data","hex":"1b5b41","text":"\"\\u001b[A\""}
{"event":"data","hex":"1b5b313b3241","text":"\"\\u001b[1;2A\""}
{"event":"stop"}
```

`repro/probe-out-node22.jsonl`（Node 22.18.0 / libuv 1.51.0）：

```
{"event":"start","node":"v22.18.0","uv":"1.51.0","platform":"win32",...,"stdinIsTTY":true,"stdoutIsTTY":true}
{"event":"data","hex":"61","text":"\"a\""}
{"event":"data","hex":"09","text":"\"\\t\""}          ← Tab
{"event":"data","hex":"1b5b5a","text":"\"\\u001b[Z\""} ← Shift+Tab（CSI Z）
{"event":"data","hex":"1b5b41","text":"\"\\u001b[A\""}
{"event":"data","hex":"1b5b313b3241","text":"\"\\u001b[1;2A\""}
{"event":"stop"}
```

`repro/wheel-log.txt`（`ENABLE_MOUSE_INPUT` 对照，Node 22.18.0）：

```
in_mode_before=0x01F7  out_mode_before=0x0007
in_mode_during=0x0208  out_mode_during=0x0007
ENABLE_MOUSE_INPUT set during raw mode: False          ← libuv 的 raw 模式把它清掉了
ENABLE_VIRTUAL_TERMINAL_INPUT set during raw mode: True
```

（`out_mode = 0x0007` 含 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`，说明 `\x1b[?1000h` 确实被控制台解析了 ——
问题不在"请求没发出去"，而在"回报的通道没打开"。）

## 附录 B · 第三方源码引用清单

| 引用 | 出处 |
|---|---|
| `UV_TTY_MODE_RAW_VT` / `UV_TTY_MODE_RAW` 的 flags | `libuv` v1.51.0 `src/win/tty.c:383-397`；v1.44.2 同函数无 `RAW_VT` |
| 非 `KEY_EVENT` 记录被丢弃 | `libuv` v1.51.0 `src/win/tty.c:786-789` |
| 字符支丢弃 Shift / 函数键表无 `VK_TAB` | `libuv` v1.51.0 `src/win/tty.c:827` 与 `:653-700` |
| `SetRawMode` 改用 `RAW_VT` | `nodejs/node` `src/tty_wrap.cc`，v22.17.0 / v24.2.0 起 |
| 鼠标 → VT 需要 VT 输入模式 | `microsoft/terminal` `src/host/inputBuffer.cpp:603-607` |
| legacy 鼠标路径被 `ENABLE_MOUSE_INPUT` 门控 | `microsoft/terminal` `src/interactivity/win32/windowio.cpp:580, 779` |
| Ink 把 `[Z` 解析成 `tab` + `shift` | `node_modules/ink/build/parse-keypress.js:84`（`'[Z': 'tab'`）与 `:87-101`（`isShiftKey` 列表含 `'[Z'`），ink v5.2.1 |

---

## 评审结论

**评审节点**: Subtask #1 · 分析报告评审与修复
**评审日期**: 2026-08-08
**结论**: **根因成立，证据链通过复核；推荐方案需要收窄与加固。**
最终推荐 **F1′**（F1 的加固版）作为**唯一**交付方案；**F3 降级为独立的后续改进，不进本次修复**。

### R1. 根因证据链复核

我把报告里每一条可机械核对的引用都回读了源码 / 原始数据，逐条结论如下。
**没有发现被夸大或倒果为因的引用。**

| # | 报告的主张 | 复核方式 | 结论 |
|---|---|---|---|
| 1 | 探针数据 `Shift+Tab`：Node 20 → `09`，Node 22 → `1b5b5a` | 直接读 `repro/probe-out-node{20,22}.jsonl` | ✅ 与报告**逐字节一致**，非事后编辑 |
| 2 | 控制台模式 `0x0008` vs `0x0208` | 读 `repro/inject-log-node{20,22}.txt` | ✅ 一致 |
| 3 | 唯一变量是 `node.exe` | 两份 inject-log 的 `mode_before` 均为 `0x01F7`，注入序列、written 计数完全相同 | ✅ 对照实验成立 |
| 4 | `Shift+Tab` 判据在 `App.tsx:1341` | 读源码 | ✅ 行号精确，`if (key.tab && key.shift)` |
| 5 | `wantMouse` 在 `cli.tsx:433` | 读源码 | ✅ 行号精确 |
| 6 | `enterAltScreen(..., { mouse: filter !== null })` | `cli.tsx:505` | ✅ |
| 7 | `mouse:false` 时写 `SAVE_ALT_SCROLL_OFF` | `ui/screen.ts:92` | ✅ 三元表达式确如所述 |
| 8 | `enabled: !!mouseSource` | `App.tsx:827` | ✅ 行号精确 |
| 9 | `use-startup-notices` 的不变量注释 | 该文件 `:59-67` | ✅ 原文存在（但见 **N-2**，报告对它的定性需要修正） |
| 10 | Tab 落到 `completeSelection()` | `PromptInput.tsx:341` 守卫 + `:354` 分支 | ✅ 两处行号精确 |
| 11 | 设置面板 Tab 下移 | `ui/overlays/SettingsScreen.tsx:341` | ✅ 行号精确，**路径已在 §4.2 就地更正** |
| 12 | `PgUp/PgDn/Shift+方向键` 归属 | `App.tsx:1366-1382` | ✅（行号已就地校正为 1366-1382） |
| 13 | `engines: >=18` | `packages/cli/package.json:40-42` | ✅ |
| 14 | `mouse` 默认 `true` | `config/schema.ts:1288` | ✅ |
| 15 | ink 把 `[Z` 解析成 tab+shift | `node_modules/ink/build/parse-keypress.js:84,100`，ink 5.2.1 | ✅ |
| 16 | spec R-1 原文 "Not a mitigation — a gate" | `docs/plans/mouse-wheel-region-routing/spec.md:1160` | ✅ 一字不差 |
| 17 | spec §12 两行 **NOT RUN** | 同上 `:1590-1591`，且 `:1682` 复述 "still NOT RUN" | ✅ |
| 18 | HelpOverlay 待改行 | `:27, :43, :76` | ✅（另需补 `:33`/`:34` 的 Wheel 两行，报告漏列） |
| 19 | README 键位表 | `:141`, `:149` | ✅ |
| 20 | 复用 `update/semver.ts::parseSemver` 可行 | 该文件 `:42` | ✅（但见 **N-7**：有更合适的复用点） |

**未采信 / 已在原文标注为未验证的**：`repro/probe-wheel.jsonl` 与
`post-wheel-message.ps1` 路径下的滚轮数据。报告 §7.1 已诚实说明注入 `MOUSE_EVENT`
绕过了窗口消息路径、因此"Node 22 滚轮也无数据"**不可**读作"Node 22 滚轮也坏"。
**评审同意这个自我否证，并认为它是本报告可信度最高的一段**——它主动拆掉了一条对自己有利的证据。

### R2. 反例与替代解释的排除

评审的重点不是复述报告，而是主动找它可能错在哪。我检查了以下替代解释，**全部排除**：

1. **"是不是 plan 模式本身被某个配置关掉了？"** —— 排除。`nextMode`（`agent/agent-mode.ts:34`）
   是纯函数无门控；`App.tsx:1341` 分支上唯一的早退是 `if (stateRef.current.overlay) return;`；
   `applyMode`（`:1045`）不读任何"plan 是否可用"的开关。
   且 `Composer.tsx:73` **无条件**渲染 `shift+tab <mode>` 提示 —— 这正对应用户描述的
   "底部提示还在，按了没用"。**没有任何配置能造成"提示在、功能不在"，只有输入层能。**
2. **"是不是终端模拟器的问题？"** —— 排除。对照实验中终端、控制台窗口、`WT_SESSION`
   等环境变量完全一致，唯一变量是 `node.exe`。这也直接**证伪了 spec §13-Q1 设想的
   `WT_SESSION` / `TERM_PROGRAM` 环境变量启发式**（报告 §3.8 已指出，评审确认）。
3. **"是不是 inline 模式（非全屏）导致的？"** —— 排除。inline 下终端自带 scrollback，
   滚轮本就能滚；用户报告的是滚轮**完全无效**，只可能发生在 alt-screen 里。
4. **"是不是装到了旧版本？"** —— 排除。用户用的是 `@latest --prefer-online`。
5. **"是不是 mouse filter 把 `\x1b[Z` 吃掉了？"** —— 排除。同一份代码在新 Node 上工作正常，
   而 filter 的行为与 Node 版本无关。
6. **"两个症状会不会是两个独立的 bug？"** —— 这是最值得怀疑的一点，评审重点看了。
   结论是**同一个开关位**：`ENABLE_VIRTUAL_TERMINAL_INPUT` 缺失同时导致
   （a）`CSI Z` 不被生成（libuv 字符支丢 Shift）、（b）`MOUSE_EVENT` 记录被丢弃。
   报告 §3.4 / §3.5 分别给了两条独立的代码路径证据，**不是把一个根因硬套到两个症状上**。
   决定性的交叉验证是 `Shift+↑` 在两个 Node 上**都正确**产出 `\x1b[1;2A`：
   这排除了"注入脚本没送出 Shift"和"控制台整体丢修饰键"两种可能，把故障面精确收窄到
   `VK_TAB` 与 `MOUSE_EVENT` 这两类记录上。

### R3. 评审期补充的证据（原报告未提及）

以下 8 条是本次评审新查到的，用于把证据链补成闭环。

- **N-1 · `mouseSource` 的完整链路**（原报告只说"`!!mouseSource`"，未给链路）：
  `cli.tsx:435` 构造 `mouseFilter` → `:505` 用 `mouseFilter !== null` 决定是否写 `?1000h`
  → `:562` 以 `mouseSource={mouseFilter?.source}` 传进 `App` → `App.tsx:827` 传给 notice。
  因此 **`!!mouseSource` ≡ `mouseFilter !== null` ≡ `wantMouse`（构造几乎不会失败）**。
  这条链路说明 F1 只需改 `wantMouse` 一处，`?1000h` 与 notice 会**同时**跟着变 ——
  §6.1 把它拆成 2、3 两项分别接线是**多余且有风险**的（见 R6-1）。
- **N-2 · 报告对 `use-startup-notices.ts` 注释的定性需要修正。** 原文说"代码实现不满足它自己的注释"，
  更准确的说法是：**这条注释自身是自相矛盾的**。它的第一句用 "i.e. a filter was installed"
  给 `enabled` 下了定义 —— 而这恰恰**就是**代码现在做的；真正被违反的是紧接着的第二句
  "A user on a terminal where R-1 fires must never be given advice about a mode that is not running."
  R-1 情形下"filter 已装"与"上报在生效"正好分道扬镳。
  **对修复的直接影响：必须连注释一起改**，否则下一个人会按第一句把实现"改回去"，且改回去时测试全绿。
- **N-3 · 有一条测试断言从来没有真正跑到过 R-1 分支。** `spec.md:1560` 记录了
  `mouse-routing.test.tsx` 的断言：*"never appears when `mouseSource` is absent
  (`--no-mouse`, inline, **or R-1 firing**)"*。但按 N-1 的链路，**R-1 触发时 `mouseSource` 恰恰是存在的**。
  也就是说这条断言的 "R-1 firing" 分支**在实现上不可达，一直是空转通过的**。
  这是"闸门从未建成"在测试层的独立佐证，比 §3.8 的 NOT RUN 记录更硬。
- **N-4 · `PromptInput.tsx:335-341` 的注释点名了这次的失败。** 守卫上方原注释写着
  *"without this guard pressing Shift+Tab with the `/` palette or an `@` file popup open would
  BOTH rewrite the user's draft and change the mode — a bug that only appears with a popup open
  and is therefore easy to ship (AC-P3 / R-P2)"*。**该守卫在受影响主机上恒为假**
  （`key.shift` 永远 `false`），于是它防的那半个 bug（改写草稿）如期发生。
  这把 §4.2 从"推断"升级成"作者自己写下的预言 + 输入层证据"。
- **N-5 · 提示与功能的错位有代码依据**：`Composer.tsx:73` 无条件渲染 `shift+tab …`。
- **N-6 · 老 Node 还漏了一次控制台模式还原**：`inject-log-node20.txt` 的 `mode_after=0x0008`
  ≠ `mode_before=0x01F7`，而 node22 那份 `mode_after=0x01F7` 正确还原。
  这是**次生问题**（退出后控制台留在被改过的模式里），不影响本次结论，但值得记一笔。
- **N-7 · 存在比 `parseSemver` 更合适的复用点**：`update/semver.ts:243`
  已有 `satisfiesNodeRange(range, nodeVersion)`，支持 `>=` `<` `<=` `>` `^` `~` `x` 与 `||` 联合、
  空格分隔的 AND 子句（`satisfiesClause` `:194-222` 逐个 case 已读）。
  用它可以把版本判据写成**一个字符串常量**而非手写比较，且它已有单测。
  实测推演四条边界均正确：`20.19.0`→false、`22.18.0`→true、`23.11.1`→false、`24.1.0`→false、`24.2.0`→true。
  ⚠️ **但它 FAILS OPEN**（`:248` 版本号无法解析、`:266` 子句无法解析，两处都直接 `return true`），
  这带来一个陷阱，见 R6-3。
- **N-8 · `Ctrl+P` 确实空闲**（供 F3 未来使用）：全量枚举了
  `App.tsx` 的 `c/l/t/o`（`:1295/1347/1383/1397`）、`keymap.ts::fromCtrl` 的 `a/e/w/u/k`（`:30-47`）、
  `fromRaw` 的裸控制字符 `\x01/\x05/\x17/\x15/\x0b`（`:58-86`），均不含 `\x10`。

### R4. 候选修复复核

#### F1 —— 通过，但需加固（见 R6）

- **"改 `wantMouse` 会不会因为不装 filter 而让上报字节漏进 composer？"** 不会，且这一点可以证明：
  被门控的路径恒为 `win32 + 老 Node`，而 §3.5 的第一道闸门
  （libuv 对非 `KEY_EVENT` 记录无条件 `continue`）**与终端、与是否写过 `?1000h` 都无关**，
  所以那条路径上**不可能有任何鼠标字节到达 stdin**，filter 没有东西可过滤。
  因此"连 filter 一起关掉"是安全的，也是最小的。
- **F1 是最小改动吗？** 是。按 N-1，`wantMouse` 是三个下游（`?1000h`、filter、notice）的唯一上游。
- **F1 会不会引入新回归？** 有**一处真实的行为改变**，报告没提，见 R6-4（alt-scroll）。

#### F3 —— **评审否定其进入本次修复**（这是对原推荐的主要修改）

报告推荐 F1+F3 并列。评审认为 **F3 应当移出本次交付**，理由三条：

1. **功能已经存在且已文档化。** `/plan` 是模式切换的**完整**等价物
   （`commands/builtins.ts:274-299`），且 README:141 就写着 "Equivalent: `/plan`"，
   HelpOverlay:43 也列着。报告为 F3 给出的唯一理由是"用户不知道 `Shift+Tab` 坏了"——
   而**这正是 F1 的 notice 要解决的问题**。F1 落地后该理由自动消失。
   为一件已有两条路径的事情加第三条路径，不是修 bug，是加功能。
2. **F3 并不能减轻这个 bug 最严重的伤害。** §4.2 的草稿被改写，是由
   "`Shift+Tab` 在受影响主机上到达时就是一个普通 Tab"造成的 —— 信息在操作系统层已经丢失。
   **加一个 `Ctrl+P` 不会让 `Shift+Tab` 停止改写草稿**；用户的肌肉记忆仍会触发它。
   能做的最好缓解就是 F1 的 notice 明说这件事（已写进 R6-2 的文案要求）。
3. **它对所有平台的所有用户生效，而 bug 只影响一部分 Windows 用户。** 全局新增键位的回归面
   （与终端 / 复用器既有绑定的冲突、帮助与文档的同步、跨平台一致性）由**未受影响的多数用户**承担，
   收益却只在少数受影响用户身上，且该收益已被 `/plan` 覆盖。不成比例。

> F3 本身不是坏主意，只是**不属于这个 bug**。建议单独开一条改进项，与本次修复解耦。

#### F2 —— 维持推迟，并补一条必须先回答的问题

报告给的推迟理由（libuv 会在下一次 `uv_tty_set_mode` 时冲掉我们改的位）**方向正确但论证未完成**：
`uv_tty_set_mode` 在模式未变化时会提前返回，这**反而可能让我们改的位存活**。
也就是说这条推理**两个方向都成立**，正因如此才必须做实验而不是靠推理定论 ——
这加强而非削弱了"推迟"的结论。§7.2 已列为未验证，评审同意保持。
实验设计已足够具体（改位 → 触发 Ink 重设 raw 模式 → 再采样 `GetConsoleMode`），可直接执行。

#### F4 / F5 —— 维持拒绝

- **F4**：`screen.ts:37-53` 的注释本身就记录了 1007 会把滚轮变成方向键、进而被读成历史回溯，
  正是 `mouse-wheel-region-routing` 立项要消灭的 G1/G3。拒绝理由成立。
- **F5**：同意报告的判断。补充一条更硬的理由：`engines` 抬到 `>=22.17.0`
  会让 Node 18/20 用户在 `npm i -g` 时看到 warn 甚至被 `engine-strict` 拦住，
  而他们的 **agent 循环、工具、skills 全都是好的** —— 用整个 CLI 的可安装性去换两个 TUI 便利功能，
  比例失当。**维持 `>=18` 不动**，只在 README 的 Requirements 里加一句条件说明。

### R5. 最终推荐（唯一方案）

> ## **推荐 F1′ —— 能力检测 + 说真话（F1 的加固版），作为本次修复的唯一交付。**
>
> **F3 移出本次范围**（`/plan` 已是完整等价物，见 R4）；**F2 只做实验、不进交付**；**F4 / F5 拒绝**。

**理由（按重要性排序）**：

1. **这个 bug 的真正伤害是"静默"，不是"缺功能"。** 用户装完能跑、两个被 README 承诺的功能
   不存在、还收到一条教他怎么用这个不存在功能的提示。他没有任何路径能自己走到"升级 Node"。
   F1′ 之后，同一台主机在启动时会读到一句明确的话，并被告知**当场可用**的替代
   （`/plan`、`Shift+↑`/`Shift+↓` —— 后者是本次唯一被字节级证明的滚动方案）。
2. **F1′ 同时修掉一个真实的不变量违反，而且这个违反是有测试掩护的。**
   N-2（注释自相矛盾）+ N-3（`spec.md:1560` 的 R-1 断言不可达、一直空转通过）说明
   这不只是"少写了一个判断"，而是"设计写了闸门、实现没建、测试还假装验过"。
   F1′ 是关闭这条链的唯一方案。
3. **它是最小改动。** 按 N-1，只需一个纯函数 + `wantMouse` 一处接线，
   `?1000h`、filter、notice 三个下游自动跟随。
4. **它对不受影响的主机逐字节不变。** 非 `win32` 恒返回 `true`；`win32` + 新 Node 恒返回 `true`。
5. **它不恢复功能，这一点必须诚实写进交付说明。** F1′ 把"静默消失"变成"明确告知 + 可用绕行"，
   真正恢复滚轮只有 F2，而 F2 尚未被证明可行。**不要在 changelog 里写"修复了滚轮"。**

### R6. F1′ 落地清单（**取代** §6.1，下游修复节点以此为准）

| # | 文件 | 改动 | 相对 §6.1 的变化 |
|---|---|---|---|
| 1 | `packages/cli/src/ui/win-vt-input.ts`（新增） | `supportsWindowsVtInput(platform, nodeVersion): boolean`。非 `win32` 恒 `true`；`win32` 时用 **`satisfiesNodeRange('>=22.17.0 <23 \|\| >=24.2.0', nodeVersion)`**（N-7），不要手写版本比较 | **改**：复用点从 `parseSemver` 上移到 `satisfiesNodeRange` |
| 2 | `packages/cli/src/cli.tsx:433` | `wantMouse` 追加 `&& supportsWindowsVtInput(process.platform, process.versions.node)`。**只改这一处**，`:505` 的 `?1000h` 与 `:562` 的 `mouseSource` 自动跟随（N-1） | **改**：§6.1 第 3 项的"另外接线 notice"是多余的 |
| 3 | `use-startup-notices.ts` + `App.tsx` | 新增一条 **warn** notice：受影响时说明原因（Windows + Node vX < 22.17）、并给出 `/plan` 与 `Shift+↑`/`Shift+↓`。**必须用一个全新的一次性键**（如 `vtInputNoticeSeen`，仿 `config/ui-state.ts:50/56/82` 加），**不得复用 `mouseNoticeSeen`** | **新增（阻断级，见 R6-1）** |
| 4 | `use-startup-notices.ts:59-67` | **改注释**：删掉自相矛盾的 "i.e. a filter was installed"，改为"上报确实在生效 = filter 已装 **且** 平台会上报" | **新增**（N-2） |
| 5 | 测试 | `win-vt-input.test.ts` 用**具体版本字符串→布尔**的表驱动断言覆盖 `18.20.8 / 20.19.0 / 22.16.1 / 22.17.0 / 22.18.0 / 23.11.1 / 24.1.0 / 24.2.0 / 25.0.0` + 非 win32 + **无法解析的版本串**；`mouse-routing.test.tsx` 补一条"受影响时 `mouseSource` 缺席"，使 `spec.md:1560` 的 R-1 断言**第一次真正可达** | **强化**（见 R6-3、N-3） |
| 6 | `packages/cli/README.md:141,149` + Requirements | 两处键位补前置条件；Requirements 加一句"Windows 上 `Shift+Tab` 与鼠标滚轮需要 Node ≥ 22.17（或 ≥ 24.2）"。**`engines` 保持 `>=18` 不动** | 同 §6.1 第 6 项 |
| 7 | `HelpOverlay.tsx` | 若补充说明，注意 wheel 在 **`:33`/`:34`** 两行，不只是 `:27/:43/:76` | **更正**（§6.1 漏列） |
| 8 | `docs/plans/mouse-wheel-region-routing/spec.md` §9 R-1 / §11 / §12 | 写回 Phase-0 结论并关闭闸门：自变量是 **Node 版本**不是环境变量，§13-Q1 的 `WT_SESSION` 启发式**作废**；§12 的两行 NOT RUN 按实际情况更新 | 同 §6.1 第 7 项 |
| ~~9~~ | ~~`App.tsx:1341` 备用键位 / HelpOverlay 新键位~~ | **移出本次范围**（R4·F3） | **删除** |

**四条必须写进代码注释、删掉就会静默作恶的约束：**

- **R6-1（阻断级）· 绝不能复用 `mouseNoticeSeen`。** `use-startup-notices.ts:106-107` 的一次性门是
  `if (!mouseEnabled || shown) return; if (getMouseNoticeSeen()) return;`。
  受影响用户**恰恰是已经启动过 CLI、已经看过那条误导提示、`mouseNoticeSeen` 已为 `true` 的人**。
  复用这个键，等于让修复对**唯一需要它的人群**完全不生效 —— 而且是静默不生效。
- **R6-2 · notice 文案必须点名"`Shift+Tab` 现在的行为是一个普通 Tab"**，不能只说"不可用"。
  按 §4.2 / N-4，它会在弹出补全时改写草稿；用户如果只被告知"不可用"，仍会继续按它。
- **R6-3 · 版本判据必须 FAIL OPEN，并用具体版本表驱动测试钉死。**
  两个方向都要写清楚：(a) `process.versions.node` 无法解析时应返回 `true`（假定支持）——
  猜错的代价是"维持现状"，而 fail-closed 猜错的代价是"把一台好主机的鼠标关掉"，后者严重得多，
  这也与 `satisfiesNodeRange` 既有的 fail-open 约定一致（`semver.ts:263-266` 有成文理由）。
  (b) 正因为它 fail-open，**range 常量里的一个笔误（比如 `>= 22.17.0` 多一个空格）会让整个门恒返回
  `true`、闸门永久失效且不报错**。所以第 5 项的测试不是可选项，它是这条 fail-open 语义的唯一护栏。
- **R6-4 · 必须手测 alt-scroll 的行为改变（本次修复唯一的真实回归面）。**
  今天受影响主机走 `mouse:true` → 写 `?1000h`，终端进入 tracking 从而**顺带抑制了** DEC 1007；
  F1′ 之后改走 `mouse:false` → 写 `?1007s?1007l`（`screen.ts:92`）。
  在**正确实现 1007 的终端**上两者等价（滚轮同样惰性）；但在**忽略 1007 却实现了 alternate scroll
  的终端**上，滚轮会开始吐方向键 → 被读成历史回溯 / 改写草稿，也就是 F4 被拒绝的那个 G1/G3 老伤口。
  风险是**有界的**（这正是 `--no-mouse` 用户今天已经在走的第 3 级 fail-safe 阶梯，非新代码路径），
  但受众从"主动 opt-out 的人"扩大到"所有受影响的 Windows 用户"，因此**必须实测**，不能推理。

### R7. 交给下游的验收点

1. Node 20 + Windows：启动后出现 warn notice；`?1000h` **不再**被写出（可用 `probe-stdin.mjs` 反向确认）；
   `/plan` 与 `Shift+↑`/`Shift+↓` 可用；**滚轮不吐方向键**（R6-4）。
2. Node 22.18 + Windows：**逐字节回归为现状**（写 `?1000h`、filter 在、旧 info notice 逻辑不变）。
3. 非 Windows：任意 Node 版本下逐字节回归为现状。
4. 已有 `mouseNoticeSeen=true` 的老用户在 Node 20 上**仍然**看得到新 warn notice（R6-1 的直接验收）。

### R8. 评审后仍然开放的项

沿用 §7 并补充，**下游不得据此宣称已解决**：

1. **"升级 Node 之后滚轮确实会动"仍是代码路径论证，不是实测**（§7.1）。
   本次评审**没有**改变这一点。需要 `mouse-wheel-region-routing/manual-test.md` 的真实滚轮矩阵。
2. **F2 的可行性未验证**（§7.2），且评审指出该推理**两个方向都成立**（R4·F2），更需要实验。
3. **`PgUp` / `PgDn` 未被注入验证**，只有 `Shift+↑`/`Shift+↓` 是字节级证明的（已就地补注到 §4.3）。
   给用户的文案应以后者为主。
4. **R6-4 的 alt-scroll 行为改变未实测** —— 这是本次修复引入的、唯一的新回归面。

---

## 实施过程发现的方案缺陷

**实施节点**: Subtask #2 · 修复实施
**日期**: 2026-08-08
**结论**: **F1′ 的判据与落地清单成立，按 R6 逐项实施完毕。** 下面四条是实施过程中
发现的、R6 未写到或写得不够的地方；其中 IF-1 与 IF-2 改变了落地方式，IF-3 是一个
被本次改动暴露、但**不属于本次范围**的既有渲染缺陷，IF-4 是一条对 R6 表格的更正。

### IF-1 · 能力判定不能在 `App.tsx` 内部读 `process`（R6 第 3 项的写法会让测试随机器变结果）

R6 第 3 项写的是「`use-startup-notices.ts` + `App.tsx`」，最直白的读法是让 `App`
自己调 `supportsWindowsVtInput(process.platform, process.versions.node)`。**这样做会
让整个 App 测试套件的结果取决于开发机装了哪个 Node。** 本机就是 `win32`，若开发者
的 Node 落在受影响区间，`app.test.tsx` / `mouse-routing.test.tsx` /
`app-follow-through.test.tsx` / `single-spinner.test.tsx` 里每一个渲染 `App` 的用例
都会多出一条 warn notice，把现有的整帧断言打红 —— 而在 CI（Linux）上全绿。
失败信息不会提到 Node 版本，排查成本极高。

**改为**：`cli.tsx` 计算一次，经新增的可选 prop `vtInputWarning?: { nodeVersion }`
传入；**「存在即受影响」**，缺省不存在。于是不受影响的机器逐字节等于没有这个 prop
的构建，测试也不再依赖宿主环境。`cli.tsx` 因此有两处改动而非 R6 第 2 项说的一处 ——
但那一处说的是**鼠标链路**（`?1000h` / filter / `mouseSource` 三个下游仍然只由
`wantMouse` 一个上游决定，N-1 的结论不变），notice 的接线是另一件事。

### IF-2 · notice 文案不能用渲染帧断言（transcript 的换行宽度比可见宽度多 2 列）

R6-2 要求文案点名「`Shift+Tab` 现在是一个普通 Tab」。最自然的验收是渲染 `App` 后对
`lastFrame()` 断言 `/plan`、`PLAIN TAB` 等短语 —— **实测不可行**。

在 100 列的测试终端上实测到：notice 文本被 Ink 按 **99 列**折行，而实际可见区域只有
**97 列**（100 − 1 列滚动条 − 2 列 gutter）。凡是贪心折行后长度落在 98～99 的行，
末尾 1～2 个字符**被静默裁掉**：

```
... so two keys never arrive: t│      ← 丢了 "he "
   wheel sends nothing at all, ...
... overwriting your draft. Use /pla│  ← 丢了 "n "
   to switch mode and ...
```

任何跨过折行点的短语都可能断成两半，断在哪取决于终端宽度。

**改为**：把文案构造函数 `vtInputDeadNotice(nodeVersion)` 从 `use-startup-notices.ts`
**导出**，对返回值断言内容（R6-2 的六个必备要素 + 「不得出现 PgUp」，见 R8 第 3 条）；
渲染帧只断言「出现了」与「是 warn 级」。

### IF-3 · 上面那个裁字是**既有缺陷**，本次不修（但会削弱本次交付的可读性）

必须说清楚它不是本次引入的：`Gutter`（`ui/layout/Gutter.tsx`）的内容列没有显式宽度，
且带着 I-2 要求的 `flexShrink={0}`，于是 yoga 按父容器宽度折行、外层再裁掉 2 列。
判据与终端宽度无关 —— 60 列终端上同样是「折行宽度比可见宽度多 2」。也就是说
**既有的 `MOUSE_SELECTION_NOTICE` 在窄终端上今天就在掉字**，只是在 100 列 + 该文案
长度下恰好没有触发。对照实验：同一帧里助手正文（走 markdown 分块，自己算宽度）折行在
97 列，**不掉字**；只有走 `Gutter` 的 notice 会。

**不在本次修**：修它要给 `Gutter` 的内容列一个显式宽度，而该文件的 I-2 明确写着
`measureElement` 依赖 `flexShrink={0}`，改错的失败模式是「滚动整体失效且不报错」。
这与本 bug 无关，属于「顺手重构」，按本节点约束不做。**后果要诚实记账**：本次新增的
warn notice 在换行处会丢 1～2 个字符，文字仍可读、语义不丢，但不好看。建议单开一条
改进项（`Gutter` 内容列宽度 + 一条「长 notice 不掉字」的回归用例）。

### IF-4 · R6 第 5 项的「`mouse-routing.test.tsx` 补一条」需要**两条**才不空转

只补「受影响时 `mouseSource` 缺席」这一条，本身也可能是空转的：一个恒返回 `false`
的坏闸门会让它同样变绿。已补成一对 —— `win32 + 20.19.0` ⇒ 无 filter，
`win32 + 22.18.0` ⇒ 有 filter，两条都用 `runInteractive` 形状的 harness 复算
`wantMouse` 表达式本身。这正是 N-3 指出的那类错误（断言存在、分支不可达、测试照绿）
在同一处的第二次机会，不应该只修一半。

另：`ui-state.test.ts` 有一条 `toEqual({ schema, submitCount, mouseNoticeSeen })`
的整对象断言，新增字段必然打红 —— 已更新，并顺带补了一条**直接钉死 R6-1** 的
存储层用例：写入一份「旧版本写的、只有 `mouseNoticeSeen: true`」的 `state.json`，
断言 `getVtInputNoticeSeen()` 仍为 `false` 且 `submitCount` 未被 schema 回退清空。

### 交付边界（复述 R5 第 5 条，不要在 changelog 里写错）

本次**没有恢复任何功能**。受影响主机上 `Shift+Tab` 与滚轮**依旧不可用**，改变的是
它从「静默消失 + 一条误导提示」变成「一条说明原因与绕行方案的 warn notice + 不再写
无效的 `?1000h`」。真正恢复功能的唯一途径是用户升级 Node（≥ 22.17.0 / ≥ 24.2.0）。
R8 的四条开放项**全部维持开放**，其中 R6-4（alt-scroll 行为改变）是本次引入的唯一
真实回归面，**仍需实测**：受影响主机从写 `?1000h` 改为写 `?1007s?1007l`，在忽略
1007 却实现了 alternate scroll 的终端上滚轮会开始吐方向键。

---

## 评审节点发现

**评审节点**: Subtask #3 · 代码评审与提交
**日期**: 2026-08-08
**结论**: **F1′ 的实现与 R6 逐项吻合，判据、fail-open 语义、一次性键、注释与文档
写回全部成立**，实测 `npm run typecheck` 干净、`npm test -w packages/cli` 146 文件
2097 通过。合入前修掉下面一条：它不在 R6 的清单里，因为 R6 没有区分渲染模式。

### RF-1 · notice 在 inline 模式下说了两句假话（已修）

`cli.tsx` 计算 `vtInputWarning` 时**没有**带上 `mode`，而 `wantMouse` 是带的。于是
`--no-fullscreen`（以及 `TERM=dumb` / `CI` 非空 / `rows < 12` / `cols < 40` 自动降级
到 inline 的那些情况）下的受影响用户，会读到一条为全屏写的文案：

- 「the wheel sends nothing at all」—— inline **从来没有**要求控制台上报滚轮
  （`mode === 'fullscreen'` 本就是 `wantMouse` 的一个合取项），所以那里的滚轮一直在
  滚终端自己的 scrollback，**在用户眼里是好的**（§4.3 已写明 inline 不受影响）；
- 「Use Shift+Up / Shift+Down to scroll」—— 这两个键的处理在 `App.tsx:1386` 的
  `if (fullscreen)` 分支**内部**，inline 下按了没有任何反应。

即：告诉用户一个能用的功能坏了，再给他一个不存在的绕行方案 —— 正是
`use-startup-notices.ts` 那条不变量（「绝不对一个没有运行的模式给建议」）本身，
只是方向反了过来。而 `Shift+Tab` 那一半**与模式无关**（修饰键是在 libuv 里丢的，
远低于本应用能选择的层次），inline 下同样会改写草稿，所以不能靠「inline 干脆不提示」
解决。

**改法**：`vtInputDeadNotice(nodeVersion, fullscreen)` 分两支，全屏支**逐字节等于**
改动前的文案；`VtInputNoticeOptions` 增 `fullscreen`，由 `App` 传自己的 `fullscreen`
（沿用 IF-1 的原则：能力由调用方决定，组件不自己探测）。回归用例三条：纯函数两支各
一条（inline 支断言不含 `wheel` / `Shift+Up` / `Shift+Down`，且仍含 `PLAIN TAB`
与 `/plan`），外加一条 inline 渲染用例钉住「`App` 确实把自己的模式传下去了」——
该用例已用变异验证（把 `fullscreen` 写死成 `true` 后它变红），不是空转。全屏渲染用例
同步补一条 `toContain('wheel')` 作为对照：折行只会从行尾削掉 1～2 个字符，所以万一
`wheel` 落到折行点上，**红的是这条对照**，而不是让 inline 那条负向断言悄悄失效。
