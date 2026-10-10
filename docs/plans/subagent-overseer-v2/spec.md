# 方案设计：subagent-overseer-v2 — 子代理周期性监察与「超时即协助」机制

- **文档版本**: v2（设计评审节点修订；闭合 R-P0-1 / R-P0-2 及全部 P1，详见下方「评审记录」）
- **日期**: 2026-10-08（v1 方案设计）→ 2026-10-08（v2 设计评审）
- **需求来源**: 用户主任务「SUB Agent 机制修改完善」
- **涉及子系统**: `packages/cli/src/team/**`、`packages/cli/src/fast/**`（只读复用）、`packages/cli/src/config/schema.ts`、`packages/cli/src/ui/**`（团队面板）、`packages/cli/src/exec/**`
- **明确不动**: `packages/core/**`（零文件变更，遵守 `public-api.test.ts` 冻结与 `no-host-coupling.test.ts` 禁令）

---

## 评审记录（Review Notes）

- **评审人 / 日期**: 设计评审节点 · 2026-10-08
- **评审基线**: v1 正文 + 对当前工作区的逐文件核对（`team/{overseer,runtime,limits,types,report,subagent,task-tool,prompt,panel-rows}.ts`、`fast/{wiring,limits,review-call}.ts`、`config/schema.ts`、`ui/{App,TeamPanel}.tsx`、`exec/{events,runner}.ts`、`agent/controller.ts`）
- **评审维度**: 可行性 / 完备性 / 一致性 / 尺度合适性
- **结果**: P0 × 2、P1 × 6、P2 × 5。全部 P0/P1 已修复进 v2 正文；P2 中 4 项顺带修复、1 项保留为观察项。v1 现状审计的证据（G-1…G-6 的行号、常量与接口形状）经源码复核全部属实，仅 exec 一处基线失实（R-P1-1）。

### 发现清单

| 编号 | 严重度 | 维度 | 位置 | 问题 | v2 处置 |
| --- | --- | --- | --- | --- | --- |
| R-P0-1 | P0 | 可行性 | D-3 / §5.2 | 批量巡查一次要返回 ≤10 个决策对象，却沿用 `FAST_LIMITS.reviewOutputTokens = 512` 的输出上限：满配时每条平均约 50 token，而单查预算允许 `reason ≤ 200` 字符、nudge `guidance ≤ 1200` 字符，批量协议物理装不下；输出一旦截断，「首 `[` 到末 `]`」解析失败 → 全批 wait——恰在需求最针对的 10 子代理满配场景里，协助能力静默退化为只等不动。 | 已修复：新增 `TEAM_LIMITS.overseerBatchOutputTokens = 2_048` 与批量协议内更紧的 `overseerBatchReasonChars = 80` / `overseerBatchGuidanceChars = 400`（单查路径 512/200/1200 不变）；补截断回退与钳制测试（§7.1-2b/2c）。 |
| R-P0-2 | P0 | 一致性 | §3.1 vs D-4 / AC-1 / AC-2 / §7.1-4 | 激活门 `supervised = deps.overseer?.active() && team.overseer` 与 D-4「无论快速档是否可用都不硬杀」自相矛盾：dispatch 起点快速档即不可用时 `active()` 为 false → supervised=false → MonitorLoop 根本不会创建，「无人协助的等待」无从发生；且看门狗 ×4（`subagent.ts` 的 `overseerActive`）挂同一门上——门不修正则「无监督 + 无拉长 + 无降级通告」同时出现，AC-2 与测试 4 无法通过。 | 已修复：门改为「provider 在场 && 策略开」（`deps.overseer !== undefined && team.overseer`），`active()` 逐拍读取、只决定本拍 assisted / unassisted；×4 拉长随新门生效；provider 整体缺席的边界显式 documented（见 D-4 修订）。 |
| R-P1-1 | P1 | 一致性 | §1 / §2.1 / §4 / §5.3 | exec 基线失实：现状 `exec/runner.ts` 的 overseer 分支已发射 `label`/`action`/`trigger`/`reason`，`ExecTeamEvent` 已含这些可选字段。「NDJSON 增量字段 `action`/`reasonHead`」基于错误基线，会引导实现者做不存在的工作。 | 已修复：基线更正为「exec 已携带决策明细，v2 对 exec 零变更」；§4 两行移入「明确不改」。 |
| R-P1-2 | P1 | 完备性 | D-7 / §4 / §5.4 | 花费行要按快速档价格渲染，但 `buildDispatchReport` 只收主档 `cost`（`task-tool.ts` 经 `deps.modelCost()` 传入）；§4 未含 `task-tool.ts`、未扩展 `ReportOptions`——照表实施拿不到 fast 价格表。 | 已修复：`ReportOptions.fastCost?` + `TaskToolDeps.fastModelCost()` 接线（controller 一行，复用 `isPricedModel`/`getModelInfoFor` 既有模式）；未知价渲染 `pricing unknown`。 |
| R-P1-3 | P1 | 一致性 | D-4 / §5.3 / §5.4 | 以 reason 前缀作「unassisted-wait / supervisor-quiet」的机器信号，违反仓库「人类可读句子绝不能成为机器契约」的既有原则（`types.ts` 对 `run.error` 的既载规则）；且报告注记需从 outcome 读到该事实，前缀方案没有数据通道。 | 已修复：结构化承载——`OverseerIntervention['trigger']` 加性扩展 `'quiet'`；降级拍不进台账，`DispatchOutcome.overseerDegraded`/`overseerDegradedTicks` 边沿锁存；报告聚合注记；`TeamEvent` 联合体成员与既有字段形状零变更（见 D-10）。 |
| R-P1-4 | P1 | 完备性 | D-3 / §3.3 / AC-3 | 批量巡查与 silence 单查是两条并发触发路径；AC-3 要求「单 label 最多一次在飞巡查」，但 §8 风险 3 只覆盖批量对批量的单飞，同 label 单查在飞时拍点到期的行为未定义。 | 已修复：`inspectBatch` 跳过处于 inFlight 的 label（该子代理本拍无决策、阶梯不动、不耗看预算）；批量调用自身受 dispatch 级单飞保护；补测试（§7.1-4e）。 |
| R-P1-5 | P1 | 完备性 | D-3 / §3.1 / §3.2 / §6 | `collectLiveRuns()` 的「存活」若含 `queued` 子代理：默认 `maxConcurrent: 3`、满配 10 时首批 digest 会装进 7 个从未启动的子代理——白耗看预算、稀释 digest，还可能招来对排队者的无意义 nudge。 | 已修复：节拍巡查仅覆盖 `startedAt` 已置且未终局者；每子代理阶梯随其实际 start 武装（对齐 `ChildSupervisor.start()` 现行为）；补测试（§7.1-4d）。 |
| R-P1-6 | P1 | 尺度合适性 | D-5 / §6 | 派发级看预算 60 在满配长任务下重新制造 G-1：10 子代理 × 每拍全员各 1 look → 6 拍（约 75 min）耗尽，整队监察静默到任务结束，与「长任务不再没人看」的立意冲突。 | 已修复：派发总额改为 `hardMaxSubagents × overseerMaxLooksPerChild = 120`（数学上界、纯防呆上限），实际约束由 per-child 预算先行生效。 |
| R-P2-1 | P2 | 尺度合适性 | §4 | controller 行原内容大半不必要：`overseerIntervalMs` 应由 `dispatch()` live 读 `config.team`（与 `subagentTimeoutMs` 同路）；监察 usage 可由 runtime 直读 `deps.overseer.usage()`。 | 已顺带修复：行收窄为仅 `fastModelCost` 接线（R-P1-2 所需）。 |
| R-P2-2 | P2 | 尺度合适性 | §4 | `subagent.ts` 行不必要：`overseerActive` 已存在；`lastIntervention` 由 runtime 的 `recordIntervention` 维护即可。 | 已顺带修复：行移除，归入「明确不改」。 |
| R-P2-3 | P2 | 一致性 | §6 | `lastIntervention.atSec` 用 dispatch 相对秒，与 `SubagentRun` 其余时间戳（`startedAt`/`endedAt`，绝对 epoch ms）口径不一，面板需二次换算。 | 已顺带修复：改为绝对 `at: number`。 |
| R-P2-4 | P2 | 一致性 | §5.4 | 台账行示例 `[12m] label nudge: reason` 与现状实现 `[clock 300s] label: nudge - reason` 不一致。 | 已顺带修复：示例对齐实现。 |
| R-P2-5 | P2 | 完备性 | §5.2 | 每子代理 digest 由单查 8 000 B 收窄至 1 200 B（6.7×），记忆与历史尾最先被裁，裁剪顺序未写明。 | 保留观察：v2 已注明沿用「事实先行、历史尾殿后」的既有裁剪序；若批量决策质量下降，先调 `overseerPerChildDigestBytes` 而非放宽整批上限。 |

