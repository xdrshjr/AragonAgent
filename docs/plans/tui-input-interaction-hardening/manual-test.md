# TUI 输入、复制与队列实施验收

日期：2026-10-07。实现基于本目录 v2 规格；未提交 Git。

> 上述为实施节点记录。最终审查、额外修复与提交结果见同目录 `code-review.md`；
> 下方追加的终审验证为最新自动化结果。

## 环境与验证边界

- Windows 10.0.26200，PowerShell 5.1.26100.9444，Node.js v22.18.0。
- CLI 0.6.11，Core 0.2.23，CLI 最低 Core 依赖 `^0.2.23`；锁文件一致。
- 自动化使用 Vitest、真实 Ink 挂载、可控 stdin 和假 provider，不调用付费模型或真实剪贴板。
- 标准构建、类型检查及 `node packages/cli/dist/cli.js --version` 已执行成功；全量结果见下方。
- 宿主是代理命令通道，不能将向 PassThrough 写入字节视为真实终端按键手测。

## 自动化证据

| 行为 | 验证入口 | 状态 |
| --- | --- | --- |
| Shift+Enter 表、任意拆包、NUL、burst、EOF | enter-sequences / stdin-filter | 定向通过 |
| 混合正文、粘贴、换行、提交和尾稿；拒绝保稿 | enter-frames / composer-input / prompt-input-commits / App | 定向通过 |
| 五个弹层 Enter 兼容、字段净化 | overlay-enter-compatibility | 真实 filter→Ink 挂载通过 |
| 选区文字变更、重选、滚轮、watchdog、延迟 hold | selection-controller | 28 项通过 |
| 空载荷/复制失败/退出已武装/服务存在 | App | 定向通过，无真实剪贴板写入 |
| 40/60/80/120 列、102 条消息、Unicode/ASCII | queue-status-row | 11 项通过，单行 cell 预算与重绘通过 |
| 精确回执、压缩 A/B、工具配对、强停迟到事件 | steering-acceptance / compaction-loop / queue-lifecycle / reducer | 定向通过 |
| 保存补全文及顺序、损坏恢复、旧 TUI/exec 兼容 | queued-messages / queue-session / session-validation / exec-session-file / session-store | 定向通过 |
| 超过 200 条未接收全文退出 | transcript-text | 260 条 pending 与普通历史混合通过 |

最终全量结果（冻结代码后重新执行，进程退出码 0）：

- `npm run build`：通过。
- `npm run typecheck`：CLI/Core 源码及测试类型检查通过。
- `VITEST_MAX_WORKERS=2` 下执行标准 `npm test`：CLI 220 文件、3349 项通过、6 项跳过；
  Core 30 文件、482 项通过；合计 3831 项通过、6 项跳过、0 失败。
- `node packages/cli/dist/cli.js --version`：`0.6.11`。
- `git diff --check`：通过；规格表 59 个计划文件存在检查通过。
- 完整测试输出：`.agentmesh/hardening-final-tests.log`；退出码证据：
  `.agentmesh/hardening-final-tests.done`（内容为 0）。日志中的 rollback 失败文案来自
  原有更新器故障回归用例，测试整体通过。

首轮全量记录为 CLI 3343 通过、2 失败、6 跳过，Core 482 通过；两个失败均来自
修复前已加载的隐藏 slash 候选路径。修复后保留原断言，重新执行上述完整测试确认通过。
两轮独立规格及质量评审已通过；关闭提示历史时的命令恢复、动态技能 starting 拒绝、
AC39 合并输入及 AC40 弹层矩阵的评审发现均已补测试与修复。

## 真实终端手测清单

以下项本节点均为**未测**，发布前仍需在具备对应终端的环境执行并附证据。

| 环境 | 配置与步骤 | 预期证据 | 本次结果 |
| --- | --- | --- | --- |
| Windows Terminal / PowerShell | 记录终端版本，在现有 actions 合并 Shift+Enter sendInput `\u001b[13;2u`；在行首/中/尾按键，再普通 Enter | 输入字节与画面；每次只换一行，普通 Enter 提交 | 未测 |
| 支持 CSI-u 的终端 | 记录版本和按键绑定；测试 `13u`、`13;1u`、`13;2u`，并打开五个弹层 | 无修饰 Enter 原行为；Shift+Enter 不确认弹层 | 未测 |
| 应用鼠标选区与宿主原生选区 | 应用拖选松开后观察剪贴板；再 Ctrl+C；以 `--no-mouse` 对照宿主设置 | 应用 release 零复制，Ctrl+C 复制且不退出；原生行为归终端设置 | 未测 |
| SSH / tmux | 记录 SSH 客户端、终端、tmux 版本与 OSC 52 允许配置，复制已选文字 | 核对实际剪贴板全文；应用“发送成功”不等同剪贴板确认 | 未测 |
| 40×12 实际窗口 | Agent 运行时连续发相同文本，滚动、暂停、切换 overlay，再继续 | 固定 Queue 与数量持续可见，只对应回执移除，无闪烁/多余行 | 未测 |

## 文件计划核对

输入、选区、App/状态栏、Core 回执、controller/reducer、会话保存恢复、帮助与发布说明均已
接续实现。原 `limits.ts` 的 newline 帧保持；三个文字弹层现有组合净化满足新协议，
ConfirmDialog 与 ModelPicker 维持原 Enter 行为，故这些条目允许零 diff 并由挂载测试覆盖。
Core 既有 helper、事件类型和队列实现通过回归保留；包版本保持前序选定版本。
新增范围仅为 spec 的“实施过程发现的方案缺陷”列出的类型镜像和测试夹具兼容修改。

## 已知限制与排障

- Shift+Enter 与 Enter 若都编码为 CR，应用无法区分，需独立绑定或 Ctrl+J/Alt+Enter。
- 拆分序列只承诺下一块在 12 ms 前到达；超时有界降级。
- 内存队列不提供进程崩溃恢复；旧 queued 恢复为全文警告，不自动重发。
- 首轮并行 Node/Vitest 出现本机内存/线程不足，定向及第一轮全量限制为单 worker；
  子任务结束后最终全量仅使用两个 worker，通过全部回归。
- 根 workspace 构建次序先 CLI 后 Core；公共类型改变时先生成 Core 后再运行根构建。

## 终审追加验证

终审修复了超限粘贴被过滤器丢弃后，同块 Enter 仍可能误提交旧稿的问题，
并保护拒绝块尾部未闭合 bracketed paste 的后续消费。新增 5 项回归，
其中过滤器用例先失败、修复后通过；真实 filter→Ink 挂载验证旧稿保留与后续输入。

- 最终构建、CLI/Core 类型检查、CLI 启动 `0.6.11` 均通过。
- 最终标准 `npm test`（环境变量 `VITEST_MAX_WORKERS=2`）：CLI 3354 通过、6 跳过；
  Core 482 通过；总计 3836 通过、0 失败，进程退出码 0。
- 输入及弹层定向测试 3 文件、110 项通过。
- 最新日志和退出码：`.agentmesh/review-hardening-final-tests.log`、
  `.agentmesh/review-hardening-final-tests.done`。
- 本追加验证仍未进行真实宿主终端、SSH/tmux 或系统剪贴板手测。
