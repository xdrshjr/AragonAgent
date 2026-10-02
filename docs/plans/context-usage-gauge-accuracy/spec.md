# 上下文占用读数的正确性与压缩联动（context-usage-gauge-accuracy）

**Feature slug:** `context-usage-gauge-accuracy`
**Document version:** **v2**（Subtask #1 评审后修订；评审记录见 §0，评审结论见文末）
**作用范围:** `packages/cli/`（TUI 状态栏 + 上下文测量 + 压缩子系统的读数接缝）。`packages/core/` **零改动**。
**前置阅读:** `docs/plans/context-auto-compaction/spec.md` v2 与
`docs/plans/context-auto-compaction-hardening/spec.md` v2。本文是它们在**读数侧**的
补完，不推翻其中任何一条压缩策略；被改写的只有「谁来测量」和「谁来写屏」。

---

## 0. 评审记录（Review Notes）

**评审人：** Subtask #1（资深评审）
**评审对象：** `spec.md` v1
**评审维度：** 可行性 / 完整性 / 一致性 / 规模适配
**核验方式：** v1 正文里的 25 处 `file:line` 断言逐条在树上比对。**结论：v1 的
缺陷清单（P0-1 / P0-2 / P1-3 / P1-4 / P1-5 / P2-6 / P2-7）全部成立**，证据引用准确，
唯一的引用偏差是 `replaceMessages` 实际在 `controller.ts:1687-1693`（v1 写 `:1688-1694`），
不影响论证。问题出在**方案侧**：本轮共 14 条，其中 **P0 × 2**、**P1 × 6**、**P2 × 6**。
P0 与 P1 已在正文中逐条修复（下表「修复位置」列指向修完之后的小节）。

### 0.1 P0（会静默产生错误行为，或使 v1 自带的验收用例无法通过）

| # | 维度 | 问题 | 为什么是 P0 | 修复位置 |
|---|---|---|---|---|
| **RV-1** | 一致性（自相矛盾） | §3.2 的事件表把 `compaction_end && applied` 映射到 `onHistoryReplaced()`，而 §3.4 规定 `onHistoryReplaced()` **同时清空 `estimateOffset`**。两条合起来 = **每一次成功的压缩都会丢掉校准量** | 与 I-5 直接冲突。I-5 要的正是「压缩后走 estimate 分支 **+ `estimateOffset`**，得到 `record.tokensAfter + offset`」。清掉 offset 之后压缩后读数系统性偏低几千 token，下一个 `turn_end` 又跳回来——这正是 `App.tsx:1005-1015` 那段注释（P1-11）花了一整段话去防的「掉过头再爬回来」，被本方案原样重新引入，且**不报错** | §3.1 I-5（重写）、新增 I-8；§3.2 方法表与事件表；§3.4 |
| **RV-2** | 可行性（不变量不成立） | I-2 断言「`wiring.settlePending()` 里 `snapshot()` 读到的必然是压缩后的数，**无论** meter 的监听器排在 wiring 前面还是后面」。**这条在压缩路径上是假的**：拼接本身不会让 meter 变脏，meter 只能从它自己的 `compaction_end` 处理器得知。若 wiring 的监听器先跑，`current()` 此时 `dirty === false`（checkpoint 那次 `measureWith` 刚清过），直接返回缓存的**压缩前**压力 | v1 自己规定的 T6 要断言「`snapshot` 事件携带的 `pressure.occupied` 是压缩后的值」、T7 要断言两种注册顺序结果相同——**这两条不可能同时通过**。dirty 标记消除的是「追加」的顺序依赖，消除不了「替换」的 | §3.1 I-2（重写）+ 新增 I-9；§3.3 第 2/3 条 |

### 0.2 P1（会让实现走偏、让门禁放行错误的树，或与已声明的非目标冲突）

| # | 维度 | 问题 | 修复位置 |
|---|---|---|---|
| **RV-3** | 完整性 | §3.3 只说 `lastMeasured()`「转发到 `deps.meter`」，没说转发到**哪个**方法。`compactor.ts:873` 的 `const tokensBefore = this.lastPressure?.occupied ?? 0` 是 `tokensReclaimed` 的唯一上游；若照字面把 `lastMeasured()` 接到会重测的 `current()`，`tokensBefore` 会在拼接之后变成压缩**后**的数 ⇒ `reclaimed = 0` ⇒ 卡片写「reclaimed 0 tokens」、`/compact status` 的累计回收量永久停在 0。静默、且只在真实压缩里发作 | 新增 I-10；§3.2 方法表新增 `lastPublished()`；§3.3 第 1 条 |
| **RV-4** | 一致性 | P2-6 的修法（`gaugeMarks` 条件改 `isCompactionRegistered()`）用错了谓词。`live = enabled && summarizer !== null`（`wiring.ts:430`）有**两个**假值来源，v1 只想解开后一个，却把前一个也解开了：`/compact off` 之后颜色仍按 90%/75% 着色，等于**用颜色承诺一次不会来的救援**。正确谓词是现成的 `controller.isCompactionEnabled()`（`controller.ts:1851`）。另外 `App.tsx:2658-2665` 里 `gaugeMarks` 与 `compactionActive` **共用一个条件展开**，照字面改会让 chip 一起在 `/compact off` 后继续宣传自己 | §3.7 阈值一致性段（重写）；§6 文件表 `App.tsx` 行 |
| **RV-5** | 一致性（与非目标冲突） | W1 把 meter 无条件挂在 `AgentController` 上，而 `aragon exec` 也构造 `AgentController`（`exec/index.ts:57`，`cli.tsx` 供工厂）。于是 N-4「本轮只动 TUI」不成立：headless 路径每次工具调用多一个 400 ms 定时器（在 `dispose()` 之前吊着事件循环）、每次刻度多一次估算，而那个数在 exec 里**没有任何读者** | §1.4 N-4（补边界）；§3.2 发布节流段新增两条门（无订阅者 no-op + `unref()`）；新增 I-11 |
| **RV-6** | 完整性（验收自相矛盾） | AC-9 要求「压缩未注册的会话，状态栏输出与本轮之前**逐字节相同**（除新增的绝对值对与累计读数门槛）」，而 W5 把 `↑` 的取数从 `usageTotal.inputTokens` 改成 `promptTokensOf()`——任何有 cache 命中的会话 `↑` 的**数值**都会变。按 v1 的 AC-9 实现，要么不敢改口径（P1-3 不修），要么 AC-9 恒红 | §7.2 AC-9（重写）+ 新增 AC-11 |
| **RV-7** | 完整性（门禁漏洞） | AC-10 只跑 `npm run build` + `npm test`。`packages/cli` 的 `build` 是 `tsc -p tsconfig.json`，**不编 `tsconfig.test.json`**；`typecheck` 才是两个都编。本轮删 4 个 `StatusBar` props、删 1 个 reducer action、改 `UsageTotal` 形状——测试树的类型错误**全部**落在 build 看不见的地方。另：本包**没有配置 linter**，「无新增 lint 错误」是一句无法执行的验收 | §7.2 AC-10（重写）；§9 每步的自检命令 |
| **RV-8** | 完整性 | §3.7 只给了 `/context` 在「压缩开着」时的一种形态。压缩有**四种**可见状态（未注册 / 注册但 `/compact off` / 注册且开但 summarizer 解不出 / self-disabled），照 §3.7 实现会对 `--no-compaction` 的会话打印「Compaction on - triggers at 90%」——一句彻底的假话。另需写明 `/context` **不得**读 `offCompactionSnapshot()`（`wiring.ts:114-135`）里那份硬编码的零压力 | §3.7 `/context` 段（补四态表 + 数据来源约束） |

### 0.3 P2（不阻塞实施，记录在案）

| # | 问题 | 处置 |
|---|---|---|
| **RV-9** | §1.2 说 `ViewState.contextTokens` 有「两个写入者」，实际有**三处**写它：`reducer.ts:1279`（`turnEnd`）、`:1877`（`contextTokensEstimated`）、`:1440`（`resetConversation` 写 0）。I-1 与 §3.4 都已正确处理第三处，只是 §1.2 的计数没跟上 | 本轮已改为「三处写入、两个真上游」 |
| **RV-10** | §3.2「测量成本」段称 `estimatePromptTokens` 是「`.length` 求和，无分配」。不成立：`messageLength`（`output-limits.ts:336-346`）对每个 `tool_call` 块走 `JSON.stringify(block.args ?? {})`。R-4 的缓解论证建立在这句话上 | 本轮已改为准确表述；结论（热路径是一个回合宽的切片）不变 |
| **RV-11** | `wiring.ts:569` 那句「`snapshot()` 用的是缓存压力（`compactor.lastMeasured()`），所以这里不花重测」在新设计下过期——静默 decline 路径每次都会走一次 `meter.current()`。§6 文件表没列这处注释更新 | 已在 §6 `wiring.ts` 行补上 |
| **RV-12** | §3.6 的 clamp `[8_000, 5_000_000]` 没说 `null` 怎么办。`contextWindow` 是 `number \| null`（`null` = auto），把 `null` 夹成 8000 会让「auto」永久消失。`maxTokens`（`schema.ts:1506` + `cli-commands.ts:471`）是现成的三态先例 | 已在 §3.6 与 §4.5 写明 `null` 直通 |
| **RV-13** | `onWindowChanged()` 只重测不丢基线，于是裸 `/model` 切换之后 `estimateOffset` 与 `lastUsage` 仍是**上一个模型**的校准量。这是可接受的（下一个 `turn_end` 自纠），但 v1 没说 | 已在 §3.4 补一句自纠窗口说明 |
| **RV-14** | AC-5 说 `↑` 的口径「与 `$` 所依据的口径一致」。不精确：`computeCost`（`usage.ts:9-19`）同时计价 output，而 `↑` 是 prompt 侧。真正要断言的是「cache 读写两侧都计入」 | 已在 AC-5 改为精确表述 |

### 0.4 复核通过、不改的部分

- **归属选择**（meter 挂 `AgentController` 而非 `CompactionWiring`）：`controller.ts:674` 在
  `compaction.enabled === false` 时确实不构造 wiring，这是唯一可行归属。✅
- **`attach` 的形状**：`CompactionWiring.attach`（`wiring.ts:238`）与
  `controller.ts:735` 的 `this.agent.subscribe(listener)` 已是同一个形状，meter 直接复用。✅
- **子 Agent / fast tier 不会污染 meter**：团队成员各自 `new Agent(...)`（`team/subagent.ts:79`），
  fast reviewer 走 `complete()` 而非 Agent（`controller.ts:750`），压缩 summarizer 同理——
  三者都不在 lead 的 `agent.subscribe` 流上，`turn_end` 不会串台。✅
- **`windowKnown` 的判据**：`isPricedModel` = `modelRegistry.getModel(...) !== undefined`
  （`controller.ts:1752`），而 `getModel` 只查静态表（`model-registry.ts:60-63`），
  未登记模型必走 `buildRuntimeModel` 的 `contextWindow: 128_000` + `cost: {0,0}`
  （`:132-150`）——两者同源，所以拿定价已知当窗口已知的代理是**准确**的，不是巧合。✅
- **I-3 的时序论证**：`agent-loop.ts:558` 发 `tool_execution_end`，`:571` 才
  `messageManager.push(tool_result)`，中间只有同步的 `.map().join()`。`setTimeout` 必然晚于它。✅
- **I-7 的 ASCII 约束**：`glyphs.test.ts::inScope` 的正则里确有 `compaction`，
  `limits.ts:5-10` 写明该树 ASCII-only，`ui/` 也在扫描范围内（`rel.startsWith('ui/')`）——
  所以 `total ` 用 ASCII 单词而非 `Σ` 的论证成立。✅
- **规模适配**：六个工作包对应七条已证实的缺陷，没有一条是「顺手做的」；
  N-1 ~ N-4 四条非目标都给了理由。范围合适，不判过度设计。✅

---

## 1. Overview（这是在修什么，为什么值得修）

### 1.1 用户看到的症状

Agent 正在跑一个多轮、多工具的任务时，界面最下方那条上下文进度条（`ui/StatusBar.tsx`
右簇的 `[████░░░░] 43%  1.2M↑ 48k↓  $3.21`）**不能被信任**：

- 它经常长时间不动，而模型明明在不停地往历史里塞工具输出；
- 自动压缩明明跑完了、卡片也打出来了，进度条**没有掉下去**；
- `/resume` 恢复一个 18 万 token 的会话之后，它读 **0%**；
- 旁边那个「累计」读数 `1.2M↑` 既不是当前上下文、也不是这一轮的 prompt、还比同一行上
  `$3.21` 所依据的 token 数**小**；
- 它没有任何地方告诉用户「总的上下文是多少」，而在自定义 baseUrl / 未登记模型上，那个
  分母根本是编出来的 128 000。

### 1.2 根因不是四个 bug，是**一个结构缺陷的四种表现**

