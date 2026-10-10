# Bug Diagnosis Session

**Session UUID:** ctrl-i-dead
**Date:** 2026-10-09 11:50 (America/New_York)
**Mode:** Fully automatic
**Status:** Fixed (needs on-terminal verification)

## Problem Description

用户报告：项目最近的修改（commit a1ca2297f, cli 0.6.17→0.6.18）添加了 Ctrl+I 触发
project index 功能，但现在按 Ctrl+I 没有任何反应（无确认框、无警告）。

## Evidence Collected

- App 侧链路完好：`packages/cli/src/__tests__/index-key.test.tsx` 5/5 通过，
  harness（terminal-harness.tsx）走 Ink 真实输入解析，`INDEX_KEY_FRAME`('\x00i')
  能打开确认框。
- 用户运行的是全局安装 `@aragon-agent/cli@0.6.18`（npm 安装，非 link），
  dist 里包含全部 Ctrl+I 代码（INDEX_KEY_FRAME 出现在 6 个文件，index-build.ts 已打包）。
- 门控满足：`config.keyboardEnhancement` 默认 true（用户 config 未覆盖），
  Node v22.18.0 ≥ 22.17 → `vtInputSupported` true；日志今日无 `stdin_filter_failed`。
- 本会话进程树：powershell.exe -NoExit → node(aragon 0.6.18)；`WT_SESSION` 未设置
  （非 Windows Terminal 托管，传统 conhost 类控制台）。
- 项目自己的字节级探针
  `docs/diagnoses/shift-enter-newline-dead-by-default/repro/probe-out-win32.jsonl`
  显示 Ctrl+字母 组合的记录形状是 **vk=字母**：
  - Ctrl+A → `ESC[65;30;1;1;8;1_`；Ctrl+J → `ESC[74;36;10;1;8;1_`
  - Tab → `ESC[9;15;9;1;0;1_`；Shift+Tab → mods=16
  - **没有采集过 Ctrl+I**（代码里的 vk=9+ctrl 形状是从未被验证的假设）
- 纯函数验证（修复前 dist 的 translateWin32Key）：
  - `rec(9,15,9,ctrl)`（假设形状）→ `INDEX_KEY_FRAME` ✅
  - `rec(73,23,9,ctrl)`（真实形状：vk='I'，char=9）→ `'\t'`（普通 Tab）❌

## Root Cause Analysis

**Root Cause（已确认）:**
`packages/cli/src/input/win32-input-mode.ts` 的 `translateWin32Key` 只在
`record.vk === VK_TAB(0x09) && ctrl` 时返回 `INDEX_KEY_FRAME`（switch 的
`case VK_TAB` 分支）。真实 Windows 控制台（Windows Terminal/ConPTY 与传统
conhost 均是）把物理 Ctrl+I 合成为 **vk=0x49('I')、uChar=0x09、ctrl** 的记录
（与探针中 Ctrl+A=65、Ctrl=74=74 的 Ctrl+字母 规律一致）。该记录走不进
`case VK_TAB`，落入通用 Ctrl-combo 分支（char<0x20），被原样翻译回 0x09
Tab 字节 → Ctrl+I 与 Tab 合流 → 空输入框下表现为"没反应"。
`INDEX_KEY_FRAME` 从不发出，App.tsx 的 `input.includes(INDEX_KEY_FRAME)`
永不成立，也不走任何 warn 路径——纯静默。

单测 `win32-input-mode.test.ts` 原来的 `['Ctrl+I', rec(9,15,9,8)]` 用例锚定了
错误形状，所以测试全绿而真机失效。

**Alternative Possibilities（已排除）:**

1. 键盘增强整体未生效 → 门控全满足；同通道 Shift+Enter 为已验证功能。
2. overlay/tooSmall 守卫吞帧 → 仅特定状态，与"一直没反应"不符。
3. 全局安装版本旧 → 全局 0.6.18 含全部 Ctrl+I 代码。

## Fix Applied

**Files modified:**

- `packages/cli/src/input/win32-input-mode.ts` - 在 char<0x20 的 Ctrl-combo
  分支里新增：`ctrl && record.char === 0x09`（不依赖 vk 是 9 还是 0x49）→
  `INDEX_KEY_FRAME`；shift → `ESC[Z`（与 VK_TAB 分支语义镜像，mode toggle
  不受影响，Ctrl+Shift+I 留在 Shift 分支）。
- `packages/cli/src/__tests__/win32-input-mode.test.ts` - 原 Ctrl+I 用例拆成
  VK_TAB 形状与 letter-vk 形状（`rec(73,23,9,8)`、`rec(73,23,9,24)`）四行，
  注释写明两种真实形状的来源。修复前新增两行确认红（得到 `\t`），修复后绿。
- `packages/cli/CHANGELOG.md` - Unreleased 增补 "### Fixed" 条目。

**原理:** 0x09 既是 Tab 字节也是 VK_TAB 数值；对 Ctrl+I 的判别依据从
"vk 是 VK_TAB 且 ctrl"放宽为"char 是 0x09 且 ctrl"，两种 vk 形状都归一到
INDEX_KEY_FRAME，普通 Tab（无 ctrl）不受影响。

## Verification

- 定向测试：win32-input-mode(44) + stdin-filter-enhanced-keys(15) +
  csiu-keys(48) + index-key(5) + index-build(9) 全绿。
- 全量：`npx vitest run`（packages/cli）263 文件 / 3878 passed / 6 skipped /
  0 failed。
- `npm run build` 成功；对重建后 dist 的 translateWin32Key 验证：
  letter-vk Ctrl+I → frame ✅，VK_TAB 形状 → frame ✅，普通 Tab → '\t' ✅。
- 待用户在真实终端按 Ctrl+I 做最终确认（应弹出 "Build the project index"
  确认框）。

## Notes

- 用户当前运行的全局安装（C:\Users\jdqqj\AppData\Roaming\npm）**不含**修复：
  需要发布 0.6.19 后 `npm i -g @aragon-agent/cli`，或先用仓库
  `npm run dev:cli` 验证（repo dist 已重建）。
- 若想字节级复核记录形状：在真实终端运行
  `docs/diagnoses/shift-enter-newline-dead-by-default/repro/probe-keys.mjs`
  后按 Ctrl+I，应看到 `ESC[73;23;9;1;8;1_`。
- CHANGELOG 里存在两个 "## Unreleased" 段（第 8 行与第 497 行附近），本次
  条目加在了顶部那个；后续可考虑清理重复段。
