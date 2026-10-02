# Repro harness — 第 2 轮

沿用第 1 轮 `../../shift-tab-and-mouse-wheel-dead-on-some-terminals/repro/` 的方法
（`WriteConsoleInput` 注入，消除「我到底有没有按住 Shift」这个变量），新增三件事：

1. 在老 Node 上**由外部把 `ENABLE_VIRTUAL_TERMINAL_INPUT`（0x0200）打开**，看 `Shift+Tab` 会不会活；
2. 让探针**自己 spawn helper**，即真实 CLI 会用的形态，并测量它的耗时；
3. 在**没有** VT 位的老路径上逐个注入候选备用键位，看哪些能穿过去。

全部必须在**真控制台窗口**里跑（探针需要 `stdin.isTTY`）。从 agent shell 直接执行测不到任何东西。

| 文件 | 作用 |
|---|---|
| `probe-vt.mjs` | 探针：raw 模式 + 每个 chunk 带相对时间戳；第 4 个参数 = 在第 N 秒做一次 `setRawMode(false)→(true)` 往返（0 = 不做） |
| `probe-vt2.mjs` | 探针：在第 N 秒自己 spawn helper，记录 spawn→exit 的墙钟耗时 |
| `force-vt-helper.ps1` | helper：`CreateFileW("CONIN$")` → `SetConsoleMode(mode \| 0x0200)`，把 before/after 写进日志 |
| `inject-vt-force.ps1` | **E1**：基线注入 → 外部强开 → 再注入 → 探针切 raw 模式 → 再注入 |
| `inject-e2.ps1` | **E2**：生产形态（helper 由探针拉起） |
| `inject-fallback-keys.ps1` | **E3**：备用键位实测（`Ctrl+P` / `Ctrl+B` / `Alt+M` / `F2` / `Ctrl+Tab`） |

## 跑

```powershell
$dir = 'M:\takoAI\JRAgentMesh\aragon-agent-core\docs\diagnoses\shift-tab-mode-toggle-still-dead-on-windows\repro'
# 老 Node：https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip 解压即可，不用安装
$n20 = '<...>\node-v20.19.0-win-x64\node.exe'

Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File',"$dir\inject-vt-force.ps1",'-NodeExe',$n20,'-Tag','node20vt' -Wait
Get-Content "$dir\probe-out-node20vt.jsonl"
Get-Content "$dir\inject-log-node20vt.txt"
```

`inject-e2.ps1` / `inject-fallback-keys.ps1` 同样的调用形状，换 `-Tag` 即可。

## 该看什么

**E1** —— 一次运行里应当出现**三条** data 行，依次是 `09` → `1b5b5a` → `09`：
强开之前是裸 Tab，强开之后是 `\x1b[Z`，探针自己切一次 raw 模式之后又变回裸 Tab。
第三条就是「libuv 会把我们改的位冲掉」的证据，也是修复必须做**重新施加**的原因。

**E2** —— helper 日志里的 `before=` 是唯一能识破 §3.5 那个陷阱的字段：

- `before=0x0008` ⇒ helper 作用在**正确**的控制台上（那是 libuv 设的 raw 模式）；
- `before=0x01F7` ⇒ helper 拿到的是**另一个**控制台（`windowsHide: true` ⇒ `CREATE_NO_WINDOW`
  给子进程分配了新控制台）。这种情况下 `SetConsoleMode` 依然返回 `True`、退出码依然是 0，
  而 CLI 侧什么都不会变。`probe-out-e2n20.*` 就是这个失败形态的留档。

**E3** —— 只有在**没有** VT 位（`mode_during=0x0008`）的前提下测出来的键位才算数。
本次结果：`Ctrl+P`→`10` ✅、`Ctrl+B`→`02` ✅、`F2`→`1b5b5b42` ✅、`Alt+M`→无数据 ❌、
**`Ctrl+Tab`→`09` ❌**（与 `Shift+Tab` 死在同一处，是最容易被误选的候选）。

## 已知坑

- PowerShell 5.1 把 `0x80000000` 解析成**有符号 Int32**，`[uint32]` 转换会抛
  `Value was either too large or too small for a UInt32`。`force-vt-helper.ps1` 里的
  `GENERIC_READ` / `GENERIC_WRITE` 因此写成十进制字面量。
  （第 1 轮的滚轮脚本在 `0xFF880000` 上踩过同一个坑。）
- 签入的 `.jsonl` / `.txt` 是 2026-08-10 在 Windows 11 26200 上的实跑输出，未经编辑，
  被 `../analysis.md` 附录 A 逐行引用。
- `node20/` 运行时与第三方源码**不签入**；`../analysis.md` 附录 B 给了出处与行号，可自行取回。