`ViewState.contextTokens` 这一个数字有 **三处写入**（`reducer.ts:1279` 的 `turnEnd`、
`reducer.ts:1877` 的 `contextTokensEstimated`、`reducer.ts:1440` 的 `resetConversation`
写 0）、其中**两个是真上游之争**（provider 的 `turn_end` usage 对压缩快照的
`pressure.occupied`；压缩记录的 `tokensAfter` 是第三个上游，经由同一个
`contextTokensEstimated` action 进来），而**唯一的测量能力**
被锁在压缩子系统的开关下面（`compactor.ts:298` 在测量之前就对 `!config.enabled` 早退；
`wiring.ts:217` 的 `this.enabled &&` 短路更早；`compaction.enabled=false` 时
`controller.ts:674` 连 `CompactionWiring` 都不构造）。

一个有两个写入者的数字，迟早会有一次「后写的那个是错的」——本轮找到的 P0-1 正是如此：
压缩成功后 `wiring.ts:593` 先发 `compaction_end`（App 据此把进度条**打下去**），紧接着
`wiring.ts:594` 发 `snapshot`，而 `snapshot()`（`wiring.ts:408-415`）优先返回
`compactor.lastMeasured()` ——那是**触发这次压缩的那一次测量**，即压缩**前**的占用。两个
事件在同一个同步 `emit` 循环里按顺序抵达（`wiring.ts:671-680`），于是进度条掉下去又被
**立刻弹回压缩前的数值**。`context-auto-compaction` spec 的 AC-5「压缩后进度条必须立刻
下落」，在**任何有工具调用的会话里恒定失效**。

### 1.3 本轮做什么

把「占用是多少」收敛成一个**任何时候都可测、任何时候都可读、只有一个写入者**的量：

1. **W1** 新增 `ContextMeter` —— 占用测量的唯一所有者，构造无条件，**不受压缩开关约束**。
   `Compactor` 从此**读**它而不是自己持有 `estimateOffset` / `measuredPrefixLength` /
   `lastPressure`，于是「进度条和触发器读同一个数」从一条纪律变成一条**结构事实**。
2. **W2** 修压缩联动（P0-1）：meter 采用 **dirty 标记 + 读时同步测量**，任何读者（包括
   `wiring.snapshot()`）拿到的都是最新数；App 里那两处 `contextTokensEstimated` 派发
   **整段删除**——第二个写入者消失，就没有「谁覆盖谁」的问题。
3. **W3** 修 `/resume` / `/reset` / 换模型之后的脱钩（P0-2）：这三条路径显式触发重测与发布。
4. **W4** 回合内活体刷新（P1-4）：`tool_execution_end` 触发**节流且延迟**的重测。
5. **W5** 累计口径（P1-3）与「总的上下文」（P1-5）：`UsageTotal` 补齐 cache 字段、状态栏
   新增绝对值对 `86k/200k`、分母来源可被 `contextWindow` 配置覆盖。
6. **W6** `/context` 命令（保证可达的报告面）、颜色阈值与触发阈值恒定一致、把
   「分子是估的」与「分母是编的」拆成两个不同的标记。

### 1.4 非目标（明确不做，并写下理由）

- **N-1 · 不改 `packages/core/`。** `estimatePromptTokens`、`AgentEvent` 联合、
  `ContextManager` 端口都不动。本轮全部缺陷都在 host 侧的读数接缝上。
- **N-2 · 流式输出期间不伪造增长。** 助手回复的 output token 在 `done` 之前不可知，唯一
  能做的是拿已流出的字符数去估——那会往一条已经有两种近似的读数上再叠第三种，而它最大
  只有 `maxOutputTokens`（默认 64k）。回合内的活体感由活动行、`tok/s` 与工具刻度提供。
- **N-3 · 不拆 `usageTotal` 的四个来源。** 主 Agent / 子 Agent 团队 / fast tier / 压缩
  摘要器各自计数需要四个计数器与四处口径论证，收益只有 `/context` 里一行。本轮改为
  **在 `/context` 里把它包含什么说出来**（D-7）。
- **N-4 · 不改 `aragon exec` 的 JSON 事件流。** `exec/runner.ts` 有自己的一套累加
  （`:173` / `:208` / `:259` / `:675`），而 `exec/events.ts` 是**对外公开的版本化契约**，
  改它是破坏性变更。本轮不新增、不修改、不删除任何 exec 事件字段。
  **但「只动 TUI」这句话要说得更准（RV-5）**：`aragon exec` 与 TUI 共用
  `AgentController`（工厂签名见 `exec/index.ts:57`），而 W1 把 meter 无条件挂在那里，
  所以 headless 进程**也会**构造并 attach 一个 meter。这不是可以含糊过去的实现细节——
  一个每次工具调用都排一个 `setTimeout` 的对象，在一个没有任何读者的进程里既费 CPU 又
  吊住事件循环。**处置见 I-11**：meter 在**没有订阅者**时不排任何定时器，`current()`
  仍随时可按需同步测量。于是 exec 路径上 meter 退化为一个零成本的惰性对象，N-4 的
  「exec 的可观测行为一字不变」才真正成立，而不是只在事件字段这一层成立。

---

## 2. 缺陷清单与证据（每行都可在树上验证）

| # | 严重度 | 现象 | 证据（`file:line`） |
|---|---|---|---|
| **P0-1** | **P0** | 压缩成功后进度条被弹回压缩前数值；`/compact status` 同样报压缩前占用，直到下一个 checkpoint | `wiring.ts:593`→`:594` 顺序发两个事件；`wiring.ts:408-415` `snapshot()` 优先取 `compactor.lastMeasured()`；`compactor.ts:971` 只在 `measure()` 里刷新 `lastPressure`，压缩后无人再调；`wiring.ts:671-680` `emit` 同步；`App.tsx:1014` 写下降值，`App.tsx:1046-1053` 随即用 `pressure.occupied` 覆盖。`isApproximate`（`pressure.ts:139-141`）在有工具调用时 `deltaTokens>0` 恒真，所以覆盖**必然发生** |
| **P0-2** | **P0** | `/resume` 一个 18 万 token 的会话后，进度条读 `0%`，`/compact status` 读 `~0%` | `builtins.ts:1062` → `controller.ts:1688-1694` 只 `invalidateMeasurement()`，不重测、不派发；`reducer.ts:2027` 的 `restoreEntries` 不写 `contextTokens`；`App.tsx:988` 挂载时那次 `getCompactionSnapshot()` 已把 `lastPressure` 写成「空历史 ≈ 0」，此后 `snapshot()` 再也不重测 |
| **P1-3** | **P1** | 状态栏同一行上 `↑`、`%`、`$` 用三套 token 口径 | `reducer.ts:1284` 只累加 `usage.inputTokens`，而 `pressure.ts:50-57` 的 `occupiedTokens` 计入 cache 读写、`usage.ts:9-19` 的 `computeCost` 也计价 cache；另有 `reducer.ts:1553` / `:1699` / `:1852` 把子 Agent、fast tier、压缩摘要器三种**别的模型**的 token 混进同一个 `↑` |
| **P1-4** | **P1** | 一整个回合内进度条不动；关掉压缩的会话**永远**只有 `turn_end` 一个采样点 | 写 `contextTokens` 的只有 `reducer.ts:1279` 与 `:1877`；后者的唯一上游是压缩快照，而 `compactor.ts:298` 在测量前对 `!config.enabled` 早退、`wiring.ts:217` 更早短路、`controller.ts:674` 关掉时连 wiring 都没有。`agent-loop.ts:478` 的 `turn_end` 在**工具执行之前**发出，工具结果要等到 `agent-loop.ts:401` 下一轮 checkpoint 才被计入 |
| **P1-5** | **P1** | 「总的上下文」从不显示；未登记模型的分母是编造的 128 000，且无配置项可纠正 | `StatusBar.tsx:253` 只算百分比；`model-registry.ts:141` `buildRuntimeModel` 返回 `contextWindow: 128_000`；`config/schema.ts` 全文无 `contextWindow` 键 |
| **P2-6** | P2 | 颜色阈值只在压缩 `live` 时才与触发阈值一致 | `App.tsx:2658-2665` 以 `state.compaction?.live` 为条件传 `gaugeMarks`；否则回落 `gauge.ts:36` 的 `{warn:60,high:85}`。summarizer 解析不出来（`live:false`）时颜色与 `/compact status` 打印的阈值不一致 |
| **P2-7** | P2 | 一个 `~` 背三种含义（窗口未知 / 占用是估算 / 占用含增量估算），用户无法据此判断该不该信 | `StatusBar.tsx:263` `pctLabel` |

---

## 3. Technical design

### 3.1 核心不变量（删了会静默作恶，改动前必回读源码注释）

> 编号按**加入时间**而非阅读顺序：I-1 ~ I-7 来自 v1，I-8 ~ I-11 是评审新增（RV-1 / RV-2 /
> RV-3 / RV-5），物理上插在 I-2 之后是因为它们全都在补 I-2 与 I-5 的洞。正文各处一律按
> **编号**引用，不按位置。

> **I-1 · `ViewState.context` 只有一个写入者。**
> 唯一写它的 reducer 分支是 `case 'contextUsage'`，唯一派发者是 `App` 里对
> `controller.subscribeContextUsage()` 的订阅。`turnEnd` **不再**写它，
> `resetConversation` / `clearTranscript` / `restoreEntries` **都不写它**。
> 两个写入者是 P0-1 的全部成因：先写的那个是对的，后写的那个把它盖掉，而两者都在同一个
> 同步 fan-out 里，没有任何日志会提到这件事。由 `context-one-writer.test.ts` 的源码扫描
> 守护（`reducer.ts` 中 `context:` 赋值只允许出现在 `contextUsage` 分支里）。

> **I-2 · meter 是「写时置脏、读时同步测量」，不是「写时测量」。**
> `current()` 在 `dirty` 时**同步**重测再返回；每个可能改变占用的事件只置脏 + 安排一次
> **延迟**发布。这条消灭的是**追加**方向上的订阅顺序依赖：不管谁先收到
> `tool_execution_end`，读者拿到的都是包含那条工具结果的数。把它改成「事件里同步测量 +
> `current()` 直接返回缓存」看起来更简单，但那样正确性就重新依赖两个 `subscribe()` 的
> 注册次序——一个在任何单测里都为真、只在生产里按 import 顺序翻车的条件。
>
> **它消灭不了「替换」方向上的顺序依赖，这是 v1 写错的地方（RV-2）。** 拼接**本身**
> 不会让 meter 变脏：`dirty` 只由 meter 自己看得见的事件置位，而历史被换短这件事，
> meter 只能从它自己的 `compaction_end` 处理器得知。若 wiring 的监听器排在前面，
> `settlePending()` → `snapshot()` → `current()` 时 `dirty` 恰好是 `false`
> （checkpoint 那次 `measureWith` 刚把它清掉），于是**直接返回缓存的压缩前压力**，
> P0-1 原样复活在一条新的路径上。补这个洞的是 **I-9**，不是 I-2。

> **I-8 · 「拼接」与「换会话」是两种深度不同的复位，绝不能共用一个方法（RV-1）。**
> v1 把两者都映射到 `onHistoryReplaced()`，而该方法按 §3.4 要清空 `estimateOffset` ——
> 合起来就是**每一次成功的压缩都丢掉校准量**，与 I-5 正面冲突。两个方法：
>
> | 方法 | 触发 | 清 `lastUsage` | 清 `measuredPrefixLength` | 清 `estimateOffset` |
> |---|---|---|---|---|
> | `onHistorySpliced()` | 压缩采纳（`applied === true`） | ✅ | ✅ | **❌ 保留** |
> | `onHistoryReplaced()` | `/clear`、`/reset`、`/resume` | ✅ | ✅ | ✅ |
>
> 判据是**「工具集与模型有没有可能变过」**，不是「历史长度有没有变」。压缩只换历史，
> 工具 schema 与模型原封不动，所以那个「这套 schema 在这个模型上的系统性差额」仍然成立、
> 仍然是压缩后 estimate 分支唯一能用的校准量（I-5）。`/resume` 则可能同时换模型
> （`builtins.ts:1071-1073`），旧 offset 是把校准量当常数用。
> 搞反的症状是**静默的、方向相反的两种偏差**：压缩路径清了 offset ⇒ 进度条掉过头再爬回来；
> `/resume` 路径留了 offset ⇒ 偏高且不自纠。两者都不报错。

