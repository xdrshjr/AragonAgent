# `Shift+Tab` 仍然不切换模式（PowerShell / Windows）—— 第 2 轮

**Bug slug**: `shift-tab-mode-toggle-still-dead-on-windows`
**版本**: v3（v1 定位分析；v2 于运行图**重跑**时补 §8 工作区实现状态审计；
v3 = 第 2 轮 · Subtask #1 · 评审节点，补 R-12..R-15 与文末 `## 评审结论`）
**日期**: 2026-08-10（v1） / 2026-08-11（v2、v3）
**代码基线**: `M:/takoAI/JRAgentMesh` @ `ef109b09`，`packages/cli` v0.6.1（= 当前 npm `@aragon-agent/cli@latest`，已含第 1 轮修复）
**前序**: `docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-some-terminals/analysis.md`（第 1 轮）

> **下游（评审 / 修复节点）阅读顺序**：
> 0. **先读 §8。** 运行图被重跑了一次，而上一次运行**已经把 §6.1 的落地清单做掉了 8 项里的 7 项**，
>    改动全部躺在工作区里**未提交**。§6.1 的行文假定它面对的是一张空清单——**今天它不是**。
>    跳过 §8 最可能的两个结果是：把已经写好的实现重写一遍，或者把「清单存在」误读成「清单未动」而整体跳过。
> 1. 再读 §0 —— 「没修复好」**不是回归，是第 1 轮交付物的既定行为**，第 1 轮从设计上就没打算恢复功能。
> 2. 再读 §3.2 / §3.3 / §3.4 —— 第 1 轮标为「未验证、推迟」的 F2 方案，本轮**实测通过了**，
>    并且把它唯一的悬念（libuv 会不会把位冲掉）从推理变成了测量结果。
> 3. §3.5 是一个**会静默作恶**的实现陷阱，写在这里是为了让它在修复阶段之前被看到，而不是之后。
> 4. §3.6 是备用键位的**实测表**——其中「`Ctrl+Tab` 也是坏的」是靠猜想不出来的。
> 5. 再读 §6 的落地清单与 §7 的未验证边界。
> 6. **修复节点：直接跳到文末 `## 评审结论` 的 V-3。** 本轮评审已复核完 §8 的全部自述
>    （测试、类型、调用点顺序都当场重跑过），并把八项清单收敛成**唯一一项**待做修复。
>    V-2 明确「已落地的那批代码不要重写」，V-5 列出了**不要顺手做掉**的六件事。

---

## 0. 一句话结论

> **第 1 轮把根因找对了，但交付的是「能力检测 + 如实告知」，它按设计不恢复任何功能**
> （提交 `45d27deb` 原文：*「本次不恢复功能（真正恢复只有用户升级 Node）」*）。
> **所以用户第 2 轮报「仍然没反应」，是这次交付的预期结果，不是新缺陷。**
> 第 2 轮的目标变了：不再是「说清楚」，而是「**在所有 PC 上真的能用**」。
> 本轮的新贡献是把第 1 轮推迟的 F2 从「理论上可行、未验证」推进到**实测可行**：
> 在 Node 20.19.0 上由**另一个进程**把 `ENABLE_VIRTUAL_TERMINAL_INPUT` 打开之后，
> `Shift+Tab` 当场从 `09` 变成 `1b 5b 5a`（`\x1b[Z`）；同时测出它**会被 libuv 在下一次
> raw 模式切换时抹掉**，因此真正的工程问题是**重新施加**，而不是「能不能打开」。

并且：用户之所以连**一句提示都没看到**，有三个各自独立的放大器（§3.7）——
一次性 notice、恒显的 `shift+tab plan` 底部提示、以及 `aragon doctor` 在受影响机器上**判定通过**。

---

## 1. 问题描述

第 1 轮用户需求（已交付，提交 `45d27deb` / `0a1c2b0c`）：另一台主机上 `npm i -g @aragon-agent/cli@latest`
安装成功、CLI 正常启动，但 `Shift+Tab` 不切模式、鼠标滚轮不滚历史；换一台主机正常。

第 2 轮用户需求（本轮）：

> 没修复好，现在在其他 PC 主机上，使用 powershell，然后使用 shift+tab 进行切换，仍然没反应，
> 需要修复，使得其在所有 PC 上都能够正常。

用户手里的版本已经是含第 1 轮修复的 `0.6.1`（本机 `npm view @aragon-agent/cli version` → `0.6.1`，
与工作区 `packages/cli/package.json` 的 `version` 一致，说明修复确实已经发布、用户装到的不是旧包）。

**本轮要回答两件事**：

1. 为什么装了修复版还是「没反应」；
2. 有没有一条路，能让 `Shift+Tab` 在**不要求用户升级 Node** 的前提下真的工作。

---

## 2. 复现步骤

### 2.1 用户侧 30 秒分诊（**先做这一步**，它决定后面走哪条路）

本轮**没有**用户那台机器的任何日志，所以第一件事是让用户自己把三种同症状的成因分开。
两条命令，任何 PowerShell 窗口都能跑，不需要装任何东西：

```powershell
node -p "process.version"
```

```powershell
node -e "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>{console.log(b.toString('hex'));if(b[0]===3)process.exit(0)})"
```

第二条跑起来之后**按一次 `Shift+Tab`**，看打印出来的十六进制，然后按 `Ctrl+C` 退出：

| 打印结果 | 含义 | 归属 |
|---|---|---|
| `09` | 键被吃掉了，与裸 `Tab` 逐字节相同 | §3.1 的根因（Node / 控制台 VT 输入位）。**本文其余部分都是给这一类写的** |
| `1b5b5a` | 键**正常到达进程** | 根因不在输入层，第 1 轮与本轮的分析都不适用，需要新一轮定位（见 §3.9） |
| 什么都不打印 | 键根本没进到控制台 | 终端 / 多路复用器 / 远程桌面吃掉了它（第 1 轮 §4.1 末两行） |

同时让用户报一下 `node -p "process.version"` 的输出。若它落在
`18.x` / `20.x` / `22.0–22.16` / `23.x` / `24.0–24.1` 之内，第一行几乎必然命中。

> 这条分诊之所以必须放在最前面，是因为**本轮无法从本机证伪「用户的 Node 其实是新的」**。
> §6 推荐的方案设计成三种情况都能改善，但归因不同，交付话术也不同。

### 2.2 本轮实际执行的确定性实验

沿用第 1 轮的方法（把按键直接 `WriteConsoleInput` 进共享控制台输入缓冲区，
消除「我到底有没有真的按住 Shift」这个变量），脚本与原始输出都在
`docs/diagnoses/shift-tab-mode-toggle-still-dead-on-windows/repro/`：

| 文件 | 作用 |
|---|---|
| `probe-vt.mjs` | 第 1 轮探针 + 每个 chunk 的相对时间戳 + 在第 N 秒主动做一次 `setRawMode(false)→(true)` 往返 |
| `probe-vt2.mjs` | 由**探针自己**（即「CLI 自己」）spawn 一个 helper 子进程，测量该 spawn 的墙钟耗时 |
| `force-vt-helper.ps1` | helper：以 `CreateFileW("CONIN$")` 拿到控制台输入句柄，`SetConsoleMode(mode \| 0x0200)` |
| `inject-vt-force.ps1` | **E1**：基线 → 外部强开 VT 位 → 再注入 → 让探针切一次 raw 模式 → 再注入 |
| `inject-e2.ps1` | **E2**：生产形态，helper 由探针自己拉起 |
| `inject-fallback-keys.ps1` | **E3**：在**没有** VT 位的老路径上，逐个注入候选备用键位，看哪些活下来 |

运行方式（必须新开一个真控制台窗口，探针需要 `stdin.isTTY`）：

```powershell
$dir = 'M:\takoAI\JRAgentMesh\aragon-agent-core\docs\diagnoses\shift-tab-mode-toggle-still-dead-on-windows\repro'
$n20 = '<...>\node-v20.19.0-win-x64\node.exe'   # https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip

Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File',"$dir\inject-vt-force.ps1",'-NodeExe',$n20,'-Tag','node20vt' -Wait
Get-Content "$dir\probe-out-node20vt.jsonl"; Get-Content "$dir\inject-log-node20vt.txt"
```

**本机环境**：Windows 11 26200，默认终端，PowerShell。唯一自变量是 `node.exe`
（`v20.19.0` / libuv `1.46.0` 对照当前 `v22.18.0` / libuv `1.51.0`）与「有没有人去改控制台模式」。

---

## 3. 根因分析

### 3.1 第 1 轮的根因仍然成立（今日在同一台机器上复测）

`repro/probe-out-fbn20.jsonl` 第 2 行，Node 20.19.0，注入 `Shift+Tab`：

```
{"t":1499,"event":"data","hex":"09","text":"\"\\t\""}
```

与第 1 轮 `probe-out-node20.jsonl` 逐字节一致。控制台模式同样是 `0x0008`
（`ENABLE_WINDOW_INPUT`，不含 `0x0200 = ENABLE_VIRTUAL_TERMINAL_INPUT`）：

```
[ 1555ms] mode_during=0x0008 VT_INPUT=False
```

机制不重述，见第 1 轮 §3.3–§3.5（libuv 的字符支丢弃 `SHIFT_PRESSED`，函数键表无 `VK_TAB`）。
**本轮的增量不在这里。**

### 3.2 决定性新证据 E1 —— 外部强开 VT 位，老 Node 当场产出 `CSI Z`

第 1 轮把 F2（自己打开 `ENABLE_VIRTUAL_TERMINAL_INPUT`）列为
*「理论上两个功能都回来（本次**未验证**）」*，并把它推迟。**本轮验证了，它成立。**

同一次运行内（`repro/inject-log-node20vt.txt` + `repro/probe-out-node20vt.jsonl`），
Node 20.19.0 / libuv 1.46.0：

```
[ 1574ms] during_rawmode mode=0x0008 VT_INPUT=False WINDOW_INPUT=True MOUSE_INPUT=False
[ 1650ms] inject Shift+Tab#1_baseline ok=True written=2
[ 2279ms] FORCE SetConsoleMode(0x0208) ok=True lastErr=0
[ 2280ms] after_force mode=0x0208 VT_INPUT=True WINDOW_INPUT=True MOUSE_INPUT=False
[ 2595ms] inject Shift+Tab#2_DECISIVE ok=True written=2
```

```
{"t":1512,"event":"data","hex":"09","text":"\"\\t\""}          ← 强开之前
{"t":2460,"event":"data","hex":"1b5b5a","text":"\"\\u001b[Z\""} ← 强开之后
```

**同一个进程、同一个 Node、同一个控制台、同一段注入代码，唯一变化是那一位**，
`Shift+Tab` 就从「与 `Tab` 无法区分」变成了 `\x1b[Z` ——
与第 1 轮在 Node 22.18.0 上测到的字节**完全相同**。

这条推翻了一个可能被默认接受的判断：**「老 Node 上这个功能无法恢复」是错的。**
无法恢复的是「让 Node 自己去设那一位」；那一位本身是**控制台输入缓冲区的属性**，
任何附着在同一个控制台上的进程都能改，而 libuv 的老翻译路径会**忠实转发**控制台生成的 VT 字符
（它的字符支只要求 `uChar.UnicodeChar != 0`，`ESC`/`[`/`Z` 三个字符都满足）。

### 3.3 新证据 E1b —— libuv 会在下一次 raw 模式切换时把它抹掉

这正是第 1 轮推迟 F2 的那条理由，评审当时判定它*「两个方向都成立，正因如此才必须做实验」*。
实验做了，**结论是会被抹掉**。探针在第 5.0 秒主动做一次 `setRawMode(false)` → `setRawMode(true)`：

```
{"t":5010,"event":"rawmode_toggle_begin"}
{"t":5010,"event":"rawmode_toggle_end"}
{"t":5973,"event":"data","hex":"09","text":"\"\\t\""}   ← 又变回裸 Tab
```

```
[ 5797ms] after_probe_rawmode_toggle mode=0x0008 VT_INPUT=False
```

