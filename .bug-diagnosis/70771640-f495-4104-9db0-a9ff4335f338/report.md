# Bug Diagnosis Session

**Session UUID:** 70771640-f495-4104-9db0-a9ff4335f338
**Date:** 2026-10-08 07:30
**Mode:** Semi-automatic (user asked to fix; diagnosis confirmed in conversation)
**Status:** Fixed (Windows E2E verified; macOS pending manual test)

## Problem Description

输入框中 Shift+Enter 无法换行（消息被直接发送）。用户要求在 Windows 和 macOS 上
都能开箱即用地用 Shift+Enter 换行。

## Evidence Collected

字节级探针（本机 Win11 26200 / Node v22.18.0，注入式复现，见 `repro/`）：

| 模式 | conhost | Windows Terminal 1.24 |
|---|---|---|
| 无 | Shift+Enter=`0d`，与 Enter 逐字节相同（不可区分） | 同左 |
| kitty `CSI > 1 u` | 无效（no-op） | **无效**（`CSI ? u` 查询无回复，ConPTY 吞掉） |
| modifyOtherKeys=2 | 无效（无害 no-op） | — |
| **win32-input-mode `?9001h`** | **生效**：`ESC[vk;sc;char;down;mods;rep_`，Shift+Enter mods=16 | **生效**，格式一致 |

其余实测（win32 模式）：Ctrl+C=`ESC[67;46;3;1;8;1_`、Esc=`ESC[27;1;27;1;0;1_`、
Shift+Tab mods=16、每次按键带 down=1/down=0 两条记录。

基线（无模式）下 Ctrl+Enter=`0a`、Alt+Enter=`1b0d` 本就能换行（现有代码已支持）。

## Root Cause Analysis

**Primary:** 终端默认不为 Shift+Enter 发送可区分的字节（Windows 上与 Enter 同为
`\r`）。应用此前刻意不推送键盘增强模式（spec `tui-shift-enter-copy-queue` §3.7
列为未来工作），因为推送会把修饰键重编码为 Ink 解析器不认识的序列，需要整套反解码
表。本次补齐该表并启用推送。

**Platform facts:**
- Windows: kitty/mok2 推送经 ConPTY 无效；`?9001h` 在 conhost 与 WT 均生效，
  但重编码**所有**按键 → 翻译器必须完备（已以实测字节为 fixture 全覆盖）。
- Windows 老于 Node 22.17/24.2 时 VT 输入位不开，序列到不了进程（复用既有
  `supportsWindowsVtInput` 门控）。
- macOS: kitty/iTerm2/ghostty/wezterm 走 kitty `CSI > 1 u` + `modifyOtherKeys=2`
  （CSI-u，`u` 结尾）；Terminal.app 无任何增强协议，只能 Ctrl+J/Option+Enter。
- `modifyOtherKeys` 只重编码无标准修饰编码的"其他键"；kitty flag-1 同理 ——
  方向键/F 键保持 legacy 编码，因此无需 PUA 功能键表，未知序列透传=现状。

## Fix Applied

**Files modified:**
- `packages/cli/src/input/win32-input-mode.ts` (新增) — `?9001h` 启停 + 记录拆分 + 翻译回 legacy（丢 keyup、修饰位掩码、AltGr 直通、Enter 族→换行帧、vk 功能键表、IME 直通）
- `packages/cli/src/input/csiu-keys.ts` (新增) — kitty/mok CSI-u 拆分 + 翻译
- `packages/cli/src/input/keyboard-enhancement.ts` (新增) — 平台决策 + push/restore 生命周期
- `packages/cli/src/input/stdin-filter.ts` — `enhancedKeys?` 特性 + 三级拆分（win32→CSI-u→Enter 族）+ torn-prefix hold 并入 `keep=max`
- `packages/cli/src/cli.tsx` — 第三个流闸门 + filter 后推送 + restore 并入退出闭包 + RawOpts/flags/config set/keys 清单
- `packages/cli/src/config/{schema,load,env}.ts` — 持久化键 `keyboardEnhancement`（默认 true）+ `ARAGON_KEYBOARD_ENHANCEMENT`
- `packages/cli/src/commands/builtins.ts` — `/terminal-setup` 文案重写
- `packages/cli/README.md` — 键位表与 Terminal setup 章节更新
- `packages/cli/src/__tests__/{win32-input-mode,csiu-keys,keyboard-enhancement,stdin-filter-enhanced-keys,cli-stream-gate,terminal-setup-command}.test.ts(x)` — 130+ 断言，fixture 来自实测字节

## Verification

- 全量 CLI 套件：**258 文件 / 3805 测试通过**；`tsc --noEmit` 干净；dist 重建成功。
- **端到端**（`repro/inject-filter-e2e.ps1`：真实控制台 → `?9001h` → 生产 dist filter）：
  `a`→`61`、Enter→`0d`、**Shift+Enter→`006e`（换行帧，修复目标）**、Ctrl+C→`03`、
  Shift+Tab→`1b5b5a`、Shift+Up→`1b5b313b3241`、Esc→`1b` —— 除 Shift+Enter 外与
  基线逐字节一致。
- 注：`context-command.test.ts` 的失败源自工作区**预先存在**的 model-windows WIP
  （compaction/ 三个文件改动早于本会话，非本次触碰；最终全量跑亦通过）。

## Notes / Manual-test boundary

- Windows：已由注入探针在 conhost 级验证；建议真机 `aragon` 交互确认（WT 与 conhost）。
- macOS：无本地实测条件；iTerm2/kitty/ghostty/WezTerm 走 CSI-u 翻译路径（单测覆盖），
  需真机手测；Terminal.app 只能 Ctrl+J/Option+Enter（物理限制，文档已说明）。
- 逃生门：`aragon config set keyboardEnhancement false`、`--no-keyboard-enhancement`、
  `ARAGON_KEYBOARD_ENHANCEMENT=0`。