> **I-9 · 压缩拼接的置脏挂在 `wiring.ts:589` 那个既有的 invalidation site 上，
> 不挂在 meter 自己的 `compaction_end` 订阅上（RV-2）。**
> 那一行今天已经是 `this.compactor.invalidateMeasurement()`，注释写着「SITE 1 OF THE
> FOUR INVALIDATION SITES」，而且它**在 `emit(compaction_end)` 与 `emit(snapshot)` 两句
> 之前**——这个位置正是它能当承重点的全部原因：置脏发生在 wiring 自己的同步代码里，
> 不依赖任何监听器先跑，于是 `snapshot()` 里那次 `current()` 必然看到脏标记、必然重测，
> **与两个 agent-stream 监听器的注册顺序无关**。
>
> **但 `Compactor.invalidateMeasurement()` 不能当这个转发器，必须删掉它（评审二轮修正）。**
> 它在生产代码里恰好有**两个**调用点，而这两个的复位深度**相反**：
>
> | 调用点 | 语义 | 目标 |
> |---|---|---|
> | `wiring.ts:283`（`CompactionWiring.onHistoryReplaced()` 的全部函数体，被 `controller.clearMessages()` / `replaceMessages()` 调用） | `/clear`、`/reset`、`/resume` | `meter.onHistoryReplaced()`（**深**） |
> | `wiring.ts:589`（`settlePending` 的 `applied` 分支） | 压缩拼接 | `meter.onHistorySpliced()`（**浅**） |
>
> 今天两者能共用一个方法，只因为 `invalidateMeasurement()` 清的字段（仅
> `measuredPrefixLength`）恰好是两种语义的交集；本轮 `estimateOffset` 的去留把它们分开了，
> 交集不再存在。所以：**删除 `Compactor.invalidateMeasurement()`，两处各自直呼 meter 上
> 对应深度的方法。** 保留它并让它转发到其中一个，就是把「哪个调用点走哪条深度」这件事
> 藏进一个名字不提深度的方法里——而选错的两种症状（压缩后掉过头 / `resume` 后偏高不自纠）
> 都是静默的。
> 注：`wiring.ts:283` 走深复位与 `controller.ts` 里那两处对 `contextMeter.onHistoryReplaced()`
> 的直呼是**重复但无害**的（深复位幂等，且压缩未注册时 wiring 根本不存在，controller 那
> 一处才是唯一保证）。两处都留着，不要为了「去重」删掉 controller 那一处——删了之后
> `compaction.enabled=false` 的会话 `/resume` 就再也不重测，P0-2 原样复活。
> meter 自己的 `compaction_end` 处理器**保留**（手工 `/compact` 与未来的第二条路径要它），
> 但必须写成**幂等**的：已经脏了就什么都不做。
>
> **第二道结构性兜底（belt）**：`current()` 在测量前先判
> `messages.length <= (measuredPrefixLength ?? -1)` ——记录的前缀比现在的历史还长，
> 说明它索引的数组已经不存在了，此时**无条件**丢弃 `lastUsage` / `measuredPrefixLength`
> 并走 estimate 分支。这条不依赖任何人来通知，是「漏掉一个 invalidation site」的最后防线；
> `estimateAppendedTokens`（`pressure.ts:118-120`）今天已经有同款 bounds-check，但它只把
> delta 降为 0、**仍然保留错误的 measured base**，所以那条 belt 不足以覆盖这里。

> **I-10 · `lastMeasured()` 转发到不测量的 `lastPublished()`，绝不是 `current()`（RV-3）。**
> `compactor.ts:873` 的 `const tokensBefore = this.lastPressure?.occupied ?? 0` 是
> `recordApplied()` → `tokensReclaimed` → 卡片「reclaimed N tokens」与 `/compact status`
> 累计回收量的**唯一**上游，它要的是**压缩前**那次测量。接到会重测的 `current()` 上，
> 一旦 meter 在建记录那一刻是脏的（或 I-9 的置脏已经先跑过），`tokensBefore` 就变成压缩
> **后**的数，`reclaimed` 归零，而卡片照常渲染、日志一个字都不会提。
> 所以 meter 暴露**两个**读法：`current()`（脏则重测，给屏幕）与
> `lastPublished()`（纯缓存读，给记账）。`Compactor.lastMeasured()` 转发后者。

> **I-11 · 没有订阅者就不排定时器（RV-5）。**
> `AgentController` 被 TUI 与 `aragon exec` 共用（`exec/index.ts:57`），而 exec 里没有任何
> 人读这个数。`scheduleTick()` 的第一条语句是 `if (this.listeners.size === 0) { this.dirty
> = true; return; }` ——只置脏、不排定时器。已排出的定时器另加 `unref()`，使一个待触发的
> 刻度永远不能把进程的退出往后拖 400 ms。
> **`current()` 不受这条门约束**：它是按需同步测量，`/context` 与任何一次
> `wiring.snapshot()` 在无订阅者时照常拿到正确的数。
> 这条同时是 AC-9「未注册压缩的会话行为不变」在**非 TUI 侧**的兑现方式。

> **I-3 · 回合内的刻度必须是延迟的，绝不能在 `tool_execution_end` 里同步测量。**
> `agent-loop.ts:557-576` 逐字是「先 `emit({type:'tool_execution_end'})`，**再**
> `messageManager.push({role:'tool_result'})`」。在事件里同步测量，量到的历史里**没有**
> 刚刚那条工具结果——而那往往是整个回合里最大的一条消息。症状是进度条系统性地少算一条
> 工具输出，且**永远不报错**。所以刻度走 `scheduleTick()`（`setTimeout`），它必然晚于
> 那条同步 `push`。

> **I-4 · `deltaTokens` 只估算「测量之后追加的那一段」，绝不给它加 `estimateOffset`。**
> 这条是 `context-auto-compaction-hardening` 已经写下的（`pressure.ts:109-116`），本轮
> 把测量搬家时必须原样带走：offset 是**整个请求**的系统性差额（主要是工具 schema，每次
> 请求发一次，且已经在测量基线里），不是每条消息的费率。加到切片上会让占用每轮虚增几千
> token，短会话上提前触发压缩。

> **I-5 · 压缩后的重测**必须走 **estimate 分支**（不传 `lastUsage`）**且必须带着
> `estimateOffset`**。
> 拼接之后，上一次测量所描述的那段历史已经不存在了；把它当基线再加 delta，得到的是一个
> 「压缩前的基线 + 压缩后的尾巴」的嵌合体。走 estimate 分支 +
> `estimateOffset` 得到的正是 `App.tsx:1014` 原来手工拼的
> `record.tokensAfter + offset` 那个量，且不需要 App 参与。
> **后半句是承重的**：`estimateOffset` 在这条路径上不是可选的精度改良，它就是
> `App.tsx:1013` 那行 `getCompactionSnapshot().pressure.estimateOffset ?? 0` 的搬家。
> 丢掉它，压缩后的读数会比真实占用低几千 token，下一个 `turn_end` 再跳回来——正是
> `App.tsx:1005-1015` 那段注释（P1-11）逐字描述并花力气避免的「掉过头再爬回来」。
> 这就是 **I-8** 必须把「拼接」与「换会话」拆成两个复位深度的全部原因。

> **I-6 · `contextWindow` 覆盖值使 `windowKnown` 为真。**
> 用户显式断言了分母，`~` 就不该再出现在百分比上；但 `windowOverridden` 要**单独**留着，
> 因为 `/context` 必须说得出这个分母是谁给的。把两者合成一个布尔，会让「表里查到的」和
> 「用户手填的」在报告里无法区分——而后者填错正是最需要被看见的一种错。

> **I-7 · `src/compaction/**` 是 ASCII-only 树。**
> `glyphs.test.ts::inScope`（`:231`）把 `compaction` 硬编码在目录列表里，`limits.ts:5-10`
> 写明该树内任何字面量不得含非 ASCII 字节。新增的 `meter.ts` / `context-command.ts` 落在
> 这棵树里，**继承这条规则**。若将来有人把 meter 迁到一棵新的 `src/context/` 树，
> **必须在同一个提交里**把 `context` 加进 `inScope` 的正则——一个悄悄停止扫描的扫描器比
> 没有扫描器更糟，这个包已经为同一处编辑付过十一次学费。

### 3.2 W1 —— `ContextMeter`：测量的唯一所有者

**归属**：`AgentController` **无条件**构造并持有；`CompactionWiring` 由构造参数接收同一
个实例并转交 `Compactor`。这是「不受压缩开关约束」的唯一可行归属——`controller.ts:674`
在 `compaction.enabled === false` 时根本不构造 wiring。

**状态**（从 `Compactor` 搬过来，原处删除）：

| 字段 | 语义 | 原位置 |
|---|---|---|
| `lastUsage?: TokenUsage` | 最近一次完成回合的权威用量 | 原先只存在于 `agent-loop.ts` 的循环局部变量里，host 侧无副本 |
| `estimateOffset?: number` | 每回合重算的校准量（D-23） | `compactor.ts:156` |
| `measuredPrefixLength?: number` | 上次测量覆盖的历史长度（hardening W1） | `compactor.ts:166` |
| `last: Pressure \| null` | 最近一次发布的压力 | `compactor.ts:158` `lastPressure` |
| `dirty: boolean` | 自上次测量以来历史是否变过 | **新增** |

**方法**：

```ts
export const CONTEXT_METER_TICK_MS = 400;

export interface ContextMeterDeps {
  getMessages(): readonly Message[];
  getSystemPrompt(): string;
  /** 主模型的 ModelInfo。每次测量都重读——会话中途可以换模型。 */
  getModelInfo(): ModelInfo;
  /** 静态表是否认得主模型（分母是否真实）。 */
  isWindowKnown(): boolean;
  /** 用户的 `contextWindow` 覆盖值，或 null。每次测量都重读。 */
  getWindowOverride(): number | null;
}

export class ContextMeter {
  constructor(deps: ContextMeterDeps);

  /** 订阅发布。返回退订函数。 */
  subscribe(listener: (usage: ContextUsageSnapshot) => void): () => void;

  /** 接入 agent 事件流。幂等（`attach` 已挂则直接返回）。 */
  attach(subscribe: (l: (e: AgentEvent) => void) => () => void): void;

  /**
   * 当前占用。`dirty` 时同步重测（I-2），并在测量前跑 I-9 的结构性兜底。绝不抛。
   * 给**屏幕**用。
   */
  current(): Pressure;

  /**
   * 最近一次发布的压力，**永不重测**（I-10）。给**记账**用——
   * `Compactor.lastMeasured()` 转发的是这个，`tokensBefore` 依赖它是压缩前的值。
   */
  lastPublished(): Pressure | null;

  /** 决策点用：带上调用方的权威 `lastUsage` 测一次，清脏，并发布。 */
  measureWith(lastUsage: TokenUsage | undefined): Pressure;

  /** `turn_end`：重算 offset + prefix + lastUsage，测量并**立即**发布。 */
  onTurnEnd(usage: TokenUsage): void;

  /**
   * 压缩拼接被采纳（I-8 浅复位）。丢 `lastUsage` + `measuredPrefixLength`，
   * **保留 `estimateOffset`**（I-5）。幂等：已经脏了就只是不再重复安排发布。
   */
  onHistorySpliced(): void;

  /**
   * 换了一段不同来源的历史（`/clear`、`/reset`、`/resume`）——I-8 深复位。
   * 三个字段全清，含 `estimateOffset`。
   */
  onHistoryReplaced(): void;

  /** 只是分母变了（换模型、改 contextWindow）：不丢基线，重测并发布。 */
  onWindowChanged(): void;

  /** 置脏 + 安排一次节流发布。**永远不同步测量**（I-3）。 */
  scheduleTick(): void;

  dispose(): void;
}
```

**agent 事件处理**（`attach` 内部）：

| 事件 | 动作 | 理由 |
|---|---|---|
| `turn_end` | `onTurnEnd(event.usage)` → 同步测量 + 立即发布 | 此刻历史正好等于被测量的那段前缀（`agent-loop.ts:478` 在 push 之前发），所以 `deltaTokens===0`、`source==='usage'`，是全流程唯一一个**完全测量**的时刻，必须立刻上屏 |
| `tool_execution_end` | `scheduleTick()` | I-3：延迟，让那条 `tool_result` 先落进历史 |
| `compaction_end` | `applied ? onHistorySpliced() : scheduleTick()` | 采纳了才丢基线（I-8 的**浅**复位——`estimateOffset` 留着，I-5）；被拒的 checkpoint 历史没变，只是可能长大了 |
| `agent_end` | `scheduleTick()` | 收尾定格 |
| 其他 | 忽略 | `message_update` 是流速事件（N-2） |

> **这张表不是压缩联动的正确性来源**（I-9）。真正保证 `wiring.snapshot()` 读到压缩后的
> 数的是 `wiring.ts:589` 那个既有 invalidation site 改调 `meter.onHistorySpliced()` ——
> 它在 wiring 自己的同步代码里、在两次 `emit` 之前，与监听器注册顺序无关。
> 上表这一行是**第二条**、幂等的路径，服务于手工 `/compact` 与将来可能出现的其它拼接者。

**发布节流**：`scheduleTick()` 的第一条语句是 **I-11 的门**——`listeners.size === 0` 时
只置脏、直接返回，一个定时器都不排（`aragon exec` 与任何无 UI 的宿主因此零成本）。
其后：若已有定时器则不重复安排；定时器句柄一律 `unref()`，使一个待触发的刻度不能把进程
退出往后拖；定时器触发时若 `dirty` 则测量并发布，否则什么都不做。`dispose()` 清定时器。
**`current()` 不清定时器**——一次已安排的发布即使量到相同的数也是无害的（reducer 有恒等
短路，见 §5.2）。