所以 F2 的工程问题**不是「能不能打开」，而是「什么时候需要重新打开」**。这把方案的难度
从「未知可行性」降到了「已知的生命周期管理」，也直接决定了机制选型（§5：一次 700 ms 的
子进程能接受，每次 raw 模式切换都花 700 ms 不能接受）。

好消息是重新施加的频率在正常会话里很低：libuv 的 `uv_tty_set_mode` 在**模式未变化时提前返回**，
而 Ink 对 raw 模式做引用计数（只要 `App` 自己的 `useInput` 还挂着，浮层的挂载/卸载不会让计数归零），
所以一次典型会话只有启动与退出两次转换。

> **【评审补证 R-1】上面这段原本没有引用，而它是 C1 全部风险评估的支点。已核实，且结论比原文更强：**
>
> | 断言 | 引用 | 核实结果 |
> |---|---|---|
> | Ink 对 raw 模式做引用计数 | `node_modules/ink/build/components/App.js:117-127` —— `if (this.rawModeEnabledCount === 0) { stdin.setRawMode(true) } … this.rawModeEnabledCount++` / `if (--this.rawModeEnabledCount === 0) stdin.setRawMode(false)` | ✅ 成立 |
> | 计数由 `useInput` 的挂载/卸载驱动 | `node_modules/ink/build/hooks/use-input.js:31-38` —— `if (options.isActive === false) return; setRawMode(true); return () => setRawMode(false);` | ✅ 成立 |
> | `App` 的 `useInput` 恒挂着 | `ui/App.tsx:1322` —— `useInput((input, key) => {` **没有第二个参数**，即 `isActive` 恒 `undefined` ⇒ 恒 active | ✅ 成立 |
>
> 三条合起来给出一个原文没说满的结论：**在本 CLI 里，计数在会话中途永远不会归零**
> （浮层的 `useInput` 只让它在 1↔2 之间摆动），所以启动之后到卸载之前**只有 0 次** raw 模式转换。
> `PromptInput.tsx:333` 的 `useInput` 即使带 `isActive` 也只影响 1↔2。
>
> **【评审更正 R-2】原文接着写的「任何触碰控制台的子进程（bash 工具、外部编辑器）都可能改回去」，
> 对本仓库的 bash 工具而言是错的**，而且错在一个有讽刺意味的地方：
>
> - `tools/bash-tool.ts:79-84` —— `spawn(command, { shell: true, cwd, env, windowsHide: true })`，
>   **没有传 `stdio`**（默认三条 pipe）＋ `windowsHide: true`。这正是 §3.5 那个陷阱的机制：
>   `CREATE_NO_WINDOW` 让子进程拿到**自己的**控制台。所以 bash 工具**碰不到** CLI 的控制台。
>   同一个标志在 helper 上是灾难，在 bash 工具上恰好是保护。
> - `tools/search-tools.ts:147` —— `spawn('rg', args, { cwd })`，共享控制台，但 `rg` 不调 `SetConsoleMode`。
> - 全仓唯一的 `stdio: 'inherit'` 在 `config/cli-commands.ts:469`（`aragon config edit` 拉外部编辑器），
>   那是**独立的非 TUI 命令路径**，不会与运行中的 TUI 会话并存。
>
> ⇒ **C1 的「重新施加」问题被原文高估了。** 在本仓库当前形态下，启动后施加一次即可维持整场会话；
> 「必须防御性重新施加」不是今天的事实，而是一条**未来的约束**（任何人给 bash 工具去掉
> `windowsHide`、或在 TUI 内新增 `stdio:'inherit'` 的子进程，都会让它变成事实）。
> 这条更正**提高**了 C1·M1 的可行性，但**不改变** §6 的排序理由 —— 那条理由是失效方式的数量，不是频率。

### 3.3b 新证据 E4（修复阶段补测）—— **重复**置同一个 raw 模式不会冲掉那一位

§3.3 测的是「转换会冲掉」，而 C1 落地真正依赖的是它的反面：**Ink 在 mount 时还会再调一次
`setRawMode(true)`**，如果那一次也重写控制台模式，那么「先起 raw、再强开」的顺序就毫无意义 ——
修复会在**所有**机器上静默失效。原文把这一点交给了 libuv 源码里的
`if (tty->tty.rd.mode == mode) return 0;` 去推断，**没有测**。

`repro/probe-rawmode-idempotent.mjs` + `inject-rawmode-idempotent.ps1`（本机，Node 22.18.0，真实控制台）。
探针位取 `ENABLE_MOUSE_INPUT`（`0x0010`）而不是 `0x0200`：新 Node 自己会置 `0x0200`，
用它做探针会分不清「位活下来了」和「Node 又设了一遍」。

```
1. after our own setRawMode(true):        0x0208
2. after an outside process OR-ed 0x0010: 0x0218
3. after a REPEATED setRawMode(true):     0x0218   ← 位还在
4. after a full false->true transition:   0x0208   ← 位被冲掉
```

⇒ **重复置同一模式是 no-op（顺序成立），完整转换会清位（§3.3 复现）**。
两条一起给出的结论比任一条单独更强：同一个机制既保证了 C1 在会话中活着，
也**就是**它的还原路径 —— 卸载时那次 `setRawMode(false)` 会把位清掉，不需要另写还原代码。
这条与 Node 版本无关（被测的是 libuv 的缓存模式判断，不是 raw 模式的口味），故在 22.18 上测得的结论对 20.x 同样成立。

### 3.3c 修复阶段发现 —— 生产 helper 的 `[uint32]0xC0000000` 在 PowerShell 5.1 上必然抛错

`repro/force-vt-helper.ps1:22-27` 用十进制字面量写 `GENERIC_READ` / `GENERIC_WRITE`，
并在注释里写明了原因；而生产实现 `ui/win-vt-force.ts::buildHelperScript()` 最初写的是
`[uint32]0xC0000000`。实测（PowerShell 5.1.26100，即 `resolvePowerShellExe()` 指向的那一个）：

```
Cannot convert value "-1073741824" to type "System.UInt32".
Error: "Value was either too large or too small for a UInt32."
exit code = 1
```

5.1 把高位置 1 的十六进制字面量按**有符号 Int32** 解析，`[uint32]` 转换随即抛错。
该语句在 `try { Add-Type }` 之外，`$ErrorActionPreference = 'Stop'` 使它成为终止错误 ⇒
helper 在 `CreateFileW` **之前**就死了，不打印 `before=`，调用方得到一个普通的
`helper_failed` 并按设计优雅降级到备用键位。

**失败形态与「C1 根本没实现」逐字相同**：日志有一行、退出码非零、用户侧毫无差别，
而 C1 在**100% 的 Windows 机器**上一次也没跑起来。已改为十进制并由
`__tests__/win-vt-force.test.ts` 对**生成出来的脚本**断言「不含 `[uint32]0x[89A-F]…`」——
这段代码是在一份把该陷阱写进注释的探针脚本旁边被写成这样的，仅靠评审显然不够。

### 3.4 新证据 E2 —— 生产形态同样成立，成本 722 ms

E1 是 PowerShell **父进程**改的模式，与真实形态不同。E2 换成真实形态：
**探针（扮演 CLI）自己 spawn 一个 helper 子进程**，helper 以 `CONIN$` 拿句柄并 OR 上那一位。

`repro/probe-out-e2b.jsonl` + `repro/inject-log-e2b.txt` + `repro/probe-out-e2b.jsonl.helper.log`：

```
{"t":1516,"event":"data","hex":"09","text":"\"\\t\""}                 ← helper 之前
{"t":3009,"event":"helper_spawn_begin"}
{"t":3731,"event":"helper_exit","code":0,"elapsedMs":722}
{"t":5742,"event":"data","hex":"1b5b5a","text":"\"\\u001b[Z\""}       ← helper 之后
```

```
handle=2764 got=True before=0x0008 set=0x0208 ok=True after=0x0208
```

helper 读到的 `before=0x0008` 正是 libuv 设的 raw 模式 —— 证明它确实作用在**同一个**控制台上。

**成本分解**（本机，`Measure-Command`）：

| | 耗时 |
|---|---|
| `powershell -NoProfile -Command "exit 0"` | 279 ms |
| `powershell -NoProfile` + 一次 `Add-Type` | 577 ms |
| E2 里实测的 helper 全程（spawn→exit） | **722 ms** |

即：PowerShell 进程本身约 280 ms，运行期 C# 编译（`Add-Type`）再加约 300 ms。
这是「不引入原生依赖」这条路线要付的价格，也是 §5 里 M1 与 M2 的分界点。

### 3.5 新陷阱 —— `windowsHide: true` 会让 helper**静默地**去配置另一个控制台

E2 的**第一次**运行（`repro/probe-out-e2n20.jsonl` + `.helper.log`）是这样的：

```
handle=2484 got=True before=0x01F7 set=0x03F7 ok=True after=0x03F7
```

```
{"t":3678,"event":"helper_exit","code":0,"elapsedMs":665}
{"t":5744,"event":"data","hex":"09","text":"\"\\t\""}      ← 什么都没变
[ 5839ms] after_helper mode=0x0008 VT_INPUT=False
```

helper **退出码 0、`SetConsoleMode` 返回 `True`、日志一切正常**，而 CLI 侧毫无变化。
差别只有 spawn 选项里的一个布尔：

```js
// 第一次（坏）
{ stdio: ['ignore','ignore','ignore'], windowsHide: true }
```

Node 在 Windows 上把 `windowsHide: true` 映射成 `CREATE_NO_WINDOW`，而该标志会给子进程
**分配一个全新的（不可见的）控制台**。于是 helper 读到的是那个新控制台的默认模式 `0x01F7`
（注意：**不是** CLI 那个控制台的 `0x0008`），改的也是它，然后带着成功状态退出。

**这个陷阱的形状值得单独记一笔**：所有可观测信号都是绿的，唯一的症状是「功能没生效」——
与「根本没做这个修复」在用户侧完全不可区分。`before` 读到的值是唯一能当场识破它的东西
（`0x01F7` 意味着「这不是一个处在 raw 模式的控制台」），所以 helper **必须把 `before` 报回来**，
调用方**必须校验它**，而不是只看退出码。

顺带一条同类的：helper 不能用 `GetStdHandle(STD_INPUT_HANDLE)`。CLI 会以 `stdio: 'ignore'`
拉起它（不能让 helper 和正在被重配置的 raw 模式 stdin 共享句柄），那样它的标准输入是 `NUL`。
必须走 `CreateFileW("CONIN$")`。

> **【评审更正 R-3】§6.1 第 5 项把校验写成「`before` 不是 `0x01F7` 之类的默认值」，这是个魔数比较，会漏判。**
> `0x01F7` 只是**本机这一台**控制台的默认值：它随 QuickEdit / Insert 模式、随宿主
> （conhost vs Windows Terminal vs ConEmu）、随「用户已经自己打开过 VT 输入」而不同。
> 一台默认值恰好不等于 `0x01F7` 的机器会让这条校验静默放行，退回 §3.5 的原始陷阱。
>
> 正确的判据是**正向位掩码**，而不是「不等于某个值」—— 我们要确认的是
> 「这个控制台已经被 libuv 置成 raw 模式」，本轮两次 E2 运行恰好给了正反两个样本：
>
> | 运行 | helper 读到的 `before` | 含义 |
> |---|---|---|
> | E2b（好） | `0x0008` | `ENABLE_WINDOW_INPUT` 置位；`LINE_INPUT`/`ECHO_INPUT`/`PROCESSED_INPUT` 全清 ⇒ **是**那个 raw 控制台 |
> | E2n20（坏） | `0x01F7` | 上述三位**全部置位** ⇒ 不是 raw 控制台，helper 配错了对象 |
>
> ⇒ 判据写成
> `(before & (ENABLE_LINE_INPUT|ENABLE_ECHO_INPUT|ENABLE_PROCESSED_INPUT)) === 0`
> （`0x0002|0x0004|0x0001 = 0x0007`），可选再加 `(before & ENABLE_WINDOW_INPUT) !== 0`。
> 这条对两个样本都判对，且不依赖任何一台机器的默认值。

