# 输入框 Shift+Enter 无法换行：终端不为修饰回车发送可区分的编码 —— 应用改为主动推送键盘增强模式并整体反解码

**Bug slug**: `shift-enter-newline-dead-by-default`
**日期**: 2026-10-08
**代码基线**: `M:/takoAI/JRAgentMesh/aragon-agent-core` @ `d2251ba4e` 之后
**会话报告**: `.bug-diagnosis/70771640-f495-4104-9db0-a9ff4335f338/report.md`

## 0. 结论一句话

> Shift+Enter 换行依赖终端发送 CSI-u（`\x1b[13;2u`）等独立序列，而默认没有任何主流
> 终端这样做（Windows 上与 Enter 逐字节相同，都是 `\r`）。原设计刻意"只读"
> （`tui-shift-enter-copy-queue` spec §3.7 列为未来工作），因为推送增强模式会把修饰键
> 重编码为 Ink 不认识的序列。本次补齐了"整套反解码表"并启用推送：
> **Windows 推 `?9001h`（win32-input-mode，conhost/WT 通吃），macOS/Linux 推 kitty
> disambiguate + `modifyOtherKeys=2`**，翻译层把新编码还原为传统字节，Ink 无感。

## 1. 字节级实证（repro/ 注入探针，Node v22.18.0，Win11 26200）

| 模式 | conhost | Windows Terminal 1.24 |
|---|---|---|
| 无 | Shift+Enter=`0d`（与 Enter 相同） | 同左 |
| kitty `CSI > 1 u` | 无效 no-op | **无效**：`CSI ? u` 查询无回复（ConPTY 吞掉） |
| `modifyOtherKeys=2` | 无效 no-op | — |
| **win32-input-mode `?9001h`** | **生效** | **生效** |

win32-input-mode 实测格式：`ESC [ vk ; scan ; char ; keyDown ; mods ; repeat _`
（每次按键 down/up 两条；`mods` 携带 `SHIFT_PRESSED=0x10` 等）。基线下
Ctrl+Enter=`0a`、Alt+Enter=`1b0d` 本就换行；唯 Shift+Enter 不可区分。

关键推理（决定翻译表范围）：`modifyOtherKeys` 顾名思义只重编码**没有**标准修饰编码的
"其他键"；kitty flag-1（disambiguate）同理。方向键/Home/End/PgUp/F 键的
`\x1b[1;mA` / `\x1b[m~` 标准编码保持 legacy，因此**无需 kitty PUA 功能键表**，
未知序列透传即等于现状。

## 2. 修复内容

| 文件 | 改动 |
|---|---|
| `input/win32-input-mode.ts` | 新增：`?9001h` 启停 + 记录拆分 + 翻译回 legacy（丢 keyup、修饰位掩码过滤 lock/enhanced 位、AltGr 直通、Enter 族→换行帧、vk 功能键表、IME/VK_PACKET 文本直通） |
| `input/csiu-keys.ts` | 新增：kitty/mok CSI-u 拆分 + 翻译（Enter/Esc/Tab/Backspace/字母 Ctrl/Alt、`:shifted` 备用键；PUA 码透传=现状） |
| `input/keyboard-enhancement.ts` | 新增：平台决策 + push/restore 生命周期（幂等、非 TTY no-op） |
| `input/stdin-filter.ts` | `enhancedKeys?` 特性（默认 false=旧行为逐字节不变）；`handleOutsidePaste` 三级拆分（win32→CSI-u→Enter 族）；torn-prefix hold 并入 `keep = max(...)` |
| `cli.tsx` | 第三个流闸门 `wantEnhancedKeys`（win32 复用 `vtInputSupported` 测量）；filter 之后、render 之前推送；restore 并入四条退出路径汇聚的闭包（先于 alt-screen 恢复） |
| `config/{schema,load,env}` + flags | 持久化键 `keyboardEnhancement`（默认 true）+ `--no-keyboard-enhancement` + `ARAGON_KEYBOARD_ENHANCEMENT=0` + `config set` |
| `commands/builtins.ts` | `/terminal-setup` 文案改为"应用已主动推送 + 例外终端的绑定建议 + 逃生门" |
| `README.md` | 键位表与 Terminal setup 章节更新 |

## 3. 验证

- 单测（实测字节为 fixture）：`win32-input-mode.test.ts`、`csiu-keys.test.ts`、
  `keyboard-enhancement.test.ts`、`stdin-filter-enhanced-keys.test.ts`。
- 回归钉子：`cli-stream-gate.test.ts` 的 `filter !== null` 计数 3→4（新能力门同型扩展）。
- 全量：CLI 258 文件 / 3805 测试通过；`tsc --noEmit` 干净。
- **端到端**（`repro/inject-filter-e2e.ps1`，真实控制台 → `?9001h` → 生产 dist filter）：
  `a`→`61`、Enter→`0d`、**Shift+Enter→`006e`（换行帧）**、Ctrl+C→`03`、
  Shift+Tab→`1b5b5a`、Shift+Up→`1b5b313b3241`、Esc→`1b` —— 除 Shift+Enter 外与基线逐字节一致。

## 4. 边界（未覆盖，需手测或不可修）

- macOS 无本地实测：kitty/iTerm2/ghostty/WezTerm 走 CSI-u 翻译路径（单测覆盖编码格式），
  真机行为待手测；Terminal.app 物理上不可区分 Shift+Enter，Ctrl+J/Option+Enter 兜底。
- 老 Node（<22.17/<24.2）Windows：VT 输入位不开，推送被门控跳过，行为与现状一致。
- tmux 内推送预计被多路复用器消化（无效但无害）。
- kitty PUA 功能键码仅在 flags 2+ 出现，本应用不推送；透传=既有行为。
