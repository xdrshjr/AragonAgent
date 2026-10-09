# 上下文压缩触发准确性与任务记忆完整性设计

版本：**v2**。状态：设计评审通过，待下游实现与验证。日期：2026-10-08。

本评审节点仅修订本规范，不修改业务源码，不提交 Git。本文的“必须”是下游实现与验收约束，不表示功能已经完成。

## 评审记录

评审依据为当前工作区源码、根目录 `CLAUDE.md` 和项目索引；按可行性、完整性、一致性和范围适当性逐节核对。未发现 P0；以下 P1 均已在正文修订闭环，“已解决”只表示设计问题已解决，不表示源码已实现或测试已执行。

| 编号 | 严重度 | 关注点与源码依据 | 正文修订与状态 |
| --- | --- | --- | --- |
| R-01 | P1 | `meter.ts::current/compute` 的 measured 分支不计算新 system prompt；只标 dirty 仍会重用旧 usage，窗口元数据变化也可能命中缓存 | §3.3 增加请求环境版本、prompt 深失效和窗口独立失效；AC-29。已解决 |
| R-02 | P1 | `summary-prompt.ts` 与 `digest.ts` 只靠正文识别块；合法形状的用户文本和宿主块无法仅凭标签区分，恢复时可能误删用户原文 | §4.1、§5.3 增加宿主采用凭据及会话可选字段，无凭据保守保留；AC-30。已解决 |
| R-03 | P1 | Core 的图片只存在于顶层 `UserMessage.content`；图片嵌入 memory JSON 后仅是文本，不能保持多模态能力 | §4.2、§4.5 将非 anchor 图片留在完整尾部，禁止转成 JSON 后移除原消息；AC-31。已解决 |
| R-04 | P1 | SourceRef.role 可由模型伪造，工具 isError 与业务成功并不等价；v1 没有可信工具证据，迁移与 done 规则冲突 | §4.2–4.3 定义宿主 source map、证据边界及 legacy 只读迁移；AC-32。已解决 |
| R-05 | P1 | `summarize-call.ts::runSummarizeCall` 仅调用 abort 后等待远端；空闲路径无 Core race，晚到结果还可能结算进后续操作 | §5.1–5.2 定义本地 deadline/abort race、操作所有权及幂等结算；AC-33。已解决 |
| R-06 | P1 | 输入队列和 Esc 在 `ui/App.tsx`，只在 controller 增锁不足以接入 UI 的 idle/running 判断；原文件计划漏此调用方 | §3.5、§6.2、§7 增补 busy 订阅与队列接线；AC-34。已解决 |
| R-07 | P1 | 原文把 Core `validateHistory` 的 `length > previousLength` 写成必须减少消息数，误拒绝合法的等长减 token 压缩 | §5.1 与 AC-35 明确允许等长候选，仍要求 token 严格减少。已解决 |
| R-08 | P1 | `ProviderRegistry.complete` 内置传输重试；“最多两次网络调用”与实际栈冲突，child 两次压缩也并非两次摘要请求 | §4.5、§9.3 区分摘要尝试、传输重试与 run 额度，统一总 deadline；AC-36。已解决 |
| R-09 | P1 | budget、JSON 深度、instructions、coverage 累计及低阈值 overflow 提示的接线未确定，边界行为难以一致实现 | §3.4、§4.3–4.5、§6.1 明确定额、累计口径和 CLI 提示出口；AC-37–38。已解决 |
| R-10 | P2 | 新增严格解析、会话凭据和 UI 接线有扩大改动范围的风险 | §7–8 仅增小型纯模块及必要接线，不引入依赖、存储服务或 Core 宿主字段。已处理 |
| R-11 | P2 | 自动化不能证明真实模型语义完整、终端取消体验和性能目标；v2 会话降级到旧程序无无损保证 | §5.3、§9.3、§11 明确验收及回退边界。实施验收待下游执行，不阻塞设计通过 |

逐节结论：§1–2 的问题定位与架构边界成立；§3 按 R-01、R-06、R-09 补齐生命周期；§4 按 R-02–04、R-08–09 收敛保护与验证契约；§5 按 R-02、R-05、R-07 补齐采用及恢复；§6–8 同步接口、文件和实施顺序；§9–11 增加对应验收与发布门槛。既有工作区的无关变更不纳入本次评审交付。

## 1. 概述

AragonAgent 是采用 TypeScript、ESM、npm workspaces 的终端 Agent 项目。`packages/core` 提供不依赖宿主存储和界面的执行引擎，`packages/cli` 使用 React 18 与 Ink 5 实现 TUI，并注入配置、模型、会话、压缩与归档服务。当前已有自动压缩、手动 `/compact`、上下文占用仪表及摘要恢复机制。本次沿用这些边界，修复“用户刚输入内容，显示的上下文尚未达到阈值却开始压缩”的行为，并加强连续执行任务时的长期信息保留。

产品规则收敛为两个条件：当前上下文占用达到用户配置阈值，或者用户显式请求压缩。普通输入、输出 token 预留不足、上轮累计花费、后台计时均不能成为独立的压缩授权。输入进入真实历史后如果使占用跨过阈值，则允许压缩；编辑框中的草稿不计入占用。触发判断和界面读取同一个占用快照，按未舍入的比例比较，所有估算值继续标明近似来源。

压缩后的工作记忆采用有版本、可验证、可连续合并的结构化文本，保留原始目标、用户后续要求、全局事实、决策、任务进度、验证证据与下一步。原始用户要求及已经保存的记忆条目由宿主保留，模型只能提交有来源的增量。任何预算、摘要、结构或并发校验失败均保留原历史。这里的完整性保证是对保护内容和已入账记忆的机械保留；模型对首次出现的工具输出仍可能理解不完整，不能宣称有限长度摘要在语义上无损。

## 2. 现状、证据与设计取舍

### 2.1 已核对的项目约束

- 已阅读根目录 `README.md`、`CLAUDE.md`、`.claude-index/index.md` 的项目概述与相关索引，以及下列源码。索引仅用于定位，源码为当前行为依据。
- Core 的 `ContextManager` 是同步判断、异步生成候选历史的注入接口；CLI 专属的数据结构、文件操作和 UI 事件不能进入 Core。
- `CLAUDE.md` 要求小模块、边界校验、明确错误以及回归测试。已有超长模块只增加必要接线，新增复杂逻辑放在专门模块；新增函数不超过 60 行，文件不超过 1,000 行。
- `src/compaction/**` 等生产源码受 ASCII 扫描约束；实现中的提示语及字段名使用 ASCII，摘要内容保持对话语言。本规范用中文。
- 工作区已经存在 `package-lock.json`、两个包的 `package.json` 等非本任务变更；后续实现不得将它们当成本任务结果或随意覆盖。

### 2.2 可直接定位的现有机制

| 路径与符号 | 已观察到的行为 | 本次处理 |
| --- | --- | --- |
| `packages/cli/src/compaction/pressure.ts::shouldCompactAt` | `ratio >= threshold` 与 `headroom < requiredHeadroom(req)` 二者任一成立即触发 | 删除输出预留作为触发条件 |
| `packages/cli/src/compaction/compactor.ts::shouldCompact` | 手动请求及 `overflow` 分支提前返回 true | 手动保留；overflow 同样检查阈值 |
| `packages/core/src/engine/agent-loop.ts::runAgentLoop` | steering 接收后、模型请求前检查；溢出后另检查一次 | 保持检查位置；成功替换后清除旧 usage |
| `packages/cli/src/compaction/meter.ts::measureWith` | 将 probe 的 usage 直接用于测量；新 run 的 usage 可为 undefined | 改为只接受与当前历史绑定的测量样本 |
| `packages/cli/src/compaction/digest.ts::buildDigest` | 用户消息裁到 2,000 字符，旧摘要最多 6,000 字符，预算不足时省略旧条目 | 新的 v2 记忆链路不裁剪用户要求、旧记忆或历史条目 |
| `packages/cli/src/compaction/summary-prompt.ts::buildAnchor` | 文本原任务裁到 4,000 字符 | 原任务完整保存，超过保护预算则拒绝替换 |
| `packages/cli/src/compaction/summary-prompt.ts::buildCompactedBlock` | 先对模型摘要执行 `slice` 再写入历史 | v2 必须整体校验，禁止字符串切片 |
| `packages/cli/src/compaction/compactor.ts::runCompaction` | 摘要失败默认可删除旧历史；可剪裁最近工具输出 | v2 不执行这两种有损降级 |
| `packages/cli/src/compaction/wiring.ts::compactNow` | 空闲手动路径在 controller 采用消息之前报告 applied | 改为采用后再结算 |
| `packages/cli/src/session/persist.ts::SavedSession` | 已保存 engine messages，可携带 user-role 压缩块 | 不新增数据库或独立记忆存储 |

例如窗口 128,000 tokens、占用 64,000 tokens、阈值 0.9、最大输出 64,000 tokens 时，界面显示 50%，旧算法因剩余 64,000 小于输出加预留 69,120 而触发。这是静态阅读已证实的提前触发路径；不能据此宣称所有用户现场问题均已复现。测量跨 run、压缩后旧 usage、残留手动标记列为必须覆盖的回归路径。

### 2.3 方案选择