### 3.5b 新证据（评审补充）—— 那一位**会活过进程退出**，所以「退出时还原」不是洁癖

§6.1 第 5 项写了「⑤ 退出时还原」，但没给出**为什么必须**的证据。本轮数据里其实有，只是没被引用：

```
# repro/inject-log-e2b.txt —— 探针已经退出之后再采样
[ 9112ms] after_exit mode=0x0208 VT_INPUT=True
```

对照 E1（同样在探针退出后采样）：

```
# repro/inject-log-node20vt.txt
[ 9163ms] after_probe_exit mode=0x0008 VT_INPUT=False
```

两者的差别不是「E1 会还原、E2 不会」，而是**E1 在 5.0 s 时被探针自己的 raw 模式往返顺手清掉了**
（§3.3），而 E2 全程没有这样一次转换，于是那一位**原样留在了用户的 PowerShell 上**。
即：**操作系统、控制台、Node 都不会替我们清这一位**。

这条同时说明了 C1 一个**自相矛盾的地方**，值得写进修复节点的头脑里：
清掉那一位的唯一自动机制，正是 §3.3 里那个会破坏 C1 的机制（Ink 卸载时的 `setRawMode(false)`）。
所以在**正常退出**路径上 C1 大概率自愈；在 `Ctrl+C` 硬杀、`taskkill`、崩溃、宿主关窗这些
**不跑 React 卸载**的路径上不会，而它们恰恰是无人值守 / 脚本化使用里最常见的退出方式。
还原逻辑因此不能只挂在 `useEffect` 的 cleanup 上。

### 3.6 新证据 E3 —— 备用键位在老路径上的实测表

如果要加一个「无论如何都能用」的备用键位，它必须在**吃掉 `Shift+Tab` 的那条路径上**被测过。
`repro/inject-log-fbn20.txt` + `repro/probe-out-fbn20.jsonl`（Node 20.19.0，**没有**强开 VT 位）：

| 注入的键 | 收到的字节 | ink 5.2.1 解析结果 | 结论 |
|---|---|---|---|
| `Shift+Tab`（对照） | `09` | `{name:'tab', shift:false}` | ❌ 与 `Tab` 不可区分 |
| **`Ctrl+P`** | **`10`** | `{name:'p', ctrl:true}` | ✅ **活** |
| **`Ctrl+B`** | **`02`** | `{name:'b', ctrl:true}` | ✅ 活 |
| `Alt+M` | *（无任何数据）* | — | ❌ 被丢弃 |
| `F2` | `1b5b5b42` = `\x1b[[B` | `{name:'f2'}` | ✅ 活（但见下） |
| **`Ctrl+Tab`** | **`09`** | `{name:'tab', shift:false}` | ❌ **也是坏的** |

三条值得点名：

1. **`Ctrl+Tab` 也塌缩成 `09`。** 它是「和 `Shift+Tab` 最像、最容易被想到」的替代键，
   而它和 `Shift+Tab` 死在同一个地方（`uChar.UnicodeChar = 0x09` 走字符支，修饰键整体丢失）。
   **没有这次注入，它几乎一定会被选中，然后在受影响主机上原样复现同一个 bug。**
2. **`Alt+M` 一个字节都没到。** 注入的记录 `UnicodeChar = 0`，既不走字符支，
   `VK_M` 又不在 libuv 的函数键表里 —— Alt+字母整类都不是可靠候选。
3. **`F2` 在两条路径上编码不同**：老路径给 `\x1b[[B`（Linux console 编码），
   新 Node 的 VT 路径会给 `\x1bOQ`。ink 两个都认，但功能键更容易被终端 / 终端复用器自己截走。

`Ctrl+P` 与 `Ctrl+B` 在本仓库都空闲：`input/keymap.ts` 的 `fromCtrl` 只占 `a`/`e`/`w`/`u`/`k`
（`:34,36,38,40,42`），`App.tsx` 只占 `c`/`l`/`t`/`o`。

> **【评审补证 R-4】这张表被读成「只有这两个键可用」的白名单是危险的；它其实是一个族的两个样本。**
> 三行的结果各自有机制解释，而机制是可以外推的：
>
> | 键 | `INPUT_RECORD.uChar.UnicodeChar` | 走 libuv 哪条支 | 结果 |
> |---|---|---|---|
> | `Ctrl+P` / `Ctrl+B` | `0x10` / `0x02`（Windows 为 Ctrl+字母生成真实控制字符） | 字符支（`UnicodeChar != 0`），**原样转发** | ✅ 活 |
> | `Shift+Tab` / `Ctrl+Tab` | `0x09` | 字符支 —— 字符本身有效，**修饰键整体被丢弃** | ❌ 与 `Tab` 不可区分 |
> | `Alt+M` | `0`（Alt+字母不产生字符） | 既不走字符支，`VK_M` 又不在函数键表里 | ❌ 一个字节都不到 |
>
> ⇒ **凡是产生 `0x01–0x1A` 控制字符的 `Ctrl+<字母>`，都会穿过老路径**。`Ctrl+P` / `Ctrl+B`
> 是这个族的两个抽样，不是仅有的两个解。这一点对修复节点是有意义的自由度：
> 选键可以按**人体工学**决定，不必被「只有这两个被注入过」绑住。
>
> **【评审补证 R-5】键位占用的核对可以做得比原文更完备，且结论是干净的。**
> 全仓 `key.ctrl` 的消费者穷举（`grep -rn "key.ctrl" --include=*.ts --include=*.tsx`，排除测试）：
>
> - `ui/App.tsx:1323` (`c`) / `:1375` (`l`) / `:1411` (`t`) / `:1425` (`o`)
> - `input/keymap.ts:91` → `fromCtrl`（`a`/`e`/`w`/`u`/`k`）
> - `ui/PromptInput.tsx:379` —— `if (key.ctrl) return;  // App owns Ctrl+C / L / T / O.`
>   **编辑器对所有 Ctrl 键一律早退**，所以新键位与草稿编辑不可能冲突
> - `ui/overlays/{PlanReviewOverlay:86, QuestionOverlay:158, SettingsScreen:359}` —— 只用 `!key.ctrl`
>   决定「要不要把这个字符插进文本框」，不绑定任何具体 Ctrl 键
>
> ⇒ `Ctrl+P` / `Ctrl+B` 在**整个包**里与任何东西都不冲突。附带一条原文没提的重要事实：
> **`Ctrl+P` 今天在本 CLI 里是彻底的空操作**（`PromptInput.tsx:379` 吃掉它，`App` 不认它），
> 所以给它加语义**不会从任何用户手上拿走已有行为**。
>
> **【评审补充 R-6】唯一的反对意见是人体工学，而它指向的是 `Ctrl+B` 而不是 `Ctrl+P`：**
>
> - `Ctrl+P` 在 readline / Emacs 传统里是 *previous-line*，而本编辑器**确实**实现了 Emacs 族
>   （`keymap.ts:34-42` 的 `a`/`e`/`w`/`u`/`k`），所以有肌肉记忆的用户会觉得被占用。
>   但如上，`Ctrl+P` 今天什么也不做 ⇒ **没有可被夺走的行为**，反对意见因此是弱的。
> - `Ctrl+B` 是 **tmux 的默认 prefix**：在 tmux 下它根本到不了应用。而这个键位会是
>   **无条件绑定、跨平台生效**的（见 §评审结论 D-2），所以 `Ctrl+B` 会对一整类
>   macOS / Linux 用户静默失效。**`Ctrl+B` 应当从「同样可用的第二选择」降级为不推荐。**
> - `F2` 在两条路径上编码不同（`\x1b[[B` vs `\x1bOQ`），且功能键最容易被终端 / 桌面环境
>   / 远程桌面自己截走 —— 它恰好落在我们**最不能依赖**的那一层。
>
> ⇒ 三个候选里 `Ctrl+P` 是唯一没有已知失效面的。§7.4 原本把这一项列为「未调研」，本轮已调研完毕。

### 3.7 为什么用户「什么提示都没看到」—— 三个各自独立的放大器

第 1 轮交付的核心是一条 notice。用户第 2 轮的描述里**完全没有提到它**。
下面三条中任何一条都足以解释这件事，而它们同时成立：

1. **notice 是「永久只显示一次」的。**
   `ui/use-startup-notices.ts:210` —— `if (getVtInputNoticeSeen()) return;`，
   同一个 effect 在 `:218` 调 `vtNoticeRef.current?.onSeen()`，落到
   `App.tsx:862` 的 `setVtInputNoticeSeen(true)` → `config/ui-state.ts:173` 写盘。
   （评审校正：原文写作「`:211` 之后立刻」，`:211` 只是进程内的 `vtNoticeShown.current = true`；
   真正的**跨会话**持久化在 `:218`。两者都成立，落盘的是后者。）
   而它是一条 **`notice`（进 transcript）而不是常驻控件**，
   会随着对话往上滚走。也就是说：受影响用户在**升级后的第一次启动**里，
   在还没开始用的时候，看到过一次、并且**只有那一次**。之后无论按多少次 `Shift+Tab`，
   界面上不会再出现任何与它有关的东西。**条件是永久性的（Node 版本不会自己变），
   提示却是一次性的**——这两者不匹配本身就是缺陷。
2. **底部提示恒显 `shift+tab plan`，一直在教用户按那个不工作的键。**
   `ui/Composer.tsx:73` 无条件构造 `shift+tab ${...}`，与能力判定没有任何关联。
   （第 1 轮 N-5 已记录这条事实，但当时未把它列为待修项。）
3. **`aragon doctor` 在受影响机器上判定「通过」。**
   `diagnostics/doctor.ts:37` 定义 `MIN_NODE_MAJOR = 18`，`:63` 对 `major >= 18` 直接
   `pass('node', ...)`。于是 Node 18 / 20 / 22.16 —— **恰好是功能死掉的那批版本** ——
   在自带诊断工具里显示为绿色。用户去排查，得到的是「一切正常」。

合起来，受影响用户能拿到的全部信息就是：底部写着 `shift+tab plan`，按了没反应，`doctor` 说没问题。
**这与「完全没修」在用户侧不可区分**，也正是本轮反馈「没修复好」的直接来源。

> **【评审补证 R-7 · 对 C3① 的必要修正】底部提示条**本身**是可被关掉的，所以「只改 `Composer.tsx:73`」不够。**
> `ui/Composer.tsx:122` —— `const visible = showHint && hintsEnabled;`，两个入参都来自 `App.tsx`：
>
> - `App.tsx:1839` `showHint={rows >= HINT_MIN_ROWS}` —— **终端一矮就整条消失**；
> - `App.tsx:1841` `hintsEnabled={cfg.hints}` —— **用户配置 `hints: false` 就整条消失**。
>
> `ui/ModeChip.tsx:12` 的注释早就把这件事写下来了（「which disappears on a short terminal
> (`showHint`), under `hints: false`」）。
>
> ⇒ 如果备用键位**只**出现在这一行里，那么「矮窗口 / 关了提示」的用户会得到一个
> **存在但无人知晓**的键位 —— 复刻第 1 轮「一次性 notice ≈ 没说」的同款失败，只是换了个开关。
> 备用键位必须至少再有一处**不可被抑制**的落点。现成的候选（都在既有代码里，无需新界面）：
> `/help` 覆盖层的键位表，以及 `commands/builtins.ts:284-297` —— `/plan` 已经在回显当前模式，
> 在那句话里带上「也可以按 `<key>`」的成本接近零，且**恰好打在正在手动找替代方案的那个用户身上**。