**测量成本**：走 measured 分支时 `estimateAppendedTokens`（`pressure.ts:121-128`）只遍历
`messages.slice(measuredPrefixLength+1)`——一个回合宽的切片，这是刻度的**热路径**。
estimate 分支才遍历全历史，而 `estimatePromptTokens`（`core/llm/output-limits.ts:356-364`）
**并非完全无分配**（RV-10）：`messageLength`（`:336-346`）对每个 `tool_call` 块要走一次
`JSON.stringify(block.args ?? {})`，文本块才是纯 `.length`。这不改变结论——estimate 分支
只在首个 `turn_end` 之前、`/resume` 之后、以及压缩刚拼接完的那一小段窗口里出现，而在这三
种情形里下一个 `turn_end` 会立刻把基线切回 measured 分支——但 R-4 的缓解论证必须建立在
准确的成本模型上，而不是一句「无分配」。节流 400 ms 下最坏 2.5 次/秒，且**仅在有订阅者时**。

### 3.3 W2 —— 压缩联动（P0-1）

**改 4 处，删 2 处：**

1. `compactor.ts`：删掉 `estimateOffset` / `measuredPrefixLength` / `lastPressure` 三个
   字段与 `computeEstimateOffset` 的 import；**三个**方法转发到 `this.deps.meter`，
   **第四个删除**，对应关系逐条写死（I-10 / I-8 / I-9）：

   | `Compactor` 方法 | 处置 | 为什么不能接到别的上面 |
   |---|---|---|
   | `measure(input)` | → `meter.measureWith(input.lastUsage)` | 决策点要的是「带权威 usage 测一次」 |
   | `lastMeasured()` | → **`meter.lastPublished()`** | `:873` 的 `tokensBefore` 要压缩**前**的值；接到 `current()` 上会让 `tokensReclaimed` 静默归零（I-10） |
   | `onTurnEnd(...)` | → `meter.onTurnEnd(usage)` | meter 自己也订阅了 `turn_end`，两条路径都必须幂等 |
   | `invalidateMeasurement()` | **删除** | 它的两个生产调用点复位深度**相反**（`wiring.ts:283` 是换会话、`:589` 是拼接），本轮 `estimateOffset` 的去留把它们分开了，一个不提深度的名字再也无法同时服务两者（I-9 的表） |

   `shouldCompact`（`:306`）改为 `const pressure = this.deps.meter.measureWith(probe.lastUsage);`
   —— **仍在 `!config.enabled` 早退之后**，因为 meter 已经在别处独立测量了，这里只是决策点。
2. `wiring.ts` 的**两个** invalidation 调用点各自直呼 meter，深度不同（I-9）：
   - `:283`（`CompactionWiring.onHistoryReplaced()` 的函数体）→ `this.deps.meter.onHistoryReplaced()`
   - `:589`（`settlePending` 的 `applied` 分支）→ `this.deps.meter.onHistorySpliced()`

   `:589` 那一行的**位置**是压缩联动正确性的承重点：它在 `emit(compaction_end)` 与
   `emit(snapshot)` 两句之前、在 wiring 自己的同步代码里，所以第 3 条那次 `current()`
   必然看到脏标记。
   **不要把它删掉、改成「靠 meter 自己订阅 `compaction_end`」** ——那正是 v1 的写法，
   而它把正确性押在两个 agent-stream 监听器的注册次序上（RV-2）。
3. `wiring.ts:408-415` `snapshot()` 改为 `return this.snapshotWith(this.deps.meter.current());`
   —— 有了第 2 条的置脏，`current()` 在此必然重测，于是 `:594` 那次 emit 携带压缩后的数。
   `snapshotWith` 保持不变。
   连带：`wiring.ts:565-571` 那段注释里「`snapshot()` 用的是缓存压力
   （`compactor.lastMeasured()`），所以这里不花重测」**已经过期，必须同一提交里改掉**
   （RV-11）——静默 decline 路径现在每次会走一次 `current()`。次数仍由 guard 4 的
   `stuckLimit` 封顶，成本结论不变，但一条与代码不符的承重注释比没有注释更糟。
4. `wiring.ts:517-521`（`turn_end` 分支里那次 `this.compactor.measure({...})`）**删除**：
   meter 自己订阅了 `turn_end`，这里再测一次是重复。保留 `:513` 的
   `this.compactor.onTurnEnd(...)`？**不保留**——它也是转发，且 meter 已经处理。整个
   `turn_end` 分支缩成 `this.emit({ type: 'snapshot', snapshot: this.snapshot() })`，
   因为快照上的**其他**字段（inFlight / 计数 / summarizer）仍需刷新。
5. `App.tsx:1005-1015`（`compaction_end` 里的 `contextTokensEstimated` 派发）**整段删除**。
6. `App.tsx:1034-1053`（`snapshot` 里的 `contextTokensEstimated` 派发）**整段删除**，只留
   `dispatch({ type: 'compactionSnapshot', snapshot: event.snapshot })`。

删掉这两处之后，`ViewState` 的占用只由 meter 订阅派发（I-1），P0-1 在**结构上**不可能再
发生：没有第二个写入者可以覆盖第一个。

### 3.4 W3 —— 历史被替换后的重挂钩（P0-2）

`controller.ts` 三处：

| 位置 | 现状 | 改为 |
|---|---|---|
| `clearMessages()` `:1666-1680` | `this.compaction?.onHistoryReplaced()` | 追加 `this.contextMeter.onHistoryReplaced()` |
| `replaceMessages()` `:1688-1694` | 同上 | 同上 |
| `setModel(...)` | 无 | 追加 `this.contextMeter.onWindowChanged()` |

这三处走的都是 I-8 的**深**复位 `onHistoryReplaced()`（三个字段全清）；压缩拼接走的是
**浅**复位 `onHistorySpliced()`，两者不可互换，理由见 I-8 与 I-5。

`onHistoryReplaced()` 会丢掉 `lastUsage` / `measuredPrefixLength`（它们索引的数组已不存在）、
置脏并安排发布。于是：

- `/resume` 一个 18 万 token 的会话 → 走 estimate 分支 + 上一个会话残留的 offset？**不**：
  `onHistoryReplaced()` **同时清空 `estimateOffset`**。理由：offset 是「这套工具 schema
  在这个模型上的系统性差额」，`/resume` 可能同时换了模型（`builtins.ts:1071-1073`），把
  旧 offset 套到新会话上是把一个校准量当常数用。清空之后首次读数是纯估计（偏低），第一个
  `turn_end` 就会把它校正回来——**偏低且会自纠**，好过偏高且不自纠。
- `/reset` → 历史空了，估计值≈系统提示词，`~2%` 而不是硬写的 `0`。

**裸 `/model` 切换的自纠窗口（RV-13）**：`setModel` 走 `onWindowChanged()`，它**只重测、
不丢基线**——于是紧接着的那一读里 `lastUsage` 与 `estimateOffset` 仍是**上一个模型**的
校准量。这是有意的取舍：分母立刻正确（用户最关心的那一半），分子在下一个 `turn_end`
被 `onTurnEnd()` 整体刷新（重算 offset + prefix + lastUsage），窗口最长一个回合。
把 `setModel` 也接成深复位并不更好——那会把一段仍然有效的测量基线换成全历史估计，
在换模型这个常见操作上制造一次可见的读数跳变，换来的只是提前一个回合的精度。
`/resume` 之所以是深复位，是因为它**同时**换了历史；两者不是同一件事。

**`resetConversation` 的 reducer 分支不再写占用**（I-1）。`builtins.ts:1006` 的顺序是
`controller.clearMessages()`（meter 同步置脏 + 安排发布）→ `dispatch(resetConversation)`，
若 reducer 也清零，最终态就是 `0` 而不是 meter 稍后发布的真值；把它交给 meter，两者不再
打架。`usageTotal` 的清零**保留**在 `resetConversation` 里——那是会话累计，不是占用。

### 3.5 W4 —— 回合内的活体刷新（P1-4）

见 §3.2 的事件表与 I-3。补两条：

- **压缩关掉的会话现在也有刻度。** meter 与 `compaction.enabled` 无关，这是它必须由
  `AgentController` 持有的全部理由。
- **刻度不改变压缩行为。** meter 的发布只走 UI 订阅；触发仍然只发生在
  `agent-loop.ts:401` 的 checkpoint 上，由 `Compactor.shouldCompact` 决定。本轮不新增任何
  触发时机。

### 3.6 W5 —— 累计口径与「总的上下文」

**`UsageTotal` 补两个字段**，并把四处累加收敛成一个 helper：

```ts
// agent/reducer.ts
export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  /** 缓存读命中。`occupiedTokens` 计入、`computeCost` 计价，累计读数不能不计。 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

// agent/usage.ts
export function addUsage(total: UsageTotal, usage: TokenUsage, costDelta: number): UsageTotal;
/** 状态栏 `↑` 的取数：与 `occupiedTokens` 的 prompt 侧口径逐字一致。 */
export function promptTokensOf(total: UsageTotal): number;
```

`reducer.ts` 的四处（`:1283` `turnEnd`、`:1553` `teamUsage`、`:1699` `fastUsage`、
`:1852` `compactionUsage`）全部改成 `usageTotal: addUsage(state.usageTotal, action.usage, action.costDelta)`。
**收敛成一个函数是重点**：第五个来源（将来的某个后台调用）如果自己手写三行加法，就会
再一次悄悄漏掉 cache 字段。

**状态栏右簇的新排布**（`StatusBar.tsx`）：

```
[████░░░░] 43%  86k/200k   total 1.2M^ 48k v   $3.21   12 tok/s  1m02s
            ^     ^            ^
            |     |            +-- cols >= 96（原 72），加 `total ` 前缀
            |     +-- 新增，cols >= 72，分母不可信时后缀 `?`
            +-- 不变，占用是估算或分母未知时前缀 `~`
```

- **绝对值对占用原来累计读数的列预算**（D-6）。同一行上必须先说清「现在占了多少 / 一共
  多少」，再说「这个会话一共烧了多少 token」；把后者摆在前者前面，就是把一个用户**正在
  误读**的数字放在他最需要的数字前面。
- `total ` 前缀是 ASCII 单词而不是 `Σ`：`ui/**` 在字形扫描器范围内（`glyphs.test.ts:210`），
  新字形要走 `glyphs.ts` 加 ASCII 回退，为一个前缀不值得。
- `cols < 72` 时右簇退化为 `43%  $3.21`，与今天一致。

**分母的可配置化**：新增顶层配置 `contextWindow: number | null`（默认 `null` = 用模型表 /
占位值），配套 `ARAGON_CONTEXT_WINDOW` 环境变量与 `aragon config set contextWindow 1000000`。
设值后 `windowKnown` 为真、`windowOverridden` 为真（I-6）。

**clamp 是三态的，`null` 必须直通（RV-12）**：`clampContextWindow(v, fallback)` 的第一条
语句是 `if (v === null) return null;`，之后才是 `Math.min(5_000_000, Math.max(8_000, n))`，
非数字回落 `fallback`。把 `null` 一起夹进 `[8_000, …]` 会得到 8000 ——「auto」这个取值
从配置里永久消失，而症状是一个 8k 的分母配上一条恒红的进度条，用户找不到它是从哪来的。
`maxTokens` 是现成的同形先例：`PersistedConfig.maxTokens: number | null`
（`config/schema.ts:1506`，注释逐字写着「`null` MEANS AUTO」）、`cli.tsx:1268` 的独立
`runConfigSetMaxTokens` 分支回显 STORED 值、`cli-commands.ts:471` 的 `displayOverride`
把 `null` 打成 `auto`。**三处都照抄，不发明第二套三态约定。**

### 3.7 W6 —— `/context`、阈值一致性、两个标记

**`/context`**（实现落在 `compaction/context-command.ts`，`builtins.ts` 只登记；
`builtins.ts` 已过 1000 行，这是 `/compact` 立下的先例，见 `builtins.ts:938-940`）：

```
Context
  Occupancy      43%   86.2k of 200k          [measured 85.1k + 1.1k estimated]
  Window         200000   from the model table (anthropic:claude-...)
  Since measured 4 messages appended since the last provider-reported usage
  Compaction     on - triggers at 90% (amber at 75%), 2 this session, 118k reclaimed
  Session spend  1.24M in (incl. 940k cache read, 12k cache write) / 48.2k out, $3.21
                 includes subagent, fast-tier and compaction spend, not just this conversation
```

第 6 行那句 `includes ...` 就是 D-7：不加四个计数器，但**把这个数里有什么说出来**。
`Window` 一行在覆盖生效时改为 `from contextWindow in config.json (overrides the model table)`，
在占位值生效时改为 `128000   PLACEHOLDER - this model is not in the table; set contextWindow to correct it`。