| 方案 | 优点 | 缺点 | 决策 |
| --- | --- | --- | --- |
| 仅移除 headroom 判断，继续六段自然语言摘要 | 修改少 | 全局任务仍可能在重复摘要、截断或降级中丢失 | 不选 |
| 严格阈值，加宿主保护账本与结构化增量摘要 | 可测、可迁移、沿用现有会话与 Core 接口 | 保护内容最终可能占满预算，此时需明确拒绝 | 采用 |
| 独立向量库、长期记忆服务、每轮自动抽取 | 可扩展到跨会话检索 | 引入存储、召回和额外调用，不能直接保证保留任务 | 本次不做 |

本规范覆盖已有文档中与之冲突的规则：headroom 自动触发、低占用 overflow 自动压缩、失败删除历史、retained-tail relief。原有结构合法性验证、取消传播、费用统计和不支持时的降级显示仍有效。Core 的通用 `relieveTail` 导出保留给其他消费者，不为 CLI 策略变化删公共 API。

## 3. 技术设计：触发与测量

### 3.1 唯一触发公式

`shouldCompactAt(pressure, threshold)` 成为只有两个参数的 CLI 内部纯函数。输入满足以下条件才返回 true：`occupied` 是有限非负数、`contextWindow` 是有限正数、`threshold` 在 `[0.5, 0.95]` 内，以及 `occupied / contextWindow >= threshold`。使用未舍入值，不使用 status bar 的整数百分比，不把系统已设置的输出上限加进 occupied。无效值返回 false 并由调用层记录诊断；用户配置继续经过既有 clamp。

`occupiedTokens` 的 provider usage、cache 字段规范及 appended delta 算法保持原口径。实际已有的 assistant 输出属于历史占用；未来可能输出的 token 不属于历史占用。Anthropic 的可加缓存字段与 OpenAI 已包含缓存的输入总数不得重复累计。累计 session usage 只表示费用，永不作为当前占用。

用户设置 `contextWindow` 时继续使用该分母；否则使用当前模型元数据，再使用现有 fallback。未知窗口的判断可以基于既有估算窗口，但 UI 必须保留 `~`、来源和 unknown 标识。它不是对服务端容量的证明；provider 拒绝请求也不能自动把比例改成 100%。

### 3.2 判断顺序与真值表

`Compactor.shouldCompact` 按以下顺序执行：检查是否启用；从 meter 获取并发布一次快照；拒绝已有 inFlight；检查 run 次数上限；处理手动请求；检查自动 selfDisabled；检查阈值；检查 pressure 冷却。overflow 可以跳过冷却，但不能跳过阈值、上限或 selfDisabled。命中 guard 不调用摘要，不改历史。手动请求仍受每 run 自动路径的尝试上限约束，但不受阈值、冷却或自动 selfDisabled 约束；空闲显式命令使用独立的一次操作额度。

| 情况 | 是否生成摘要 | 对用户的结果 |
| --- | --- | --- |
| 普通输入后 50%，阈值 90%，headroom 不足 | 否 | 正常执行或显示原始 provider 错误 |
| 普通输入后 89.99%，UI 四舍五入为 90% | 否 | `/compact status` 显示精确占用与阈值 token 数 |
| 输入或工具结果使占用恰好 90% | 是，其他 guard 允许时 | 显示达到阈值的压缩卡片 |
| 编辑框有未提交草稿 | 否 | 不进入 engine messages |
| `/compact` 或 `/compact <instructions>`，只有 10% | 是，有可压缩完整历史时 | 显示 manual；无可压缩历史则明确说明 |
| `/compact status`、`history`、`show`、`threshold`、`keep`、`on`、`off` | 否 | 只执行对应查询或设置 |
| provider overflow，但本地占用未达阈值 | 否 | 保留原错误，提示手动压缩或校正窗口 |
| provider overflow，占用已达阈值 | 最多一次，guard 允许时 | trigger 仍记录 overflow，附阈值证据 |
| `--no-compaction`，或当前已 `/compact off` | 否 | 沿用未注册或关闭状态提示；手动要求先启用 |

启用和修改阈值只影响下一安全检查点，不立即创建压缩工作。不增加后台定时压缩，不在 prompt UI 回调中直接调用 compactor。

### 3.3 测量生命周期

meter 继续作为唯一权威。`onTurnEnd` 记录 usage、被测前缀长度及被测前缀最后一条消息的对象引用。该事件发生在 assistant 消息入列之前，所以 appended delta 继续从 `measuredPrefixLength + 1` 开始；不能重复计算该 assistant 输出。

为避免新 run 的 undefined probe 覆盖有效缓存，以及旧 probe 恢复已失效样本，生产 `shouldCompact` 改为读取 `meter.current()`。`measureWith` 作为 CLI 内部兼容入口保留，但只在样本与已记录 usage 对象相同且前缀有效时允许使用；其它参数不建立新样本，转用 current。注入 meter 和 child 的 onTurnEnd 接线必须在生产中完整，测试不能再只构造 probe.lastUsage 冒充历史样本。

前缀有效性必须同时检查长度与末条对象引用。`onHistorySpliced` 清空 usage 和前缀指纹、保留 offset；`onHistoryReplaced` 清空 usage、指纹、offset，覆盖 clear、reset、resume；切换 provider/model/baseUrl 或工具定义改变时同样清空样本和校准，只有单纯 window override 更改可沿用样本。`AgentController` 的模型配置应用点必须区分二者。不能以相同消息数证明同一历史。

另外缓存“上次发布时”的消息长度、最后一条对象引用和 systemPrompt 字符串引用；`current()` 每次先进行这些常数级比较，有新增历史或 prompt 变化就标 dirty，然后才允许返回缓存。这组缓存与 measuredPrefix 是两个概念：前者保证新增 steering、user 和 child tool_result 会被及时计算，后者保证旧 usage 仍适用。不得只依赖 400ms UI 定时器，因为检查点可能先于定时器且 child 没有 UI 订阅。框架的原地消息内容变更必须显式 scheduleTick；本次实现不新增这种变更。

上述 dirty 是最低要求，不能代替样本失效：采样时同时记录实际 systemPrompt 值与请求环境版本（provider/model/baseUrl、工具定义版本）。prompt 或请求环境变化须先清除 usage、前缀指纹和 offset，再全量估算；否则 measured 分支会忽略新的 prompt。发布缓存另外比较 resolved window、windowSource、windowKnown、windowOverridden，任一变化必须重算并发布；仅分母或来源变化保留有效样本。模型元数据异步刷新也遵守此规则。稳定读取只做标量/引用比较，不每次序列化工具定义；工具注册、权限或技能导致实际请求环境变化时由宿主递增版本。计时器发布和 measureWith 也统一经过这些失效检查，不能另开绕行路径。

Core 在 `runCompaction` 返回 applied=true 后把 loop 局部 `lastUsage` 置为 undefined，pressure 与 overflow 两处一致。CLI meter 的测量防线负责宿主正确性，此处清理负责通用端口不会继续获得压缩前 usage。无成功替换时不清理。子 Agent 显式创建自己的 meter，经 `onTurnEnd` 校准，下一检查点通过历史前缀指纹识别压缩导致的失效，不能共用主 Agent 的样本。

子任务的已压缩计数也只接受 Core verdict：ChildContextManager 新增 CLI-local `onCompactionEnd({ applied, reason?, tokensBefore, tokensAfter })`，由 `team/subagent.ts` 将 Core 事件的 estimatedTokensBefore/After 映射后传入，applied=true 才调用现有 `req.onCompacted()` 并使 child meter 失效；所有 verdict 都交给 §5.1 的 settleOperation。删除 child 当前在 compactor 的乐观 compaction_end 上递增计数的路径；不能把候选生成视为历史已采用。

### 3.4 输出空间不足与错误行为

本次不另造 token 上限解析器，也不修改 provider 出错分类。仍由 Core 现有 output limit 逻辑决定实际请求参数。由于各 provider 的上下文裁定并不完全相同，严格阈值可能使估算窗口偏大、小窗口或超大单条输入更早遇到 provider 错误；此时保持历史，给出 ASCII 提示：`Context limit reached before the configured compaction threshold. Use /compact or correct contextWindow.`。原错误详情继续可见。

不自动降低用户阈值，不把 overflow 当成手动授权，不通过 tail relief 绕开公式。用户可显式 `/compact`，也可校正窗口；这些操作的后果由原有 command 流程处理。

恢复提示由 CLI wiring 的 overflow 检查分支发出：启用状态下、probe.trigger=overflow 且当前快照有效但未达阈值时，每次 run 最多 notify 一次，不创建压缩事件或卡片；Core 继续抛原错误。child 只写原因日志，不向主 TUI 冒充主历史错误。快照无效时只保留原错误与测量诊断，不声称“未达阈值”。§6.3 的 below_threshold 静默规则只针对普通 pressure 检查。

### 3.5 手动请求的生命周期

`PendingManual` 扩展为 `{ requestId, instructions?, historyEpoch }`，由 compactor 内递增整数分配 requestId；一次只有一个 pending，重复输入替换未开始请求，沿用最后一次 instructions，并反馈已更新排队请求。正在摘要时再次请求只反馈 already running，不追加费用。

pending 在进入 compact 前一次性取走，无论成功、失败、取消均不回放。`onRunEnd` 清理尚未消费的 pending；`onHistoryReplaced`、关闭压缩、dispose 也清理。新用户 prompt 不得继承上一 run 未消费的手动请求。run 上限阻止已排队手动请求时清理并提示 `Compaction limit reached for this run.`，不能静默挂到下一次用户输入。