> **【评审更正 R-13 · 对 R-7 的两处收紧】R-7 低估了抑制面，也高估了它推荐的那个备用落点。**
>
> **① 内联（非全屏）模式根本没有提示条，不是「会被开关关掉」。**
> `App.tsx:1849` 是一个三元：`fullscreen ?` 渲染 `<Composer …modeToggleKey={modeToggleKey}…/>`，
> `:` 渲染的是**裸 `<PromptInput>` 包一层 `<Box marginTop={1}>`，完全没有 hint 行**。
> 也就是说 C3① 那条「按真实能力显示 `ctrl+p plan`」的提示，**在内联模式下不存在**——
> 不是被 `showHint` / `hints:false` 关掉，是这条渲染路径上压根没有它。
> 而内联用户**确实是本 bug 的目标人群**：`vtInputDeadNotice(nodeVersion, fullscreen)` 专门为
> 内联写了一条分支（§8.2 引的那句 `Use /plan to switch mode instead.`），
> 证明这批人早已被承认在受影响范围内。
>
> **② R-7 提议的 `/plan` 回显通道，按当前代码并不存在。**
> `commands/builtins.ts:283-298`：只有 `/plan status` 分支调 `ctx.notify(...)`；
> 裸 `/plan`（以及 `/plan on|off`）走到 `:297-298` 的
> `const target = …; ctx.applyAgentMode(target);` —— **一句 `notify` 都没有**，
> 模式切换的可见反馈来自 `ModeChip` / `StatusBar` 的重绘，不是一条可以「顺手挂一句话」的消息。
> 要在这里加提示，就得**新增**一次 notify（改变既有命令的输出行为），成本不是 R-7 说的「接近零」。
>
> ⇒ 合并 ①②，**在未修复 G1 的前提下**，一台 C1 失败的机器上 `Ctrl+P` 的可发现通道实际是：
>
> | 渲染模式 | 底部提示条 | `/help` | 启动 notice |
> |---|---|---|---|
> | 全屏 | ✅ 有（但 `showHint` / `hints:false` 两个开关） | ✅ 不可抑制 | ❌ G1：老用户永不出现，新用户看到旧文案 |
> | **内联** | ❌ **该路径无提示条** | ✅ 不可抑制 | ❌ 同上 |
>
> 即：**内联用户只剩「主动去敲 `/help`」这一条**。这把 §8.2 那句
> 「用户并非无从发现 `Ctrl+P`」限定在了全屏模式；对内联模式，它不成立。
> **这条是把 G1 从「补一条文案」抬成「唯一主动通道」的关键事实**，见 §评审结论 D-1。

### 3.8 字节路径零自动化覆盖

`Shift+Tab` 从字节到行为的整条链是：
`\x1b[Z` → `stdin-mouse-filter`（装了 filter 时）→ ink `parse-keypress` → `key.tab && key.shift`
→ `App.tsx:1369` → `applyMode(nextMode(...))`。

- `__tests__/app.test.tsx` **确实**用真实字节序列驱动测试：`:669` 写 `\x1b[1;2A`（Shift+Up）、
  `:728` 写 `\x1b[5~`（PgUp）、`:686` 写 `\f`（Ctrl+L）。
- 但**全仓没有任何一处测试写过 `\x1b[Z`**（`grep` 覆盖 `packages/cli/src/__tests__/` 全部文件）。
- `__tests__/plan-mode.test.ts` 只测纯函数（`nextMode` / `MODE_LABEL` / `/plan` 命令），不碰键路径。
- `__tests__/stdin-mouse-filter.test.ts` 也没有 `\x1b[Z` 的透传用例。

也就是说：这个功能**唯一**的自动化保护是 `App.tsx` 里那行 `if` 的存在性，而
「`\x1b[Z` 能不能变成 `{tab:true, shift:true}`」「filter 会不会把它切碎」两层
**完全没有断言**。本轮已手工验证 ink 5.2.1 的映射是对的：

```
"\u001b[Z" -> {"name":"tab","shift":true}
"\t"       -> {"name":"tab","shift":false}
```

且 `input/mouse-events.ts::matchReport` 对 `\x1b[Z` 走 `{kind:'none'}` 分支（`:120-135`），
原样透传。**但这两条今天都靠人读，不靠测试。** 修复阶段必须补上，否则下一次同样的问题
仍然会以「测试全绿」的姿态发布。

> **【评审补证 R-12】本轮评审当场重跑了这两条映射，并补上原文缺的那一环：`input` 是怎么来的。**
> （`node -e` 直调 `node_modules/ink/build/parse-keypress.js`，ink 5.2.1）
>
> ```
> 0x10        -> {"name":"p",  "ctrl":true,  "shift":false}   # Ctrl+P
> ESC + "[Z"  -> {"name":"tab","ctrl":false, "shift":true }   # CSI Z
> 0x09        -> {"name":"tab","ctrl":false, "shift":false}   # bare Tab
> ```
>
> **原文（以及 §3.6 的表）只给到 `parse-keypress` 这一层，而 `App.tsx` 的判据用的是 `input`，
> 两者之间还隔着一次转换**：`ink/build/hooks/use-input.js:67` ——
> `let input = keypress.ctrl ? keypress.name : keypress.sequence;`。三条推论：
>
> 1. `Ctrl+P` 的 `input` 是 **`'p'`（小写 `name`），不是字节 `\x10`**
>    ⇒ 已落地的 `input === 'p'` 判据成立，且它成立的理由是 `keypress.name`，**与原始字节无关**。
> 2. 同文件 `:68` 对 `nonAlphanumericKeys`（含 `tab`）把 `input` 置空串
>    ⇒ `Shift+Tab` 那一半**必须**用 `key.tab && key.shift`，**不可能**改写成 `input` 比较。
>    这解释了为什么已落地的分支是「两个形状不同的判据 or 在一起」而不是统一写法 —— 那是被迫的，不是风格。
> 3. `parse-keypress` 的 `name` 恒小写 ⇒ 已落地分支里的 **`input === 'P'` 是不可达代码**。
>    无害（`||` 的死支），但它会让下一个读者以为存在「大写 P」的输入形态而去别处找对称处理，
>    删掉更诚实；**这是可选清理，不构成修复项**。

### 3.9 本轮**无法**从本机排除的解释

诚实边界。以下三种都会产生「按 `Shift+Tab` 没反应」，本轮拿不到用户机器，**都没有被排除**：

| 情况 | 判据（用 §2.1 的分诊命令区分） | 归属 |
|---|---|---|
| 用户 Node 已经 ≥ 22.17，另有原因 | 分诊打印 `1b5b5a` | **本文分析不适用**，需新一轮定位。§6 的 C2/C3 仍然改善处境 |
| 控制台拒绝 `ENABLE_VIRTUAL_TERMINAL_INPUT`（很老的 conhost） | 分诊打印 `09`，且 §5 的 C1 落地后仍然 `09` | libuv 在 `SetConsoleMode` 失败时静默回退（v1.51.0 `src/win/tty.c:417`）。**只有 C2 能救** |
| 终端 / 多路复用器 / 远程桌面根本不转发 `CSI Z` | 分诊**什么都不打印** | 第 1 轮 §4.1 末两行，`/plan` 兜底 |

这也是 §6 推荐「C2 必须落地」的根据：**C1 有三种已知的失效方式，C2 一种都没有。**

> **【评审补充 R-8】第一行「分诊打印 `1b5b5a`，键是好的」这一支原文只写了「需新一轮定位」，
> 等于把下一轮从零开始。本轮可以低成本地把候选先摆出来 —— 它们全部只需读代码即可枚举：**
>
> | 候选 | 引用 | 表现是否吻合「按了没反应」 |
> |---|---|---|
> | **有浮层开着** | `App.tsx:1370` `if (stateRef.current.overlay) return;` | ✅ 完全吻合：字节到了、`if` 命中了、第一行就 return，界面零变化、零日志 |
> | **运行中按下** | `App.tsx:1073` `applyMode` → `applied.pending` 分支，`:1078` toast「applies after this run」 | ⚠️ 部分吻合：模式**不会立刻**变，但 `StatusBar.tsx:210` 会显示 `BUILD → PLAN` 且有 toast ⇒ 有可见反馈，除非用户只盯着 `ModeChip` |
> | **`mouseFilter` 把 `\x1b[Z` 切碎** | `input/mouse-events.ts:120-135` | ❌ 已排除，见 §3.8：`s[2]==='Z'` 落 `{kind:'none'}` 原样透传 |
> | **ink 不认 `[Z`** | `node_modules/ink/build/parse-keypress.js:84,:100` | ❌ 已排除：`'[Z': 'tab'` + `'[Z'` 在 `isShiftKey` 里 |
>
> ⇒ 若用户回报 `1b5b5a`，**第一个要问的不是「哪里坏了」而是「你按的时候屏幕上有没有浮层 / 是不是正在跑」**。
> 前两行都是**产品行为而非缺陷**，把它们先排掉能省下一整轮定位。

---

## 4. 影响面

1. **平台**：仅 `win32`。macOS / Linux / WSL 走真 PTY，不受影响。
2. **人群规模没有变**：按第 1 轮 §3.6 的表，`18.x` / `20.x` / `22.0–22.16` / `23.x` / `24.0–24.1`
   全部受影响，而 `engines: ">=18"`（`packages/cli/package.json`）对它们全部放行。
   Node 20 仍是 Windows 上最常见的 LTS。
3. **不是「没反应」，是「做了别的事」**（第 1 轮 §4.2，本轮未变）：受影响主机上
   `Shift+Tab` 到达 Ink 时就是一个普通 `Tab`，于是
   - 开着 `/` 面板或 `@` 补全时命中 `PromptInput.tsx:353` 的补全分支，**改写用户草稿**——
     `:341` 的守卫 `if (key.tab && key.shift) return;` 因 `key.shift` 恒 `false` 而形同虚设；
   - 设置面板里让光标下移一格。**（评审补引：`ui/overlays/SettingsScreen.tsx:341`
     `if (key.downArrow || (key.tab && !key.shift))`，且 `:336` 的注释本身就写着
     「`&& !key.shift` is a real key collision, not a style choice」—— 那条守卫是为
     `Shift+Tab` 专门加的，而在受影响主机上 `key.shift` 恒 `false` 使它恒真，
     于是 `Shift+Tab` 在设置面板里被当成 `Tab` 处理。这是本文所有「守卫形同虚设」
     断言里唯一有源码注释自证的一条，值得引用。）**
4. **第 1 轮之后新增的伤害面：用户被明确地引导去按一个坏键，且没有任何持续可见的更正**（§3.7）。
   这一条比第 1 轮更严重 —— 第 1 轮至少「一次性说过一次」，而在真实使用节奏里那等于没说。
5. **`aragon doctor` 给出错误的安心信号**（§3.7 第 3 条），这会让用户和支持人员都走错方向。
6. **滚轮**：本轮**没有**新增关于滚轮的结论。第 1 轮的结论（老路径上必然无效）仍然成立；
   「强开 VT 位之后滚轮会不会活」**未被证明**，见 §7。

---

## 5. 候选修复对比

三个候选是**互补的，不是互斥的**。C1 修「Shift+Tab 本身」，C2 修「无论如何都要有一条能用的路」，
C3 修「用户能不能知道自己踩到了什么」。