**`Compaction` 一行有四种形态，不是一种（RV-8）。** 上面的样例只画了其中一种；照它实现
会对一个 `--no-compaction` 的会话打印「Compaction on - triggers at 90%」，那是一句彻底的
假话，而 `/context` 存在的全部理由就是**成为那个可以被信任的报告面**。四态的判据与文案
逐条给死，取值来源与 `formatCompactionStatus`（`compaction/command.ts:41-62`）**共用同一组
谓词**，不另起一套：

| 判据 | `Compaction` 行 |
|---|---|
| `!controller.isCompactionRegistered()` | `off - not registered for this session (started with --no-compaction)` |
| 已注册，`snapshot.selfDisabled` | `self-disabled (<reason>) - no compaction will run until /compact on` |
| 已注册，`!controller.isCompactionEnabled()` | `off for this session - /compact on re-enables it` |
| 已注册且启用，`!snapshot.live` | `on, but no summarizer model resolves - triggers at 90% (amber at 75%)` |
| 已注册且启用且 `live` | `on - triggers at 90% (amber at 75%), 2 this session, 118k reclaimed` |

> **`/context` 的占用数据只能来自 `controller.getContextUsage()`，绝不能来自
> `getCompactionSnapshot().pressure`。** 后者在压缩未注册时返回的是
> `offCompactionSnapshot()`（`wiring.ts:114-135`）里那份**硬编码的零压力**
> （`occupied: 0, contextWindow: 0, windowKnown: false`）。而「压缩关掉的会话也要有真实
> 读数」正是 W1 存在的理由——从那里取数会让 `/context` 在它最该管用的那类会话里读 0%。
> 顺带记一笔：`offCompactionSnapshot().pressure` 在本轮之后成为**无人读取的死数据**，
> `/compact status` 在未注册分支早退、根本不打印 Occupancy 行（`command.ts:47-52`），
> 所以 AC-2 不受它影响；本轮**不删**它（那是压缩子系统的类型完整性），但任何新读者
> 都必须先回读这一段。

**阈值一致性（P2-6）**：`App.tsx` 传 `gaugeMarks` 的条件从 `state.compaction?.live` 改为
**`controller.isCompactionEnabled()`**，取值仍是 `cfg.compaction.warnThreshold * 100` /
`cfg.compaction.threshold * 100`。理由：颜色回答的是「什么时候会被压」，那由**配置**决定，
不由 summarizer 当下解不解析得出来决定。

> **谓词是 `isCompactionEnabled()`，不是 `isCompactionRegistered()`（RV-4）。**
> `live = this.enabled && summarizer !== null`（`wiring.ts:430`）有**两个**假值来源，
> 本条只想解开后一个。`isCompactionRegistered()`（`controller.ts:1846`，`this.compaction
> !== null`）把前一个也解开了：`/compact off` 之后颜色仍按 90%/75% 着色 ——
> **用颜色承诺一次不会来的救援**，比 P2-6 本身更坏。`isCompactionEnabled()`
> （`controller.ts:1851`，`this.compaction?.isEnabled() === true`）正好是要的那条线：
> 已注册**且**开着，与 summarizer 解不解析得出来无关。未注册时它返回 `false`，
> 于是仍取 `gauge.ts:36` 的 60/85 默认，那一档的语义是「没有人会来救你」，与今天一致。
>
> **它是在 render 里读的一个非响应式 getter，而这是安全的**，理由必须写下来：
> `setEnabled` 与 `onConfigChanged`（`wiring.ts:258-269`）**都**会 `emit` 一个 `snapshot`，
> App 据此 `dispatch({type:'compactionSnapshot'})` 触发重渲染，那一帧才重新读它。
> 若将来有人加一条**不发 snapshot** 的启停路径，这行会静默停在旧颜色上；届时正确的修法
> 是给 `CompactionSnapshot` 补一个 `enabled: boolean` 字段（今天它只有合成好的 `live`，
> `types.ts:144-157`），而不是在这里加一个 `useEffect` 轮询。
>
> **改动必须把一个条件展开拆成两个。** `App.tsx:2658-2665` 今天是
> `{...(state.compaction?.live ? { compactionActive: {...}, gaugeMarks: {...} } : {})}`
> —— 两个 prop 共用一个条件。照字面「把条件改掉」会连 `compactionActive` 一起改，
> 而那个 chip 的既有约定（源码注释逐字写着）是「`/compact off` 之后必须停止宣传自己」。
> 正确改法是拆成两个独立的展开：`compactionActive` 继续吃 `state.compaction?.live`，
> `gaugeMarks` 吃 `controller.isCompactionEnabled()`。

**两个标记（P2-7）**：`~` 留给**分子**（占用是估的），`?` 给**分母**（窗口是编的），
`?` 只出现在本轮新增的绝对值对上，所以既有输出的形状一字不变。

---

## 4. Interface design

### 4.1 新增：`ContextUsageSnapshot`（`compaction/types.ts`）

```ts
/**
 * 状态栏与 `/context` 读的唯一占用投影。
 *
 * 刻意**不带时间戳**：唯一的消费者是 reducer 的恒等短路（§5.2），而一个每次刻度都变的
 * 字段会让那个短路永远不成立，把一条常驻屏幕的行变成 2.5 Hz 的重渲染源。
 */
export interface ContextUsageSnapshot {
  /** 占用 token（测量 + 可能的追加估算）。 */
  occupied: number;
  /** 实际使用的分母。 */
  window: number;
  /** `occupied / window` 的百分比，clamp 到 [0,100] 并取整。 */
  pct: number;
  /** 基线来自哪里。 */
  source: 'usage' | 'estimate';
  /** `occupied` 里属于「测量之后追加部分」的估算量；> 0 即整体近似。 */
  deltaTokens: number;
  /** 分母是否可信（在模型表里，或用户显式覆盖）。 */
  windowKnown: boolean;
  /** 分母是否来自用户的 `contextWindow` 覆盖（I-6）。 */
  windowOverridden: boolean;
}
```

`Pressure`（`compaction/types.ts:57-95`）新增 `windowOverridden: boolean`，由
`computePressure` 从 `PressureInput` 透传。`toContextUsage(p: Pressure): ContextUsageSnapshot`
是两者之间唯一的转换函数，导出自 `compaction/meter.ts`。

### 4.2 `AgentController` 新增 3 个方法

```ts
/** 无条件可用（压缩关掉也在）。返回退订函数。 */
subscribeContextUsage(listener: (u: ContextUsageSnapshot) => void): () => void;
/** 当前占用，脏则同步重测。`/context` 与测试用。 */
getContextUsage(): ContextUsageSnapshot;
/** 供 `CompactionWiring` / `Compactor` 注入，也供测试断言「全进程只有一个」。 */
getContextMeter(): ContextMeter;
```

### 4.3 `StatusBar` props 收敛

删除 `contextTokens` / `contextWindow` / `contextWindowKnown` / `contextEstimated` 四个
props，代之以一个：

```ts
/** 占用投影。见 `ContextUsageSnapshot`。 */
context: ContextUsageSnapshot;
```

四个平行 prop 是「多个真相源」在 props 层的投影，收成一个对象之后调用方不可能只更新其中
三个。`usageTotal` prop 保留（它是另一个量）。

### 4.4 新增 reducer action

```ts
| { type: 'contextUsage'; snapshot: ContextUsageSnapshot }
```

删除 `{ type: 'contextTokensEstimated'; tokens: number }`（`reducer.ts:643`）。

### 4.5 CLI / 配置面

| 面 | 签名 | 说明 |
|---|---|---|
| 斜杠命令 | `/context` | 无参数。输出见 §3.7 |
| 配置 | `aragon config set contextWindow <n\|auto>` | `auto` 写入 `null`（**不经 clamp**，RV-12）。回显 **STORED** 值（`maxTokens` 先例，`cli.tsx:1268` 的独立 `runConfigSetMaxTokens` 分支——本键同样需要一个 switch 之前的独立分支，否则回显的是用户键入值而非 clamp 后的值） |
| 配置 | `aragon config get contextWindow` | `null` 显示为 `auto`（`cli-commands.ts:471` 的 `displayOverride` 加一条） |
| 环境变量 | `ARAGON_CONTEXT_WINDOW=1000000` | 与 `env.ts` 既有正列表同款解析 |

**不新增**任何 REST / WebSocket / 进程间接口——本包没有这些面。

---

## 5. Data model

### 5.1 磁盘

`~/.aragon-agent/config.json` 顶层新增一个可选标量：

```jsonc
{
  "contextWindow": null   // number | null；null = 用模型表 / 占位值
}
```

`SavedSession`（`session/*`）**不变**：占用是运行期派生量，存下来只会在 `/resume` 时提供
一个过期的数——而 `/resume` 恰好是本轮要求必须**重新测量**的路径（P0-2）。

### 5.2 内存

`ViewState`（`agent/reducer.ts:378-...`）：

```diff
-  contextTokens: number;
-  contextTokensEstimated: boolean;
+  /**
+   * 占用投影。**唯一写入者是 `case 'contextUsage'`**（I-1）。
+   */
+  context: ContextUsageSnapshot;
```

初值：`{ occupied: 0, window: 0, pct: 0, source: 'estimate', deltaTokens: 0, windowKnown: false, windowOverridden: false }`。

**恒等短路**（性能承重，写在 reducer 分支里）：

```ts
case 'contextUsage': {
  const prev = state.context;
  const next = action.snapshot;
  // 刻度多数时候量到同一个数。返回同一个 state 对象让 React 直接跳过重渲染——
  // 状态栏是全程常驻的一行，2.5 Hz 的无差别重渲染会一路推高渲染调速器的档位。
  if (
    prev.occupied === next.occupied && prev.window === next.window &&
    prev.pct === next.pct && prev.source === next.source &&
    prev.deltaTokens === next.deltaTokens &&
    prev.windowKnown === next.windowKnown && prev.windowOverridden === next.windowOverridden
  ) return state;
  return { ...state, context: next };
}
```

`ContextMeter` 的内存足迹：5 个标量 + 一个 `Set<listener>` + 一个定时器句柄。**不持有历史
消息的任何副本**——它每次从 `deps.getMessages()` 读引用。

---

## 6. File / module change plan