空闲手动路径增加操作锁和 epoch 检查。运行期间只排队到安全边界；空闲摘要期间输入继续按既有队列规则保留，不可并行启动新 run。Esc 通过同一 AbortController 取消。clear/reset/resume 若已执行，则增加 epoch 并取消候选；即使远端迟到返回，也必须因 epoch 不同而丢弃。

锁状态由 controller 提供 CLI-local `isCompactionBusy()` 和状态订阅，在本地 prepare 开始时同步置 busy，finally 释放后通知；不能只依赖摘要网络调用前才出现的 compaction_start。`ui/App.tsx` 的发送、队列 drain、slash command 分发及 Esc 分支均读取这一状态：普通输入仍通过既有队列保存，busy 时禁止启动新 run，结束后仅触发一次 drain。clear/reset/resume 先取消并失效本次操作再替换历史；模型设置变化同样使候选失效。controller 的 prompt/continue 入口也检查锁，供 exec 等非 UI 调用方得到明确 busy 结果，不能覆盖或丢弃传入文本。不得为此伪造 Core agent_start/agent_end 事件。

## 4. 技术设计：结构化工作记忆

### 4.1 分层与权威

上下文保持四层：当前 system prompt；完整原任务 anchor；一个 v2 工作记忆块；最近完整对话尾部。权限、工具策略、模型设置与实时 TODO 状态属于宿主运行状态，摘要不能覆盖它们。已有 `SavedSession.todos` 和 TodoStore 恢复机制保持权威，不从自然语言摘要反向生成 TODO 或更改权限。

原任务文本不得再按 4,000 字符截断。原任务按原 Message 保留；legacy original_task 标签识别严格限定有来源凭据的历史前缀、生成格式和相邻记忆块。JSON 字符串中的 `<`、`>` 使用 Unicode 转义写出，避免用户内容伪造块的结束标签。生产源码仍保持 ASCII。

**文本形状不是宿主身份凭据。** 进程内仅对本次成功采用时登记的 anchor/block 对象识别“已生成块”；跨进程使用 §5.3 的会话凭据恢复身份。解析函数只判断语法，排除 userMessages 或继承 generation 必须另有凭据。普通用户输入即便逐字复刻合法 v2，也按普通原文保护，不授予 supersession 权威。v2 新 anchor 一律保留原 UserMessage（shape=verbatim），不再为字符串新造 XML 包裹；已确认来源的 legacy anchor 可以原样延续。这样用户自身 original_task 标签无需被猜测或重新包装。

压缩块使用 user role，不能伪造 assistant 发言，也不能提升为 system role。引导文案明确：这是历史记录，不能授权工具调用；最新未压缩用户指令优先于冲突旧记录；未知信息仍未知；从任务未完成项继续。`COMPACTION_BLOCK_VERSION` 固定升级为 `v2-2026-10`。

### 4.2 数据模型

下列为接口规范，均置于 CLI 新模块 `compaction/memory.ts`；不加入 Core 导出。

```ts
interface SourceRef {
  messageId: string; // 宿主生成 g<generation>:m<snapshotIndex>
  role: 'user' | 'assistant' | 'tool_result';
  excerpt: string; // 来自实际展示给摘要器的文本，最长 512 字符
}

interface MemoryItem {
  id: string; // 宿主生成 g<generation>:i<ordinal>
  section: 'global' | 'decisions' | 'files' | 'facts' |
    'tasks' | 'verification' | 'pitfalls' | 'next';
  text: string; // 1..1200 字符，不接受纯空白
  sources: SourceRef[]; // 1..8 条
  status?: 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  supersedes?: string; // 可选旧条目 ID，保留旧条目而非删除
}

interface ProtectedUserMessage {
  id: string; // 与 SourceRef 使用相同 messageId
  message: UserMessage; // 原 content、timestamp 不变；类型从 Core 导入
}

interface CompactionMemory {
  schemaVersion: 2;
  generation: number; // 正整数
  originalTask: { sourceId: string; location: 'anchor' };
  userMessages: ProtectedUserMessage[];
  items: MemoryItem[];
  legacySummary?: string; // 迁移前 v1 完整块，永不假装已恢复丢失原文
  coverage: {
    summarizedMessages: number;
    clippedToolResults: Array<{ messageId: string; omittedChars: number }>;
    legacyIncomplete: boolean;
  };
}

interface MemoryDelta {
  schemaVersion: 2;
  additions: Array<Omit<MemoryItem, 'id'>>;
}
```

`userMessages` 不是模型输出，由宿主收集本次将移出历史、除原任务和有效先前记忆块之外的全部 user-role 消息，逐代合并并按时间顺序保存。这是有意保守的规则：现有 Message 不具有足够可信的 human/synthetic 来源区分，因此包括某些框架注入的 user 消息，不靠正文猜测指令是否重要。只排除已同时验证语法及采用凭据的框架 anchor/前缀块，以及本轮单独保留的原任务；不能用“以某标签开头”过滤任意用户文本。

原任务保存在 anchor，不再重复放入 userMessages。原 anchor 已存在时，不再次摘出所谓“第一条用户消息”；原始文本中自己的 XML 样式标签只是数据。仅含 text 的 ContentPart[] 可原样入账。含 image 的非 anchor user 消息必须继续作为真实 UserMessage 留在 tail：在原 plan 切点之前找到最早此类消息，将切点退到不越过该消息的最近闭合工具对边界，再重建 head/tail。不足以构造有效候选则 keep/protected_multimodal_tail；不得把 base64 放进 JSON 后删除原消息。多模态 anchor 本来就是顶层 Message，原样保留。此保守策略维持模型看图能力，也避免在正文中复制图片数据；本期不引入图片旁路存储。

每个新 item 的 section 必填，tasks 必须提供 status，其余 section 禁止 status。generation 和 id 均由宿主写入，模型不能指定。SourceRef.messageId 必须存在于本次摘要 source map；role 必须与原 Message.role 相同；excerpt 必须是该消息可见正文的非空连续子串，不能引用宿主添加的标题、裁剪标记或 image 占位符。source map 保存实际 role、toolCallId、工具名、isError 与可见文本区段；这些校验依据不得由模型填写。路径、命令、参数、测试结果和错误值应在 text 中原样列出。

verification 不具有 status 字段，只能记载所引工具实际结果；有关成功的执行证据须来自原始 `tool_result` 且 `isError !== true`，工具名称由闭合调用对查得。isError 只证明执行器未标错，不能机械证明测试全过或业务成功：提示要求保留退出码、失败数等原文，UI 标为“模型提取，附来源”，不自动将宿主 TODO 标 done。对于未显式报告成功的工具内容，不写成功结论。任务 done 的机械条件为至少一个这样的工具来源或本轮 user 原文；后者是否真的表示接受仍是模型语义判断，须显示来源且保留旧状态，不能宣称已由程序证明。模型将 assistant.role 伪造成 tool_result，或引用 isError=true 均拒绝。

### 4.3 合并算法与任务状态

先解析先前 v2，再收集本轮 head；模型接收完整旧 memory 作为只读参考和本轮 digest，返回只有 schemaVersion 与 additions 的 JSON 对象。禁止自由文本前言、Markdown fence、未知字段、非有限数字、重复键；解析器遇到重复键须拒绝，不接受 JSON.parse 的后值覆盖。使用小型严格扫描器检查重复键后再解析，不新增依赖。

扫描器先检查字符串长度，再做有界词法/层级扫描，最大 JSON 嵌套深度 32；重复键按解码后的键名判定，含 Unicode 转义的同名键也算重复，字符串里的括号不计层级。合法性最终由 JSON.parse 与 schema 边界校验决定，不自造完整 JSON 解释器。先校验数组限额再遍历，generation、序号和 coverage 计数必须为非负安全整数（generation 为正），超界统一拒绝。持久化块的 JSON body 与模型增量各最多 32,000 字符；块的固定封装额外最多 1,024 字符，完整块原始文本先按 33,024 限制，再抽取 JSON，防止先扫描任意长正文。

宿主按模型数组顺序分配 ID，原有 items 的 id、text、sources、status 全部原样保留。更新任务或修正事实通过新增 item.supersedes 表示：必须引用已有同 section 条目，且只指向当前链尾；同一 delta 不允许两个 additions 指向同一旧条目，不允许环。没有 supersedes 的新条目不删除旧条目。渲染活动视图时以链尾为当前值，完整链保留在 JSON 中供追溯。

用户目标、约束冲突的 supersession 必须引用本轮 user 消息；任务 done 必须引用成功工具证据或用户明确接受的原文；cancelled 必须引用用户原文。其它任务状态仍需本轮来源。无法机械判断语义时不可自动赋予更高可信度，显示来源，并保留旧条目与原始用户要求。模型不必重复输出旧事项，因此漏掉旧 ID 不造成删除。

模型可以返回空 additions，但如果本轮确有 assistant/tool 可总结消息而 additions 为空，则认定 `empty_memory_delta`，进入一次重试。只有本轮移除内容全部是已经由 userMessages 原样保存的 user 消息时，空 additions 才有效。自动清理已完成 items、自动合并相似条目、自动摘掉旧 userMessages 均不在本次范围；容量不足走拒绝路径。