| # | 方案 | 侵入性 | 风险 | 工作量 | 在所有 PC 上都成立？ |
|---|---|---|---|---|---|
| **C1** | **自己打开 `ENABLE_VIRTUAL_TERMINAL_INPUT`**：检测到受影响 Node 时，在 Ink 进入 raw 模式**之后**把那一位 OR 上去，并在每次 raw 模式转换 / 子进程返回后重新施加；退出时还原控制台模式 | 中 | 中。见下面 M1/M2 与三条已知失效方式 | 中 | ❌ 三种失效方式（§3.9）：控制台拒绝该位、被子进程改回、helper 机制不可用 |
| **C1·M1** | 机制 = **PowerShell 子进程 + `CONIN$`**（本轮 E2 实测通过） | 低（无新依赖，纯 JS + 一个 `.ps1`） | 中。722 ms/次（§3.4）⇒ 只能低频施加；依赖 PowerShell 可用且未被 ExecutionPolicy 锁死；杀软会对「spawn PowerShell 改控制台」敏感；`windowsHide` 陷阱（§3.5） | 小～中 | — |
| **C1·M2** | 机制 = **原生 FFI / 预编译 addon**（如 `koffi`，仅 win32 的 `optionalDependency`） | 高（CLI 首个原生依赖，破坏「纯 JS、`npx` 可跑」） | 中。调用成本≈0 ⇒ 可以随便重新施加，反而**消除**了 M1 最大的约束；代价是预编译矩阵（x64/arm64）与安装失败面，失败必须优雅退回 C2 | 中 | — |
| **C2** | **增加一个能穿过老路径的备用键位（`Ctrl+P`）**，与 `Shift+Tab` 并存，默认启用 | 低（`App.tsx` 一条分支 + 帮助层 + README） | 低。`Ctrl+P` / `Ctrl+B` 实测在老路径上完好到达（§3.6），本仓两个都空闲；唯一需要确认的是与用户终端既有绑定的观感冲突 | 小 | ✅ **是**。不依赖控制台模式、不依赖 Node 版本、不 spawn 任何东西 |
| **C3** | **让「坏掉」持续可见**：① 底部提示按真实能力显示（受影响时显示备用键位而不是 `shift+tab`）；② `doctor` 增加一条真正的 VT-input 检查；③ notice 不再「永久一次性」 | 低 | 低 | 小 | ✅ 是（它不恢复功能，但它消灭「静默」） |

**已拒绝**（沿用第 1 轮结论，本轮无新证据推翻）：
把 `engines.node` 抬到 `>=22.17`（把主体功能正常的用户挡在门外，不成比例）；
滚轮降级到 DEC 1007 alternate scroll（重开 `mouse-wheel-region-routing` 立项要消灭的旧伤口）；
只改文档（第 1 轮已经做过一个更强的版本，用户反馈就是它不够）。

---

## 6. 推荐修复

**推荐 C2 + C3 立即落地，C1·M1 紧随其后，C1·M2 作为后续升级路径。**

理由：

1. **只有 C2 满足需求原话「使得其在所有 PC 上都能够正常」。**
   C1 是本轮最重要的技术发现，但它有三种已知失效方式（§3.9），其中「控制台拒绝该位」
   与「被子进程改回」都不在我们控制之内。把「模式能不能切」押在一个可能失败的机制上，
   会得到一个**时灵时不灵**的功能 —— 那比现在「稳定不灵」更难排查。
   C2 是唯一被实测证明能穿过故障路径、且不依赖任何外部条件的一级。**它是地板，必须先有。**
2. **C1 是唯一能让「`Shift+Tab` 这个键本身」复活的方案，而用户要的正是这个键。**
   第 1 轮把它记为「未验证、推迟」；本轮 §3.2/§3.3/§3.4 把三个未知量
   （能不能打开、会不会被冲掉、生产形态成不成立）全部变成了测量结果。剩下的都是工程：
   施加时机、重新施加、退出还原。**先做 M1**（不引入原生依赖，722 ms 可以放到非关键路径上），
   把 M2 留给「如果需要高频重新施加」这一天 —— 那时 M1 的 722 ms 会从「可接受」变成「不可接受」，
   而那正是切换机制的信号。
3. **C3 不是文档工作，是这次反馈的直接成因。** §3.7 的三条里，
   「`doctor` 在受影响机器上判定通过」和「底部一直教用户按坏键」都是**主动的错误信号**，
   不是「缺少信息」。哪怕 C1 与 C2 都落地，C3 也仍然必要：C1 失败的那些机器需要知道自己在哪一档。

### 6.1 落地清单（下游修复节点照此执行）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/cli/src/ui/App.tsx:1369` 附近 | C2：新增备用键位分支（建议 `Ctrl+P`），与 `key.tab && key.shift` 共用 `applyMode(nextMode(...))`，同样受 `stateRef.current.overlay` 早退保护 |
| 2 | `packages/cli/src/ui/Composer.tsx:73` | C3①：提示文案按真实能力选择。受影响时显示备用键位，不再无条件写 `shift+tab` |
| 3 | `packages/cli/src/diagnostics/doctor.ts:37,61-68` | C3②：`checkNode` 之外新增一条 VT-input 检查。**`MIN_NODE_MAJOR` 保持 18 不变**（安装门槛不动），新检查产出 `warn` 而非 `fail`，remedy 指向备用键位与 Node 升级两条路 |
| 4 | `packages/cli/src/ui/use-startup-notices.ts:210` | C3③：`vtInputNoticeSeen` 的一次性语义改为「每次大版本 / 每 N 天重提一次」或至少在 `/help` 里常驻一条。**不要**简单删掉一次性（会变成每次启动都刷屏） |
| 5 | 新增 `packages/cli/src/ui/win-vt-force.ts` + helper 脚本 | C1·M1：`forceWindowsVtInput()`。**必须** ① 在 Ink `setRawMode(true)` **之后**调用；② helper 走 `CreateFileW("CONIN$")` 而非 `GetStdHandle`；③ spawn 时 **`windowsHide: false`**（§3.5）；④ helper 把 `before` 模式回报给调用方，调用方**校验它不是 `0x01F7` 之类的默认值**，否则判定失败；⑤ 退出时还原 |
| 6 | `packages/cli/src/cli.tsx:495-501` | **C1 落地后这里必须改语义**：`vtInputSupported` 目前是「Node 版本够不够新」的**预测**。C1 之后它变成错的 —— 我们刚把那位打开了，控制台是能上报的。它同时门控 `wantMouse`（`?1000h` 的写出、filter、`mouseSource`）与那条 notice，**继续用版本预测会让 CLI 在自己刚修好的机器上关掉滚轮并继续吓唬用户**。改为「实际拿到那一位了吗」 |
| 7 | 测试 | ① `app.test.tsx` 补一条 `stdin.write('\x1b[Z')` → 模式切换的**字节级**用例（§3.8，与 `:669` 的 Shift+Up 同款写法）；② 补一条备用键位用例；③ `stdin-mouse-filter.test.ts` 补 `\x1b[Z` 透传用例；④ `win-vt-force` 的 `before` 校验分支要有用例（`0x01F7` ⇒ 判失败） |
| 8 | `packages/cli/README.md` | 键位表补备用键位；`Shift+Tab` 一节补 §2.1 的分诊命令 |

### 6.2 给用户的即时答复（无需等修复）

> 先跑这一条，把原因定下来（PowerShell 里直接粘贴，按一次 `Shift+Tab`，再按 `Ctrl+C` 退出）：
>
> ```powershell
> node -e "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>{console.log(b.toString('hex'));if(b[0]===3)process.exit(0)})"
> ```
>
> - 打印 `09` → 是 Node 版本这一类。**立刻可用的绕行：用 `/plan` 切换模式**；
>   彻底解决：把 Node 升到 `22.17.0`+（或 `24.2.0`+）后重启 `aragon`。
>   （请同时把 `node -p "process.version"` 的输出发回来。）
> - 打印 `1b5b5a` → 键是好的，问题在别处，**请把这个结果发回来**，需要另行定位。
> - 什么都不打印 → 你的终端 / 远程桌面没把这个键送进来，换一个终端试试，或用 `/plan`。

---

## 7. 本轮**未能**验证的部分（不要当成已验证）

1. **「强开 VT 位之后鼠标滚轮也会活」没有被证明。** E1 里注入的 `MOUSE_EVENT` 记录在
   强开之后依然没有产生任何数据（`inject-log-node20vt.txt` `[3224ms] inject WheelUp` /
   `[3477ms] inject WheelDown`，`probe-out-node20vt.jsonl` 在这两个时刻**没有对应的 `data` 行**），
   但这**不能**读作「滚轮也坏」—— 第 1 轮 §7.1 已经查明
   `WriteConsoleInput` 塞进去的鼠标记录会**绕过**控制台的「鼠标 → VT」翻译（那条翻译挂在
   窗口消息路径 `windowio.cpp::HandleMouseEvent → HandleTerminalMouseEvent`）。
   本轮沿用同一注入手段，因此同样不构成证据。**滚轮要么用真实滚轮手测，要么不要在
   changelog 里提。**

   > **【评审补证 R-9】上面这段解释了「为什么注入测不了滚轮」，却从来没有解释
   > 「那为什么注入测得了按键」。这个不对称是 E1/E2 全部结论的合法性前提，必须写下来，
   > 否则 §3.2 那条决定性证据会显得是运气。**
   >
   > 差别在于 conhost 的两次翻译**挂在不同的位置**：
   >
   > - **键盘 → VT 的翻译发生在输入缓冲区的「写入」侧**（`InputBuffer::Write` 在
   >   `IsInVirtualTerminalInputMode()` 为真时走 `_HandleTerminalInputCallback` →
   >   `TerminalInput::HandleKey`，把 `KEY_EVENT` 换成一串合成的字符记录）。
   >   `WriteConsoleInput` 正是「写入」侧的公开 API ⇒ **注入的按键会被照常翻译**。
   >   这就是 E1 里同一段注入代码在置位前后分别产出 `09` 与 `1b5b5a` 的原因。
   > - **鼠标 → VT 的翻译挂在窗口消息侧**（`windowio.cpp::HandleMouseEvent`），
   >   在 `WriteConsoleInput` 的**上游**。注入的 `MOUSE_EVENT` 直接落进缓冲区，
   >   从不经过那段翻译 ⇒ 注入对滚轮**在原理上**就不是一个有效手段。
   >
   > ⇒ **E1/E2 的按键结论有效；滚轮的沉默是探针的性质，不是滚轮的性质。**
   > 这也意味着：机制上有理由**预期**强开那一位之后滚轮也会恢复
   > （合成的字符记录会走 libuv 的字符支，与 `\x1b[Z` 走同一条路），
   > 但**预期不是证据**，本文其余部分不得据此断言，须以真实滚轮手测为准。
2. **没有在用户那台机器上验证任何东西。** §2.1 的分诊命令就是为此设计的；
   在拿到它的输出之前，「用户的 Node 是老版本」是**最可能**的解释，不是已确认的事实。
3. **C1 在以下场景未测**：ConPTY 之外的宿主（很老的 conhost、第三方终端如 ConEmu / MSYS2）、
   arm64 Windows、PowerShell 被 ExecutionPolicy 或杀软限制的机器、
   以及「CLI 跑 bash 工具 / 外部编辑器之后那一位还在不在」。~~第三条是最可能在真实使用里咬人的。~~

   > **【评审更正 R-10】末句已被 R-2 推翻**：本仓 bash 工具走 `windowsHide: true` ⇒ 独立控制台，
   > 唯一的 `stdio:'inherit'`（`config/cli-commands.ts:469`）不在 TUI 路径上，所以这条**今天不成立**。
   >
   > **同时补一个原文完全没提、比它更可能咬人的场景：PowerShell 的 Constrained Language Mode。**
   > helper 依赖 `Add-Type`（§3.4 实测的 300 ms 就是它的运行期 C# 编译），而 CLM 下
   > `Add-Type` 被**直接禁用**。企业机器上 CLM 由 AppLocker / WDAC 策略批量下发，
   > 恰恰是「另一台 PC」这类场景的高发人群。这不是「PowerShell 不可用」，
   > 是「PowerShell 在、但正好缺我们唯一需要的那个能力」——
   > helper 会以非零退出码失败，**必须**优雅降级到 C2，而不是让 CLI 报错或卡住。
   >
   > 另一条同样缺失的边界：**helper 是异步的（722 ms）**。若用户在这 722 ms 内退出 CLI，
   > helper 会把那一位设到一个 CLI 已经不再拥有的控制台上（并且按 §3.5b 不会有人清它）。
   > 需要一个「进程已退出则放弃/回滚」的顺序保护。
   >
   > **【评审补充 R-15 · 一条比 CLM 更宽的失败面：`-EncodedCommand` + `Add-Type` 正是 EDR 的高频告警形状】**
   >
   > 已落地实现的命令行是
   > `powershell.exe -NoProfile -NonInteractive -NoLogo -EncodedCommand <base64>`
   > （`win-vt-force.ts:240-246`），脚本体内再跑 `Add-Type -TypeDefinition …` 做 P/Invoke。
   > 模块头把「内联而不是随包发 `.ps1`」的理由记为 ExecutionPolicy —— **这一步推理是对的**
   > （ExecutionPolicy 只管脚本**文件**）。但它**推不出 `-EncodedCommand`**：
   > `-Command` 同样不受 ExecutionPolicy 约束，两者在这一点上等价，
   > 选 `-EncodedCommand` 换来的其实是**免引号转义**，那是工程便利，不是策略必需。
   >
   > 代价没有被记下来：**base64 编码的 PowerShell 命令行 + 运行期 C# 编译**，
   > 这两件事各自都是 EDR / ASR 规则里最常见的可疑特征之一
   > （`Add-Type` 会落一个临时 DLL 并拉起 C# 编译器），合在一起更是教科书形状。
   > 而本 bug 反复命中的人群，恰恰是 §R-10 已经点名的**企业批量下发策略的机器**。
   >
   > 三条结论：
   > 1. **C1 在企业机队里的失败率应当按「高于 CLM 单独估计」来预期**，
   >    失败模式仍是优雅的（`helper_failed` → 降级到 `Ctrl+P`），所以**这不是正确性阻塞项**。
   > 2. 但它是**「C2 必须是地板」这条排序理由的又一个独立支点**（§6 理由 1）：
   >    C1 的失效面比 §3.9 列的三种还要宽一档。
   > 3. 它还可能给用户的 IT 部门产生一条安全告警。**若将来要降低这个面**，
   >    可评估把 `-EncodedCommand` 换成 `-Command`（策略上等价、形状更常见），
   >    或长期走 §5 的 C1·M2（原生 addon，彻底不 spawn PowerShell）。
   >    **本轮不做**——它属于 C1 的调优，不属于「让所有 PC 能用」的必要路径。