### 核对说明

- §2.2 六项差距的现状证据逐条复核属实（`TEAM_LIMITS.overseerMaxInspectionsPerChild = 4`、`runtime.ts` 的 `!supervised && subagentTimeoutMs > 0` 分支、`ui/App.tsx:841`、`fast/wiring.ts:311` 等）。
- D-1 / D-2 / D-6 / D-9 与仓库既有架构约束（Core 公共 API 冻结、零 host 耦合、`pickGlyphs` ASCII 扫描、`limits.ts` 结构常数与 `config/schema.ts` 策略键二分）核对无冲突。
- AC-11 数值复算：巡查时刻 300 → 480 → 768 → 900（封顶）…，60 min 内共 5 拍 ≤ 8，成立。

---

## 1. 概述（Overview）

本项目是一个终端 TUI 编码代理（AragonAgent），其团队模式允许主代理通过一次 `task` 工具调用 fan-out 一批短命子代理并行工作。仓库中已经存在第一代监察机制 team-overseer（commit `a1ca2297f`）：当子代理越过时间触发点（事件静默或墙钟检查）时，由一个运行在快速模型档（fast tier）上的有界 `complete` 调用做出 wait / nudge / replace / abandon 四种决策，且「被监察的子代理不再挂硬性墙钟」。这已经实现了需求的骨架，但审计发现六个尚未闭合的缺口：监察不是真正的周期性（每个子代理每次 dispatch 只有 4 次巡查预算，耗尽即静默）；快速档不可用时回退到旧式硬超时击杀，与「不需要超时硬约束」直接矛盾；每次巡查只看一个子代理，没有跨子代理的整体视野；监察决策在 TUI 里几乎不可见（仅刷新快照，用户要等最终报告才知道发生过什么）；监察调用自身的 token 花费没有进入任何账目；失败的巡查调用同样消耗巡查预算（fail-soft 的 wait 也计数）。

本方案（v2）把监察者从「事件驱动的单点检查器」升级为「每次 dispatch 专门拉起、按节拍周期巡视全部存活子代理的监察代理」。它仍然运行在快速模型上，但巡查变成有节奏的批量巡检：一次快速模型调用同时审视最多 10 个存活子代理（受 `hardMaxSubagents` 结构上限保护），返回逐子代理的决策数组；节拍按阶梯递增（默认 5 分钟起步、1.6 倍递增、15 分钟封顶），健康的慢子代理只需对数级别的巡查次数，长任务不再「看着看着就没人看了」。同时，需求中「超时了以后，由监察 subagent 进行协助」被推到极致：只要 `team.overseer` 开启（默认），`subagentTimeoutMs` 在任何情形下都不再直接终止子代理——快速档缺失时降级为「无人协助的等待」（记一条通告、按节拍续期、绝不击杀），唯一保留的硬终止是用户显式 Esc、用户显式设置的 `dispatchTimeoutMs` / `maxTurnsPerSubagent` 全局上限、子代理自身的（监察门开时 4 倍拉长的）空闲看门狗兜底，以及监察者自己的 abandon / replace 裁决。

「监察 subagent 自身使用快速模型即可」由既有的 `createFastOverseerProvider` 满足并保持不变：单次 `complete`、无工具、thinking 关闭、temperature 0、墙钟 20 秒——输出限在单查路径为 512 token、批量路径为 `overseerBatchOutputTokens`（2 048，见 D-3/R-P0-1）——一个自己会挂死的监察者需要第二个监察者，这是本设计拒绝的回归。用户体验上，本方案补齐实时可见性：团队面板为每个子代理行渲染最近一次监察动作的小徽记（如 `nudged 2m`），replace / abandon 发生时在转录里落一条有界通告，`aragon exec` 的 NDJSON 流**现状已**携带 overseer 决策明细（`label`/`action`/`trigger`/`reason`；经评审核对为 R-P1-1，v2 对 exec schema 零变更、仅回归验证），最终报告新增监察花费行，使「谁在什么时候被监察者做了什么、花了多少」成为一条完整可审计的链路。整体目标是 Anthropic 级的产品质感：等待变得可读、干预变得可解释、花费变得可核对，而子代理的能力上限不因监督而受损。

---

## 2. 现状审计（差距基线）

以下结论来自对当前 `main` 的逐文件审计，是本方案所有改动的依据。

### 2.1 已存在且保持不变的资产

| 资产 | 位置 | 状态 |
| --- | --- | --- |
| `TeamOverseer`（记忆、预算、单飞锁） | `team/overseer.ts` | 保留，扩展 |
| 四种动作 `wait/nudge/replace/abandon` | `team/types.ts` | 保留，语义不变 |
| 快速档传输 `createFastOverseerProvider` | `team/overseer.ts` | 保留，复用 `completeViaFastRegistry` |
| `ChildSupervisor` 双软定时器（silence + clock） | `team/runtime.ts` | 重构为节拍循环 + 保留 per-child silence |
| nudge 经 `agent.steer()` 在安全检查点注入 | `team/runtime.ts` `applyDecision` | 保留（I-OV4 不向已请求 abort 的子代理注入） |
| replace 携带修正简报（`buildReplacementPrompt`） | `team/overseer.ts` | 保留，预算 1 不变 |
| 死后一次 post-mortem 检查 | `team/runtime.ts` `maybePostMortem` | 保留 |
| 报告 Overseer 台账小节 | `team/report.ts` `buildOverseer` | 保留，追加花费行 |
| `TeamEvent 'overseer'` / `ExecTeamEvent subtype:'overseer'` | `team/types.ts` / `exec/events.ts` | 保留；exec 载荷已含 `label`/`action`/`trigger`/`reason`，v2 对 exec 零变更（R-P1-1 更正），仅 `trigger` 值域加性扩展 |
| `team_wait` / 人审队列的「合法阻塞」豁免（I-OV3） | `runtime.ts isBlocked` | 保留 |