旧 v1 块没有可机械核实的工具来源，仅作为 legacySummary 只读参考，不允许据此新增已验证事实或 done 状态。空 additions 判定不把 legacy 块算作本轮 assistant/tool 消息。连续世代的 coverage 由宿主累计：summarizedMessages 仅加本轮新移出的 assistant/tool 消息数，不重复计算旧 block、anchor 和原文入账 user；clippedToolResults 按稳定 messageId 追加，omittedChars 只记该条本轮遗漏数，legacyIncomplete 为历史逻辑 OR。coverage 最多 200 条裁剪记录，超限保留历史并返回保护预算错误，不静默丢审计记录。只有被采用的候选才提交这些累计值。

### 4.4 文本封装与显示

block 结构为 opening tag、固定说明、单个完整 JSON 对象、closing tag。沿用现有 compacted_context 标签及 replaced/turns/anchor/generation 属性，version 固定为 v2-2026-10；属性值由宿主生成，不接受重复/未知属性。解析严格定位完整边界，schema 与 generation 一致；摘要器从解析对象获取旧记忆，不把原包裹说明再当摘要内容循环输入。采用字段顺序固定的 JSON 序列化，使用两空格缩进以便归档检查；body 不用字符切片。

TUI 与 `/compact show <n>` 用单独纯函数 `renderMemoryMarkdown(memory)` 输出以下固定标题，空节写 `(none)`：`Goal`、`User requirements`、`Global context`、`Decisions`、`Files and facts`、`Tasks`、`Verification`、`Pitfalls`、`Next steps`、`Coverage`。标题为 ASCII，条目正文保持原语言。显示分为可展开预览与完整摘要；显示裁剪不改变存入 engine messages 的 JSON。

`CompactionOutcome.summary` 和现有记录 `summary` 使用渲染后的可读 Markdown，便于沿用卡片和归档。用于下一轮工作的权威对象始终是 messages 内的 v2 JSON，而非 card 文本、记录摘要或第三份磁盘文件。

### 4.5 预算与无损失败

所有新上限集中在 `compaction/limits.ts`，不新增可调配置项：memory JSON 最多 32,000 字符，原任务 anchor 与 memory 总计最多 48,000 字符，items 最多 200 条，userMessages 最多 200 条，单次 additions 最多 64 条，coverage 裁剪记录最多 200 条，JSON 深度最多 32，instructions 最多 4,000 字符，单次摘要输出上限 4,096 tokens。字符统一按 JavaScript UTF-16 code units 计算；使用最终转义、缩进后的文本计预算，anchor 按完整 Message 序列化长度计算，含多模态数据。大图片触及保护预算时明确拒绝，不承诺所有多模态会话都能压缩。

每个压缩操作最多两次摘要层 `complete` 尝试，每次最多 45 秒（包括其传输重试和退避），CLI 整体硬上限 120 秒；运行路径还受 Core 配置的 compactionHardTimeout 约束，任一较早到期即终止。第二次只使用剩余总时限；无剩余则不启动。ProviderRegistry 的既有重试策略仍有效，因此不把两次 complete 宣称为最多两个 HTTP 请求。父实例每 run 最多 5 次压缩尝试、child 最多 2 次，故摘要层调用上限分别为 10 和 4；空闲 manual 每条显式操作另有一次压缩额度。不要为限定本功能请求数而修改共享 registry 的全局重试配置。

预算检验在调用前和合并后各做一次。用实际候选 messages 加 systemPrompt 经现有 estimator 计算 tokens；候选必须严格小于原历史估算值，且小于模型窗口减现有安全余量。自动触发继续按既有 `minReclaimRatio` 判断进展并控制重复尝试，但进展不足不授权删除任何保护字段。

比较 before/after 使用相同 estimator 和同一 systemPrompt；校准 offset 不加入收益差值，但容量检查加上可用非负 offset。安全余量复用 Core 的 `CONTEXT_SAFETY_MARGIN_TOKENS`（当前 1,024），只用于候选容量验收，绝不成为触发授权。输出预留仍不加进 occupied，也不通过预算拒绝变相修改门槛。

用户消息、原任务、先前 memory 以及 prior legacySummary 不得裁剪。digest 不能省略整条历史消息；assistant 文本与 tool_call 参数完整呈现。超大 tool_result 文本允许保留头 1,500 和尾 1,500 字符，并加原长度、工具名、toolCallId 和 clipping 标记；每次截断均列入 coverage。图片只向摘要器提供占位说明，user 图片依 §4.2 留在真实 anchor/tail；不能声称摘要器理解了图片。若 head 的 tool_result 也包含图片，同样退回安全切点将整条结果和闭合调用留在 tail。所有裁剪只作用于摘要输入副本，绝不改 retained tail。

摘要输入预算按所选摘要模型计算：`min(120000, max(0, (window - reserveTokens) * CHARS_PER_TOKEN))`，reserve 至少 8,000 tokens，并核对实际 system、prior memory、digest 与 max output 的总估算。未知摘要窗口沿用解析后的 fallback 并保留估算标记。旧 memory 或完整 user/assistant/call 内容放不下时不丢最旧记录，返回 `digest_budget_exceeded`。若首选 fast 模型预算不足而主模型可容纳，则直接用主模型，算一次实际调用；两者都不满足则不发请求。

失败原因包括 `protected_memory_too_large`、`protected_multimodal_tail`、`digest_budget_exceeded`、`invalid_memory_delta`、`empty_memory_delta`、`no_token_reclaim`、`aborted`、`stale_history` 和已有 invalid_history/timeout 分类。schema/空增量错误允许用主模型重试一次，并附短错误路径；重试不放宽 schema。保护限额、输入放不下、无收益和无安全切点属于确定性拒绝，不重复付费。两次失败返回 keep。实际收到的 usage 无论是否采用都计入费用，缺失 usage 不臆造；迟到 usage 按 §5.2 去重处理。

`compaction.onFailure` 保留现有 `stop | truncate` 类型以读取旧配置；默认改为 stop。v2 对 legacy truncate 也执行 preserve/keep，并在 status 中显示 `truncate (legacy; preserving history)`，首次该配置实际遇到失败时提示一次。不可借旧配置自动删掉任务上下文。child 取消强制 truncate，统一走 stop。失败后的当前 run 允许原请求继续一次，若 provider 拒绝则正常结束；不另建无限重试循环。

自动路径（pressure 与 overflow）的预算拒绝、schema 失败和无 token 收益均计入 no-progress 计数；连续两次则 selfDisabled，提示应准确说明 `reason`，不继续沿用“最近 turns 过大”这条单一解释。取消、stale_history 和手动失败不递增该计数。只有成功采用且达到进展目标才清零；单纯生成了候选不清零。`/compact on` 继续显式解除 selfDisabled。进展目标沿用现有严格比较 `projected.ratio < threshold - minReclaimRatio`；候选有收益但未达目标可以采用，并记一次 no-progress，避免把进展门槛误写成新的触发或删除授权。

## 5. 操作时序、原子性与恢复

### 5.1 一次运行中压缩

1. Core 接收已排队 steering，形成当前历史快照。
2. Compactor 读取 meter 快照，判断 explicit manual 或 threshold；未授权立即返回，无模型调用、无卡片。
3. 记录 historyEpoch、配置/模型版本与摘要操作 ID，复制数组；保存本次 trigger 与阈值证据。
4. 调用既有 `planCompaction` 确定闭合工具对切点，保留配置指定的最近完整 turns；依 §4.2 将含图历史所在完整轮次保留到 tail，必要时退回更早安全切点。overflow 不再临时减半 keepRecentTurns。
5. 无安全切点则 keep/nothing_to_drop；不尝试 relief-only。手动请求显示结果，自动 no-op 保持安静。
6. 完整建立 anchor、旧 memory、保护账本和 source map；检查预算。进入实际摘要调用前才发 CLI compaction_start。
7. 执行有界摘要、校验增量、宿主合并、重新计算预算和估算收益；生成 `[anchor, v2Block, ...tail]`，tail 消息逐条保持原对象内容。
8. 检查 signal、historyEpoch、配置/模型版本，任一变化即 keep/stale_history。已接受入历史的用户消息必须处于 snapshot 或 tail 中；尚未接受的输入继续留队列，不拼接进正在生成的摘要。
9. Core 执行 `validateHistory`，采用成功后发最终 verdict。CLI 收到真实 applied 后再确认 generation、tokens reclaimed、meter splice、archive 与 UI。失败丢弃 staged 状态。
10. 下一次请求使用新历史；新一代 memory 直接从已采用的 v2 block 读取，不依赖 compactor 曾经生成过但未采用的字段。

当前 `validateHistory` 仅拒绝 `candidate.length > previousLength`，等长数组合法；本设计不增加更严格的消息数限制。只要存在安全 head、候选消息数不增长、工具结构完整且估算 token 严格减少，就允许等长候选。无法构造满足这些条件的数组才返回 nothing_to_drop/no_token_reclaim，不能为手动请求伪造成功。

Core verdict 到达前，generation、身份凭据、成功计数和 no-progress 清零均为 staged。wiring 与 child 收到真实 verdict 后调用 CLI-local `settleOperation({ applied, reason, tokensBefore, tokensAfter })`，当前操作只能结算一次：成功提交候选代次、累计收益并按真实进展重置/递增计数；拒绝则丢弃 staged，预算/schema/无收益计入 no-progress，取消和 stale 不计入。child 也通过此入口，不能只改 UI 回调而漏掉 compactor 账本。attempts 在 compact 入口消耗，与成功计数区分。

