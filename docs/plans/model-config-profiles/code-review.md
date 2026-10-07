# 多套模型配置：最终代码审查

日期：2026-10-07。审查范围为 v2 设计第 7 节的 36 个目标文件，以及设计文档本身。逐项检查实现覆盖、相邻功能回归、命名、注释及提交边界。未引入新依赖，Core 源码和公共 API 未变。

## 已修复问题

| 编号 | 级别 | 触发条件与影响 | 修复及验证 |
| --- | --- | --- | --- |
| CR-01 | P1 | 磁盘主地址为默认地址，启动参数将主地址覆盖为网关；旧命令修改使用默认地址的快方案，解绑后意外继承主网关。 | 隐式解绑同时校验磁盘与最终 live 目标；不能无损表达则在写盘前拒绝。回归断言 live 对象与磁盘字节不变。 |
| CR-02 | P1 | 设置草稿明确切回 Current custom 并更改服务商；显式配置库分支跳过适配，遗留旧厂商地址。 | 显式草稿仍经过适配入口，仅对最终未绑定角色清理未明确输入的旧地址。回归覆盖主、快两角色。 |
| CR-03 | P1 | 关键设置快照应用失败后，prompt 已阻断，但 `/compact` 可绕过该阻断发出请求。 | 手动压缩入口复用故障阻断标志，返回固定重启原因；回归验证不调用压缩请求入口。 |

三条回归均先复现失败，再验证修复通过。没有遗留本次发现的待修复问题。

## 设计覆盖核对

下表路径相对 `packages/cli/`，标明根目录的除外；每个计划目标均核对了实际文件和对应差异。

| 目标 | 审查结果 |
| --- | --- |
| `src/config/model-profiles.ts` | 稳定 ID、名称默认值、复制截断、引用和凭据校验、输出字段白名单齐全。 |
| `src/config/model-profile-resolution.ts` | 启动投影、覆盖标记、主快角色凭据及地址作用域统一解析。 |
| `src/config/model-profile-store.ts` | 严格读取、原文 revision、原子提交、无损旧命令适配齐全；补 CR-01/02。 |
| `src/config/schema.ts` | 持久化和运行时字段可选，保留旧配置兼容性。 |
| `src/config/store.ts` | 数组完整替换、坏段保留、严格写入及临时文件清理覆盖。 |
| `src/config/load.ts` | flags/env 优先级、配置投影和安全错误提示接入。 |
| `src/config/cli-commands.ts` | 短密钥固定掩码、无效段整体隐藏、编辑解析错误无原始片段。 |
| `src/cli.tsx` | 连接 set 错误退出码区分校验与 I/O；仅成功输出 Set。 |
| `src/logging/secret-registry.ts` | 容错注册所有方案凭据，不依赖有效 schema。 |
| `src/logging/install.ts` | 启动早期注册已保存方案密钥。 |
| `src/agent/model-profile-settings.ts` | busy/revision/hash 守卫、预构建、一次保存、提交后结果分流；补 CR-01/02。 |
| `src/agent/controller.ts` | 角色解析、统一应用和设置 revision 接入；补 CR-03。 |
| `src/fast/resolve.ts` | 方案默认地址不继承主网关；缺钥检查使用 fast 角色。 |
| `src/fast/wiring.ts` | 实际 tier 角色传播，review 使用 fast 密钥；策略与预算保留。 |
| `src/team/runtime.ts` | 角色参数沿依赖接口传递。 |
| `src/team/subagent.ts` | 子任务使用实际解析角色，回退主角色时不沿用快密钥。 |
| `src/compaction/compactor.ts` | 同名模型也按完整 ref/role 切换回退目标，每次请求绑定自身凭据。 |
| `src/compaction/wiring.ts` | 角色化依赖与启用状态通知接入。 |
| `src/compaction/child.ts` | 显式覆盖子任务地址，保留实际角色，快候选从 lead 解析。 |
| `src/ui/overlays/model-profile-state.ts` | 子草稿、keep/replace/shared、显式保留、复制、删除和取消状态齐全。 |
| `src/ui/overlays/ModelProfilePicker.tsx` | 选择、管理动作、搜索、角色标签、宽字符裁剪及焦点滚动齐全。 |
| `src/ui/overlays/ModelProfileEditor.tsx` | 独立输入所有者、密钥空输入、地址变更确认与安全帧净化齐全。 |
| `src/ui/overlays/SettingsScreen.tsx` | 普通字段只提交 dirty patch，失败留草稿，已提交失败禁重复保存。 |
| `src/ui/App.tsx` | 保存和模型选择走事务，settings Esc 转交子界面，重启要求阻断发送。 |
| `src/commands/builtins.ts` | `/fast` 连接保存先于成功反馈，reload 更新完整模型状态，resume 使用 busy 守卫。 |
| `src/__tests__/model-profiles.test.ts` | 数据边界、名称、引用和复制覆盖。 |
| `src/__tests__/model-profile-store.test.ts` | 真实文件、冲突、失败、无损转换和配置纯度覆盖。 |
| `src/__tests__/model-profile-resolution.test.ts` | 角色密钥、地址、启动覆盖和旧配置解析覆盖。 |
| `src/__tests__/model-profile-runtime.test.ts` | 真实 controller/请求接线、事务、压缩回退及三条审查回归覆盖。 |
| `src/__tests__/model-profile-settings.test.tsx` | reducer 与真实 Ink 输入、取消、重载确认、搜索和三档尺寸覆盖。 |
| `src/__tests__/model-profile-security.test.ts` | 固定掩码、白名单、坏段与未来版本覆盖。 |
| `src/__tests__/overlay-enter-compatibility.test.tsx` | 编辑器通过真实 stdin filter 验证 Enter 与粘贴帧。 |
| `src/__tests__/max-tokens-ui.test.tsx` | 普通 token 字段 dirty 保存和无效值拒绝覆盖。 |
| `src/__tests__/fast-resolve.test.ts` | 新方案独立默认地址及旧配置继承回归覆盖。 |
| `README.md` | 操作、覆盖、凭据、命令兼容、重启和持久化边界已说明。 |
| 根目录 `docs/plans/model-config-profiles/manual-test.md` | 自动化与人工记录分开，缺少的平台和真实终端验收明确标记未执行。 |