### 2.2 差距（本方案要闭合的缺口）

| # | 缺口 | 现状证据 | 需求条款 |
| --- | --- | --- | --- |
| G-1 | 巡查预算 4 次/子代理，耗尽后监察静默，长任务失去监督 | `TEAM_LIMITS.overseerMaxInspectionsPerChild: 4`；`inspectAndApply` 中 `decision === null` 即 `supervision.clear(label)` | 「专门负责定期监督」 |
| G-2 | 快速档不可用（无 key / `/fast off` / provider 缺席）且 `subagentTimeoutMs > 0` 时，回退为硬击杀 | `runtime.ts` `!supervised && subagentTimeoutMs > 0` 的 legacy 定时器 | 「不需要超时硬约束」 |
| G-3 | 每次巡查一个子代理一次调用，最多 10 子代理 = 10 次快速调用，且无跨子代理视野 | `TeamOverseer.inspect` 单 digest 单决策 | 「专门有一个监察 subagent 监督这些各个 subagent」 |
| G-4 | 监察决策 TUI 实时不可见：`App.tsx` `case 'overseer'` 仅重读快照 | `ui/App.tsx:841` | 顶级人机交互 |
| G-5 | 监察调用花费不进账：`completeViaFastRegistry` 的 usage 无人收集 | `fast/wiring.ts:311` | 诚实记账（项目一贯原则） |
| G-6 | 失败的巡查调用同样消耗 4 次预算（fail-soft 为 wait 也计数） | `TeamOverseer.inspect` 无差别 `inspections.set` | 稳健性 |

---

## 3. 技术设计（Technical Design）

### 3.0 关键决策（D-x，与仓库既有决策编号风格一致）

- **D-1 监察者不是 Agent 循环，而是「无循环的有界被记忆调用者」**。需求说「专门有一个监察 subagent」；本设计用「每次 dispatch 专属、带跨巡查记忆、按节拍周期醒来、跑在快速模型上」的监察者满足它，而不是真的 `Agent.prompt()` 循环。理由：(a) 一个自己会挂的监察者需要第二个监察者，无限回归；(b) Core 公共 API 冻结与零 host 耦合测试使 `packages/core` 不可动；(c) 无状态调用 + 外置记忆在进程崩溃恢复语义上更简单。该偏离在文档与代码头注释中显式声明。
- **D-2 节拍阶梯（cadence ladder）取代「首次墙钟 + 模型自选」**。首个巡检点 = `team.overseerIntervalMs > 0 ? overseerIntervalMs : TEAM_LIMITS.overseerDefaultCheckMs`（300 s）；此后每次无动作巡检按 `overseerCadenceRatio`（1.6）递增，封顶 `overseerNextCheckMaxMs`（900 s），下限 `overseerNextCheckMinMs`（60 s）。模型仍可在 wait 决策里给出 `nextCheckMs`，钳制到同一区间后**覆盖**阶梯值（保留第一代的自适应能力）。任一动作（nudge/replace/abandon）把该子代理的阶梯重置回基准档。健康慢任务的巡查次数随时长按对数增长。
- **D-3 批量巡查（batched tick）**。节拍到期时，监察者把**全部存活子代理**合成一个 digest（每子代理切片 ≤ `overseerPerChildDigestBytes` 1 200 B，整批 ≤ `overseerBatchDigestBytes` 12 000 B），一次快速调用返回 JSON 决策数组 `[{label, action, reason, guidance?, nextCheckMs?}, ...]`。`hardMaxSubagents = 10` 保证一批永远装得下；digest 构造按 label 排序保证可测可复现。**批量调用的输出预算独立于单查**（R-P0-1）：`maxTokens = TEAM_LIMITS.overseerBatchOutputTokens`（2 048；单查路径维持 `FAST_LIMITS.reviewOutputTokens = 512` 不变），且批量协议内 `reason` 钳至 `overseerBatchReasonChars`（80）、`guidance` 钳至 `overseerBatchGuidanceChars`（400）——10 条决策 × 约 80 token 必须完整装得下，否则输出截断会让「首 `[` 到末 `]`」解析失败、全批退化为 wait，恰好在满配场景废掉协助能力。事件静默触发仍是**单子代理**立即检查（对卡死快速反应），两者共用 `applyDecision` 应用路径；`collectLiveRuns()` 只收 `startedAt` 已置且未终局的子代理，`queued` 不入（R-P1-5）；`inspectBatch` 跳过处于单查 inFlight 的 label（R-P1-4，见 D-5）。
- **D-4 超时永非死刑（no-kill-by-default）**。**激活门 = provider 在场且策略开**：`supervised = deps.overseer !== undefined && team.overseer`（R-P0-2 修正——`active()` 不再是门的一部分，改为逐拍读取，只决定本拍是 assisted 巡查还是 unassisted 等待；v1 的 `deps.overseer?.active() && team.overseer` 会让「起点即无快速档」的 dispatch 连 MonitorLoop 都不创建，与下述承诺矛盾）。门开后：无论快速档是否可用，`subagentTimeoutMs` 不再武装任何硬 abort；子代理看门狗 ×4（`subagent.ts` 的 `overseerActive`）随该门生效——无协助等待时它更是唯一兜底。快速档缺席（起点即缺席或中途 `/fast off`）时节拍触发降级为「无人协助的等待」：每个存活子代理照常走 `TeamEvent 'overseer'`（action = wait，正常 label），但**不**计入 interventions 台账；首次降级在 `DispatchOutcome.overseerDegraded` 边沿锁存（另计 `overseerDegradedTicks`），报告聚合为一条注记（R-P1-3：不用 reason 前缀做机器信号，见 D-10）。silence 触发路径在快速档缺席时保持安静（沿用现有 null → clear 语义，靠 ×4 看门狗兜底），不刷降级通告。provider 整体缺席（会话无 fast 接线，`deps.overseer === undefined`）且 `team.overseer: true`：无 MonitorLoop、无硬定时器、无通告，子代理靠自身**未拉长**的空闲看门狗兜底——此边界行为在 README 标注。`team.overseer: false` 时保留完整 pre-feature 旧制（`subagentTimeoutMs` 硬 abort）作为显式逃生舱，文档标注 legacy。子代理仍会死于：用户 Esc / dispatch abort；用户显式设置的 `dispatchTimeoutMs`、`maxTurnsPerSubagent`；子代理自身空闲看门狗（监察门开时 `idleTimeoutMs × overseerWatchdogFactor(4)`）；监察者 abandon；replace 的技术性 abort。
- **D-5 预算语义拆分（look vs action）**。看预算（`overseerMaxLooksPerChild: 12`，另加每 dispatch 总看预算 `overseerMaxLooksPerDispatch = hardMaxSubagents × overseerMaxLooksPerChild = 120`，R-P1-6——数学上界、纯防呆上限，实际约束由 per-child 预算先行生效，避免满配长任务约 75 min 就整队静默）只管成本；动作预算管突变：nudge ≤ `overseerMaxNudgesPerChild: 3`、replace ≤ 1（不变）、abandon ≤ 1（新增，防反复击杀）。传输失败（fail-soft wait）计入看预算但**不**计入任何动作预算（闭合 G-6）；被 R-P1-4 跳过的 label（单查在飞）同样不耗看预算。per-child 看预算耗尽时对该子代理发一条「监察转入静默」通告事件并计入 interventions（`trigger: 'quiet'`，见 D-10）后停止其巡查；dispatch 总额（仅防呆）耗尽时整队 MonitorLoop 停止并发一条聚合通告。阶梯让耗尽变得罕见。
- **D-6 看门狗权衡（显式记录，不改 Core）**。子代理的空闲看门狗在构造时固定（`subagent.ts` `timeouts.idleTimeout`），监察者的 wait 祝福无法延长它。本设计接受该权衡：4 倍拉长 + 死后 post-mortem 检查兜底；「Core 增加 `renewIdleWatchdog()`」列为未来可选，不在本方案范围（会破坏零 Core 变更约束）。
- **D-7 诚实记账**。`OverseerProvider` 的实现把每次调用的 `AssistantMessage.usage` 累加进 per-dispatch 台账（沿用 `fast/review-call.ts` 的 `usageOf`/`accumulateUsage` 已验证读取路径）；runtime 在 dispatch 结束时直读 `deps.overseer.usage()`（R-P2-1：不经 controller 转发，避免第二口径），`DispatchOutcome` 增加可选 `overseerUsage` / `overseerCalls`。报告脚注按快速档价格表渲染——价格表经 `ReportOptions.fastCost` 传入、由 `TaskToolDeps.fastModelCost()` 提供（R-P1-2：`buildDispatchReport` 现只收主档 `cost`，不补此接线则拿不到 fast 价格）；价格未知时遵循「未知定价不是零定价」规则显示 `pricing unknown`，不显示 `$0.00`。状态栏不新增字段（团队花销已由 `usage` 事件按主档汇报，监察花销属于快速档，混入会制造两个口径）。
- **D-8 配置键职责分离**。新策略键 `team.overseerIntervalMs`（0 = 结构默认 300 s，钳制 0..3 600 000）专属监察节拍；`subagentTimeoutMs` 在 overseer 开启时降级为 legacy 键。生效优先级（只读推导，不改写用户磁盘配置）：`overseerIntervalMs > 0` 优先；否则若 `subagentTimeoutMs > 0` 采用其值（兼容老用户把它当触发点用的习惯）；否则结构默认。`/config` 文档与 `packages/cli/README.md` 同步更新。
- **D-9 提示词版本化**。批量协议的系统提示更新，并新增 `OVERSEER_PROMPT_VERSION = 'v2-2026-10'` 常量（`TEAM_BLOCK_VERSION` 只覆盖 lead 的 `<team>` 提示块，不覆盖监察者自身提示），行为报告可 grep 定位。
- **D-10 合成通告结构化（R-P1-3）**。「无人协助的等待」与「监察转入静默」不用 reason 前缀做机器信号——本仓库既载原则：人类可读句子绝不能成为机器契约（`types.ts` 对 `run.error` 的规则）。降级拍：per-child wait 事件照发（供 exec NDJSON 与面板刷新），但**不**进 interventions 台账，聚合事实由 `DispatchOutcome.overseerDegraded` / `overseerDegradedTicks` 边沿锁存，报告渲染一条注记。静默：计入 interventions，`OverseerIntervention['trigger']` 加性扩展 `'quiet'`。`TeamEvent` 联合体成员与既有字段形状零变更（AC-7 措辞不变）；exec 的 `trigger` 本就是透传字符串，新值自动可见，exec schema 零变更。