### 5.2 空闲手动压缩的两阶段采用

将 `CompactionWiring.compactNow` 内部改为 prepare + adopt + settle：传入 controller 提供的同步 `adopt(messages)` 回调与 `isCurrent()` 回调。校验通过、未取消且 isCurrent=true 时调用 adopt；adopt 返回之后才 `settlePending(applied: true)`。异常则 applied=false，不能提前写成功 archive。

Controller 在进入前获取同一操作锁，创建并持有 AbortController；回调中再次核对历史 epoch、模型设置版本与 idle 状态，然后执行 `agent.replaceMessages`。finally 释放锁并继续既有输入队列。controller 原来 await 后直接替换消息的语句删除，避免采用两次。供外部命令调用的 `controller.compactNow(instructions?)` 返回形状保持不变。

每次操作持有 `{ operationId, historyEpoch, settingsVersion, abortController, deadline, settled }`。网络 Promise 与本地 abort/deadline Promise 必须显式 race；仅调用 signal.abort() 后继续 await transport 不满足取消契约。进程内取消应在下一轮事件循环结算、释放 busy，不等待不遵守 signal 的 provider。进入调用前检查 signal.aborted，注册监听后再复查；abort、超时或 Core 的 applied=false verdict 立即使操作失效并取消调用。迟到响应与 finally 仅在 operationId 仍为当前时可清除 inFlight/锁，不能清掉下一操作的状态；每条远端 Promise 均挂拒绝处理以防 unhandled rejection。

晚到 usage 用每个调用闭包中的一次性标志入账，不改变已结算结果、generation、no-progress、归档或 UI 成功卡片；没有收到 usage 则只能显示已知费用，不能宣称统计了未知远端消耗。busy 释放后允许新操作，但旧调用即使晚到也不能再尝试第二次摘要。adopt 是同步且不可重入的提交边界：替换前检查，替换后不得因通知或 best-effort archive 抛错而把已采用历史标失败；这些观察者错误单独诊断。manual 与 Core 路径共用同一操作状态机及幂等结算方法。

archive 继续 best effort、按当前 run 分区、沿用既有容量与保留时长。归档失败不能回滚已经采用的有效历史；不得把“有归档”当作删除保护信息的理由。归档中的 dropped messages 可能已有文件大小上限，因此它是审计辅助，不是完整工作记忆的唯一存储。

### 5.3 跨进程恢复与旧格式

无需数据库、无需额外 sidecar 文件，现有 `/save`、`/resume`、exec 会话持久化继续存取 engine messages。`SavedSession.version` 保持 1；memory 自带 schemaVersion=2，与外层会话版本分开。仅新增可选的 `compactionIdentity?: { version: 1; anchorIndex: 0; blockIndex: 1; generation: number; prefixSha256: string }`，这是宿主采用凭据，不存第二份摘要。prefixSha256 使用 Node 内置 crypto，对固定字段顺序序列化的完整 `[anchor, block]` Message（含 timestamp/content）计算 SHA-256；generation 为正安全整数，hash 为 64 位十六进制字符串。序列化函数由同一纯模块提供，保存前和恢复后复核哈希、角色、索引及块 generation。一旦凭据不匹配，保留原 messages，标记下一次压缩 invalid_prior_memory；不从正文重建凭据。哈希用于防误认和损坏检测，不是对恶意修改会话文件的认证。

`session/persist.ts` 的接口、saveSession 输入和实际 payload 都必须透传字段；`commands/builtins.ts` 的 TUI save/resume、`exec/index.ts` 的恢复和 writeSession 数据组装、`session/store.ts` 的中转均需接线。controller 原子提供 messages 与凭据的同一快照，并在恢复 messages 时同时导入凭据；仅添加 TS 字段不能算完成。会话边界验证字段形状；运行期间的成功采用才生成新凭据，clear/reset 或任意外部历史替换清除它。恢复后先清空 meter 与 pendingManual，再凭有效凭据解析 memory，generation 取已采用块值，下一次成功压缩加一。

旧 v1 会话没有该凭据，不能靠标签区分真实框架块与用户贴出的同形文本。保守迁移：原始前缀仍按普通 user 原文保留到 anchor/userMessages，不据此排除任何原消息；可把完整的 v1 形状文本额外拷贝到 legacySummary 供只读参考并置 legacyIncomplete=true，但不能据此授予条目权威。首次新 v2 从 generation=1 建账，已有裁掉的原文不可恢复；若重复保护内容超预算则拒绝，而不丢原文。无凭据的 v2 也按普通 user 文本保护，不声称延续既有代次。只有有凭据而语法损坏、未知版本的块才触发 invalid_prior_memory，普通用户的相似标签不阻止压缩。resume 不为修复摘要而自动发请求。

v2 JSON 只在需要工作记忆时按新 schema 解析，session validator 继续验证普通 Message 内容的结构。日志和 metrics 不输出保护账本全文；可读摘要仅在既有卡片展开、show 和受用户控制的会话/归档中出现。`/clear`、`/reset` 清除历史即清除该记忆，不能从旧 archive 自动回灌。

回退边界：旧 CLI 的宽松标签识别和 truncate 路径不能保证 v2 连续性，不支持让旧程序继续压缩 v2 会话。发布说明要求保留升级前会话副本，回退时恢复该副本；只需临时读取 v2 会话时关闭压缩，不宣称它可安全往返写回。新实现关闭压缩是停用操作开关，不是磁盘格式回滚。

## 6. 接口设计与交互

### 6.1 命令与配置兼容性

不新增 REST、WebSocket、顶层 CLI 参数或 Core 公共导出。保留 `/compact`、`/compact <instructions>`、`/compact status`、`/compact on`、`/compact off`、`/compact threshold <0.5-0.95|percent>`、`/compact keep <1-20>`、`/compact history`、`/compact show <n>` 以及 `/context`。自由文本 instructions 只决定摘要关注点，不能要求删掉保护账本、重写权限或绕过 schema；超长 instructions 返回长度提示，不再静默 slice。

instructions 在命令入口按 trim 后 UTF-16 长度校验，最多 4,000；超长立即返回错误，不更新旧 pending、不创建新请求也不付费；空字符串等同无附加要求。指令文本计入摘要实际输入预算。

默认 threshold=0.9、warnThreshold 及 keepRecentTurns 保持现有配置；onFailure 默认 stop。`--no-compaction` 的未注册语义保持原状。本次不修改版本号、依赖锁文件或发布脚本。

### 6.2 新增 CLI 内部接口

| 接口 | 输入 | 输出与职责 |
| --- | --- | --- |
| `shouldCompactAt` | `(pressure: Pressure, threshold: number)` | boolean；唯一比例门槛 |
| `parseMemoryBlock` | `(message: Message)` | 只区分语法上的 none、v1、v2、invalid；宿主身份另验，不抛异常穿透 |
| `verifyMemoryIdentity` | `{ messages, identity }` | 检查宿主凭据及前缀 hash；不从用户正文自授身份 |
| `buildMemoryInput` | `{ before, plan, prior, generation, summarizerWindow }` | 保护内容、source map、digest 或有原因的拒绝 |
| `parseMemoryDelta` | `{ text, sources, prior }` | 已校验 additions 或错误字段路径 |
| `mergeMemory` | `{ prior, protectedUsers, delta, coverage, generation }` | 新对象；不修改 prior，不删除旧条目 |
| `renderMemoryMarkdown` | `(memory: CompactionMemory)` | 完整可读文本，预览限高交给 UI |
| `Compactor.onRunEnd` | `()` | 清理未消费手动请求 |
| `Compactor.onHistoryReplaced` | `()` | 提升 epoch，取消当前调用，清理 pending 与 staged 状态 |
| `Compactor.settleOperation` | `{ applied, reason?, tokensBefore, tokensAfter }` | wiring/child 当前唯一操作的真实 verdict；幂等提交账本或失效取消 |
| `ChildContextManager.onCompactionEnd` | `{ applied, reason?, tokensBefore, tokensAfter }` | 接收映射后的 Core 真实结果，结算 child 账本、计数与 meter |
| `CompactionWiring.compactNow` | 原参数对象加 `adopt(messages): void`、`isCurrent(): boolean` | 原 success/reason 结果，采用之后才结算 |
| `Controller.isCompactionBusy/subscribeCompactionBusy` | 查询或 listener | 同步公开本地操作锁状态，供 App 队列与 Esc 使用 |
| `Controller.getCompactionSessionState` | `()` | 同一同步快照的 messages 与可选 compactionIdentity |
| `Controller.replaceMessages` | 原 messages 参数加可选 identity | 历史与凭据一起恢复；缺字段则清除旧身份 |

新类型均使用 interface 描述对象；联合类型仅用于判别结果。buildMemoryInput/parseMemoryDelta/mergeMemory 通过明确 Result 联合传播错误，不让格式错误变成 `manager_threw`。

### 6.3 反馈与可观察性

`CompactionRecord` 增加可选 `decision: { occupied, contextWindow, threshold, source, deltaTokens }` 与 `memoryVersion?: 2`，仅 CLI 使用；Reducer 的 compaction Entry、session validation 及 exec 事件映射按可选字段传递，旧会话缺字段仍有效。manual 无须伪造达阈值理由，decision 只记录当时读数。