| 文件 | 新建/修改 | 一句话意图 |
|---|---|---|
| `packages/cli/src/compaction/meter.ts` | **新建** | `ContextMeter`：占用测量的唯一所有者；dirty 标记、`current()` 同步重测 + I-9 结构性兜底、`lastPublished()` 纯缓存读（I-10）、`onHistorySpliced()` / `onHistoryReplaced()` 两级复位（I-8）、无订阅者不排定时器 + `unref()`（I-11）、`toContextUsage()`；ASCII-only（I-7） |
| `packages/cli/src/compaction/types.ts` | 修改 | `Pressure` 增 `windowOverridden`；新增并导出 `ContextUsageSnapshot` |
| `packages/cli/src/compaction/pressure.ts` | 修改 | `PressureInput` 增 `windowOverridden?`，`computePressure` 原样透传。**算术一行不动**（I-4） |
| `packages/cli/src/compaction/compactor.ts` | 修改 | 删 `estimateOffset` / `measuredPrefixLength` / `lastPressure` 三字段；**删 `invalidateMeasurement()`**；其余三个方法按 §3.3 第 1 条的**逐条对应表**转发到 `deps.meter`（`lastMeasured → lastPublished` 一条不可弄错）；`CompactorDeps` 增 `meter` |
| `packages/cli/src/compaction/wiring.ts` | 修改 | `CompactionWiringDeps` 增 `meter` 并转交；`:283` → `meter.onHistoryReplaced()`（深）、`:589` → `meter.onHistorySpliced()`（浅），**两处深度不同**；`snapshot()` 读 `meter.current()`；`turn_end` 分支删掉重复测量；**`:565-571` 那段「不花重测」的注释同一提交里更新**（RV-11） |
| `packages/cli/src/compaction/context-command.ts` | **新建** | `/context` 报表；ASCII-only |
| `packages/cli/src/agent/controller.ts` | 修改 | 无条件构造 + attach `ContextMeter`；`clearMessages` / `replaceMessages` / `setModel` 三处挂钩；新增 3 个公开方法；`dispose()` 释放 |
| `packages/cli/src/agent/reducer.ts` | 修改 | `contextTokens`+`contextTokensEstimated` → `context`；新增 `contextUsage` 分支（含恒等短路）；删 `contextTokensEstimated` action；`UsageTotal` 增 cache 字段；四处累加改走 `addUsage` |
| `packages/cli/src/agent/usage.ts` | 修改 | 新增 `addUsage()` / `promptTokensOf()`；`computeCost` 不动 |
| `packages/cli/src/ui/App.tsx` | 修改 | 订阅 `subscribeContextUsage` 并派发；删两处 `contextTokensEstimated` 派发；`StatusBar` 传 `context={state.context}`；`:2658-2665` 的条件展开**拆成两个**——`compactionActive` 留在 `state.compaction?.live`，`gaugeMarks` 改吃 `controller.isCompactionEnabled()`（RV-4） |
| `packages/cli/src/ui/StatusBar.tsx` | 修改 | 四 props 收敛为 `context`；新增 `86k/200k` 绝对值对（`cols>=72`）与 `?` 分母标记；累计读数门槛 72→96 并加 `total ` 前缀 |
| `packages/cli/src/ui/transcript-text.ts` | 修改 | 退出摘要的 token 行改走 `promptTokensOf()`，与状态栏同口径 |
| `packages/cli/src/ui/exit-snapshot.ts` | 修改 | `UsageTotal` 形状变更的连带（若只是转发则仅类型跟随） |
| `packages/cli/src/commands/builtins.ts` | 修改 | 登记 `/context`（仅登记，实现在 `context-command.ts`） |
| `packages/cli/src/config/schema.ts` | 修改 | `PersistedConfig.contextWindow: number \| null`；`DEFAULT_CONFIG` 补 `null`；新增 `clampContextWindow(v, fallback)`——**`null` 第一条语句直通**，其后 clamp `[8_000, 5_000_000]`（RV-12，`clampTranscriptWindow` `:149-152` 是形状先例、`maxTokens` `:1506` 是三态先例） |
| `packages/cli/src/config/env.ts` | 修改 | `ARAGON_CONTEXT_WINDOW` |
| `packages/cli/src/cli.tsx` | 修改 | `CONFIG_SET_KEYS` 加 `contextWindow` + setter 分支（回显 STORED 值） |
| `packages/cli/src/config/cli-commands.ts` | 修改 | `displayOverride` 对 `contextWindow === null` 显示 `auto` |
| `packages/cli/README.md` | 修改 | 状态栏图例、`/context`、`contextWindow` 三处文档 |
| `packages/cli/src/__tests__/context-meter.test.ts` | **新建** | meter 状态机（见 §7.1） |
| `packages/cli/src/__tests__/context-gauge-wiring.test.ts` | **新建** | P0-1 / P0-2 回归 |
| `packages/cli/src/__tests__/context-one-writer.test.ts` | **新建** | I-1 的源码扫描守护 |
| `packages/cli/src/__tests__/status-bar-context.test.tsx` | **新建** | 宽度阶梯 + `~` / `?` 标记 |
| `packages/cli/src/__tests__/context-command.test.ts` | **新建** | `/context` 三种分母来源的文案 |
| `packages/cli/src/__tests__/reducer.test.ts` | 修改 | 单一写入者 + `addUsage` 的 cache 累加 |
| `packages/cli/src/__tests__/compaction-{compactor,wiring,pressure,e2e}.test.ts` | 修改 | 注入 meter；`computePressure` 行为不变的断言保留 |
| `packages/cli/src/__tests__/config.test.ts` | 修改 | `contextWindow` clamp / 默认 / `auto` 回显 |

**不改**：`packages/core/**`（N-1）、`exec/**`（N-4）、`ui/gauge.ts`（阈值来源变了，函数
本身不变）、`ui/layout/budget.ts`（行数预算不变，状态栏仍是一行）。

---

## 7. Testing & acceptance criteria

### 7.1 单元测试

| # | 文件 | 断言 |
|---|---|---|
| T1 | `context-meter.test.ts` | `turn_end` 后 `current().source === 'usage'` 且 `deltaTokens === 0` |
| T2 | 同上 | `tool_execution_end` **同步**不改变 `current()`（未 push 前不测），定时器推进后才变 —— **I-3 的回归**，用 fake timers，且必须**两个方向都断言**：推进前不变、推进后变 |
| T3 | 同上 | `onHistoryReplaced()` 之后 `source === 'estimate'`、`estimateOffset` 被清空、下一次 `current()` 反映**新**历史 |
| **T3b** | 同上 | **I-8 / RV-1 的回归**：`onHistorySpliced()` 之后 `source === 'estimate'`、`lastUsage` 与 `measuredPrefixLength` 被清、而 **`estimateOffset` 原样保留**，`current().occupied === estimatePromptTokens(新历史) + offset`。**两个方法都要断言、且必须断言在 `estimateOffset` 上分叉** —— 只测「拼接后走 estimate 分支」两个方法都会绿，而这条不变量的全部内容就是它们的差别 |
| **T3c** | 同上 | **I-9 belt 的回归**：不调用任何复位方法，直接把 `getMessages()` 换成一个比 `measuredPrefixLength` 更短的数组，`current()` 必须自行降级到 estimate 分支（而不是返回旧的 measured base） |
| T4 | 同上 | `current()` 在脏时同步重测；连续两次 `current()` 只测一次（第二次读缓存） |
| T5 | 同上 | `dispose()` 后已安排的定时器不再发布 |
| T6 | `context-gauge-wiring.test.ts` | **P0-1 回归**：喂完整序列（checkpoint 测量 → `compact()` → 历史被换成短的 → 核心 `compaction_end` → wiring `settlePending`），断言最终 `ViewState.context.occupied` 是**压缩后**的值；并断言 `snapshot` 事件携带的 `pressure.occupied` 同样是压缩后的值 |
| T7 | 同上 | **P0-1 的顺序无关性（I-9）**：把 meter 的 attach 分别注册在 wiring 之前和之后各跑一遍，`snapshot` 事件携带的 `pressure.occupied` **两次都是压缩后的值**。这条在 v1 的设计下**必然有一次失败**（RV-2），它现在守的是「置脏发生在 `wiring.ts:589`，不依赖监听器次序」。做一次变异验证：把那行改回 `compactor.invalidateMeasurement()` 的旧语义（或让它只在 meter 自己的 `compaction_end` 里置脏），T7 必须变红 |
| **T7b** | 同上 | **I-10 的回归**：跑完一次成功压缩，断言 `record.tokensBefore` 是压缩**前**的占用、`tokensReclaimed > 0`。变异验证：把 `Compactor.lastMeasured()` 接到 `meter.current()` 上，这条必须变红（否则它没有守住任何东西） |
| T8 | 同上 | **P0-2 回归**：`replaceMessages(<18 万 token 历史>)` 之后，无需任何回合，`getContextUsage().pct` > 80 |
| T9 | 同上 | 压缩**关闭**（`compaction.enabled=false`，`controller.compaction === null`）时，`tool_execution_end` 刻度仍然推动 `getContextUsage()` —— P1-4 的核心 |
| **T9b** | `context-meter.test.ts` | **I-11 的回归**：**零订阅者**时 `tool_execution_end` **不排任何定时器**（用 fake timers 断言 `vi.getTimerCount() === 0`），但 `current()` 仍返回更新后的占用；`subscribe()` 之后第一次 `scheduleTick()` 才排定时器。**两个方向都断言** —— 只测「无订阅者时不发布」会被一个「排了定时器但发布时发现没听众」的实现骗过，而那个实现照样吊住 exec 的事件循环 |
| **T9c** | 同上 | 已排出的定时器句柄调用过 `unref()`（注入一个可断言的 `setTimeout` 替身，或断言返回句柄上 `unref` 被调用） |
| T10 | `context-one-writer.test.ts` | 源码扫描 `agent/reducer.ts`：`context:` 作为对象字面量键的赋值**只允许**出现在 `case 'contextUsage'` 的函数体内；`contextTokens` 标识符全文为 0 次 |
| T11 | 同上 | 源码扫描：`src/**` 内 `dispatch({ type: 'contextUsage'` 的出现次数恰好为 1 |
| T12 | `reducer.test.ts` | `contextUsage` 同值时返回**同一个 state 引用**（恒等短路） |
| T13 | 同上 | 四个 usage action 都把 `cacheReadTokens` / `cacheWriteTokens` 累加进 `usageTotal`；`promptTokensOf` 与 `occupiedTokens` 的 prompt 侧口径一致 |
| T14 | 同上 | `resetConversation` **不**改 `state.context`（I-1），但**要**清 `usageTotal` |
| T15 | `status-bar-context.test.tsx` | 宽度阶梯：`cols=60` 无绝对值对；`cols=72` 有 `86k/200k`；`cols=96` 追加 `total ...` |
| T16 | 同上 | `windowKnown=false` 时绝对值对带 `?`；`source='estimate'` 或 `deltaTokens>0` 时百分比带 `~`；两者**独立**（四种组合都断言） |
| T17 | 同上 | `windowOverridden=true` ⇒ 无 `~`、无 `?`（I-6） |
| T18 | `context-command.test.ts` | 三种分母来源各自的 `Window` 行文案；`Session spend` 行含 `includes subagent, fast-tier and compaction spend` |
| **T18b** | 同上 | **RV-8 的回归**：`Compaction` 行的**五种**形态逐条断言，其中未注册（`--no-compaction`）那条**必须不含** `on` 与 `triggers at`；且未注册会话的 `Occupancy` 行取自 `getContextUsage()` 而**非** `offCompactionSnapshot()` 的零压力 —— 喂一段非空历史，断言 `Occupancy` > 0 |
| T19 | `compaction-pressure.test.ts` | 既有断言全绿（`computePressure` 算术未变）；新增 `windowOverridden` 透传 |
| T20 | `config.test.ts` | `contextWindow` 默认 `null`、clamp 上下界、`auto` 回显、`ARAGON_CONTEXT_WINDOW` 解析 |
| T21 | `glyphs.test.ts` | 新增两个文件在 `compaction/` 树内被扫到且无非 ASCII 字节（I-7 的既有守护自动覆盖） |

### 7.2 验收标准（AC）

- **AC-1** 一次成功的自动压缩后，进度条在**同一帧**下落到压缩后的占用，并在下一个
  `turn_end` 之前**不回弹**。（对应 P0-1，T6/T7）
- **AC-2** `/compact status` 与状态栏在任何时刻显示同一个百分比，误差 0。（结构保证：
  两者都读 `meter.current()`）
- **AC-3** `/resume` 一个已知大小的会话文件后，**无需发送任何消息**，进度条与
  `/context` 立即显示合理占用（估计值，带 `~`）。（P0-2，T8）
- **AC-4** `compaction.enabled=false` 的会话里，工具执行推进进度条。（P1-4，T9）
- **AC-5** 状态栏 `↑` 的数值 = `inputTokens + cacheReadTokens + cacheWriteTokens`，
  即 `occupiedTokens` 的 **prompt 侧**口径（`pressure.ts:50-57` 减去 `outputTokens`）。
  与 `$` 的关系要说准（RV-14）：`computeCost`（`usage.ts:9-19`）**同时**计价 output，
  所以 `↑` 与 `$` 不是同一个总量；此处要断言的是 **cache 读写两侧都计入**——今天
  `↑` 漏了它们而 `$` 没漏，这才是「同一行上三套口径」的实际内容。（P1-3，T13）
- **AC-6** `cols >= 72` 时状态栏同时显示占用与窗口（`86k/200k`）。（P1-5，T15）
- **AC-7** 未登记模型上分母带 `?`；设置 `contextWindow` 后 `?` 消失且分母变为设定值。
  （P1-5 / I-6，T16/T17）
- **AC-8** 压缩已注册、`isCompactionEnabled()` 为真但 `live=false`（summarizer 解不出）时，
  颜色阈值仍等于 `cfg.compaction` 的配置值；而 **`/compact off` 之后颜色回落
  `gauge.ts:36` 的 60/85**，chip 也同时消失。（P2-6 / RV-4，**两个方向都要断言** ——
  只测前半句，`isCompactionRegistered()` 那个错谓词照样全绿）
- **AC-9** 压缩**未注册**的会话，状态栏的**结构**（字段顺序、宽度阶梯、`~` 的出现条件、
  颜色阈值来源）与本轮之前相同。**三条例外，逐条列出**（RV-6）：
  (a) 新增的绝对值对 `86k/200k`（`cols >= 72`）；
  (b) 累计读数门槛 72 → 96 并加 `total ` 前缀；
  (c) **`↑` 的数值口径由 `inputTokens` 变为 `promptTokensOf()`** —— 任何有 cache 命中的
  会话这个数都会变大，这是 W5 的目的而不是回归。
  换言之 AC-9 守的是**形状**，`↑` 的**数值**由 AC-11 单独守。v1 把两者写成一条，导致
  「逐字节相同」与 P1-3 互相排斥、任一实现都会让另一条恒红。
- **AC-11**（新增，RV-6）`↑` 的口径变更是**可断言的**：给定一个含
  `cacheReadTokens`/`cacheWriteTokens` 的 `usageTotal`，`↑` 严格大于本轮之前的
  `inputTokens`，且等于 `promptTokensOf(total)`。（P1-3，T13）