### 3.1 架构与关键代码路径

```
TeamRuntime.dispatch()
  ├─ normalizeSubagentSpecs()                    (不变)
  ├─ makeHandle() / buildSubagentTools()         (不变)
  ├─ supervised = deps.overseer !== undefined && team.overseer   (R-P0-2: active() 逐拍读)
  ├─ [新] MonitorLoop 实例（节拍阶梯 + 批量 digest + 批量决策应用）
  │     ├─ 首拍: firstCheckMs（D-8 优先级；随子代理实际 start 武装，R-P1-5）
  │     ├─ 每拍: collectLiveRuns()（仅 startedAt 已置且未终局者，queued 不入）
  │     │         → buildBatchDigest() → provider.inspectBatch()（maxTokens=overseerBatchOutputTokens）
  │     │         → 跳过 inFlight 中的 label（R-P1-4；本拍无决策、阶梯不动、不耗看预算）
  │     │         → for each {label, decision}: applyDecision()   (复用现有路径)
  │     └─ 快速档缺席: unassistedWait() → 降级事件 + degraded 锁存 + 续拍（D-4/D-10）
  ├─ ChildSupervisor (重构保留): 仅 silence 窗口 per-child
  │     └─ fire('silence') → isLegitimatelyBlocked? re-arm : 单子代理 inspectAndApply()
  ├─ worker() → runOne()                          (不变, 除: 删除 !supervised 硬定时器分支→
  │                                              由 D-4 的 legacy 分支取代: 仅 overseer:false 时武装)
  └─ dispatch 结束: 清定时器、MonitorLoop.dispose()、outcome 附 interventions + overseerUsage + overseerDegraded
```

`TeamOverseer` 类职责调整：`inspect(req)` 单子代理接口保留给 silence 触发；新增 `inspectBatch(reqs): Promise<Map<string, OverseerDecision>>`，内部一次 provider 调用、逐条 `normalizeOverseerDecision`（repair-never-reject：解析失败的条目落 wait，绝不抛出）、逐条写记忆与预算。`OverseerProvider` 接口增加 `inspectBatch(req: { label, goal, digest }[]): Promise<unknown>`（原始返回由 `TeamOverseer` 归一化）；默认实现把数组序列化进同一个系统提示。

### 3.2 操作时序（一次典型 dispatch）