卡片第一行区分 `Automatic: threshold reached`、`Manual compaction`、`Overflow: threshold reached`。折叠显示原有 token 前后值和耗时，新增一行 `Task memory v2`；展开才展示记忆章节。不能将 before/after 差值为零或 applied=false 渲染为成功。80 列及更窄终端沿用布局降级，不新增弹窗、动画或焦点移动。

`/compact status` 移除 `or when headroom drops below one full response`，改为 `Automatic trigger: occupancy >= <threshold>; manual: /compact`。同时显示 `occupied / contextWindow` 的原始 token 整数、threshold token 数 `ceil(window * threshold)` 与两位小数百分比。`/context` 保持同一 snapshot，不另外计算 occupancy。

普通 pressure 的 below_threshold 不产生卡片、toast、compaction_start 或摘要调用，只允许 debug 日志；provider 已拒绝的 overflow 路径依 §3.4 给一次恢复提示。用户主动请求后的拒绝必须有一句可行动说明。格式、预算失败不说“已压缩”；提示 `History preserved: <reason>.`。仅记录 ID、generation、尺寸、trigger、applied、reason 与计数，默认日志不输出用户要求和工具内容。

## 7. 文件与模块变更计划

以下为下游应实施的目标清单；本评审节点实际只修订本 spec。名称以仓库相对路径为准。已有文件修改须保留原有无关内容。

| 文件 | 操作 | 单一意图 |
| --- | --- | --- |
| `docs/plans/context-compaction-integrity/spec.md` | 修订，本评审节点 | v2 设计、评审记录及验收契约 |
| `docs/plans/context-compaction-integrity/manual-test.md` | 新建，下游 | 记录 Windows 宿主、阈值、恢复和取消人工结果 |
| `packages/cli/src/compaction/pressure.ts` | 修改 | 比例成为唯一自动触发条件，移除无调用方的 headroom trigger helper |
| `packages/cli/src/compaction/meter.ts` | 修改 | 样本绑定前缀身份，避免 undefined 和旧 usage 污染 |
| `packages/cli/src/compaction/compactor.ts` | 修改 | 严格门槛、pending 生命周期、接入 v2、取消有损 fallback |
| `packages/cli/src/compaction/memory.ts` | 新建 | 数据类型、完整块解析、宿主合并和版本迁移 |
| `packages/cli/src/compaction/memory-input.ts` | 新建 | 保护账本、带来源 digest、预算与 source map |
| `packages/cli/src/compaction/memory-validation.ts` | 新建 | 严格 JSON、重复键、来源、supersession 和限额校验 |
| `packages/cli/src/compaction/memory-render.ts` | 新建 | schema 对象到固定 Markdown 章节的纯渲染 |
| `packages/cli/src/compaction/memory-identity.ts` | 新建 | CLI-local 宿主凭据、规范序列化及完整性复核 |
| `packages/cli/src/compaction/operation.ts` | 新建 | 有界操作、取消 race、操作所有权及幂等结算 |
| `packages/cli/src/compaction/digest.ts` | 修改 | 用严格前缀识别取代仅 startsWith；旧摘要保留兼容入口 |
| `packages/cli/src/compaction/summary-prompt.ts` | 修改 | v2 增量摘要提示、完整 anchor 和完整 JSON block |
| `packages/cli/src/compaction/summarize-call.ts` | 修改 | 摘要输入协议、输出预算和重试校验错误上下文 |
| `packages/cli/src/compaction/limits.ts` | 修改 | v2 常量、版本、限额与结构边界 |
| `packages/cli/src/compaction/wiring.ts` | 修改 | run 结束清理、手动采用后结算与实际 generation |
| `packages/cli/src/compaction/child.ts` | 修改 | 独立 meter、严格阈值与 preserve 失败策略 |
| `packages/cli/src/team/subagent.ts` | 修改 | 向 child manager 传递 Core 最终 compaction verdict |
| `packages/cli/src/compaction/command.ts` | 修改 | 精确触发说明、兼容配置提示与手动失败反馈 |
| `packages/cli/src/compaction/types.ts` | 修改 | CLI 可选 decision 与 memoryVersion 字段 |
| `packages/cli/src/agent/controller.ts` | 修改 | 手动操作锁、epoch、abort 与模型变更失效接线 |
| `packages/cli/src/ui/App.tsx` | 修改 | busy 状态下保留输入队列、阻止 drain、路由 Esc 与释放后恢复 |
| `packages/cli/src/commands/builtins.ts` | 修改 | TUI save/resume 透传同一快照的凭据 |
| `packages/cli/src/session/persist.ts` | 修改 | 可选凭据类型、输入与实际磁盘 payload |
| `packages/cli/src/session/store.ts` | 核对并按需修改 | exec 会话中转不得丢失凭据 |
| `packages/cli/src/exec/index.ts` | 修改 | exec 恢复及保存透传凭据 |
| `packages/cli/src/agent/reducer.ts` | 修改 | 透传新增可选卡片元数据 |
| `packages/cli/src/ui/entries/CompactionCard.tsx` | 修改 | 显示真实触发原因和 v2 展开摘要 |
| `packages/cli/src/config/schema.ts` | 修改 | onFailure 默认 stop，保留 legacy 值读取 |
| `packages/cli/src/session/validate-session.ts` | 修改 | 验证 Entry 可选元数据与 session 可选凭据形状 |
| `packages/cli/src/exec/events.ts` | 修改 | 定义 compaction 的可选 decision 与 memoryVersion |
| `packages/cli/src/exec/runner.ts` | 修改 | 从最终 CompactionRecord 透传新增字段 |
| `packages/core/src/engine/agent-loop.ts` | 修改 | 两条成功替换路径清除旧 lastUsage |
| `packages/cli/src/__tests__/compaction-pressure.test.ts` | 修改 | 边界、headroom 不触发、cache 口径 |
| `packages/cli/src/__tests__/compaction-compactor.test.ts` | 修改 | manual/pressure/overflow 真值表、保护失败和费用 |
| `packages/cli/src/__tests__/compaction-memory.test.ts` | 新建 | v2 schema、原文保护、来源与连续合并 |
| `packages/cli/src/__tests__/compaction-memory-input.test.ts` | 新建 | digest 预算、长消息、多模态及 clipping 覆盖 |
| `packages/cli/src/__tests__/compaction-memory-identity.test.ts` | 新建 | 伪造合法标签、会话往返与凭据损坏 |
| `packages/cli/src/__tests__/compaction-operation.test.ts` | 新建 | 忽略 signal 的传输、晚到结果及幂等结算 |
| `packages/cli/src/__tests__/compaction-busy-ui.test.tsx` | 新建 | 实际 App 发送、Esc 和队列 drain 行为 |
| `packages/cli/src/__tests__/compaction-session-roundtrip.test.ts` | 新建 | 真实 serializer 的 TUI/exec 保存恢复链路 |
| `packages/cli/src/__tests__/compaction-digest.test.ts` | 修改 | 旧块兼容与伪造前缀回归 |
| `packages/cli/src/__tests__/compaction-wiring.test.ts` | 修改 | 两阶段采用、取消、清理和实际 applied |
| `packages/cli/src/__tests__/compaction-child.test.ts` | 修改 | 子任务计量独立、不可 truncate、两次压缩额度及真实采用结算 |
| `packages/cli/src/__tests__/compaction-config.test.ts` | 修改 | 新默认及 legacy truncate 的明确兼容行为 |
| `packages/cli/src/__tests__/compaction-render.test.tsx` | 修改 | 真实原因、失败不报成功、窄终端 |
| `packages/cli/src/__tests__/compaction-quiet-noop.test.ts` | 修改 | 低占用完全安静，手动拒绝可见 |
| `packages/cli/src/__tests__/compaction-tail-relief.test.ts` | 修改 | CLI 不再调用有损 relief，保留纯 helper 本身测试 |
| `packages/cli/src/__tests__/compaction-archive.test.ts` | 修改 | 采用前不归档、v2 可读摘要与失败保留 |
| `packages/cli/src/__tests__/compaction-e2e.test.ts` | 修改 | 三代压缩、任务连续性及 save/resume |
| `packages/cli/src/__tests__/context-meter.test.ts` | 修改 | 跨 run、等长替换、splice、模型变化样本失效 |
| `packages/cli/src/__tests__/context-gauge-wiring.test.ts` | 修改 | 判断和显示共享同一个读数 |
| `packages/cli/src/__tests__/session-validation.test.ts` | 修改 | 新可选 Entry 字段与旧会话兼容 |
| `packages/cli/src/__tests__/exec-runner.test.ts` | 修改 | NDJSON 可选压缩证据与旧事件兼容 |
| `packages/cli/src/__tests__/controller-prompt-boundary.test.ts` | 修改 | 空闲手动操作锁、队列恢复与历史 epoch |
| `packages/core/src/__tests__/compaction-loop.test.ts` | 修改 | applied 后 probe 不携带旧 usage，工具结构保持 |
| `packages/cli/README.md` | 修改 | 更新触发、失败、结构记忆及恢复边界 |

`tail-budget.ts` 与 Core `compaction.ts` 的公共算法不必删除；CLI 主路径移除调用即可。所有旧测试中将“任意非空字符串摘要”视为成功的 fixture，必须替换为真实合法 MemoryDelta；不允许通过绕过 validator 维持绿灯。exec 的类型位于 `events.ts`，实际 compaction record 映射已确认位于 `runner.ts`，二者按表同步修改。

