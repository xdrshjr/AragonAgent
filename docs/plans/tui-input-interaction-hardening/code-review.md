# TUI 输入、复制与 Queue 最终代码审查

日期：2026-10-07。审查基线：`50de29d0c`，规格：同目录 `spec.md` v2。
本节点负责审查、修复及提交；规格中“不提交 Git”仅描述已经结束的设计节点。

## 需求及文件计划核对

| 规格范围 | 实现及审查重点 | 验收入口 |
| --- | --- | --- |
| §3.1、AC-01–07、44 | 单 stdin reader；Enter 有限表、NUL 清除、burst 顺序、EOF 幂等排空 | enter-sequences、stdin-filter |
| §3.2、AC-08–13、39–41 | 局部编辑事务、提交同步接管、拒绝保稿、一次提交及一次 dispatch | composer-input、editor-reducer、prompt-input-commits、App |
| §3.3、AC-14–19、43 | 松开零复制、Ctrl+C 优先消费、退出解除武装、选中文字变更后延迟释放 hold | selection-controller、App |
| §3.4–3.5、AC-20–28、32 | 同步写入历史后发精确 ID 回执；三接收点；reviewer 不能清除用户队列；迟到回执不复活旧 run | steering-acceptance、compaction-loop、queue-lifecycle、reducer |
| §3.6、AC-29–31、42 | 固定一行、宽度统一预算、grapheme 截断、paused 及数量下限、重绘载体 | queue-status-row、TODO/统一滚动布局回归 |
| §3.7、AC-33–37、45–46 | 恢复前边界校验；运行中切换守卫；pending 全文按 ID 补齐；恢复不重放 | session-validation、queue-session、queued-messages、transcript-text、exec/session-store |
| AC-38、发布文件 | 旧 steer 单参数兼容、无新增 runtime export/宿主耦合；CLI 0.6.11/Core 0.2.23 与锁文件一致 | public-api、no-host-coupling、glyphs、包元数据 |

文件计划中的 `limits.ts` 与五个既有弹层无需人为制造 diff：继续复用 newline 帧、
CR 确认路径和既有净化，真实 filter→Ink 挂载测试覆盖兼容行为。实施阶段增加的
测试夹具、日志事件镜像和 store 类型修正均在 spec 的实施缺陷记录中有对应理由。
历史 `tui-input-queue-reliability/spec.md` 是本功能的前序规格，一并保存，当前验收以 v2 为准。

## 终审发现与处置

1. **P1：过滤器拒绝超限粘贴后仍放行同块提交。** 超过单次粘贴上限的 burst 或
   bracketed paste 被丢弃，但紧随其后的 CSI-u Enter 仍转成 CR；编辑器已有草稿时，
   会提交未包含粘贴内容的旧稿。新增过滤器及真实 Ink 挂载回归，先观察失败，
   再将过滤器一次外部输入块的输出缓冲为事务，超限时统一拒绝该块并清理尾部状态。
   普通 Enter 协议、外部接口及后续独立输入保持兼容。最终结果见下方验证记录。
2. **P2：注释和样式。** 修正 persist 中“只验证数组”的过时说明，将 reducer 的类型
   import 放回导入区，避免新边界校验与源码说明矛盾。
3. **P2：历史文件尺寸例外未覆盖本轮基线。** 在 `.claude-index/config.md` 显式记录
   App、controller、reducer、builtins 的基线与接线增量上限；新算法继续独立成小模块。

## 回归风险与验证边界

Core 回执表示进入历史，不能解读为回答完成。强停后有效回执仍按 ID 消费；
未知或重复 ID 为 no-op。未接收消息独立于转录保留环，保存和退出共用全文补齐逻辑。
同内容不同 ID 保持独立，旧存档 queued 降级为全文警告且不自动执行。

超限粘贴修复的原子范围是一次外部 stdin 数据块；此前独立数据块已经交付的输入不回滚。
普通粘贴限额和编辑器混合输入事务的边界分别由对应测试约束，不宣称提供全局输入回滚。

审查另复现一个基线既有问题：工具批次的 turn_end 监听者同时 steering 与 abort 时，
历史可能留下未闭合 tool_call，后续 continue 的 provider 请求会被严格历史验证拒绝。
HEAD 同一路径已有该行为，v2 §3.7 明确排除通用历史修复；本轮回执测试只能证明接收，
不能据此声称任意中断历史均可继续执行。此限制未混入本功能提交的行为修改。

真实 Windows Terminal、CSI-u 宿主、原生选区、SSH/tmux 及实际 40×12 窗口均仍为
**未测**，详见 `manual-test.md`。自动化与代码审查通过不等同这些发布前手测已完成。

## 验证记录

修复前独立执行构建、类型检查、启动检查均通过；第一轮全量 CLI 3349 通过、6 跳过，
Core 482 通过，新增的两条过滤器回归失败，确认了上述 P1。第一轮日志为
`.agentmesh/review-hardening-tests.log`，退出码 1。

代码冻结后重新执行结果：

- `npm run build`：退出码 0。
- `npm run typecheck`：CLI/Core 源码与测试类型检查通过，退出码 0。
- `VITEST_MAX_WORKERS=2` 环境执行 `npm test`：CLI 220 文件、3354 项通过、6 项跳过；
  Core 30 文件、482 项通过；合计 3836 项通过、6 项跳过、0 失败，退出码 0。
- `node packages/cli/dist/cli.js --version`：`0.6.11`。
- 定向输入、粘贴及弹层回归：3 文件、110 项通过。
- `git diff --check`：通过。59 个计划路径存在，63 个功能文件清单与包/锁版本一致。
- 最终日志：`.agentmesh/review-hardening-final-tests.log`；退出码记录：
  `.agentmesh/review-hardening-final-tests.done`（0）。更新器 rollback 文案来自既有故障用例。

历史文件最终行数：App 2676（+29）、controller 2079（+1）、reducer 2084（−7）、
builtins 1398（+13），均在本轮显式例外上限内。

## 终审结论

**代码审查通过，可以提交。** 本轮发现的 1 项 P1 功能缺陷已修复并经红→绿验证，
2 项 P2 注释/规范问题已处理；本功能未解决的 P0/P1 为 0。真实终端手测与上述基线
中断历史限制如实保留，不将代码审查通过等同于完整发布验收。

提交范围为经过逐项核对的 63 个文件：功能源码、回归测试、配套包元数据、规格与
验收文档、尺寸例外配置。逐文件执行 `git add <path>`；已跟踪但父目录受忽略规则
覆盖的配置文件使用 `git add -u -- .claude-index/config.md`。不包含 dist、任务运行文件
或父项目的无关未跟踪文件；正常执行 Git hooks，提交后核对 `git log -1 --stat`。