1. `dispatch()` 归一化规格、构建子代理（监察门开则看门狗 ×4，D-4），`MonitorLoop` 创建；每子代理的节拍阶梯与 silence 窗口都在该子代理**实际 start** 时武装（首拍 `firstCheckMs`，D-8 优先级；R-P1-5——`queued` 子代理不产生巡查、不占 digest、不耗看预算）。
2. 子代理流式产出事件 → 每个真实事件 kick silence 窗口与自身看门狗。
3. **静默路径**：某子代理 `idleTimeoutMs` 无事件 → 若 `isLegitimatelyBlocked`（`team_wait` / 人审队列）静默续期；否则单子代理巡查 → 决策应用。
4. **节拍路径**：阶梯到期 → 收集存活子代理（仅已启动未终局者，R-P1-5）→ 批量 digest → 一次快速调用（`maxTokens = overseerBatchOutputTokens`，D-3）→ 按数组顺序逐个应用（wait 续拍/覆写 nextCheck、nudge steer、replace 置 verdict+abort、abandon 置 verdict+abort）；处于单查 inFlight 的 label 本拍跳过（R-P1-4）。
5. 决策应用点统一走 `applyDecision`（现有守卫全保留：settled 检查、aborted 检查、nudge 的 `isAborted()` 守卫、replace 预算先行检查防双重建）。
6. 子代理终局：正常结束 / 看门狗死亡（触发一次 post-mortem 巡查，可能一次 replace 重建）/ 监察 verdict 终止。verdict 消费后不清除（现有语义）。
7. 全部终局 → `dispatch_end`：`DispatchOutcome` 携带 `runs`、`interventions`、`overseerUsage`、`overseerCalls`、`overseerDegraded` → 报告渲染 Overseer 台账 + 花费行 + 聚合注记。

### 3.3 序列图（节拍巡查，文本形式）

```
MonitorLoop        TeamOverseer       FastOverseerProvider   TeamRuntime/Child
   | tick 到期          |                     |                     |
   |──collectLive──────▶|                     |                     |
   |   buildBatchDigest |                     |                     |
   |──inspectBatch─────▶|──inspect(array)───▶▶| completeLLM (fast)  |
   |                    |  normalize 每条      |   ≤20s, ≤2048tok(batch)     |
   |◀──Map<label,dec>───|◀────────────────────|                     |
   |  for each: applyDecision ──────────────────────────────────────▶| steer/verdict/abort
   |  ladder = dec.nextCheckMs ?? ladder*1.6 (clamp)                |
   |  emit TeamEvent 'overseer' × n  (每个已应用决策一条)             |
```

---

## 4. 文件 / 模块变更计划

| 文件 | 动作 | 一句话意图 |
| --- | --- | --- |
| `packages/cli/src/team/overseer.ts` | 修改 | 批量 digest 构建、批量决策解析（JSON 数组、repair-never-reject）、看/动作预算拆分、`OVERSEER_PROMPT_VERSION`、usage 回传统道 |
| `packages/cli/src/team/runtime.ts` | 修改 | `MonitorLoop`（节拍阶梯）；删除 `!supervised` 硬定时器、改为 `overseer:false` 专属 legacy 分支；unassisted-wait 降级；监察预算耗尽通告；`overseerUsage` 汇入 outcome |
| `packages/cli/src/team/limits.ts` | 修改 | 新结构常数：`overseerCadenceRatio`、`overseerPerChildDigestBytes`、`overseerBatchDigestBytes`、`overseerBatchOutputTokens`、`overseerBatchReasonChars`、`overseerBatchGuidanceChars`（R-P0-1）、`overseerMaxLooksPerChild`、`overseerMaxLooksPerDispatch = hardMaxSubagents × overseerMaxLooksPerChild`（R-P1-6）、`overseerMaxNudgesPerChild`、`overseerMaxAbandonsPerChild`；移除 `overseerMaxInspectionsPerChild` |
| `packages/cli/src/team/types.ts` | 修改 | `OverseerIntervention['trigger']` 加性扩展 `'quiet'`（D-10）；`SubagentRun.lastIntervention?`（瞬态，绝对 ms，R-P2-3）；`DispatchOutcome.overseerUsage?/overseerCalls?/overseerDegraded?/overseerDegradedTicks?`；`TeamEvent` 联合体成员不变（`OverseerProvider` 接口本体在 `overseer.ts`，见上行） |
| `packages/cli/src/team/report.ts` | 修改 | `ReportOptions` 增 `fastCost?: ModelCost`（R-P1-2）；Overseer 台账后追加监察花费行（按 `fastCost` 计价、未知价显示 `pricing unknown`）；降级/静默各渲染一条聚合注记（D-10） |
| `packages/cli/src/team/task-tool.ts` | 修改 | `TaskToolDeps` 增 `fastModelCost(): ModelCost \| undefined`，报告调用传入 `fastCost`（R-P1-2） |
| `packages/cli/src/config/schema.ts` | 修改 | 新策略键 `team.overseerIntervalMs`（钳制+默认 0）；`subagentTimeoutMs`/`overseer` 的 docstring 更新为 D-4（v2 修订语义）/D-8 |
| `packages/cli/src/agent/controller.ts` | 修改 | 仅一处：为 task-tool 接线 `fastModelCost`（复用 `this.fast.fastRef()` + `isPricedModel`/`getModelInfoFor` 既有模式，R-P1-2/R-P2-1；`overseerIntervalMs` 由 `dispatch()` live 读 config，不经 deps；监察 usage 由 runtime 直读 provider） |
| `packages/cli/src/ui/TeamPanel.tsx`（或团队面板所在文件） | 修改 | 每行最近监察徽记（`nudged 2m` 等，glyph 走 `pickGlyphs`）；面板激活时监察状态行；遵循 ASCII 扫描约束 |
| `packages/cli/src/ui/App.tsx` | 修改 | `case 'overseer'`：除刷新快照外，replace/abandon 落一条有界 `notice` 转录条目（wait/nudge 不落，防噪音） |
| `packages/cli/README.md` | 修改 | 团队章节：周期监察、no-kill 语义、新配置键、provider 整体缺席边界（D-4）、legacy 逃生舱说明 |
| `packages/cli/src/team/*.test.ts`（新增/扩展） | 修改 | 见 §7 测试计划 |
| `docs/plans/subagent-overseer-v2/spec.md` | 本文件 | 设计文档 |

**明确不改**：`packages/core/**` 全部；`fast/wiring.ts`、`fast/limits.ts`、`fast/resolve.ts`（只读复用）；`exec/events.ts`、`exec/runner.ts`（overseer 载荷已齐，R-P1-1，仅回归验证）；`team/subagent.ts`（`overseerActive` 已在，`lastIntervention` 由 runtime 的 `recordIntervention` 维护，R-P2-2）；`team/bus.ts`、`team/human-queue.ts`、`team/comm-tools.ts`（豁免逻辑已正确）；`team/prompt.ts`（lead 提示块无涉）。

---

## 5. 接口设计

### 5.1 配置（`config/schema.ts`，POLICY 层）

```ts
interface TeamConfig {
  // ...既有键不变...
  /**
   * 监察节拍基准（毫秒）。0 = 结构默认 (TEAM_LIMITS.overseerDefaultCheckMs = 300_000)。
   * 生效优先级: overseerIntervalMs > 0 ? 它 : (subagentTimeoutMs > 0 ? 它 : 结构默认)。
   * 仅当 team.overseer 为 true 时有意义。
   */
  overseerIntervalMs: number;   // clampIntAllowingZero(0 .. 3_600_000), default 0
}
```

`subagentTimeoutMs` docstring 改为：overseer 开启时仅作首拍兼容来源，永不直接 abort；仅 `team.overseer: false` 的 legacy 制下恢复硬 abort 语义。