## 8. 实施顺序

1. 先补失败回归：50% 占用因 64k 输出预留触发、低于阈值 overflow、旧 usage 污染、失败摘要删除历史。断言模型调用次数及历史内容，而非只断言卡片消失。
2. 修改触发公式与 meter，保持 existing pressure/cache/offset 算术，补齐 Core 两个清理点、child meter 与手动生命周期。先运行定向测试。
3. 实现 memory 类型、严格解析、合并、来源校验、预算和渲染纯函数，再接摘要提示与候选构建；对旧 fixture 做协议升级。
4. 去除 CLI 的失败 truncation、overflow keep 减半与 tail relief，修改默认值及兼容说明；不可只隐藏卡片而继续删历史。
5. 调整手动 prepare/adopt/settle，统一 applied 与 generation、归档、计量的提交点；补取消和迟到结果测试。
6. 接入可选 UI/exec 元数据，核对 session 验证，完成三代压缩与恢复集成测试，最后更新用户文档和人工验收记录。

步骤 2 同时补齐 prompt/工具版本及窗口异步更新的失效；步骤 3 接入凭据与含图 tail 规划；步骤 5 接入 operation 模块及 App busy 订阅；步骤 6 必须走实际 saveSession/exec 写入入口验证凭据，而不只手工拼测试 JSON。scope 只覆盖这些正确性接线，不把大文件整体重构纳入交付。

每一步完成后保持旧公开 Core API 与 ESM import 扩展名规则。不要重构无关模型配置、版本发布、滚动或输入布局代码。

## 9. 测试与验收标准

### 9.1 自动化验收矩阵

| 编号 | 设置与操作 | 必须观察到的结果 |
| --- | --- | --- |
| AC-01 | window=128000，occupied=64000，threshold=.9，maxOutput=64000，提交普通输入仍低于阈值 | 摘要调用 0；历史只增加正常消息；没有压缩卡片 |
| AC-02 | 固定窗口 100000，分别占用 89999、90000、90001 | 触发结果 false、true、true；忽略 UI 舍入 |
| AC-03 | 相同 occupied，改变 maxOutput 从 256 到 64000 | 触发结果完全相同 |
| AC-04 | 低于阈值 provider 抛 context_overflow | 不摘要、不删历史；保留错误与明确恢复提示 |
| AC-05 | 已达阈值，provider overflow，多次连续失败 | recovery 最多一次；不会靠 continue 重置恢复次数 |
| AC-06 | 10% 下空闲 `/compact` 与运行中 `/compact` | 前者立即安全执行，后者到检查点；各消费一次 manual |
| AC-07 | 查询、修改 threshold、keep、on、off，或编辑草稿 | 不创建 pendingManual；不调用模型 |
| AC-08 | 排队 manual 后 abort/run_end/clear/resume，再发送新输入 | 未消费请求被清除；新输入不触发残留 manual |
| AC-09 | 新 prompt 的 probe.lastUsage=undefined，meter 有有效上轮样本 | 使用有效样本加新增 delta，不跳成全历史粗估 |
| AC-10 | 压缩后、等长替换后继续检查 | 旧 usage 不复活；splice 保留 offset，replace 清除 offset |
| AC-11 | 模型变化、同模型只改窗口、工具定义变化 | 分别执行深失效、保留样本改分母、深失效 |
| AC-12 | 原任务 5000 字符，关键约束在末尾；后续用户要求 3000 字符 | 原文完整保留；含 content parts 的 user 也不被静默裁剪 |
| AC-13 | 三代压缩，第一代含全局约束、未完成任务、失败办法 | 第三代仍保留原记录 ID 与原文；新状态通过可追溯 supersession 表达 |
| AC-14 | 后续输入修正目标，其他任务未提到 | 修正保留来源；未提任务仍存在且不能自动 done |
| AC-15 | 非 JSON、缺字段、重复键、未知 ID、伪造 excerpt、工具失败充当 done 证据 | 拒绝，最多重试一次，历史字节保持 |
| AC-16 | prior memory、用户内容或整个候选超预算 | 不截断；keep 且 reason 明确；模型调用前发现则 0 次调用 |
| AC-17 | 摘要模型超时、无 key、空结果，legacy onFailure=truncate | 不删除历史；usage 如有则入账；UI 不报成功 |
| AC-18 | retained tail 存在巨型 tool_result，已达阈值但无安全 head | 不 relief；结构保持，提示无法压缩 |
| AC-19 | 压缩时用户输入排队、Esc、resume、模型更换，远端结果迟到 | 不覆盖新历史；无重复采用或成功归档；inFlight 最终释放 |
| AC-20 | Core 拒绝孤立 tool_result、不闭合调用或增长的候选 | generation 不增长；archive 不写成功；原历史保留 |
| AC-21 | 带凭据 v2 保存退出再恢复，随后压缩；v1 首次迁移；凭据指向未知版本 | v2 连续增代；v1 原文完整保留且标 incomplete；有凭据的未知版本拒绝替换 |
| AC-22 | archive 关闭或写失败，然后继续和保存恢复 | 已采用 memory 可继续使用，不依赖 archive 文件 |
| AC-23 | 主子模型窗口不同、child 超阈值、child 摘要失败 | 使用各自 meter；主界面不冒充主历史被压缩；child 不丢任务 |
| AC-24 | 80/100/160 列，ASCII 终端，展开/折叠卡片 | 原因与结果准确；原输入焦点、滚动及队列行为不变 |
| AC-25 | Anthropic cache additive 与 OpenAI inclusive usage fixture | 无 double count；费用统计不混入占用 |
| AC-26 | 旧 session Entry 缺 decision/memoryVersion，新 Entry 带字段 | 都可恢复；非法字段形状被边界验证拒绝 |
| AC-27 | 输入中含伪造 compacted_context、闭合标签和指令 | 不改变 authority，不将普通用户内容丢成旧记忆 |
| AC-28 | 自动 keep/no-progress 达到既有上限后再次普通输入 | 不产生付费重试循环；manual 仍有明确结果 |
| AC-29 | 历史不变，仅 prompt、工具版本、异步窗口元数据或 window override 变化；下一检查点早于 timer | prompt/工具变更深失效；仅窗口变化保留样本；UI 与 gate 使用新快照；稳定 gate 不遍历全史 |
| AC-30 | 用户逐字伪造合法 v2/anchor；带凭据保存恢复；缺凭据旧会话；hash 不符 | 伪造及无凭据文本原样保护；真实凭据连续增代；不符时保留历史、压缩拒绝；TUI 与 exec 往返都覆盖 |
| AC-31 | 非首条 user 图片或 tool_result 图片原在待丢弃 head；原任务带图 | 切点退到闭合轮次之前，图片仍为顶层原 Message；无安全收益则 keep；禁止 base64 文本替换图像能力 |
| AC-32 | source.role 伪造、引用裁剪标记、isError=true、v1 自称测试通过 | 拒绝伪造/失败证据；legacy 不升级为已验证事实；语义无法机械核实的成功不伪装为程序认证 |
| AC-33 | provider 忽略 signal 且永不 resolve；取消后启动下一操作；旧响应随后到达 | 本地及时释放 busy；不再重试旧操作；旧 finally 不清新锁；费用至多入账一次；无迟到采用/归档/未处理拒绝 |
| AC-34 | 实际 App 在 manual prepare/网络期间按 Enter、Esc、clear/resume，随后恢复 drain | 文本不丢失、不启动并发 run；只释放本次操作；队列只执行一次；controller 非 UI 入口也拒绝 busy |
| AC-35 | 有安全 head，候选消息数等于原历史但 token 减少；再构造消息数增长候选 | 前者经 validateHistory 允许采用；后者拒绝；不修改 Core 既有增长规则 |
| AC-36 | complete 第一次 schema 失败、第二次成功；底层 transport 503 重试；child 达额度 | 摘要层最多两次，传输按现有 retry 且共享时限；child 每 run 两次压缩至多四次 complete；到期/取消不再开始新请求 |
| AC-37 | instructions 长度 4000/4001；转义后 memory 超限；重复转义键和 33 层 JSON | 边界分别接受/拒绝；超长不改变旧 pending；解析有界且拒绝重复键；预先可知预算错误不付费 |
| AC-38 | 三代有工具裁剪，第二代候选被 Core 拒绝；低阈值 pressure 后出现 overflow | coverage 只累计被采用的代次，不重复；取消不增 no-progress；pressure 安静，overflow 提示一次且保留原错误 |

连续性测试使用确定性 provider stub：每次返回预设增量，最终按结构解析读取 JSON，断言原始需求、所有旧 item 与状态来源仍在；不能只匹配自然语言关键词。再设模型漏报旧事项的 delta，证明宿主保留机制独立于模型表现。语义质量另用人工固定对话评估，不把 stub 全绿解释为真实模型绝不会漏事实。

### 9.2 下游执行命令

以下命令逐条执行并检查退出码，不使用 shell 链接符。它们是下游验证计划，本设计节点未执行业务测试。