## 验证方法与提交边界

共享工作区还存在队列、输入框、剪贴板、布局、版本号和锁文件改动。验证快照从 HEAD 导出，仅叠加本功能差异；App、controller、builtins、cli 和 README 按差异块筛选。这样可以验证本次提交独立成立，而不依赖其他未提交功能。测试直接调用项目安装的 TypeScript/Vitest 和构建脚本，避免 npm 在嵌套快照中回到外层 workspace。

快照首次全量通过：CLI 226 文件、3432 项通过、6 项跳过；Core 30 文件、482 项通过。此轮包含 CR-01/02，并验证本功能不依赖当时尚未提交的队列/输入功能。

随后并发节点将队列/输入功能单独提交为 `d2251ba4e`。最终快照从该 HEAD 重新导出，仅叠加本功能和 CR-03，完整复验结果：**CLI 233 文件、3511 项通过、6 项跳过；Core 30 文件、482 项通过，总计 3993 项通过**。生产构建、生产及测试类型检查、品牌检查全部通过。真实构建产物的 4 项 CLI 冒烟检查验证 get/list 固定掩码、专属 key 隐式解绑退出码 2，以及损坏 JSON 写入退出码 1 且原字节不变。日志位于 `.agentmesh/model-profile-review-final-*.log`，结构化结果为 `.agentmesh/model-profile-review-final-validation.json` 和 `.agentmesh/model-profile-review-final-smoke.json`。

本次提交共 39 文件：36 个计划目标、设计文档、本审查记录和 `queue-session.test.ts` 的 busy 守卫替身适配。删除了 `app.test.tsx` 中未被使用的模型阻断替身方法，避免保留无意义差异。包版本、锁文件、构建产物、运行时工具和其他功能改动不进入提交。暂存逐文件明确指定；已比对全部暂存源码及测试与最终验证快照一致，不跳过 git hooks。

## 验收边界

跨平台真实终端、真实双账户网关和 Windows ACL 人工验收仍以 `manual-test.md` 的未执行记录为准。自动化成功不替代这些人工结果。首次启用快速层需重启、跨进程仅乐观冲突检测和通用诊断日志的既有边界保持不变。
