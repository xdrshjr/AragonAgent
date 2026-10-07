# 多套模型配置：实现验收记录

日期：2026-10-07。环境：Windows / PowerShell / Node.js，当前共享工作区。

## 自动化验证

配置数据、角色解析、严格存储、输出安全、controller 事务以及真实 Ink 输入分别位于六个 `model-profile-*.test` / `model-profiles.test` 文件。测试使用隔离配置目录与假 provider，不调用真实收费服务。

最终验证结果：六组功能专项 **69/69 通过**；最终全量 `npm test` 的 CLI **233 个文件、3508 项通过、6 项跳过**，Core **30 个文件、482 项通过**，退出码 0。`npm run typecheck`、`npm run build`、`npm run verify:brand`、`git diff --check` 均通过。设计清单 36 个目标文件全部存在并已实现对应职责。

另通过真实构建产物执行 `config list --json` 与 `config get modelProfiles`，输出均使用固定凭据标签；专属 key 的 `config set model` 返回 2 且不输出 Set；损坏 JSON 的无关设置写入返回 1，文件字节保持不变。真实 App 设置集成测试验证选择、Ctrl+S 保存、关闭弹层及后续凭据解析。

早期全量运行遇到共享工作区并发修改中的旧测试替身、队列/TODO断言及构建中 dist 暂态失败；逐项复核后，最后一轮全量通过。最终日志保存在 `.agentmesh/model-profiles-full-tests-final.log`，CLI 冒烟结果保存在 `.agentmesh/model-profile-cli-smoke-result.json`。没有删除断言来回避失败。

| 验收项 | 证据与边界 |
| --- | --- |
| AC-01、02、03、14、15、28、37 | 数据与存储测试：默认名称、Unicode 截断、重名、引用、数组替换、无启动迁移、错误段保留及重启读取。窄屏通过 Ink 渲染验证。 |
| AC-04、06、07、08、09、21、29 | resolution/runtime/fast-resolve：主快独立地址与密钥、覆盖作用域、实际回退角色、reviewer/真实子 Agent 请求捕获；目标相同与模型名相同分别处理。 |
| AC-05、10、11、16、24、25、30 | settings/reducer 与真实 stdin filter：共享引用、草稿复制、保留与替换密钥、取消、绑定项删除阻止、Return/CSI Enter、粘贴、搜索和 80/60/40 列焦点。 |
| AC-12、13、17、19、20、27、31、33、34、35 | store/runtime：严格读写、冲突、忙碌守卫、专属凭据及有损解绑拒绝、重新读取失败保持 live、提交后异常状态和新请求阻断。 |
| AC-18 | 事务返回 restart_required；界面保存提示明确要求重启。未注册快速层不动态重建工具 schema。 |
| AC-22、36 | security：固定掩码、白名单、短密钥、未激活条目、损坏/未来版本整体隐藏与容错注册。 |
| AC-23、26、32 | exec/诊断沿用 main resolver；全量回归检查 exec、主题和 glyph；runtime 捕获同名网关回退与 child summarizer 的实际请求。 |

上述表为覆盖导航，不把单元测试称为真实终端或真实网关的人工验收。

## 人工验收矩阵

最终代码审查补充：修复启动网关下快配置有损解绑、显式自定义 provider 切换遗留地址、故障后手动压缩绕过阻断三项问题。基于 `d2251ba4e` 加本功能差异的独立快照重新执行：CLI **3511 项通过、6 项跳过**，Core **482 项通过**，总计 **3993 项通过**；构建、生产/测试类型检查、品牌检查及 4 项真实 CLI 冒烟检查通过。完整逐文件审查与证据路径见 `code-review.md`。以下人工验收状态不因自动化通过而改变。

| 场景 | 状态 | 说明 |
| --- | --- | --- |
| Windows 真实交互终端中的三套配置保存、重启、切换 | 未人工执行 | 自动化 Ink/真实 stdin filter 已验证对应操作；当前工具终端不能替代 Windows Terminal 的目视操作。 |
| Windows Terminal / PowerShell 的 80×24、60×18、40×12 视觉检查 | 未人工执行 | 自动化验证 80、60、40 列的焦点可达和内容渲染。 |
| NO_COLOR、ASCII、warm/cool/light | 自动化回归 | 不宣称人工目视结果。 |
| 真实本地 HTTP 网关主快双账户切换 | 未人工执行 | 假 provider 捕获主、快、review、team、compaction 的请求地址与凭据；没有发送真实网络请求。 |
| 配置写入权限/rename 失败 | 自动化故障注入 | 验证不提交、不改变 live；未修改 Windows ACL。 |
| macOS/Linux 终端与 POSIX 0600 权限 | 未执行 | 本机只有 Windows，不能据此宣称其它平台通过。 |

人工复核时，使用工作区内的隔离 `ARAGON_HOME`：先保存主/快两套同服务商不同账户方案，再复制第三套；确认切主不切快、取消不写入、被引用方案不能删除、外部修改会冲突。首次启用快速层需确认重启提示。不要把真实密钥放入截图或测试报告。

## 工作区与范围

开始前已有输入框、队列、布局、包版本及锁文件等未提交改动；执行期间其它节点持续修改这些文件。本节点保留它们，没有回退，也没有执行 `git commit`。因此整个共享仓库的 `git status` 不可能只显示本功能；本功能新增源码与测试均限于设计清单，App/controller 等重叠文件只添加本功能接线。

跨进程保存采用 hash 乐观校验，没有文件锁；首次启用快速层需重启；通用日志关闭脱敏时的第三方错误回显仍属于已记录的既有边界。