4. ~~**`Ctrl+P` 与用户既有终端绑定的冲突面未调研**（本仓内部无冲突，已核对）。
   若发现冲突，`Ctrl+B` 是同样被实测证明可用的第二选择。~~

   > **【评审更正 R-11】本轮评审已调研，结论见 R-5 / R-6：`Ctrl+P` 在整个包内零冲突且今天是空操作
   > （拿不走任何既有行为）；`Ctrl+B` 应从「同样可用的第二选择」**降级为不推荐**（tmux 默认 prefix
   > 会在应用之前吞掉它，而键位是无条件跨平台绑定的）。若 `Ctrl+P` 仍需替换，
   > 按 R-4 的机制，任何空闲的 `Ctrl+<字母>` 都可用，但须避开 `Ctrl+I/J/M/H`（分别就是
   > `Tab`/`LF`/`CR`/`Backspace`）与 `Ctrl+Q/S`（XON/XOFF 流控，会被终端截走）。
5. **非 Windows 平台完全未测**，归因明确指向 Windows 专有路径。

---

## 8. 工作区实现状态审计（v2 · 运行图重跑时补）

**为什么需要这一节。** 本轮运行图被重跑了一次。重跑之前，**上一次运行已经按 §6.1 落地了实现**，
但**没有提交**——`git status` 里这批 `A` / `M` 全部停在暂存区：

```
A  packages/cli/src/ui/win-vt-force.ts                 (270 行，新增)
A  packages/cli/src/__tests__/win-vt-force.test.ts     (252 行，新增)
M  packages/cli/src/cli.tsx  ui/App.tsx  ui/Composer.tsx  ui/overlays/HelpOverlay.tsx
M  packages/cli/src/diagnostics/doctor.ts  agent/agent-mode.ts  README.md
M  packages/cli/src/__tests__/{app.test.tsx, stdin-mouse-filter.test.ts}
```

§6.1 是写给「面对空清单的修复节点」的。**今天它面对的不是空清单**，所以下面是逐项实测的差量。
本节全部结论均由本次重跑当场核对得出，未沿用上一次运行的任何自述。

### 8.1 §6.1 落地清单 vs 工作区（逐项核对）

| # | 清单项 | 状态 | 实测证据 |
|---|---|---|---|
| 1 | `App.tsx` C2 备用键位 | ✅ 已落地 | `App.tsx:1375` `if ((key.tab && key.shift) \|\| (key.ctrl && (input === 'p' \|\| input === 'P')))`，**与 `Shift+Tab` 同一分支**（不会漂移成两种行为），下一行 `if (stateRef.current.overlay) return;` 保留了清单要求的浮层早退 |
| 2 | `Composer.tsx` C3① 提示按真实能力显示 | ✅ 已落地 | `Composer.tsx:55,113,163` 新增 `modeToggleKey` prop（缺省 `MODE_TOGGLE_KEYS.primary`）；`App.tsx:1847` `const modeToggleKey = vtInputWarning ? MODE_TOGGLE_KEYS.fallback : MODE_TOGGLE_KEYS.primary` —— 底部提示不再无条件写 `shift+tab` |
| 3 | `doctor.ts` C3② VT 检查 | ✅ 已落地 | 新增 `checkVtInput()`（`:95-112`），非 win32 返回空列表；判定为 `warn` 而非 `fail`；**`MIN_NODE_MAJOR` 仍是 18**（`:39`，安装门槛未动，符合清单要求） |
| 4 | `use-startup-notices.ts` C3③ notice 一次性语义 | ❌ **未落地** | 该文件**零改动**（不在 `git status` 中）。`:210` `if (getVtInputNoticeSeen()) return;` 原样保留。详见 §8.2 —— **这是清单里唯一一项没被碰过的** |
| 5 | 新增 `win-vt-force.ts` C1·M1 | ✅ 已落地，五个子要求全中 | ① `cli.tsx:469` 先 `process.stdin.setRawMode(true)` 再调 helper；② helper 走 `CreateFileW("CONIN$")`；③ `win-vt-force.ts:263` `windowsHide: false`；④ `before` 校验**用了比清单更强的写法**（见下）；⑤ `cli.tsx:475` `process.on('exit')` 还原 |
| 6 | `cli.tsx` 语义从「预测」改「测量」 | ✅ 已落地 | `cli.tsx:564-565` `const vtInputByNode = supportsWindowsVtInput(...)` / `const vtInputSupported = vtInputByNode \|\| forceVtInputForThisConsole();` —— 强开成功后 `wantMouse` 与 notice 都跟着变真，堵住了清单点名的「在自己刚修好的机器上关掉滚轮并继续吓唬用户」 |
| 7 | 测试 4 个子项 | ✅ 全部落地 | ①`app.test.tsx:694` `stdin.write(\`${ESC}[Z\`)` → 断言模式切换；②`:713` `stdin.write('\u0010')`（Ctrl+P）→ 断言模式切换；③`stdin-mouse-filter.test.ts:70` CSI Z 透传，**且额外覆盖了「跨 chunk 撕开」**（`ESC` 与 `[Z` 分两次写）——清单没要求，但那正是真实控制台的行为；④`win-vt-force.test.ts:58,72,79,96` 覆盖 `wrong_console` / `bit_not_set` / `no_before` |
| 8 | `README.md` 键位表 + 分诊命令 | ✅ 已落地 | +58 行 |
| — | **清单之外的两项加法** | ✅ | `agent/agent-mode.ts:68` 新增 `MODE_TOGGLE_KEYS = { primary:'shift+tab', fallback:'ctrl+p' }` 作单一真相源（`doctor` / `Composer` / `App` / `cli` 四处引用，杜绝硬编码漂移）；`HelpOverlay.tsx` 键位表与 PLAN 段都列出 `Shift+Tab / Ctrl+P` —— **这正是 R-7 要求的那个「不可被抑制的落点」** |

两处实现**优于**清单原文，值得记一笔（评审不必把它们当偏离）：

- **第 5 项 ④**：清单写的是「校验 `before` 不是 `0x01F7` 之类的默认值」，而 R-3 已指出那是会漏判的魔数比较。
  实现采用了 R-3 的正向位掩码：`win-vt-force.ts:74` `COOKED_INPUT_BITS = ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT`，
  判据 `isRawConsoleMode(before)`。`win-vt-force.test.ts:61` 还专门写了一条
  「默认值**不是** `0x01F7` 的机器」用例来钉死这件事。
- **第 7 项**：`win-vt-force.test.ts:157` 对**生成出来的 helper 脚本**断言
  `expect(script).not.toMatch(/\[uint32\]\s*0x[89a-fA-F]/)` —— §3.3c 那个
  「在 100% 的 Windows 机器上一次也没跑起来、且失败形态与没实现逐字相同」的陷阱，现在有护栏了。

> **【评审补证 R-14 · 一条没写下来的不变量：`doctor` 必须继续用「预测」，改成「测量」会静默作恶】**
>
> 第 6 项刚刚把 `cli.tsx` 从**版本预测**改成**实测**，并在注释里把理由写得很重
> （「继续用版本预测会让 CLI 在自己刚修好的机器上关掉滚轮并继续吓唬用户」）。
> 而 `doctor.ts::checkVtInput()`（`:95-112`）**仍然**只调 `supportsWindowsVtInput(platform, version)`，
> 一次 helper 都不 spawn。**两处不一致，且下一个读者极有可能把它当成第 6 项漏改的地方去「补齐」。**
> 那会踩两个坑，且都不报错：
>
> 1. **它会恒判失败。** `decideVtForceOutcome` 的 `wrong_console` 判据是
>    `isRawConsoleMode(before)`（`win-vt-force.ts:209`），要求 `PROCESSED|LINE|ECHO` 三位全清；
>    而 `aragon doctor` 是**非 TUI 命令，从不 raise raw 模式**，它那个控制台恒为 cooked
>    ⇒ `before` 三位全置 ⇒ 直接返回 `wrong_console`。
>    净效果：doctor 在**一台 C1 完全能修好的机器上**报「修不了」。
> 2. **如果为此把那道守卫拆掉，代价是污染用户的 shell。** 按 §3.5b 实测，
>    那一位**会活过进程退出**，而清掉它的唯一自动机制是一次 raw 模式**转换**（§3.3）。
>    doctor 全程没有这样一次转换 ⇒ `aragon doctor` 跑完退出后，用户那个 PowerShell
>    会被**永久**留在 VT-input 模式里，影响之后在同一窗口里跑的**其它**程序，且没有任何人会去清。
>
> ⇒ **「`cli.tsx` 测量、`doctor` 预测」是正确设计，不是遗漏**：只有持有 raw 模式的那个进程
> 才有资格改这一位，因为只有它自带还原路径。已落地实现恰好做对了（`checkVtInput` 的
> `warn` 文案写的是「aragon turns that bit on at startup; if a policy blocks it, …」——
> 措辞已经是「启动时会尝试」而非「你这台机器坏了」），**但这条理由今天只存在于本评审里，
> 源码注释没写**。建议修复节点顺手把这两句补进 `checkVtInput()` 的注释；
> **这是注释级加固，不改行为，不构成本轮推荐修复的一部分。**

### 8.2 唯一未落地项 G1 —— 启动 notice 停在第 1 轮的文案与一次性语义

`use-startup-notices.ts` 零改动，于是有**两个各自独立**的缺口：

1. **文案陈旧。** `vtInputDeadNotice()`（`:86-102`）两条分支给出的绕行方案分别是
   「`Use /plan to switch mode instead.`」（inline）与「`Use /plan to switch mode and Shift+Up / Shift+Down to scroll.`」（全屏），
   **两支都没有提到 `Ctrl+P`** —— 而 `Ctrl+P` 恰恰是本轮新增的、§3.6 里**唯一被字节级实测证明能穿过故障路径**的键。
2. **一次性闸门已被消耗。** `:210` `if (getVtInputNoticeSeen()) return;` 原样保留。这条 notice 的受众
   **恰恰是第 1 轮已经启动过、已经看过它一次、该标志早已落盘为 `true` 的那批人**。

合起来的净效果，是第 1 轮那个坑**换了一层再来一次**：第 1 轮提交信息里写得很清楚——
*「绝不复用 `mouseNoticeSeen`：这条 notice 的受众恰恰是……该标志早已为 true 的人，复用等于让修复对唯一需要它的人群静默失效」*。
今天 `vtInputNoticeSeen` 对第 2 轮扮演的正是当初 `mouseNoticeSeen` 对第 1 轮扮演的角色：

