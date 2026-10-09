# 上下文压缩 v2 实施验收记录

日期：2026-10-08。环境：Windows 10.0.26200、PowerShell、Node v22.18.0、x64、Intel Core Ultra 5 125H。

## 自动化结果

定向测试已经覆盖严格阈值、usage 前缀与环境失效、三代结构化记忆、来源和身份凭据、失败保留、操作取消、真实 App 输入排队、保存恢复、child verdict 与实际卡片展开。

以下为本任务实现完成、另一项布局任务改写公共接口之前的完整验证快照，不代表持续变化的共享工作区：

| 命令 | 已完成结果 |
| --- | --- |
| `npm test` | CLI：244 个文件，3,672 项通过、6 项跳过；Core：32 个文件，549 项通过；退出码 0 |
| `npm run typecheck` | CLI 与 Core 的生产代码、测试类型检查通过；退出码 0 |
| `npm run build` | CLI 与 Core 构建通过；退出码 0 |
| `node packages/cli/dist/cli.js --version` | 启动成功，输出 0.6.14；退出码 0 |
| `git -c core.safecrlf=false diff --check -- .` | 通过；退出码 0 |

该轮全量日志为 `.agentmesh/compaction-verified-test.log`。随后新增请求版本失效及窗口元数据保留样本的回归，`context-meter.test.ts` 的 22 项测试通过。

### 最终排版与并行工作区复验

- 8 个记忆相关模块格式整理后，100 列与 60 行函数检查通过；34 项纯模块测试及独立严格类型检查通过，提示文案与序列化输出保持一致。
- 排版后的压缩专项复验：11 个文件、154 项测试通过，退出码 0；日志 `.agentmesh/compaction-postformat-targeted.log`。
- 本任务 62 个文件范围的 `git diff --check` 通过。
- 另一任务 `tui-stable-composer-status` 此时处于实施中，正在改写 AppShell、budget、Header、BottomStatusRow、StatusBar、弹层及相应测试。共享工作区最新 typecheck/build 因这些接口接线尚未一致而失败；日志为 `.agentmesh/compaction-postformat-typecheck.log` 与 `.agentmesh/compaction-postformat-build.log`。未将此前通过的结果当作这一时刻的通过结果。
- 同期再次运行 `npm test`，CLI 为 213 个文件通过、35 个失败，3,454 项通过、190 项失败、21 项跳过；Core 32 个文件、549 项通过；整体退出码 1。日志 `.agentmesh/compaction-postformat-test.log`。失败包含挂载真实 App/StatusBar 的压缩 UI 测试，不能仅凭专项测试宣称当前集成通过。
- 未回退或代替另一任务的接口迁移。下游合并审查需在布局实现稳定后重新运行全量检查，尤其核对共同修改的 App.tsx 中压缩忙碌、排队、取消及费用接线。

验收条目与主要自动化入口对应如下，文件均位于 `packages/cli/src/__tests__/`，Core 入口另注明：

| 条目 | 主要测试文件 |
| --- | --- |
| AC-01～05 | compaction-pressure、compaction-e2e、compaction-quiet-noop；Core compaction-loop |
| AC-06～08、28 | compaction-config、compaction-wiring、compaction-compactor、compaction-busy-ui |
| AC-09～11、25、29 | context-meter、context-gauge-wiring；Core compaction-loop |
| AC-12～16、27、31～32、37 | compaction-memory、compaction-memory-input、compaction-memory-identity、compaction-digest、compaction-compactor |
| AC-17～20、33～36、38 | compaction-operation、compaction-compactor、compaction-busy-ui、compaction-e2e；Core compaction-loop |
| AC-21～22、26、30 | compaction-session-roundtrip、session-validation、compaction-archive、exec-runner |
| AC-23～24 | compaction-child、compaction-render、app、exec-text-parity |

性能采用相同机器的确定性数据：

| 项目 | 数据与采样 | 实测 |
| --- | --- | --- |
| 稳定 gate | 1,000 条消息、200,000 字符，已缓存后 100 次 current() | P95 0.0019 ms；消息属性读取 0 次，无全历史遍历 |
| v2 解析及合并 | 32,000 UTF-16 字符 JSON，预热 20 次，采样 100 次 | P95 0.385 ms，小于 20 ms 目标 |

复现命令：`npm run test -w packages/cli -- src/__tests__/context-meter.test.ts src/__tests__/compaction-memory.test.ts --disableConsoleIntercept`。计时为此机器样本，不推断所有机器或真实模型的表现。

## 真实宿主与模型验收

以下项目尚未在可交互的真实终端及付费模型上执行，均为**待验证**，自动化通过不替代这些发布前证据。

| 场景 | Windows Terminal / PowerShell | 传统 Windows console |
| --- | --- | --- |
| 阈值前普通输入、长粘贴跨阈值 | 待验证 | 待验证 |
| 运行中 manual、Esc、取消后输入队列继续 | 待验证 | 待验证 |
| 三次真实模型压缩后的全局目标与任务语义 | 待验证 | 待验证 |
| 保存退出恢复、v1 保守迁移、凭据损坏提示 | 待验证 | 待验证 |
| 80 列及窄窗口展开、焦点与滚动 | 待验证 | 待验证 |

每次人工执行需记录终端名称、Node 版本、窗口来源、threshold、before/after token、applied 和原始错误。当前未宣称真实模型能够无损理解所有工具输出。

## 恢复与回退边界

v2 会话仍使用外层 SavedSession.version=1，凭据与 memory 自带版本。新程序以哈希匹配的前缀恢复代次；无凭据或用户仿造的标签只作原文保护，不据此继承权威。凭据损坏保持历史并拒绝压缩。旧程序无法验证新凭据及 v2 保护账本，降级前应保存独立备份，不承诺降级后继续压缩仍无损。

开发节点交接时未发布、未提交 Git；既有工作区及其他 TUI 人工验收不属于该节点已完成结果。最终审查与提交验收见下文和 `code-review.md`。

本任务文件清单保存在 `.agentmesh/compaction-changed-files.json`；基线哈希为 `.agentmesh/compaction-baseline.json`。工作区含开始前已有的依赖、版本等改动，以及实施期间其他节点的项目指导和布局修改；这些内容均予保留，未纳入本任务实现声明。

## 最终审查验证

最终审查修复原任务摘要参考、取消结算顺序及队列用户轮次初始化，补齐真实 wiring/Core 回归和既有队列测试适配。65 文件独立功能快照的 CLI 3,680 项、Core 549 项测试通过，6 项跳过；typecheck、build、CLI 启动均退出 0。共享工作区最新 typecheck 也退出 0。提交保留原版本，App、README 和压缩呈现测试按功能变更片段隔离，未包含另一布局任务。

最终日志与范围清单为 `.agentmesh/compaction-review-verification.json`、`.agentmesh/compaction-review-files.json`。更详细的逐项覆盖与审查结论见 `code-review.md`；上述真实终端和模型项目仍待验证。
