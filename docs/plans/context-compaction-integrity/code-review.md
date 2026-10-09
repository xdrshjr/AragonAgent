# 上下文压缩 v2 最终代码审查

日期：2026-10-08。审查基线：`42d3ced25`。范围为本目录 v2 规范及开发节点交付清单。

## 设计覆盖核对

| 设计条目 | 实现与回归入口 | 审查结论 |
| --- | --- | --- |
| AC-01～05：实际阈值、输出预留、overflow | pressure、compactor、wiring；Core compaction-loop | 自动触发仅比较实际占用比例；overflow 不绕过阈值，低占用保留错误 |
| AC-06～08、28：显式手动及额度 | command、compactor、compaction-config/wiring/quiet-noop | 查询与设置不创建请求；pending 在 run 结束、关闭或换历史后失效 |
| AC-09～11、25、29：统一测量 | meter、controller、child；context-meter/gauge-wiring | 前缀引用、prompt 和请求版本失效；窗口更新保留可用样本；Core 采用后清 usage |
| AC-12～16、27、31～32、37：记忆与来源 | memory、memory-input/validation/identity、digest、summary-prompt | 原始用户内容和旧条目由宿主保留；拒绝伪造来源、非法 JSON、预算超限；图片留在原消息 |
| AC-17～20、33～36、38：取消、采用、连续执行 | operation、summarize-call、wiring、controller、App；compaction-operation/busy-ui/controller-lifecycle | 失败保留原历史；本地取消结束后才交还输入；采用后才结算代次与归档 |
| AC-21～22、26、30：持久化及兼容 | session/persist/store/validate-session、builtins、exec | TUI 与 exec 保存凭据；损坏凭据阻止替换；旧条目字段仍兼容 |
| AC-23～24：子任务与呈现 | child、team/subagent、Transcript、CompactionCard、reducer | 子任务只接受 Core verdict；卡片透传触发证据与 v2 版本；费用按实际摘要调用计价 |

新增模块遵循 CLI-local 边界；没有增加依赖、Core 宿主类型或公共导出。保留独立 tail-budget API，但 CLI 不再调用有损 tail relief。原有 controller/App 大模块只增加必要接线。

## 已修复问题

1. **摘要输入缺少原任务参考。** anchor 留在模型执行历史，却被摘要 head 排除，prior memory 又只保存来源 ID。现将完整原任务文本作为只读参考传入每代摘要请求并计入输入预算。参考不进入 sourceMap 或 coverage，不能成为新用户验收证据；图片仅发送占位描述。回归覆盖全文末尾约束、预算拒绝、图片及实际连续两代摘要请求。
2. **取消后的所有权释放顺序。** 真实 wiring 回归证实控制器外层 abort race 可先返回，而压缩器仍显示 inFlight。修复以本地取消结算为释放边界，确保立即发起下一操作不会继承旧锁，也不会由旧回调结算新操作。
3. **队列恢复遗漏用户轮次初始化。** 压缩期间输入入队后，continue 直接进入 Core，沿用旧轮次的提问额度及辅助功能状态。补齐新用户轮次准备，保留原队列接收凭据，避免重复追加用户消息。
4. **触发规则注释与边界常量。** 更新仍宣称 headroom 自动救援及模型切换保留样本的过时注释；手动说明长度从统一的 instructionsChars 读取。

以上行为问题均先通过回归确认失败，再修复验证；没有以删除旧断言或绕过校验维持通过。

## 提交隔离

同一工作区另有 `tui-stable-composer-status` 布局任务及版本、锁文件改动。通过当前 HEAD 与本功能文件清单构建 `.agentmesh/compaction-review-snapshot`：App.tsx 只取 busy/队列/取消/费用接线，README 只取压缩章节，compaction-render 测试只取本功能新增用例。布局接口、英文状态文案迁移、版本及依赖改动留在原工作区。

验证和提交使用相同快照内容。临时目录、构建产物和 `.agentmesh` 日志不纳入提交。实际命令与结果在下方最终验证记录中登记。

全量验证期间，另一任务继续迁移 app、controller-prompt-boundary、queue-lifecycle 测试的英文文案与 Ctrl+G 详情入口。逐项核对这些后续差异后，提交仍采用已通过验证的测试快照；后续布局适配留在工作区。

## 验收边界

真实 Windows 双宿主交互和付费模型三代语义验收仍待执行；自动化只证明确定性契约及机械保护，不证明模型语义无损。当前节点执行本地审查与提交，不执行发布。共享工作区的并发布局迁移结果与本次提交快照分别报告。

## 最终验证记录

最终固定快照为 65 个功能文件覆盖审查基线。使用工作区已有依赖，并将快照的 `@aragon-agent/core` 指向快照自身构建，避免并发构建清空共享 dist 的干扰。

| 检查 | 实际结果 |
| --- | --- |
| `npm run build -w packages/core` | 退出码 0 |
| `npm run typecheck` | CLI/Core 生产及测试类型检查均通过，退出码 0 |
| `npm test` | CLI 245 文件、3,680 项通过、6 项跳过；Core 32 文件、549 项通过；退出码 0 |
| `npm run build` | 两包构建通过，退出码 0 |
| `node packages/cli/dist/cli.js --version` | 启动通过，退出码 0；使用基线版本，未纳入他人的版本调整 |
| 共享工作区 `npm run typecheck` | 最后复验退出码 0；不据此宣称共享布局全量测试已通过 |

日志：`.agentmesh/compaction-review-verification.json`、`.agentmesh/compaction-review-snapshot-*.log`、`.agentmesh/compaction-review-shared-typecheck-final.log`。初轮快照曾采集到修复中的测试及另一任务的状态文案，第二轮暴露旧测试 Set 断言和新配置缺项；均已处理，表内只记录最终固定快照的实际结果。

结论：本次功能审查通过，发现的问题已修复并回归；允许完成本地功能提交。真实宿主和模型验收仍作为发布前待验项保留。