- **AC-10** 三条命令全绿：`npm run build`、**`npm run typecheck`**、`npm test`。
  **`typecheck` 不可省（RV-7）**：`packages/cli` 的 `build` 只跑 `tsc -p tsconfig.json`，
  而 `typecheck` 跑 `tsconfig.json` **与** `tsconfig.test.json` 两个。本轮删 4 个
  `StatusBar` props、删 1 个 reducer action、改 `UsageTotal` 的形状——测试树里的类型错误
  **全部**落在 `build` 看不见的地方，只跑 build + test 会让一棵类型已经破了的树通过门禁。
  「无新增 lint 错误」一句**删除**：本包没有配置 linter，那是一条无法执行的验收。

### 7.3 手工验收

见同目录 `manual-test.md`（14 条，其中 ★ 6 条是发布门禁）。
**该文件仍标注「配套 spec.md v1」**，实施节点在动它时需同步为 v2，并按本轮结论补三条：
`/compact off` 之后颜色回落 60/85（AC-8 后半句）、`--no-compaction` 会话的 `/context`
不撒谎（RV-8）、以及一次成功压缩后 `/compact status` 的累计 `reclaimed` 严格增长（I-10）。
本次评审受「只改 `spec.md`」约束，未改 `manual-test.md`。

---

## 8. Risks & mitigations

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R-1** | `Compactor` 的三个字段搬家会波及 10 个 `compaction-*.test.ts` | 大面积编译红 | `CompactorDeps.meter` / `CompactionWiringDeps.meter` 声明为**可选**，缺省时惰性构造一个私有 meter（用既有的 `getMessages` / `getSystemPrompt` / `getModelInfoFor` / `isPricedModel` deps）。生产路径**必须**注入，由 T7 的同一性断言（`controller.getContextMeter() === wiring 内部持有的实例`）守住 |
| **R-2** | meter 与 wiring 的 attach 顺序影响正确性 | 生产按 import 顺序翻车、单测恒绿 | **分两半**：追加方向由 I-2 的 dirty + 读时测量消除；**替换方向由 I-9 消除**——置脏挂在 `wiring.ts:589` 的同步代码里而非 meter 的订阅上，另加 `messages.length <= measuredPrefixLength` 的结构性兜底。T7 显式跑两种顺序**并做变异验证**（v1 的写法在其中一种顺序下必然失败，RV-2） |
| **R-3** | 刻度带来的重渲染压力 | 状态栏 2.5 Hz 重渲染推高 `render-governor` 档位 | 400 ms 节流 + reducer 恒等短路（§5.2）+ T12；`render-governor.test.ts` 既有阈值不放宽 |
| **R-4** | 全历史估算在超长会话上的 CPU | 卡顿 | measured 分支只估一个回合宽的切片（`pressure.ts:121-128`），这是刻度的热路径；estimate 分支才走全历史，而它只在首个 `turn_end` 前、`/resume` 后、压缩刚拼接后这三段窗口里出现，且每段最长一个回合。**成本模型要写准（RV-10）**：`estimatePromptTokens` 并非纯 `.length` 求和——`messageLength`（`output-limits.ts:336-346`）对每个 `tool_call` 走一次 `JSON.stringify`，所以全历史估算在工具密集的会话上是有分配的；结论不变，但不要再用「无分配」当论据 |
| **R-11**（新增，RV-5） | meter 无条件挂 `AgentController`，而 `aragon exec` 也构造它 | headless 路径白付定时器与估算；待触发的刻度把进程退出往后拖 | I-11：无订阅者时 `scheduleTick()` 只置脏不排定时器，已排出的句柄一律 `unref()`。`current()` 不受影响，`/context` 与 `wiring.snapshot()` 在任何宿主里都能按需拿到正确的数。T9b / T9c 两个方向都断言 |
| **R-12**（新增，RV-1） | 「拼接」与「换会话」共用一个复位方法 | 每次成功压缩丢掉 `estimateOffset`，进度条掉过头再爬回来，且不报错 | I-8 拆成 `onHistorySpliced()` / `onHistoryReplaced()` 两级深度；§3.3 第 1 条给出逐条转发对应表；T3b 断言两者**在 `estimateOffset` 上分叉**，而不只是断言「都走 estimate 分支」 |
| **R-5** | `/resume` 清空 `estimateOffset` 让首个读数偏低 | 用户看到偏低的百分比 | 有意为之：偏低会被第一个 `turn_end` 自纠，而套用旧模型的 offset 得到的偏高值**不会**自纠。带 `~`，并在 `/context` 的 `Since measured` 行说明 |
| **R-6** | `UsageTotal` 加字段破坏 `exit-snapshot` / `transcript-text` / `cli.tsx:732` 的形状 | 编译红（响亮，非静默） | 三处一并改；`addUsage` 收敛加法，杜绝第五处手写 |
| **R-7** | `contextWindow` 覆盖被填错（比如填成 2000000 却是 32k 模型） | 压缩永不触发，请求被 provider 拒 | 反应式 overflow 压缩（`agent-loop.ts:464`）仍是兜底；`/context` 明确标注该分母来自用户覆盖（I-6），使误配可见 |
| **R-8** | 删掉 App 里两处派发时误删相邻的 `compactionSnapshot` / `compactionUsage` 派发 | 压缩卡片与成本静默丢失 | §3.3 逐行给出保留/删除清单；`compaction-render.test.tsx` 既有断言覆盖卡片，`reducer.test.ts` 覆盖成本 |
| **R-9** | `?` 与 `~` 两个标记增加认知负担 | 用户困惑 | 两者出现在**不同的数字**上（分子 / 分母），且 `/context` 用整句解释；`?` 只出现在本轮新增的读数上，既有输出形状不变 |
| **R-10** | `src/compaction/` 里放一个「不属于压缩」的模块，语义别扭 | 后人误迁 | I-7 写明：迁到新树必须同一提交里改 `glyphs.test.ts::inScope`。选它是因为 `pressure.ts` 已在此处、ASCII 规则已生效、且无需改扫描器 |

---

## 9. 实施顺序（给下游节点）

1. `compaction/types.ts` + `pressure.ts` 的字段透传（最小、无行为变化，先绿）。
2. `compaction/meter.ts` + `context-meter.test.ts`（纯单元，不接线）。
3. `compactor.ts` / `wiring.ts` 改为读 meter（`CompactorDeps.meter` 可选，既有测试仍绿）。
4. `controller.ts` 无条件构造 + attach + 三处挂钩 + 三个公开方法。
5. `reducer.ts` 的 `context` / `contextUsage` / `addUsage`（此步会让 `App.tsx`、
   `StatusBar.tsx`、`transcript-text.ts` 编译红——这是**好**的红，逐个改完即可）。
6. `App.tsx` 订阅 + 删两处派发 + `gaugeMarks` 条件。
7. `StatusBar.tsx` 的读数改版。
8. 配置面（`schema.ts` / `env.ts` / `cli.tsx` / `cli-commands.ts`）。
9. `/context` + `builtins.ts` 登记。
10. 余下测试与 README。

每一步之后跑 `npm test -w packages/cli`；第 5 步之后**每一步**都跑
`npm run typecheck -w packages/cli`（**不是** `npm run build` —— 后者不编 `tsconfig.test.json`，
而第 5 步之后的编译红恰恰主要落在测试树里，见 AC-10 / RV-7）。合并前跑一遍完整的
`npm run build` + `npm run typecheck` + `npm test`。

**第 3 步的执行顺序有一条硬约束（I-8 / I-9 / I-10）**：`compactor.ts` 的三个转发方法 +
`invalidateMeasurement()` 的删除 + `wiring.ts` 两个调用点的分深度改写，必须
**按 §3.3 第 1、2 条那两张表一次接完**。分两次接（比如先把三个「显然的」转发接上、
把 `wiring.ts:283 / :589` 的分深度留到后面）会得到一棵**测试全绿但压缩联动已经坏掉**的树
—— 既有的 `compaction-*.test.ts` 不覆盖 `tokensBefore` 的来源、也不覆盖 `estimateOffset`
在两种复位下的去留，而 T3b / T7 / T7b 要到第 10 步才写。**若要拆步，先把这三条测试写了。**

---

## 评审结论（Review Verdict）

### **有条件通过（Approved with conditions）**

**问题诊断部分：无条件通过。** v1 的七条缺陷（P0-1 / P0-2 / P1-3 / P1-4 / P1-5 / P2-6 /
P2-7）全部在树上复现，证据引用逐条准确。「不是四个 bug 而是一个结构缺陷的四种表现」这个
判断是对的，而且是这份文档最有价值的部分：`ViewState.contextTokens` 有三处写入、
两个上游在同一个同步 fan-out 里互相覆盖，而唯一的测量能力被锁在一个**可以关掉的子系统**
下面——这不是靠加一条「记得同步」的纪律能修的，收敛成「一个数、一个写入者」是正确的方向。

**方案部分：修订后通过。** 本轮记录 14 条，P0 × 2、P1 × 6 均已在正文中修复：

| # | 严重度 | 已修 |
|---|---|---|
| RV-1 | P0 | I-8 拆出 `onHistorySpliced()` / `onHistoryReplaced()` 两级复位；I-5 补写「`estimateOffset` 是承重的」；§3.2 事件表与方法表、§3.3 转发对应表、§3.4 同步；新增 T3b 与 R-12 |
| RV-2 | P0 | I-2 收窄为「只消除追加方向的顺序依赖」；新增 I-9 把置脏挂到 `wiring.ts:589` 并加结构性兜底；§3.3 升为第 2 条；T7 补变异验证、新增 T3c；R-2 重写。**二轮修正**：`Compactor.invalidateMeasurement()` 的两个生产调用点（`wiring.ts:283` 换会话 / `:589` 拼接）复位深度相反，故该方法**删除**、两处各自直呼 meter，而不是共用一个转发器 |
| RV-3 | P1 | 新增 I-10；meter 暴露 `lastPublished()`；§3.3 给出逐条转发表；新增 T7b |
| RV-4 | P1 | §3.7 改用 `isCompactionEnabled()`，写明非响应式 getter 为何安全及未来的正确演进路径，并要求拆开共用的条件展开；AC-8 补后半句 |
| RV-5 | P1 | N-4 补 exec 边界；新增 I-11（无订阅者不排定时器 + `unref()`）；新增 T9b / T9c 与 R-11 |
| RV-6 | P1 | AC-9 收窄为守「形状」并逐条列三条例外；新增 AC-11 单独守 `↑` 的数值口径 |
| RV-7 | P1 | AC-10 加 `npm run typecheck` 并说明 build 为何不够；删去无法执行的「无新增 lint 错误」；§9 每步自检命令同步 |
| RV-8 | P1 | §3.7 补 `Compaction` 行五态表，并写死「`/context` 的占用只能来自 `getContextUsage()`」；新增 T18b |

六条 P2（RV-9 ~ RV-14）为表述与论据准确性问题，不阻塞实施，已一并在正文中改正。

### 放行条件（合并前必须满足，逐条可验证）

1. **三条变异验证真的做过，不是写在文档里。** T7（把置脏改回 meter 自己的
   `compaction_end` 订阅 ⇒ 必红）、T7b（把 `lastMeasured()` 接到 `current()` ⇒ 必红）、
   T3b（把 `onHistorySpliced()` 改成清 `estimateOffset` ⇒ 必红）。这三条守的都是
   **静默失效**——不做变异验证，一条恒绿的断言与一条真正的护栏在报告里长得一模一样。
2. **AC-10 的三条命令全绿**，且 `npm run typecheck` 的输出被贴进实施记录（RV-7 的整个
   要点就是它容易被 `build` 的绿灯替代掉）。
3. **`manual-test.md` 同步到 v2** 并补上 §7.3 列出的三条（`/compact off` 后颜色回落、
   `--no-compaction` 会话的 `/context` 不撒谎、压缩后 `reclaimed` 严格增长）。
   本次评审受「只改 `spec.md`」约束未动它，这笔账转给实施节点。
4. **`/context` 的五种压缩形态在真实会话里各看过一遍**，尤其是
   `aragon --no-compaction` 那条——它是本轮唯一一处「新命令有可能直接说假话」的地方。

### 未解决但**有意**不纳入本轮的（记录，非放行条件）

- **N-2（不伪造流式增长）** 成立：output token 在 `done` 之前不可知，回合内的活体感由
  活动行、`tok/s` 与 W4 的工具刻度提供，三者合起来够用。
- **N-3（不拆 `usageTotal` 的四个来源）** 成立，且 D-7 的处置（在 `/context` 里把这个数
  包含什么说出来）比加四个计数器更诚实。
- **`ContextMeter` 住在 `src/compaction/`** 语义上确实别扭（它是压缩的**上游**而非一部分），
  但 I-7 给的理由——`pressure.ts` 已在此处、ASCII 规则已生效、迁树必须同一提交里改
  `glyphs.test.ts::inScope`——足以支撑本轮不迁。这条记在 R-10，将来迁树时回读。
- **`offCompactionSnapshot().pressure` 成为死数据**（RV-8 附带发现）。本轮不删，
  但已在 §3.7 写下「任何新读者必须先回读这一段」。

**评审人签署：** 方案在修订后可以进入实施。上面四条放行条件不是建议，是 DoD 的一部分。