```powershell
npm run test -w packages/cli -- src/__tests__/compaction-pressure.test.ts src/__tests__/compaction-compactor.test.ts src/__tests__/context-meter.test.ts
npm run test -w packages/cli -- src/__tests__/compaction-memory.test.ts src/__tests__/compaction-memory-input.test.ts src/__tests__/compaction-wiring.test.ts src/__tests__/compaction-e2e.test.ts
npm run test -w packages/cli -- src/__tests__/compaction-memory-identity.test.ts src/__tests__/compaction-operation.test.ts src/__tests__/compaction-busy-ui.test.tsx src/__tests__/compaction-session-roundtrip.test.ts
npm run test -w packages/core -- src/__tests__/compaction-loop.test.ts src/__tests__/compaction.test.ts src/__tests__/public-api.test.ts src/__tests__/no-host-coupling.test.ts
npm run typecheck
npm test
npm run build
```

若包间引用依赖已编译 Core，在运行 CLI 定向测试前先执行 `npm run build -w packages/core`。全量测试还必须覆盖 glyphs、queue、TUI 输入和 session 等既有契约。不得把原来依赖已废弃“提前触发/自动截断”的断言简单删掉；应改成新行为的明确反向断言。

### 9.3 人工与性能验收

在 Windows Terminal/PowerShell 与项目仍支持的传统 Windows console 各执行：阈值前普通输入、长粘贴跨阈值、运行中 manual、Esc 取消、三次压缩、保存退出恢复、旧会话迁移和窄窗口展开。记录 host、Node 版本、窗口来源、threshold、每次 before/after token 与是否 applied。自动化不能代替真实终端验收；没有执行的项写“待验证”。

以固定 1,000 条消息、约 200k 字符历史在同一机器预热后采样 100 次：稳定无新增消息的 gate 不进行全历史 stringify；不得新增低阈值模型请求；处理一个 32k memory 的解析与合并 P95 目标不超过 20ms。记录真实值与机器信息，若不满足先定位新实现，不通过调大阈值规避。每次压缩最多两次摘要层 complete 尝试，底层 HTTP 重试依 §4.5 共享时限；整体受 CLI 120s 与 Core 实际配置中较早者约束，取消后不得等远端自然超时才释放 UI。性能和真实模型质量没有实测数据时标记待验证；发布前必须补齐记录。

## 10. 风险与缓解

| 风险 | 影响 | 明确缓解与验收 |
| --- | --- | --- |
| 严格阈值遇到错误窗口或估算误差 | 阈值前 provider 可能拒绝请求 | 保留历史、显示窗口来源，提供 manual/校正窗口路径；AC-04 |
| 保护用户原文和旧条目持续增长 | 很长会话最终不能继续压缩 | 有界预算、提前拒绝、保留原会话；不承诺无限无损压缩；AC-16 |
| 模型首次抽取遗漏工具事实 | schema 合法但语义不全 | 原用户要求机械保留、工具来源与 coverage、固定真实对话评估；必要时从现有归档核对 |
| 增量错误地结束任务 | 后续 Agent 跳过未完成事项 | 原项不删、来源校验、仅带证据的状态链；宿主 TODO 仍独立权威 |
| 历史文本含提示注入 | 模型误把工具文字当新授权 | user-role 历史边界、显式非授权说明、不从 memory 修改宿主权限、保留来源角色 |
| 手动与 resume/取消并发 | 旧候选覆盖新任务 | 操作锁、epoch、adopt 后结算、迟到回调忽略；AC-19 |
| 旧格式已有信息损失 | 用户误以为迁移可补回原文 | legacyIncomplete 明示，完整保留仍可见的 v1；不虚构恢复 |
| 数据敏感性及磁盘保留 | 原始用户内容随会话/归档存在 | 仅既有用户数据目录、沿用存储控制、不新增外部服务或全文日志 |
| 兼容配置 truncate 的行为改变 | 用户旧配置与实际行为不一致 | 保留读取、status 清晰解释、失败时一次提示、README 明确迁移 |
| 测试大量依赖旧摘要 fixture | 假绿或绕过验证 | 统一合法增量 fixture，并单独测试 malformed 输出，禁止 mock validator |

## 11. 交付门槛

上游设计节点完成了规范初稿。本评审节点的完成条件是：只修改本 spec、版本明确为 v2、包含近顶部的评审记录和末尾的评审结论、所有 P0/P1 设计问题在正文解决，且未修改业务源码或执行 commit。完成后按任务工具登记“未改代码”的 logic 记录，最后上报并核对 Subtask #1 状态。

开发节点完成条件是：实现本规范、AC-01 至 AC-38 全部自动化覆盖，typecheck/test/build 通过并记录实际结果；真实终端、真实模型语义及性能验收另记结果，不得提前标通过。发布前补齐这些人工/性能证据与 v2 回退说明；它们是实施验收门槛，不是尚未解决的设计问题。版本发布、无关工作区变更以及其它 TUI 历史验收均不属于本节点已完成事项。

## 评审结论

**通过**。

v2 已解决本次发现的 9 项 P1 设计问题；无 P0、无未解决 P1。严格阈值与显式手动授权、保护原文与已入账记忆、失败保留历史、真实采用后结算均可在当前 TypeScript/Ink 与注入式 Core 架构内实现。新增模块仅承担可独立验证的解析、身份和操作生命周期职责，不新增外部服务或 Core 公共宿主类型。

本次仅进行了设计与源码一致性评审、文档结构和交付范围校验，没有运行或宣称通过尚未实现的业务验收。R-11 的终端、真实模型、性能和回退验证由下游按 §9、§11 执行；设计通过不等于实现完成或允许跳过发布门槛。

## 实施过程发现的方案缺陷

以下为开发节点实施中发现并修正的接线遗漏或契约歧义，不改变严格阈值、保护原文及真实采用后结算的产品规则。

1. **实际 Transcript 调用方遗漏。** `ui/Transcript.tsx` 手工选择 CompactionCard 参数，原文件计划仅改组件会使真实 TUI 丢失新增字段。补列该文件，透传 decision、memoryVersion，并通过实际 EntryView 的折叠/展开测试验证。
2. **旧 headroom helper 仍有独立调用方。** `tail-budget.ts` 的独立容量 API 仍引用 `requiredHeadroom`；保留此纯容量 helper，自动触发仅使用两参数 shouldCompactAt。CLI 压缩主路径不调用 tail relief，避免为了删除 helper 而扩大公共算法改动。
3. **关联模型测试 fixture 遗漏。** 补列 `packages/cli/src/__tests__/model-profile-runtime.test.ts`，将摘要改为真实合法增量；缺密钥路径从旧截断成功改为明确 keep，保留原账户、地址与请求次数断言。
4. **verification 的失败事实。** §4.2 允许记录工具实际失败输出；AC-32 的“拒绝失败证据”指不得把失败来源用于任务 done。verification 可以记录真实失败结果，但必须附实际工具来源。旧 v1 摘要原文仍完整保护，其只读来源不能成为用户验收、取消或目标修正的授权证据。
5. **费用归属必须随调用传递。** 仅传 usage 会把主模型重试和迟到费用按当前 fast 设置计价。CLI usage 增加可选实际模型与逐调用费用，snapshot 累计已知费用，贯通 child、App、status 与 exec；缓存读写 token 也累计。沿用既有计价规则，不增加 Core 字段或网络服务。补列 `app.test.tsx`、`exec-text-parity.test.ts` 的真实调用费用回归。
6. **工作区并非干净基线。** 开始时已有版本、依赖锁、项目指导提示与相关测试等修改，实施期间另有外部修改。开发节点保留这些内容，以 `.agentmesh/compaction-baseline.json` 的文件哈希及本任务文件清单区分交付，不以清理工作区为由回退他人工作。README 的既有内容保留。
7. **本地等待探针接口差异。** 本宿主对 file_exists 返回 `probe_template_not_supported_on_host`；实际 CLI 的 shell 形式须使用 `--probe-cmd`，与任务描述中的通用 `--probe-arg` 示例不同。验证命令写入 `.agentmesh` 日志，以实际进程退出码为验证依据，并持续上报进度。
8. **提示重建结构测试需要允许取消检查。** `skills-controller.test.ts` 原断言要求 setSystemPrompt 必须是方法首句；现在必须先检查 prompt 是否改变以取消过期候选。仅调整此结构断言，继续保证只有一个调用点且位于 rebuildSystemPrompt；保留该文件原有其他修改。
9. **验收期间有独立布局任务并发实施。** 本任务首次全量 test/typecheck/build 已通过后，`tui-stable-composer-status` 开始改写布局与状态栏公共接口，导致共享工作区后续全量复验失败。压缩专项及独立模块检查仍通过；不扩大本任务去接管另一方案。最终交接必须区分已验证快照与并发工作区状态，具体日志与复验结果记入 manual-test.md。

自动化验证结果和人工待验项记录在同目录 `manual-test.md`。新增内存、操作与持久化类型均为 CLI-local，不新增依赖，未执行 Git 提交。

## 最终代码审查补充

最终审查在既有方案内修复三处遗漏：每代摘要输入须携带完整原任务只读参考，计入预算但不进入新证据来源或 coverage；控制器须等待本地压缩结算完成再发布 busy=false；压缩期间排队的用户输入恢复执行时须初始化新轮次技能、提问额度、评审目标和 TODO，仍由 Core 单次消费原队列凭据。

65 文件功能快照完成全量验证：CLI 3,680 项、Core 549 项通过，6 项跳过；typecheck/build/启动通过。具体审查、提交隔离及人工验收边界见 `code-review.md` 与 `manual-test.md`。前文“未提交”描述设计、开发节点的交接状态，最终节点执行本地功能提交，不执行发布。