| 人群 | 会不会看到 notice | 看到的话说了什么 |
|---|---|---|
| 第 1 轮就受影响、已看过一次的老用户（**本轮的目标人群**） | ❌ 永远不会再出现 | — |
| 全新用户 | ✅ 出现一次 | 一条**只推荐 `/plan`**、不知道 `Ctrl+P` 存在的旧文案 |

**严重度定级：不是「功能坏了」，是「最精准的那条通道空着」。** `Ctrl+P` 的另外两个落点都已落地——
底部提示条会显示 `ctrl+p plan`（持续可见，但有 R-7 点名的两个开关：矮窗口 `showHint`、`hints: false`），
`/help` 覆盖层已列出且**不可被抑制**。所以用户并非无从发现 `Ctrl+P`，
但**唯一会主动糊到受影响用户脸上的那条消息，没有携带本轮真正的修复**。

**给修复节点的建议（本节点不写代码），按成本排序**：

1. **先改文案，不动闸门**（成本最低、立刻覆盖全新用户）：把 `MODE_TOGGLE_KEYS.fallback` 写进
   `vtInputDeadNotice()` 的两条分支。注意 inline 支与全屏支的差异是 RF-1 刻意设计的
   （见该函数上方注释：inline 下滚轮**没坏**、`Shift+Up/Down` **不工作**），
   `Ctrl+P` 与渲染模式无关，**两支都该加**。
2. **再处理一次性语义**。§6.1 第 4 项已经写明 **不要简单删掉一次性**（会变成每次启动刷屏）。
   最小且正好够用的改法是**让「看过」带上版本**（把 `vtInputNoticeSeen` 的布尔语义换成「已看过的 notice 版本号」），
   这样**文案变更本身**就是重放条件——恰好只覆盖「老用户第一次看到 `Ctrl+P`」这一个场景，之后照旧沉默。
   若要动 `config/ui-state.ts` 的持久化形状，请复核第 1 轮那条约束：**不要 bump schema**
   （`readFromDisk` 会丢弃整个对象、清空 `submitCount` 并把鼠标提示重放一遍）。

### 8.3 本轮重跑独立复核过的断言

下表全部是**本次重跑当场跑出来的**，不是转述上一次运行的自述：

| 断言 | 原出处 | 复核方式 | 结果 |
|---|---|---|---|
| ink 5.2.1 把 `\x1b[Z` 解析成 `{tab, shift:true}`，`\t` 解析成 `{tab, shift:false}` | §3.8（原文自陈「靠人读，不靠测试」） | 本机直接调 `ink/build/parse-keypress.js` | ✅ 逐字复现：`CSI-Z -> {"name":"tab","shift":true}` / `TAB -> {"name":"tab","shift":false}`。**且 §3.8 的「零自动化覆盖」结论今天已经失效**——三条字节级用例都在了 |
| helper 的 `[uint32]0xC0000000` 必炸（§3.3c） | §3.3c | 读生产实现 + 测试 | ✅ 已改十进制，`win-vt-force.ts:129-137` 把原因写进了注释；`win-vt-force.test.ts:157` 有正则护栏 |
| `windowsHide: true` 会静默配置另一个控制台（§3.5） | §3.5 | grep 实现 | ✅ `win-vt-force.ts:263` `windowsHide: false`，`:24-28` 注释复述了机制 |
| `before` 必须用正向位掩码而非魔数（R-3） | R-3 | 读实现 + 测试 | ✅ `COOKED_INPUT_BITS`（`:74`）+ `wrong_console` 分支（`:209`）+ 专门的非-`0x01F7` 用例 |
| 全量测试 | — | `npx vitest run`（`packages/cli`） | ✅ **157 文件 / 2242 通过 / 5 跳过 / 0 失败**（55.7 s） |
| 类型 | — | `npx tsc -p tsconfig.json --noEmit` | ✅ 退出码 0，零错误 |

### 8.4 交给评审节点的三条判断题

1. **722 ms 只落在受影响机器上——这一点必须写进 changelog，否则会被读成「Windows 启动慢了 0.7 秒」。**
   `cli.tsx:565` 是 `vtInputByNode || forceVtInputForThisConsole()`，JS `||` **短路**：
   `vtInputByNode` 为真时 helper 根本不会被 spawn。而 `supportsWindowsVtInput` 对**所有非 win32 恒真**
   （`ui/win-vt-input.ts`），所以 macOS / Linux / 新 Node 的 Windows **一次也不 spawn**。
   §3.4 那 722 ms 只在「本来就坏掉」的机器上付出，买回的是那台机器上 `Shift+Tab` 本身。
2. **R-10 的第二条边界已经不存在了，评审不必再为它设计顺序保护。** R-10 担心
   「helper 是异步的 722 ms，若用户在此期间退出，那一位会被设到一个 CLI 已不再拥有的控制台上」。
   实现用的是 **`spawnSync`**（`win-vt-force.ts:55,257`，5 s 超时），在启动路径上同步等待 ⇒ 那个窗口不存在。
   R-10 的**第一条**（Constrained Language Mode 下 `Add-Type` 被禁）仍然成立，
   实现按设计降级：`cli.tsx:491` 记 `vt_input_force_failed` 并返回 `false`，
   于是 `vtInputWarning` 亮起、底部提示切到 `ctrl+p`——**C2 接住了它**，这正是 §6 推荐顺序的意义。
3. **§7.1 的滚轮边界原封不动，不要在 changelog 里写「修复了滚轮」。**
   本轮重跑**没有**新增任何滚轮证据。R-9 已说明「注入测不了滚轮」是探针的性质而非滚轮的性质：
   强开那一位之后滚轮**有机制上的理由预期恢复**，但**预期不是证据**，须以真实滚轮手测为准。

### 8.5 仍然没有被验证的那一件事（DoD 缺口，留给修复 / 验收节点）

**整套实现从未在一台真正受影响的机器上端到端跑过。** 本次重跑时本机只有 Node v22.18.0
（`where node` → `D:\Program Files\nodejs\node.exe`），
上一轮实验用的那份 `node-v20.19.0-win-x64` 已不在机器上，
因此「老 Node + PowerShell 下，装上本轮构建的 CLI，按 `Shift+Tab` 真的会切模式」
这句话目前**只有推理链**（§3.2 强开生效 → §3.3b 顺序成立 → 实现按该顺序落地 → 单测全绿），
**没有一次端到端观测**。

这条不影响本报告的根因结论（那由 §3.2 的字节级对照实验支撑），
但它是**验收的最后一环**，且**恰恰是用户两轮反馈的那件事**。最小验收脚本：

```powershell
# 1) 取一份受影响的 Node（任一：18.x / 20.x / 22.0-22.16 / 23.x / 24.0-24.1）
#    https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip
# 2) 用它跑本轮构建的 CLI（先在 packages/cli 里 npm run build）
& '<...>\node-v20.19.0-win-x64\node.exe' 'M:\takoAI\JRAgentMesh\aragon-agent-core\packages\cli\dist\cli.js'
# 3) 按一次 Shift+Tab      -> 期望 ModeChip 从 BUILD 切到 PLAN（C1 生效）
# 4) 按一次 Ctrl+P         -> 期望同样切换（C2 生效，且与 C1 互不依赖）
# 5) 退出后回采控制台模式  -> 期望 VT_INPUT 位已被还原（§3.5b）
```

第 3 步失败而第 4 步成功 ⇒ C1 在这台机器上被拒（§3.9 的三种失效方式之一），
**这不是回归**，是 §6 早已预期并用 C2 兜住的那一档；
第 4 步也失败 ⇒ 才是真正需要新一轮定位的信号。

---

## 附录 A · 本轮原始数据索引

全部在 `repro/`，均为本轮 2026-08-10 在 Windows 11 26200 上实跑产出，未经编辑：

| 文件 | 对应结论 |
|---|---|
| `probe-out-node20vt.jsonl` / `inject-log-node20vt.txt` | §3.2 强开生效、§3.3 raw 模式切换后被抹掉 |
| `probe-out-e2b.jsonl` / `inject-log-e2b.txt` / `probe-out-e2b.jsonl.helper.log` | §3.4 生产形态成立 + 722 ms |
| `probe-out-e2n20.jsonl` / `inject-log-e2n20.txt` / `probe-out-e2n20.jsonl.helper.log` | §3.5 `windowsHide: true` 静默配置了另一个控制台（`before=0x01F7`） |
| `probe-out-fbn20.jsonl` / `inject-log-fbn20.txt` | §3.1 复测、§3.6 备用键位实测表 |
| `probe-out-rawmode-idempotent.txt`（+ `probe-rawmode-idempotent.mjs` / `inject-rawmode-idempotent.ps1`） | §3.3b 重复置同一 raw 模式不清位（修复阶段补测，Node 22.18.0） |

关键三行，便于快速核对：

```
# §3.2  Node 20.19.0，同一次运行，强开 0x0200 前后
{"t":1512,"event":"data","hex":"09",    "text":"\"\\t\""}
{"t":2460,"event":"data","hex":"1b5b5a","text":"\"\\u001b[Z\""}
# §3.3  探针自己切一次 raw 模式之后
{"t":5973,"event":"data","hex":"09",    "text":"\"\\t\""}
```

## 附录 B · 引用清单

| 引用 | 出处 |
|---|---|
| 第 1 轮交付「不恢复功能」的原话 | `git show 45d27deb`（提交信息正文） |
| `Shift+Tab` 判据 | `packages/cli/src/ui/App.tsx:1369` |
| `Tab` 落到补全 / 守卫恒假 | `packages/cli/src/ui/PromptInput.tsx:341, :353` |
| `wantMouse` 与版本预测 | `packages/cli/src/cli.tsx:495-501` |
| VT notice 的一次性键 | `packages/cli/src/ui/use-startup-notices.ts:210-211` |
| 底部提示恒显 `shift+tab` | `packages/cli/src/ui/Composer.tsx:73` |
| `doctor` 的 Node 下限 | `packages/cli/src/diagnostics/doctor.ts:37, :63` |
| `Ctrl` 键位占用（`a/e/w/u/k`） | `packages/cli/src/input/keymap.ts:34,36,38,40,42` |
| `\x1b[Z` 在 filter 里走 `none` 分支 | `packages/cli/src/input/mouse-events.ts:120-135` |
| ink 把 `[Z` 解析成 `tab`+`shift` | `node_modules/ink/build/parse-keypress.js:84, :100`（ink 5.2.1） |
| libuv 在 `SetConsoleMode` 失败时静默回退 | `libuv` v1.51.0 `src/win/tty.c:417` |
| 第 1 轮全部第三方引用（libuv 翻译表、`tty_wrap.cc`、conhost 鼠标路径） | `docs/diagnoses/shift-tab-and-mouse-wheel-dead-on-some-terminals/analysis.md` 附录 B |

---

## 评审结论

**评审范围**：analysis.md v2 全文 + 工作区**已落地但未提交**的那批实现（`git status` 里的 12 个源文件）。
**评审方式**：**不采信 §8 的任何自述**。下面 V-0 的每一行都是本次评审当场跑出来或当场读出来的。

### V-0 复核结果总表（本轮评审自己产出的证据）