---

## 实施过程发现的方案缺陷（Issues Found During Implementation）

**实施人：** Subtask #2（资深实施工程师）
**基线：** 本文档 v2（含 §0 的 14 条评审记录）
**结论：** 方案整体成立，六个工作包全部落地。以下 6 条是实施期与树对照时发现的
偏差，**已按修正后的写法实现**，未静默偏离。

### IF-1（P0 · 会静默作恶）· I-9 的兜底判据 `<=` 差一，必须是 `<`

**文档原文（§3.1 I-9 第二道兜底）：** 「`current()` 在测量前先判
`messages.length <= (measuredPrefixLength ?? -1)`」。

**问题：** `turn_end` 在 assistant 消息 push **之前**发出（`pressure.ts` 的
`estimateAppendedTokens` 注释逐字写着这条，`agent-loop.ts:478` / `:497`），所以
`onTurnEnd` 记下 `measuredPrefixLength = messages.length` 的那一瞬间，两者**相等**。
包含等号的判据会在记录测量的下一条语句里把它丢掉——而**只在 meter 的监听器排在
compaction wiring 前面时**才会发作，因为 wiring 的 `turn_end` 分支里那次
`snapshot()` 正是在这个窗口内读的。

**症状**（如果照文档字面实现）：每一个回合都静默退化到 estimate 分支，且退化与否
取决于两个 `subscribe()` 的注册次序——**正是本轮 RV-2 要消灭的那一类缺陷**，换了个
位置重新长出来。T1 与 T3c「strict」那条用例会同时变红，但只在其中一种注册顺序下。

**已实现：** `discardStalePrefix()` 用 `length >= measuredPrefixLength` 提前返回，
即只有**严格更短**的历史才丢弃基线。判据的正确表述是：一次在长度 N 上做的测量可以
描述任何长度 **>= N** 的历史，只有更短的才不可能。理由写在
`meter.ts::discardStalePrefix` 的方法头里。代价是「拼接后长度恰好等于旧前缀」这个
边界不再被兜底覆盖——它由 I-9 的主路径（`wiring.ts:589` 的置脏）与 meter 自己的
`compaction_end` 处理器两条路覆盖，且这条兜底本来就是第三道防线。

### IF-2（P1 · 使一条放行条件无法按原文兑现）· T7b 的变异验证在端到端层面恒绿

**文档原文（放行条件 1）：** 「T7b（把 `lastMeasured()` 接到 `current()` ⇒ 必红）」。

**问题：** 实测**不红**。原因在 `wiring.ts::settlePending`：`record.tokensBefore`
被 `...(verdict.tokensBefore !== undefined ? { tokensBefore: verdict.tokensBefore } : {})`
覆盖，而 `verdict.tokensBefore` 在**两条路径上都有值**——in-loop 路径来自核心的
`event.estimatedTokensBefore`（`wiring.ts:589` 一带），idle `/compact` 路径来自
`compactNow` 里那次 `estimatePromptTokens`（`wiring.ts:411`）。因此
`compactor.ts::finish()` 用 `lastMeasured()` 算出的那个 `tokensBefore` **从来不会
出现在结算后的记录上**，`tokensReclaimed` 也就不受这个转发器影响。

I-10 的论证「`compactor.ts:873` 是 `tokensReclaimed` 的**唯一**上游」在 v2 定稿时
就已经不成立了（`settlePending` 的覆盖是既有代码，不是本轮引入的）。

**已实现：** 保留 `lastMeasured() → lastPublished()`（这个选择仍然正确，见下），
但把**变异敏感的断言换到真正承重的接缝上**：
`compaction-compactor.test.ts::lastMeasured() is the ACCOUNTING read` 断言两件事
——(a) 拼接之后 `lastMeasured()` 仍返回拼接**前**的数；(b) 调用它**不向订阅者
发布**。把它接到 `current()` 上，两条都红（已实测）。

**为什么这个选择仍然正确**：`current()` 有副作用——它会 publish，也就是会**移动
用户的进度条**。让一次记账读顺带改屏，是比数值错误更难排查的一类耦合；而
`lastMeasured()` 这个名字承诺的正是「上次测到的」而不是「现在测一次」。
`context-gauge-wiring.test.ts::T7b` 保留为端到端的用户可见断言（reclaimed > 0），
并在文件里写明变异守卫不在那里、在哪。

### IF-3（P1 · 与 AC-1「同一帧」冲突）· `current()` 必须在重测时发布

**文档原文（§3.2 方法表）：** `current()` 只描述为「脏则同步重测」，未提发布；
`measureWith` / `onTurnEnd` 才写了「并发布」。

**问题：** 照字面实现，压缩路径上进度条**永远不会下落**。序列是：
`settlePending` → `meter.onHistorySpliced()`（置脏 + `scheduleTick`）→
`emit(compaction_end)` → `emit(snapshot)` → `snapshot()` → `current()` → 重测并
**清脏** → 400 ms 后定时器触发时 `dirty === false`，§3.2 规定「否则什么都不做」
⇒ 那次发布被吞掉，而 `current()` 又没发布。AC-1 的「同一帧下落」与 I-1 的「唯一
写入者是 meter 订阅」合起来，只有一种自洽解。

**已实现：** `current()` 在**确实重测时**经同一个内部 `measureAndPublish()` 发布；
命中缓存时不发布。这也让 §3.2 那句「一次已安排的发布即使量到相同的数也是无害的」
（依赖 reducer 恒等短路）成为一句有意义的话。理由写在 `meter.ts::current` 的
方法头里。

### IF-4（P2 · 表述）· `CliConfig.contextWindow` 必须是必填 `number | null`

§4.5 与 §6 只说「新增顶层配置 `contextWindow: number | null`」，没有区分
`PersistedConfig` 与 `CliConfig`。实施时两处都加了，且 `CliConfig` 侧是**必填**
（不是 `?:`）——理由与 `showThinking` / `liveToolOutput` / `diffRender` 三个字段
的既有注释逐字相同：运行期读的是 `config.*`（`CliConfig`），只加到持久化形状上会
让这个键在 `config set` / `config list` 里活得好好的，却永远到不了 `ContextMeter`，
且**不报任何错**。代价是 13 个测试夹具各补一行 `contextWindow: null`（本轮已补）。

### IF-5（P2 · 表述）· 「`~` 的出现条件不变」需要一句限定

AC-9 说未注册压缩的会话「`~` 的出现条件」与本轮之前相同。实施后确实如此，但要说准：
`~` 现在的判据是 `!windowKnown || source === 'estimate' || deltaTokens > 0`，而
本轮之前是 `!contextWindowKnown || contextTokensEstimated`。两者在**未注册压缩**
的会话上等价（那种会话里 `contextTokensEstimated` 恒 `false`，而新判据的后两项也
只有在有测量之后才可能为真且此前根本没有采样点）——但在**注册了压缩**的会话上，
新判据更常为真（回合内有工具输出即 `deltaTokens > 0`）。这是 W4 的目的，不是回归。
`status-bar-context.test.ts` 的四组合断言把这条钉住。

### IF-6（P2 · 记录）· 三条 `proc-supervisor.test.ts` 用例先于本轮即为红

合并前的完整 `npx vitest run` 结果：**2934 passed / 3 failed / 6 skipped**。三条
失败全部在 `src/__tests__/proc-supervisor.test.ts`（`AC-18 stopAll` /
`AC-42 reapSync` / `P2-8 every slot LIVE`），是 Windows 上真实子进程被 kill 的时序
断言（`expected true to be false` on a live pid，以及一个 `afterEach` 钩子超时）。

**与本轮无关的证明**：该文件的传递 import 图共 20 个文件，与本轮改动集的交集**只有
`config/schema.ts` 一个**，而该文件本轮相对 `HEAD` 的 diff **删除行数为 0**（纯新增
一个可选键、一个 clamp、两个常量、一条 `DEFAULT_CONFIG` 条目）。纯新增不可能改变
`ProcSupervisor` 杀子进程的行为。

> **Attempt 02 复核（2026-09-01）：该三条已自行转绿。** 同一棵树上重跑
> `npx vitest run` 得到 **196 files / 2937 passed / 6 skipped / 0 failed**。
> 这坐实了上面的判断——它们是 Windows 上的时序 flake，不是本轮引入的回归。
> 记录保留在此，是因为「本轮之前即为红」与「本轮之后偶发红」在排障时是两条
> 不同的线索：下次再见到这三条，应查 Windows 子进程回收时序，不要来查读数链路。

### IF-7（P2 · 验收标准无法按字面兑现）· T11 的「恰好为 1」应为「恰好一个派发模块」

**文档原文（§7.1 T11）：** 「源码扫描：`src/**` 内 `dispatch({ type: 'contextUsage'`
的出现次数**恰好为 1**」。

**问题：** 这条与 **AC-3** 互斥，任一实现只能满足其中之一。meter 只在**事件**上发布，
而 `/resume` 的 `replaceMessages()` 发生在 `App` 挂载**之前**——那一次发布打给零个
订阅者，等于没发生。若 `App` 只在订阅回调里派发，`state.context` 会一直停在初值
（`occupied: 0`）直到下一个刻度，于是 AC-3 要求的「无需发送任何消息，进度条立即显示
合理占用」在最典型的那条路径上失败。挂载时先用 `getContextUsage()` 播一次种是必需的，
而它就是第二处 `dispatch({ type: 'contextUsage'`。

**已实现：** `context-one-writer.test.ts::T11` 断言 `total === 2`，并**补了一条真正
承重的断言**——`only 'App.tsx' dispatches it`（派发模块列表严格等于 `['/ui/App.tsx']`）。
I-1 要守的从来不是字面的调用次数，而是「只有一个模块拥有这个数的写入权」；两次调用
同在 `subscribeContextUsage` 那**一个** effect 里，播种与订阅是同一个写入者的两个时刻。
把 T11 写成计数是设计期的一处口径失误，改为「一个派发模块 + 计数锁死在 2」之后，
新增第三处派发（无论在哪个文件）仍然会红。

### 放行条件的兑现情况

| # | 条件 | 状态 |
|---|---|---|
| 1 | 三条变异验证**真的做过** | ✅ 已做。T7：把 `wiring.ts` 的 `meter.onHistorySpliced()` 删掉、退回「靠 meter 自己订阅 `compaction_end`」⇒ `meter attached AFTER the wiring` 变红、`BEFORE` 仍绿（**正是 RV-2 预言的那种不对称**）。T3b：把 `onHistorySpliced()` 改成清 `estimateOffset` ⇒ `onHistorySpliced KEEPS the offset` 变红。T7b：端到端恒绿（见 IF-2），已把守卫换到接缝上并重做变异 ⇒ 变红。三次变异后均已还原，`git diff` 无残留 |
| 2 | `npm run build` / `npm run typecheck` / `npm test` 三条全绿，且 typecheck 输出入记录 | ✅ `npm run build` 成功（`[prepend-shebang] dist/launcher.js and dist/cli.js are executable with a Node shebang.`）；`npm run typecheck`（`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`）**零输出、EXIT=0**；`npm test` 见 IF-6 |
| 3 | `manual-test.md` 同步 v2 并补三条 | ✅ 见该文件 |
| 4 | `/context` 的五种压缩形态各看一遍 | ⚠️ **未做——这是本次交付唯一的未兑现项**。它需要一个真实会话与真实 provider key，超出本节点的自动化边界。五种形态各有自动化断言（`context-command.test.ts::T18b`，含「未注册那条不得含 `on` 与 `triggers at`」与「未注册会话的 `Occupancy` 仍非零」两条），但**断言不能替代人眼看一遍**，这笔账转给发布前的手工验收（`manual-test.md` 第 15 条） |

> **Attempt 02 的独立复核（2026-09-01）。** 本节点被重启了一次；attempt 01 完成了实现
> 但未成功上报，attempt 02 接手。**条件 1 与 2 不能靠读上一轮的记录来兑现**——一条
> 「已做」的声明和一条真正的护栏在报告里长得一模一样，这正是放行条件 1 存在的理由。
> 故三条变异**全部重做了一遍**（备份→变异→跑→还原），结果与上表逐条一致：
> M1 红在 `T6` 与 `T7 … AFTER`（`BEFORE` 仍绿，asymmetry 复现）、M2 红在
> `onHistorySpliced KEEPS the offset`（expected 49791 / received undefined）、
> M3 红在 `lastMeasured() … answers with the pre-splice figure and publishes nothing`
> （expected 150000 / received 149992）。还原后 `grep -rn "MUTATION" src/compaction/`
> 无命中，三个套件 70 passed。
> 条件 2 同样重跑：`tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.test.json --noEmit`
> **两条各自零输出、EXIT=0**；`npm run build` EXIT=0；`npx vitest run` **2937 passed /
> 6 skipped / 0 failed**（IF-6 的三条已转绿）。
> **条件 4 仍未兑现**，理由不变（需要真实 provider key 的交互式会话）。