### 5.2 监察者接口（`team/overseer.ts`）

```ts
export interface OverseerProvider {
  active(): boolean;
  /** 单子代理巡查（silence 触发路径，保留第一代行为）。不抛。 */
  inspect(req: { label: string; goal: string; digest: string }): Promise<OverseerDecision>;
  /** 批量巡查（节拍路径）。返回原始值，由 TeamOverseer 归一化。不抛。 */
  inspectBatch(req: ReadonlyArray<{ label: string; goal: string; digest: string }>): Promise<unknown>;
  /** [新] 该 provider 的累计 usage（诚实记账，D-7）。 */
  usage(): TokenUsage;
}

// TeamOverseer 新增：
inspectBatch(reqs: OverseerInspectRequest[]): Promise<Map<string, OverseerDecision>>;
```

批量系统提示（`OVERSEER_PROMPT_VERSION = 'v2-2026-10'`）要求模型只输出一个 JSON 数组，每元素 `{"label","action","reason","guidance?","nextCheckMs?"}`；解析取首个 `[` 到末个 `]`；单条解析失败该条落 wait，其余照常（repair-never-reject）。批量调用 `maxTokens = TEAM_LIMITS.overseerBatchOutputTokens`（2 048；单查路径仍为 `FAST_LIMITS.reviewOutputTokens`，R-P0-1）；批量协议内 `reason` ≤ `overseerBatchReasonChars`（80）、`guidance` ≤ `overseerBatchGuidanceChars`（400），由归一化钳制执行；digest 裁剪沿用「事实先行、历史尾殿后」的既有顺序（R-P2-5：每子代理 1 200 B 比单查 8 000 B 紧，记忆与历史尾最先让位）。

### 5.3 事件（`team/types.ts` / `exec/events.ts`）

- `TeamEvent 'overseer'` 形状不变：每个**已应用**决策发一条（批量巡查发 n 条，消费端逐条处理，无需理解批量）。
- 「监察转入静默」「无人协助的等待」走结构化信号（D-10，R-P1-3）：静默 = interventions 条目 `trigger: 'quiet'`（`OverseerIntervention['trigger']` 加性扩展）；降级拍 = 每子代理一条 wait 事件照发但不进台账，聚合事实由 `DispatchOutcome.overseerDegraded` / `overseerDegradedTicks` 锁存。事件联合体成员与既有字段形状零变更；**不**使用 reason 前缀做机器信号。
- `ExecTeamEvent` / `exec/runner.ts`：**零变更**（R-P1-1 基线更正）——overseer 子事件现状已发射 `label`/`action`/`trigger`/`reason`（`reason` 已被归一化钳至 200 字符）；新的 `trigger: 'quiet'` 值经既有透传字段自动可见，NDJSON schema 不动。

### 5.4 报告（`team/report.ts`）

`ReportOptions` 增 `fastCost?: ModelCost`（R-P1-2；`task-tool.ts` 经 `deps.fastModelCost()` 传入，controller 一行接线，复用 `isPricedModel` / `getModelInfoFor` 既有模式）。Overseer 小节末尾追加一行：`supervisor: N calls, X in / Y out tokens (fast tier)`，按 `fastCost` 计价；价格未知时 `pricing unknown`（「未知定价不是零定价」，与 fast 档 C-11 / RV-4 同源规则），不渲染 `$0.00`。台账行格式不变（`[clock 300s] label: nudge - reason`，R-P2-4 对齐现状实现）。降级与静默各渲染**一条**聚合注记（数据源为 `overseerDegraded` / `trigger: 'quiet'` 条目，D-10），不逐拍刷行。

---

## 6. 数据模型（内存形状）

```ts
// 瞬态，永不持久化（与 activity/activityArgs 同规则）
interface SubagentRun {
  // ...
  lastIntervention?: {
    action: OverseerAction;
    /** 绝对 epoch ms，与 startedAt/endedAt 同口径（R-P2-3）；面板用 now - at 渲染 'nudged 2m'。 */
    at: number;
    /** ≤ 60 chars，仅 UI 徽记用。 */
    reasonHead: string;
  };
}

interface DispatchOutcome {
  // ...
  /** 监察巡查的快速档累计花销；无监察时缺省。 */
  overseerUsage?: TokenUsage;
  /** 巡查调用次数（含失败降级的调用）。 */
  overseerCalls?: number;
  /** 首次降级边沿锁存（D-10）：快速档缺席期间仍按节拍续拍。 */
  overseerDegraded?: boolean;
  /** 降级拍计数（报告聚合注记用）。 */
  overseerDegradedTicks?: number;
}

// TeamOverseer 内部（不变量保持: 每 label 单飞；记忆/预算按 label 键控）
// inspections(看) 与 actions(nudge/replace/abandon) 分账:
//   looks: Map<label, number>          上限 overseerMaxLooksPerChild (12)
//   looksTotal: number                 上限 overseerMaxLooksPerDispatch
//                                      (= hardMaxSubagents × 12 = 120, R-P1-6 防呆上界)
//   nudges: Map<label, number>         上限 overseerMaxNudgesPerChild
//   replacements: Map<label, number>   上限 1 (不变)
//   abandons: Map<label, number>       上限 1 (新)
```

节拍阶梯状态在 `MonitorLoop`：`nextAt: Map<label, number>`（下次应查时刻）+ `ladderStep: Map<label, number>`；两表均在该子代理**实际 start** 时建立首项（`queued` 不占位，R-P1-5）；`wait` 决策的 `nextCheckMs` 覆盖 `nextAt` 并把 `ladderStep` 同步为该值（下一次仍从被覆盖值按 ratio 递增）；动作决策重置 `ladderStep` 为基准档；`inspectBatch` 构批时跳过处于单查 inFlight 的 label（R-P1-4）。全部定时器 `unref()`（沿用 `ChildSupervisor` 的退出语义）。

---

## 7. 测试与验收标准

### 7.1 单元测试（Vitest，沿用 263 文件套件约定；纯函数优先）