| 复核项 | 方式 | 结果 |
|---|---|---|
| ink 5.2.1 的两条键映射 | 直调 `node_modules/ink/build/parse-keypress.js` | ✅ `CSI Z` → `{tab, shift:true}`；`0x10` → `{p, ctrl:true}`（**R-12**） |
| `App.tsx` 判据依赖的 `input` 是怎么派生的 | 读 `ink/build/hooks/use-input.js:67-68` | ✅ `input==='p'` 成立；`Shift+Tab` 那半**必须**用 `key.tab&&key.shift`（**R-12**） |
| 全量测试 | `npx vitest run`（`packages/cli`） | ✅ **157 文件 / 2242 通过 / 5 跳过 / 0 失败**（53.5 s） |
| 类型 | `npx tsc -p tsconfig.json --noEmit` | ✅ 退出码 0 |
| 三个直接相关测试文件单跑 | `vitest run win-vt-force / stdin-mouse-filter / app` | ✅ 78 条全过 |
| C1 调用点顺序（本方案的全部机制） | 读 `cli.tsx:437-499` + `:564-565` | ✅ `setRawMode(true)` → `forceWindowsVtInput()` → `render()`，与 §3.3b 要求一致 |
| `wrong_console` 守卫 | 读 `win-vt-force.ts:200-216` | ✅ 正向位掩码（R-3），非魔数 |
| 短路省成本 | 读 `cli.tsx:565` + `win-vt-input.ts` | ✅ 非 win32 / 新 Node **一次都不 spawn** |
| **内联模式的提示条** | 读 `App.tsx:1849-1881` | ❌ **该路径根本没有 hint 行**（**R-13①**） |
| **`/plan` 的回显通道** | 读 `commands/builtins.ts:283-298` | ❌ 裸 `/plan` **不 notify**，R-7 假设的落点不存在（**R-13②**） |
| `doctor` 仍用版本预测 | 读 `doctor.ts:95-112` | ⚠️ **设计正确但零注释**，且极易被误「修」（**R-14**） |
| helper 的部署面 | 读 `win-vt-force.ts:240-246` | ⚠️ `-EncodedCommand` + `Add-Type` 是 EDR 高频形状（**R-15**） |

### V-1 根因证据链：**成立**，可以据此修复

判定依据不是「文章写得细」，而是三条各自独立、且都可被推翻却没被推翻的东西：

1. **E1 是真正的单变量对照**（§3.2）。同一进程、同一 Node、同一控制台、同一段注入代码，
   唯一变量是 `0x0200` 那一位，输出从 `09` 变成 `1b 5b 5a`。这不是相关性论证。
2. **E4 把方案的前提也测了**（§3.3b）。C1 的落地顺序依赖「重复置同一 raw 模式是 no-op」，
   原文本来只有 libuv 源码推断；补测之后它是测量结果。**没有这一条，C1 会在所有机器上静默失效**。
3. **E3 的备用键位是实测而非挑选**（§3.6）。其中 `Ctrl+Tab` 也塌缩成 `09` 这一条，
   是靠推理绝对得不到、而靠直觉几乎必然选错的（它是最像的替代键）。

我另外主动找过的替代解释，逐条已被排除：`mouseFilter` 切碎 `CSI Z`（§3.8，走 `{kind:'none'}` 透传）、
ink 不认 `[Z`（本轮直调复现）、浮层/运行中吞键（R-8，属产品行为）。
**§3.9 的三种情况仍未被排除，但它们已被诚实标注，且 §6 的排序正是按「C2 对三种都免疫」来定的**——
这恰恰是把未闭合的不确定性转成了设计约束，而不是掩盖。

**唯一仍未闭合的是 §8.5：整套实现从未在一台真正受影响的 Node 上端到端跑过。**
这是**验收缺口，不是证据缺口**——根因由 §3.2 的字节级对照独立支撑，不依赖端到端。V-4 处理它。

### V-2 已落地实现：**接受（Accept），不建议返工**

C1·M1 / C2 / C3① / C3② 与 6 项测试全部落地，两处**优于**清单（正向位掩码取代魔数比较；
对生成脚本断言 `[uint32]0x8…` 陷阱）。我逐条核对了 §8.1 的表，**没有发现夸大**：
每一项都能在源码里定位，且 V-0 的测试与类型检查独立复现了 §8.3 的数字。

**明确给下游修复节点的指令：不要重写这批代码。** 它已经吸收了本文档 R-1..R-11 的评审意见，
特别是三个「删了会静默作恶」的点（`windowsHide:false`、`CONIN$` 而非 `GetStdHandle`、
十进制而非 `[uint32]0xC0000000`）都带着解释性注释。重写只会把它们重新引入。

### V-3 最终推荐修复（**唯一一项**）

> **关闭 G1：把 `Ctrl+P` 写进启动 notice 的两条分支，并把该 notice 的一次性闸门从
> 「布尔 seen」换成「版本号 seen」——`vtInputNoticeSeen: boolean` → `vtInputNoticeVersion: number`，
> 当 `stored < VT_INPUT_NOTICE_VERSION` 时展示一次，展示后写入当前版本号；
> 全程**不得** bump `UI_STATE_SCHEMA`。**

**为什么是它（D-1）**：这是 §6.1 八项里唯一没落地的一项，而它恰好是**唯一一条主动推送给受影响用户的通道**。
其余通道在 R-13 之后已被证明覆盖不全：

- 底部提示条：**内联模式压根没有这一行**；全屏模式下还有 `showHint`（矮窗口）与 `hints:false` 两个开关。
- `/help`：不可抑制，但**要求用户主动去敲**——而这个用户此刻的心智状态是「按了键没反应」，不是「我去查帮助」。
- `/plan` 回显：R-13② 已证明**不存在**。

于是在内联模式下，一台 C1 失败的机器**只剩 `/help` 一条需要用户主动发起的路**。
而 notice 是 `warn` 级、**恰好只在受影响机器上触发**、**恰好在用户第一次启动时糊到脸上**——
它是信噪比最高的那条通道，今天却装着一条**只推荐 `/plan`、从不提本轮真正修复的 `Ctrl+P`** 的旧文案。

**为什么必须动闸门而不是只改文案（D-2）**：本轮的目标人群 = 第 1 轮就受影响、已经启动过、
`vtInputNoticeSeen` 早已落盘为 `true` 的那批人。只改文案 ⇒ 他们**永远不会再看到这条 notice**，
修复对唯一需要它的人群静默失效。**这正是第 1 轮提交信息里自己写下并谴责过的失败模式**
（`ui-state.ts:55-60` 的注释至今还留着那段话：「Folding the two would make the fix inert for its
entire audience, in silence.」）。第 1 轮当时的解法是**新开一个键**；本轮同一个坑换了一层，
解法相应地是**给键加上版本维度**。

**硬约束（D-3，删了会静默作恶）**：**不得 bump `UI_STATE_SCHEMA`。**
`ui-state.ts:95` —— `if (parsed.schema !== UI_STATE_SCHEMA) return { ...DEFAULT_UI_STATE };`
整个对象回落默认值 ⇒ 会**清空所有人的 `submitCount`**（提示条渐隐进度全丢）
并**把鼠标 notice 再放一遍**。`ui-state.ts:61-65` 的既有注释已经把这条写死了，本轮只是复述。
新增字段是安全的，因为 `readFromDisk`（`:97-106`）是**逐字段显式构造**：
旧文件里多出来的键被忽略，缺失的键取默认值——这正是第 1 轮加 `vtInputNoticeSeen` 时走的同一条路。

**迁移矩阵（D-4，必须三类都对）**：

| 用户 | 盘上状态 | 新判据 `stored(0) < CURRENT(1)` | 结果 |
|---|---|---|---|
| 第 1 轮受影响、已看过旧 notice（**目标人群**） | `vtInputNoticeSeen:true`，无新字段 ⇒ `stored=0` | 真 | ✅ **恰好重放一次**，且带 `Ctrl+P` |
| 全新用户 | 无 state 文件 ⇒ `stored=0` | 真 | ✅ 出现一次，带 `Ctrl+P` |
| 已看过**新** notice 的用户 | `vtInputNoticeVersion:1` | 假 | ✅ 从此沉默，不刷屏 |

关键性质：**「文案变更本身」成为重放条件**，覆盖面精确等于「还没见过这版文案的人」，
既满足 §6.1 第 4 项「不要简单删掉一次性」（否则每次启动刷屏），又不需要发明日期/大版本这类外部时钟。

**文案要求（D-5）**：`vtInputDeadNotice()` 的**两条分支都要改**（`:86-102`）。
`Ctrl+P` 与渲染模式无关，而内联分支的读者恰恰是 R-13 里通道最少的那批人。
措辞上把 `MODE_TOGGLE_KEYS.fallback` 放在 `/plan` **之前**（它是一次按键，`/plan` 是四次击键 + 回车），
并保留既有的「Node 22.17.0+ / 24.2.0+ 可根治」一句。
**必须引用 `MODE_TOGGLE_KEYS.fallback` 常量而非硬编码字符串**——`agent-mode.ts:68` 已经是单一真相源，
`doctor` / `Composer` / `App` / `HelpOverlay` 四处都在引它，notice 是最后一个还没接上的消费者。

**测试要求（D-6）**：`vtInputDeadNotice` 已经为其测试导出（源码注释说明了原因：
transcript 换行会让 `lastFrame()` 断言不可靠）。补两条：① 两条分支都含 fallback 键；
② 版本闸门的三行迁移矩阵各一条（`stored=0` 展示、展示后写 `1`、`stored=1` 不展示）。

**回归面（D-7）**：本修复**不触碰** C1/C2 的任何机制，只动 notice 文案与一个持久化字段，
因此不可能回归 V-0 那 2242 条。风险集中在 `ui-state.ts`，而该文件的读路径是逐字段容错的。

**被否决的三个替代方案**：

| 替代 | 否决理由 |
|---|---|
| 只改文案、保留布尔闸门 | 对**目标人群零效果**（盘上已是 `true`）。见 D-2。 |
| 直接删掉一次性语义 | 每次启动刷屏；§6.1 第 4 项已明令禁止。 |
| 什么都不做，靠提示条 + `/help` 兜住 | 被 **R-13 证伪**：内联模式无提示条，`/plan` 通道不存在，只剩需用户主动发起的 `/help`。 |

### V-4 验收门（这不是代码改动，但没有它就不能声称修复）

沿用 §8.5 的脚本，并按 R-13 **增加一条**：

1. 取一份受影响的 Node（18.x / 20.x / 22.0–22.16 / 23.x / 24.0–24.1）跑本轮构建的 CLI。
2. **全屏**：按 `Shift+Tab` → 期望切模式（C1 生效）；按 `Ctrl+P` → 期望同样切换（C2 生效）。
3. **内联**（新增）：同样两个键各按一次——这是提示条不存在的那条路径，必须单独走。
4. 退出后回采控制台模式 → 期望 VT-input 位已还原（§3.5b）。
5. 把 `state.json` 的 `vtInputNoticeVersion` 改回 `0`（或删掉该键）重启 → 期望 notice 重放一次并带 `Ctrl+P`。

判读：**第 2/3 步里 `Shift+Tab` 失败而 `Ctrl+P` 成功 ⇒ 不是回归**，是 §3.9 三种失效方式之一，
正是 C2 设计来兜住的那一档；**`Ctrl+P` 也失败才是需要新一轮定位的信号。**

### V-5 明确排除在本轮之外的事项（列出来是为了它们不被顺手做掉）

| 事项 | 出处 | 处置 |
|---|---|---|
| 给 `checkVtInput()` 补「为什么 doctor 必须继续用预测」的注释 | R-14 | **可选**，注释级，不改行为 |
| 清理 `input === 'P'` 死支 | R-12 | **可选**，无害 |
| `-EncodedCommand` → `-Command` 以降低 EDR 面 | R-15 | **不做**，属 C1 调优，非「所有 PC 能用」的必要路径 |
| 滚轮 | §7.1 / §8.4-3 | **不做**，且 **changelog 不得声称修复了滚轮**——本轮无任何滚轮证据 |
| C1·M2（原生 addon） | §5 | 后续升级路径，触发条件是「需要高频重新施加」 |
| 提交这批改动 | — | 本节点与修复节点均**不 `git commit`**（任务约束） |

**一句话交付**：根因证据链成立、已落地实现予以接受；**本轮唯一推荐的修复是关闭 G1 ——
带版本号的启动 notice + 两条分支都写上 `Ctrl+P`，且不得 bump `UI_STATE_SCHEMA`**；
完成后按 V-4 在一台真正受影响的 Node 上端到端验收，其中内联模式必须单独走一遍。