1. `overseer-cadence.test.ts`（新）：阶梯数学——首拍来源优先级（D-8 三分支）、1.6 递增、60 s/900 s 钳制、`nextCheckMs` 覆盖、动作重置、动作后首拍。
2. `overseer-batch.test.ts`（新）：批量 digest 排序稳定性、每子代理字节钳、整批字节钳（构造 10 个长历史假 run）；数组解析——正常、混入垃圾条目（该条 wait 其余保留）、整体无 JSON（全 wait）、死子代理条目归一为 abandon（复用现有 `childAlive` 规则按批内存活标记）；**2b** 输出截断回退——伪造被截断的批量回复（无闭合 `]`）→ 全批 wait 且零动作副作用（R-P0-1）；**2c** 批量钳制——`reason > 80` / `guidance > 400` 被钳、单查路径 200/1200 不受影响。
3. `overseer-budget.test.ts`（扩展）：看/动作分账、传输失败不耗动作预算（G-6）、被跳过的 in-flight label 不耗看预算（R-P1-4）、per-child 耗尽后只发一次静默通告（interventions 落一条 `trigger: 'quiet'`）、dispatch 总额（120）为防呆上界、abandon ≤ 1。
4. `runtime-supervision.test.ts`（扩展）：**4a** no-kill——`overseer:true` + **dispatch 起点即**无快速档 + `subagentTimeoutMs>0`：MonitorLoop 存在、子代理到点不被 abort、发出 unassisted-wait 事件、`overseerDegraded` 锁存（G-2 / R-P0-2）；`overseer:false` 时 legacy 硬 abort 仍在（回归）；节拍到期触发一次批量调用并逐个应用；mid-dispatch `/fast off` 后下一拍降级；abort 期间在飞巡查的决策被丢弃（现有守卫回归）；**4d** `queued` 子代理不入批量 digest、不耗看预算、阶梯随实际 start 武装（R-P1-5）；**4e** 同 label 单查在飞时拍点到期 → 该 label 被跳过、批量与单查并发时单飞不变量保持（R-P1-4）。
5. `report.test.ts`（扩展）：花费行渲染（`fastCost` 计价）、价格未知路径（`pricing unknown`，不渲染 `$0.00`）、降级/静默各一条聚合注记（D-10）、台账不变回归。
6. `config` 钳制测试：`overseerIntervalMs` 0/边界/超界。
7. UI 测试：面板徽记宽度退化（窄列）、`notice` 仅 replace/abandon 落条、`pickGlyphs` 约束（glyphs 扫描器自动覆盖新文件——**新增任何 src 树须同步加入扫描正则**，本方案不新增顶层树，复用 `team/`、`ui/` 现有条目）。
8. `exec` 映射回归：overseer 子事件现有字段（`label`/`action`/`trigger`/`reason`）不变、新 `trigger: 'quiet'` 值透传、未知字段前向兼容（exec 零变更，R-P1-1）。

### 7.2 验收标准（AC）

- **AC-1** `team.overseer: true` 时不存在任何由 `subagentTimeoutMs` 直接引起的子代理 abort（代码路径 + 测试双证）。
- **AC-2** 快速档缺席时，到点行为 = 通告 + 续期等待；dispatch 仍能靠 Esc / 自身看门狗 / 用户显式上限终止。
- **AC-3** 每次 dispatch 恰有一个监察者实例；节拍期间最多一次在飞批量调用；单 label 最多一次在飞巡查（单飞不变量保持；批量构批时跳过处于单查 inFlight 的 label，R-P1-4）。
- **AC-4** 10 子代理满配时，一个节拍 = 恰 1 次快速调用（非 10 次）。
- **AC-5** TUI：面板可见每存活子代理最近监察徽记；replace/abandon 在转录留下一条 notice；wait/nudge 不产生转录噪音。
- **AC-6** 报告含监察台账 + 花费行（按 `fastCost` 计价，未知价显示 `pricing unknown`，R-P1-2）；`aragon exec` NDJSON 含 overseer 决策明细（现状已具备，回归验证）；两者数据同源（`interventions`/`overseerUsage`）。
- **AC-7** `packages/core` 零变更；`TeamEvent` 联合体成员零变更（仅 `OverseerIntervention['trigger']` 值域加性扩展 `'quiet'`）；exec schema 零变更（R-P1-1）。
- **AC-8** `team.overseer: false` 时系统提示、行为与 pre-feature 字节等价（沿用「可选子系统条件拼接」的既有测试手法）。
- **AC-9** 失败巡查调用永不产生 kill 类副作用（I-OV2 回归）。
- **AC-10** `nudge` 只经 `agent.steer()` 在安全检查点注入，且不向已请求 abort 的子代理注入（I-OV4 回归）。
- **AC-11** 阶梯令「健康慢子代理」的巡查次数随运行时长按对数增长（用假时钟断言 60 min 运行 ≤ 8 次）。
- **AC-12** 全部新代码过 `npm test`；glyph ASCII 扫描、公共 API 冻结、no-host-coupling 三项结构性测试保持绿色。
- **AC-13** 批量输出预算（R-P0-1）：满配 10 子代理的一拍批量回复（10 条决策、`reason ≤ 80` 字符）在 `overseerBatchOutputTokens`（2 048）内完整装下；被截断的回复归一为全批 wait，零动作副作用。
- **AC-14** 监察门 = provider 在场且 `team.overseer`（R-P0-2/R-P1-5）：dispatch 起点快速档即不可用时 MonitorLoop 仍存在、发出 unassisted-wait 事件、`overseerDegraded` 锁存、子代理不被 `subagentTimeoutMs` abort；`queued` 子代理不计入巡查与看预算。

### 7.3 手动验收脚本

双终端：一端跑会产生 10+ 分钟子代理的任务（如全量测试套件分析），另一端观察面板徽记与节拍通告；中途 `/fast off` 观察降级；`Esc` 观察全部子代理及时终止；`aragon exec --output-format stream-json` 观察 overseer 子事件流。

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 批量回复超出输出预算被截断，满配时协助静默失效 | 高→低 | `overseerBatchOutputTokens = 2_048` + 批量协议内 reason/guidance 更紧钳制（80/400）；截断 → 全批 wait、零动作副作用；测试 2b 与 AC-13 锁定（R-P0-1） |
| 批量 digest 超快速档输入预算，调用变贵 | 中 | 每子代理 1.2 KB / 整批 12 KB 结构钳；输出仍独立限额（2 048）；阶梯对数增长摊薄调用数；对比基线（10 次单查）净省 |
| 批量决策解析失败面变大（一条坏数据拖垮整批） | 中 | 逐条 repair-never-reject；整批无 JSON 时全 wait；测试覆盖混合垃圾输入 |
| 监察者自身 20 s 超时与节拍互相干扰（调用横跨下一拍）；批量与 silence 单查并发争用 | 低 | 单飞不变量 + 拍点只在上一调用 settle 后重新武装（沿用 inFlight 集合语义）；`inspectBatch` 跳过单查在飞的 label（R-P1-4，测试 4e） |
| 移除无快速档硬超时后，卡死子代理只能靠 4× 看门狗（约 4×(toolTimeout+margin)）才死 | 中 | 该值本来就是「零事件」判据；post-mortem 巡查保留；文档明示权衡；`overseer:false` 逃生舱保留给要硬上限的用户 |
| wait 祝福无法延长子代理看门狗（D-6 权衡） | 低 | 已有 ×4 拉长 + post-mortem；记录为已知限制，未来 Core `renewIdleWatchdog()` 可选 |
| unassisted-wait 通告刷屏 | 低 | 同一降级状态只发一次聚合注记（`overseerDegraded` 边沿锁存，D-10）；降级拍的 per-child wait 事件不进台账、不落转录 |
| usage 回收依赖 `AssistantMessage.usage` 形状 | 低 | 沿用 fast reviewer 已验证的读取路径；缺省时不渲染花费行（宁缺勿假） |
| `subagentTimeoutMs` 语义变化让老用户困惑 | 中 | 只读优先级兼容（老值仍当首拍用）；README + `/config` 文档双处说明；行为测试锁定 |
| 团队面板行宽挤占（新徽记） | 低 | 徽记走既有 `activityBudget(cols)` 宽度分配，窄列降级为仅动作词 |

---

## 9. 实施顺序建议（给下游实现节点）

1. `limits.ts` + `config/schema.ts`（结构常数与策略键先行，纯增量；含 R-P0-1 / R-P1-6 新常数）。
2. `overseer.ts`（批量协议 + 输出预算 + 预算拆分 + usage 通道）＋单测。
3. `runtime.ts`（MonitorLoop、激活门与 no-kill 分支、降级、outcome 扩展）＋单测。
4. `types.ts`/`report.ts`/`task-tool.ts`（瞬态字段、`fastCost`、报告行与聚合注记）＋ `controller.ts` 一行接线 ＋单测。
5. UI（面板徽记、notice）＋ exec 回归验证 ＋各自测试。
6. README / 文档收尾；全量 `npm test` + 手动验收脚本。

（设计节点仅产出本文档、不落实现代码；评审节点仅修订本文档——两阶段约束均为「不触碰源码、不运行 git commit」。）

---

## 评审结论（Review Verdict）

**有条件通过**（approved with conditions）。

v1 的差距审计（G-1…G-6）经源码逐条复核全部属实，总体架构——无循环的有界监察者（D-1）、节拍阶梯（D-2）、批量巡查（D-3）、no-kill-by-default（D-4）、看/动作预算拆分（D-5）、诚实记账（D-7）——方向正确，与仓库既有约束（Core 公共 API 冻结、零 host 耦合、ASCII glyph 扫描、`limits.ts` 结构 / `config/schema.ts` 策略二分、字节预算）一致，可以在修正后进入实现。

评审共发现 **P0 × 2、P1 × 6、P2 × 5**，全部 P0/P1 已修复进 v2 正文（逐项对应关系见「评审记录」发现清单的「v2 处置」列）。实现节点以下列条件为准：

1. **按 v2 修正后的语义实现**，尤其是四处关键修订：
   - D-3 / R-P0-1：批量输出预算 `overseerBatchOutputTokens = 2_048` + 批量协议内 reason ≤ 80 / guidance ≤ 400（单查路径 512/200/1200 不变）；
   - D-4 / R-P0-2：激活门 = `deps.overseer !== undefined && team.overseer`，`active()` 逐拍读取决定 assisted / unassisted，看门狗 ×4 随该门生效；
   - D-10 / R-P1-3：合成通告走结构化信号（`trigger: 'quiet'` 加性扩展 + `overseerDegraded` 锁存），不用 reason 前缀；
   - D-5 / R-P1-6：派发级看预算 = `hardMaxSubagents × overseerMaxLooksPerChild = 120`（防呆上界）。
2. **测试与实现同批落地**：§7.1 新增的 2b / 2c / 4a / 4d / 4e 及修订后的 3 / 4 / 5 / 8；AC-13 / AC-14 纳入验收；AC-12 三项结构性测试保持绿色。
3. **P2 观察项跟踪**：R-P2-5（批量 digest 收窄对决策质量的影响）在 §7.3 手动验收中顺带观察，不阻塞合入；其余 P2 已随 v2 顺带修复。
4. **边界不越界**：`packages/core/**` 与 §4「明确不改」清单（含 `exec/**`、`team/subagent.ts`）保持零变更；AC-7 按修订后口径（联合体成员零变更、exec schema 零变更）验证。

---

## 实施过程发现的方案缺陷（Issues Found During Implementation）

实现节点（2026-10-08）按 v2 正文实施时发现以下方案缺口。均已按「修正后继续」处理，不改变任何已评审决策（D-1…D-10）的语义：

| # | 位置 | 缺口 | 处置 |
| --- | --- | --- | --- |
| I-1 | §4 文件表缺 `config/cli-commands.ts` | 新策略键 `team.overseerIntervalMs` 未加入 `TEAM_CONFIG_SET_KEYS` 与 `applyTeamConfigSet` 的 switch，`aragon config set team.overseerIntervalMs ...` 会报 Unknown config key——该模块自身头部注释明确记载「membership 集合漏键 = 设置存不上」（P1-2 教训）。 | 补键 + 补 case，路由经 `clampOne`（与既有数值键同一钳制门）。 |
| I-2 | §4 文件表缺 `commands/builtins.ts` | `/team` 状态行的 `(needs the fast tier)` 与 D-4 矛盾：v2 语义下快速档缺失是「降级为无人协助的等待」，监察不会因此关闭。 | 单字符串改写为 `(never kills; checks the fast tier each tick)` / `(legacy hard timeouts)`。 |
| I-3 | §4 文件表缺 `ui/layout/team-panel.ts` | 面板新增监察状态行（AC-5）后，`buildTeamPanelLayout` 的 `natural` 行数预算未计入该行，行预算会少算一行。 | `natural` 增加一项：任一 run 带 `lastIntervention` 时 +1。 |
| I-4 | §6 节拍状态机未定义「跳过标签的再调度」 | R-P1-4 跳过单查在飞的 label 后其 `nextAt` 留在过去时刻，单一定时器按 `max(0, due-now)` 重武装会热旋转直到单查结算（最长 20 s）。 | 引入结构性再查延迟 `MONITOR_RECHECK_MS = 500`（runtime.ts 模块常数）：仅移动 `nextAt`、不动 `ladderStep`、不耗看预算，与「阶梯不动」的协议语义一致。 |
| I-5 | §5.2 `TaskToolDeps.fastModelCost()` 未标注可选 | 设计写 `fastModelCost(): ModelCost \| undefined`（必选成员）；实现取可选属性，与 `modelCost` 的既有形状一致，controller 始终接线，语义无差（未接线时报告按「价格未知」渲染，正是 R-P1-2 的缺省路径）。 | 按可选实现；既有构造点零改动编译。 |
| I-6 | §6 聚合通告伪标签 `team` 的防撞声明失实（代码评审节点发现） | runtime 的 `MONITOR_TEAM_LABEL` 注释声称「规范化路径不可能产出裸词 `team`」，但 `slugLabel('team')` 恰好产出合法 slug `team`（4 字符，落在 `[a-z0-9-]{1,12}` 内）；一旦某个子代理叫 `team`，派发总额耗尽的聚合台账行会被归到它名下，且报告「went quiet on N children」的计数会把它自己的 quiet 注记吞掉。 | `limits.ts` 新增结构常数 `TEAM_AGGREGATE_LABEL = 'team'`；`normalizeSubagentSpecs` 以它播种 `dedupeLabel` 的已占命名空间（要 `team` 的规格拿到 `team-2`）；runtime / report 改用同一常量，三处副本合一；`team-normalize.test.ts` 补回归测试。 |

其余核对结论：`exec/events.ts` / `exec/runner.ts` 确如 R-P1-1 所述零变更（overseer 载荷已齐，新 `trigger: 'quiet'` 经透传字段自动可见，已补回归测试）；`team/subagent.ts` 零变更（`overseerActive` 随新门生效，`lastIntervention` 由 runtime 的 `recordIntervention` / `replaceChild` 维护）；`packages/core/**` 零变更。
