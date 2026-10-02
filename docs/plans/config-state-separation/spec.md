# AragonAgent CLI · 配置与运行时状态分离（config-state-separation）— 设计方案

- **Feature slug**：`config-state-separation`
- **Version**：**v2**（方案评审节点修订版；评审记录见下方 §0，P0 × 1 / P1 × 5 已全部在正文中修复）
- **实施范围**：**仅** `aragon-agent-core/packages/cli/`（TUI 包）+ 该包的 `README.md` / `CHANGELOG.md`
- **不涉及**：`@aragon-agent/core` 引擎包（一行不改）、宿主 `server/` `src/` `desktop/` `homepage-web/` `android/`、任何 DB / WS / REST 协议
- **新增运行时依赖**：**0 个**（只用 `node:fs` / `node:path` / `node:process`）
- **新增磁盘文件**：2 个（`<home>/prompt-history.jsonl`、`<home>/state.json`）
- **删除的持久化字段**：4 个（`promptHistory` / `submitCount` / `mouseNoticeSeen` / `recentModels`）

---

## 0. 评审记录（Review Notes）

评审方式：逐节对照 `packages/cli/src/` 实读复核。v1 引用的**全部**行号与结构性断言均已核实为真——`store.ts:107-122` 的 `...partial` 展开、`schema.ts:444/445`、`load.ts:329/330`、`App.tsx:123-124/329/500-509`、`package.json` 只有 `bin` 无 `exports`、四个测试 fixture 的字段位置，以及需求描述的现场（复核当日实读用户 `config.json`：27 键、`promptHistory` 9 条、`submitCount: 16`、`mouseNoticeSeen: true`、`recentModels: []`）。§4.5 认定的「`loadPersistedConfig()` 是唯一写前收口」也已通过全仓 grep 复核：`updatePersistedConfig` 的 6 个调用点（`cli.tsx:507/609`、`controller.ts:143`、`skills/cli-commands.ts:74`、`config/cli-commands.ts:165`、`App.tsx:446`）无一绕过它。

下列问题按严重度排列。**P0 / P1 已在本版正文中直接修复**，每条注明落点；P2 为改进建议，同样已落到正文（除 RV-13 / RV-14 属描述性澄清）。

### P0

| # | 问题 | 影响 | 修复落点 |
|---|---|---|---|
| **RV-1** | **新的 `recordPrompt` 丢掉了 `setPromptHistory(next)` React 状态更新。** v1 §4.8 的表格逐条列出改写后的函数体（`appendPrompt` + `bumpSubmitCount` + `controller.setSubmitCount`），§7.2 又写「移除 `persistConfig` 调用」——照此实施会连同第 502 行的 `setPromptHistory(next)` 一起删掉。而 `history` prop（`App.tsx:988` / `1007`）**只吃 React state**；`prompt-history.ts` 的模块级内存数组不触发重渲染。 | **本会话内 `↑` 召回不到刚提交的内容**，直接违反 G2 与 AC-2。且因为跨进程重启后能召回（磁盘是对的），这个 bug 在只做「重启后召回」的验收里会被漏掉——只有「提交后不重启就按 ↑」才复现。 | §4.3.4 步 5·§4.8 表格·§5.1 `appendPrompt` 签名改为返回 `string[]`·§7.2 App.tsx 行·§8.2 新增用例 12 |

### P1

| # | 问题 | 影响 | 修复落点 |
|---|---|---|---|
| **RV-2** | **两个新 store 的写路径都没有 `mkdirSync(<home>)`。** v1 §4.3.4 步 5 直接 `openSync(path,'a',0o600)`，§4.4 直接 tmp+rename。范本 `usage.ts:164` 恰恰是先 `mkdirSync(getUserDataDir(),{recursive:true})` 再写。`<home>` 并非总是存在：`installLogging()` 只在 `log.toFile !== false` 时创建 `logs/`，而 `config.json` 只在用户第一次写配置时才被创建。 | 一个「首次运行 + 关掉文件日志 + 没改过任何设置」的用户，`openSync` 抛 `ENOENT` → 被 C2「永不抛」吞掉 → **提示词历史静默地永远不落盘**，且没有任何用户可见迹象。这正是 C2 的失败策略在缺一步 mkdir 时会放大的那类 bug。 | §4.3.4 步 5·§4.4·§5.1/§5.2 注释·§8.2 新增用例 13 |
| **RV-3** | **压实（§4.3.5）用「本进程内存数组」整体覆盖文件，把 §4.3.1 理由 3 声称已解决的多实例互吞问题原样搬了回来。** 而且 v1 把损失量描述为「可能丢几条尾部条目」是低估的：真实损失是**本进程 `loadPromptHistory()` 之后、其它实例追加的全部条目**（另一个终端跑了一整晚，这边一次压实全抹掉）。 | 与 §4.3.1 的核心论证自相矛盾；违反 AC-2 的「重启进程后仍能召回」。 | §4.3.5 改为「压实前重新读盘 → 合并去重 → 取末尾 CAP → 原子替换」·§9 R-3 重写 |
| **RV-4** | **`mouse-routing.test.tsx` 的三处 `store.writes` 断言（第 538 / 552 / 574 行）未列入 §7.2 变更清单。** v1 只写了「第 34 行的 `readConfigFile` mock」和「fixture 356-361 行」。这三处断言经由被 mock 的 `updatePersistedConfig` 观测 `{mouseNoticeSeen:true}`；改用 `setMouseNoticeSeen()` 后，第 538 行（`toContainEqual`）会硬失败，**而 552 / 574 行（`not.toContainEqual`）会静默常绿**。 | 后两条恰恰是「不该重复提示」的负向断言，改完之后它们守的是一个永远不会被写的对象，等于护栏被摘掉却看不出来——这正是 v1 自己在 §9 R-7 里命名的失效模式，只是漏掉了断言点。 | §7.2 `mouse-routing.test.tsx` 行·§9 R-7 |
| **RV-5** | **`historyEnabled` 在迁移时点尚未解析，而 v1 没有规定模块级开关的初值。** `migrateStateOutOfConfig()` 在启动链 ③.5，`setHistoryEnabled()` 由 `loadConfig()` 调用（⑤ 的命令 action 内，更晚）。此外 §5.1 只说「由 `loadConfig()` 调用一次」，没说没被调用之前 `appendPrompt` 该按什么行为走。 | 实施者必须靠猜补这个初值；且「用户显式 `historyEnabled false` → 降级到 0.5.x（旧版把 `promptHistory` 写回 config.json）→ 再升级」这条路径会把用户明确拒绝记录的提示词重新写进新文件——一个隐私开关被静默绕过。 | §4.3.4 步 1·§4.6 步 3·§5.1 注释 |
| **RV-6** | **C4（新文件 POSIX `0600`）在 `state.json` 与压实路径上没有兑现手段，AC-4 也只覆盖了 `prompt-history.jsonl`。** `store.ts:93-100` 白纸黑字写明「rename 在某些平台不保留 mode」并因此在 rename 之后补 `chmodSync`；v1 的两处 tmp+rename 都没有这一步，AC 也没断言。 | 硬约束 C4 变成一句没有护栏的口号；含用户原文的历史文件在某些平台上可能以 `0644` 落地。 | §4.3.5·§4.4·AC-4 |

### P2

| # | 问题 | 处置 |
|---|---|---|
| **RV-7** | §5.6 与 RV-11 提出「补一条 CLI 往返用例」防 `historyEnabled` 只进 `CONFIG_SET_KEYS` 不进 `switch`。但 `__tests__/config.test.ts:292-322` **已有**一条源码文本护栏 `config set: every accepted key actually writes something`，它正则扫出 `CONFIG_SET_KEYS` 的每个键并断言存在对应 `case '<key>':`——新键自动被覆盖，无需新用例。 | 已在 §5.6 / RV-11 改为引用既有护栏 |
| **RV-8** | `state.json` 这个名字既泛（§11 Q-4 自己担心它变垃圾抽屉），又与既有模块 `config/migrate-legacy-state.ts`（品牌迁移，与本文件毫无关系）语义撞车。 | 保留文件名（`<home>` 作用域下不歧义），但把 Q-4 的规矩**升格为 §4.4 的强制文件头约定**，并把新迁移模块命名与既有模块的区别写进 §7.1 |
| **RV-9** | §1 的「1542 字节」是易腐快照；复核当日该文件已是 1678 字节。 | 已改为不带易腐数字的表述，保留可核验的结构性事实 |
| **RV-10** | AC-5「`config.json` 字节与 mtime 均不变」没写基线取样时点。启动期迁移本身会写一次 `config.json`。 | AC-5 已补「基线在启动迁移完成之后取」 |
| **RV-11** | D-4 用「避免每次 `loadConfig()` 都读历史文件」论证删 `promptHistory`，同一节却把 `submitCount` 改成在 `loadConfig()` 里读 `state.json`，等于新增了一次同类文件读。论证不对称。 | D-4 已补一段显式承认这个代价并说明为何可接受 |
| **RV-12** | `historyEnabled=false` 时 `loadPromptHistory()` / `aragon history list` 是否仍读已有文件，v1 未规定。`usage.ts:190-194` 已有先例：关掉只停写、不停读，否则「想看看到底存了什么再删掉」就做不到。 | §4.3.3 已补明确规则 |
| **RV-13** | §3.1 称 `↑` 走到 `>= length` 会「回到草稿」；实读 `PromptInput.tsx:305-310` 是清空 buffer，并不恢复草稿。 | 描述性偏差，不影响设计。已就地更正措辞 |
| **RV-14** | AC-8 的「干净环境」不得清除 `ARAGON_HOME`——`app-paths.ts:38-40` 测试隔离契约第 2 条明令禁止。 | AC-8 已补该限定 |
| **RV-15** | 升级后回退到 0.5.x 的窗口内，旧版读不到新文件，用户会看到「历史空了」（数据仍在，重新升级即恢复）。 | 已写入 §7.2 的 CHANGELOG 要求 |

**未采纳的意见**：无。**范围外确认**：本方案不触碰 `@aragon-agent/core`、不新增运行时依赖、不动任何 DB/WS/REST 协议——与 `CLAUDE.md` 记载的 `aragon-agent-core-rename` 边界（宿主 `server/agent-core/` 五个 shim 经 tsconfig `paths` 解析）无交集，复核确认无联动风险。

---

### 阅读导航

| 想知道什么 | 去哪一节 |
|---|---|
| **评审发现了什么、改了什么** | **§0 评审记录** |
| 要解决什么问题、为什么现在必须解决 | §1 概述 |
| 做 / 不做的边界与硬约束 | §2 |
| 现在代码到底长什么样（含精确行号） | §3 现状核对 |
| **「什么算配置、什么算状态」的判定规则** | **§4.1**（整份方案的承重墙） |
| 新的目录布局 | §4.2 |
| 历史文件怎么写、怎么读、怎么压实 | §4.3 |
| `state.json` 怎么设计 | §4.4 |
| **config.json 怎么保证不再长出状态字段** | **§4.5**（单一收口，漏了就白改） |
| 老用户的数据怎么搬 | §4.6 一次性迁移 |
| 「启动正确读取配置」怎么兑现 | §4.7 |
| 「TUI 修改正确写入配置」怎么兑现 | §4.8 |
| 关键取舍与理由 | §4.9 决策表 D-1 ~ D-11 |
| 函数签名 / CLI / 配置键 | §5 接口设计 |
| 磁盘上每个文件的确切形状 | §6 数据模型 |
| 改哪些文件、每个文件改什么 | §7 变更计划表 |
| 怎么算做完了 | §8 测试与验收标准 |
| 哪里会炸 | §9 风险与缓解 |
| 从哪一行开始写 | §10 实施顺序 |
| 还没拍板的（已由评审拍板） | §11 |
| 评审结论 | §12 |

---

## 1. 概述（Overview）

Windows 安装并使用一段时间后，用户主目录下的 `C:\Users\<you>\.aragon-agent\config.json` 里出现了 `promptHistory` —— 一个逐条记录用户在 TUI 里敲过的每一句提示词的数组。实测该文件当前有 27 个键，其中 `promptHistory` 已积累 9 条、`submitCount` 已到 16，并且**每提交一次提示词就会把整个 `config.json` 重写一遍**（含明文 API Key 段）——文件因此还在持续变大（评审复核当日已比方案起草时又长了一百多字节，正是这条写路径的直接证据）。这不是一个尺寸问题，而是一个**职责问题**：`config.json` 是「用户声明过的意图」的载体，是文档里明确鼓励用户手工编辑（`aragon config edit` 会先备份再打开编辑器）、可以被复制到另一台机器、可以贴进 issue 求助（`aragon config list` 会为此把密钥打码）的文件。把「用户做过什么」的流水混进「用户想要什么」的声明里，会同时破坏三件事：手工编辑时用户要在几十行历史噪声里找那一行 `model`；复制配置到新机器会连带把上一台机器上敲过的私人提示词一起搬走；而每次提交都整体重写含密钥的文件，让一个本该「几周才写一次」的文件变成「每分钟写好几次」的热文件。

本方案把 `config.json` 收敛成**纯配置**，并把当前混在里面的四个「运行时状态」字段各自搬到合适的载体上。判定规则写在 §4.1，一句话是：**能由用户主动声明、且丢失后用户会感到「我的设置没了」的，是配置；由使用行为自动累积、丢失后最多损失一点便利的，是状态。** 按这条规则，`promptHistory`（提示词流水）搬到新的追加型日志文件 `<home>/prompt-history.jsonl`；`submitCount`（终身提交计数，用于渐进隐藏输入框提示）与 `mouseNoticeSeen`（一次性提示是否已展示过）搬到新的 `<home>/state.json`；`recentModels`（**当前代码里只读不写的死字段**，见 §3.2）直接删除。`config.json` 的字段数从 27 降到 23，且此后**只在用户明确表达意图时被写**。

需求同时点了另外两件必须一并保证的事：**「agent 启动需要正确读取使用对应的配置信息」**与**「用户在 TUI 里的修改需要正确写入配置文件」**。这两条在现有代码中基本是成立的（`loadConfig()` 的四层解析链、`updatePersistedConfig()` 的原子写 + 嵌套段深合并都已就位），但**没有任何一条机械化的护栏在守它们**——尤其是本次改动会同时动读路径（`load.ts`）与写路径（`store.ts`、`App.tsx`），一次手滑就能让「设置存不住」这类最难归因的 bug 溜进去。因此 §4.7 / §4.8 把这两条从「现状描述」升格为**带验收用例的显式契约**：新增一条 `config_loaded` 日志记录（列出本次真正生效的非密钥配置值，让「我的设置为什么没生效」第一次可以被离线诊断），并新增端到端回归用例——写配置文件 → 冷启动 `loadConfig()` → 逐字段断言；以及 TUI 三条写路径（设置页、`/theme`、模型选择器）落盘后重新读回断言。

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 验收落点 |
|---|---|---|
| G1 | `config.json` 中不再出现 `promptHistory` | AC-1 |
| G2 | 提示词历史落到专门的、日志形态的文件中，且 TUI 的 `↑`/`↓` 召回行为**逐字不变** | AC-2 / AC-3 |
| G3 | `config.json` 只剩配置字段；提交提示词**不再触碰** `config.json` | AC-4 / AC-5 |
| G4 | 老用户升级后历史与计数**不丢**，且迁移只发生一次 | AC-6 / AC-7 |
| G5 | 启动读取配置的链路有显式回归护栏 | AC-8 |
| G6 | TUI 内的配置修改落盘链路有显式回归护栏 | AC-9 |
| G7 | 用户可以查看与**清除**自己的提示词历史 | AC-10 |

### 2.2 非目标（本期明确不做）

- 不改 `@aragon-agent/core`。`no-host-coupling.test.ts` 机械禁止 core 引入 `node:*`，一切文件 I/O 只能活在 CLI 包内。
- 不改现有日志子系统（`logging/`）的任何行为、格式与轮转策略。提示词历史**不是**诊断日志，不进 `logs/`（理由见 D-3）。
- 不做跨机器同步、不做加密存储、不做历史的模糊搜索 / `Ctrl+R` 反向查找。
- 不重构 `updatePersistedConfig` 的手写嵌套合并（`store.ts:143-163` 的注释明确要求：新增第三层嵌套前必须先换成真正的深合并工具）。本方案因此**只新增扁平键**，不新增嵌套段。
- 不动 `sessions/`、`skills/`、`skill-usage.json`。

### 2.3 硬约束

- **C1**：所有新路径必须经 `config/app-paths.ts` 派生，禁止任何模块自己 `join(homedir(), ...)`。`app-paths.ts` 头部的「测试隔离契约」第 4 条（VITEST 分支把根重定向到 `os.tmpdir()`）是所有单测不碰开发机真实主目录的唯一保证。
- **C2**：新增的两个 store **永不抛出**。范本是 `skills/usage.ts` 的失败策略（D-A14）：这是便利性数据，读不出来就当没有；一个只读的主目录不能让 CLI 起不来。
- **C3**：迁移函数**永不抛出**，理由与 `migrate-home.ts:22-24` 逐字相同——「重新输一次 API Key 的用户只是不便，CLI 起不来的用户是被堵死」。
- **C4**：涉及用户内容的新文件在 POSIX 上必须 `0600`，与 `config.json`（`store.ts:90`）和日志文件（`file-sink.ts:270`）一致。
- **C5**：不得向 stdout 写任何新行。`aragon -p "…" > out.txt` 必须继续只承载模型输出（`migrate-home.ts:198-202`）。

---

## 3. 现状核对（逐行实读）

### 3.1 `promptHistory` 的完整读写链（5 个点，一个不能漏）

| # | 位置 | 现状 |
|---|---|---|
| 1 | `config/schema.ts:445` | `PersistedConfig.promptHistory: string[]` —— 声明它是持久化配置 |
| 2 | `config/schema.ts:496` | `DEFAULT_CONFIG.promptHistory: []` |
| 3 | `config/schema.ts:542` | `CliConfig.promptHistory: string[]` —— 进入内存有效配置 |
| 4 | `config/store.ts:115` | `loadPersistedConfig()` 里 `promptHistory: partial.promptHistory ?? []` |
| 5 | `config/load.ts:330` | `loadConfig()` 里 `promptHistory: file.promptHistory ?? []` |
| 6 | `ui/App.tsx:123-125` | `useState(() => controller.getConfig().promptHistory ?? [])` —— 唯一读者 |
| 7 | `ui/App.tsx:500-509` | `recordPrompt()`：去重 → `slice(-PROMPT_HISTORY_CAP)` → `persistConfig({ promptHistory, submitCount })` —— **唯一写者，也是 config.json 被每次提交重写的元凶** |
| 8 | `ui/App.tsx:988` / `1007` | 传给 `<Composer>` / `<PromptInput>` 的 `history` prop |

消费侧（`ui/PromptInput.tsx:296-317`）的语义必须原样保留：数组**从旧到新**排列，`↑` 从 `length-1` 往前走；`↓` 走到 `>= length` 时把 `historyIndex` 置 `null` 并**清空输入缓冲**（第 305-310 行——注意是清空，不是恢复此前的草稿；这是既有行为，本方案不改）。上限常量 `PROMPT_HISTORY_CAP = 100`（`schema.ts:117`）。

第 8 行的 `history` prop 是**唯一**抵达消费侧的通道，而它取自 React state（第 123 行的 `promptHistory`），不是任何模块级缓存。任何改写 `recordPrompt` 的实施都必须继续更新这个 state —— 见 §4.8 的显式要求与 RV-1。

### 3.2 `config.json` 里其余的「非配置」字段

| 字段 | 声明处 | 写入处 | 判定 |
|---|---|---|---|
| `submitCount` | `schema.ts:466` / `:550` | `App.tsx:506-508`（随历史一起写）；`controller.ts:319-321` 只改内存 | **状态**。终身计数器，驱动 `Composer.tsx:80` 的提示淡出（`HINT_FADE_AFTER = 8`）。 |
| `mouseNoticeSeen` | `schema.ts:464` | `App.tsx:329`；读点在 `ui/use-startup-notices.ts:79` | **状态**。`schema.ts:461-463` 的注释已经自己写着：「Bookkeeping for a one-shot notice, **NOT a preference**」。 |
| `recentModels` | `schema.ts:444` / `:495` / `:541` | **全仓库无写者**（`store.ts:114`、`load.ts:329` 只做透传；无任何 UI 读者） | **死字段**。`RECENT_MODELS_CAP`（`schema.ts:118`）同样无消费者。 |

### 3.3 可直接复用的现成范本（不要另起炉灶）

- **旁车状态文件**：`skills/usage.ts` —— `schema` 版本号、内存缓存、`tmp + renameSync` 原子写、全函数吞异常、`resetUsage()` 提供「用户可擦除」、`resetUsageForTests()` 提供测试隔离。本方案的两个新 store 逐条照抄这套纪律。
- **追加型日志文件**：`logging/file-sink.ts` —— `openSync(file,'a',0o600)` + `writeSync`，以及头部那段「为什么不用 `createWriteStream`」的论证（`process.exit()` 会丢弃流缓冲）。本方案的历史追加同样走同步 `O_APPEND`。
- **一次性迁移**：`config/migrate-home.ts` —— 「永不抛 / 逐产物幂等键（`existsSync(target)`）/ 面包屑不是幂等键 / rename 失败降级为保留源文件的 copy」。
- **单一收口的钳制函数**：`schema.ts:290`（`clampSkillsConfig`）与 `:399`（`clampLogConfig`）的头部注释都写明「读写共用同一个门，只硬化读路径会留下一个每次启动都被默认值悄悄覆盖的坏值——症状是『我的设置存不住』」。§4.5 的 `stripLegacyStateKeys` 完全同构。

---

## 4. 技术设计

### 4.1 边界规则：什么进 `config.json`

> **规则**：`config.json` 只存**用户主动声明的意图**。判据有二，须同时成立：
> 1. 存在一条用户显式表达它的通道（CLI flag / `ARAGON_*` 环境变量 / `aragon config set` / 设置页 / 斜杠命令）；
> 2. 它丢失后，用户的感受是「我的设置没了」而不是「少了点便利」。

按此规则对当前 27 个持久化字段分类：

| 类别 | 字段 | 去处 |
|---|---|---|
| **配置**（23） | `version` `provider` `model` `baseUrl` `thinkingLevel` `maxTokens` `theme` `reducedMotion` `fullscreen` `exitTranscript` `transcriptWindow` `confirmTools` `toolTimeoutMs` `idleTimeoutMs` `apiKeys` `density` `hints` `mouse` `planModeDefault` `planModeMaxAskRounds` `planModeHumanTimeoutMs` `skills{}` `log{}` | 留在 `config.json` |
| **使用流水** | `promptHistory` | → `<home>/prompt-history.jsonl` |
| **UI 记账** | `submitCount` `mouseNoticeSeen` | → `<home>/state.json` |
| **死字段** | `recentModels` | 删除（连同 `RECENT_MODELS_CAP`） |

新增 1 个**配置**字段（它满足上面两条判据，因此归属 `config.json`）：`historyEnabled: boolean`（默认 `true`），用户可用 `aragon config set historyEnabled false` 彻底关掉提示词记录。理由见 D-9。

> **为什么 `submitCount` 必须一起搬（这是本方案不能砍的部分）**：只搬 `promptHistory` 的话，`App.tsx:508` 仍会在**每次提交**时因为 `submitCount` 而重写整个 `config.json`（含明文 API Key）。需求「config.json 仅仅需要配置相关的信息」的运维含义——把一个热写文件变回冷文件——就只兑现了一半。

### 4.2 新目录布局

```
~/.aragon-agent/                    (Windows: C:\Users\<you>\.aragon-agent\)
├── config.json                     配置（0600）— 只在用户表达意图时被写
├── config.json.bak                 `aragon config edit` 的编辑前备份
├── prompt-history.jsonl            提示词历史，追加型 JSON Lines（0600）   ← 新增
├── state.json                      UI 记账：submitCount / mouseNoticeSeen（0600） ← 新增
├── logs/                           诊断日志（0700）
├── sessions/                       /save · /resume
├── skills/
└── skill-usage.json
```

两个新文件都是 `<home>` 的**直接子项**，与 `skill-usage.json` 同级，理由与 `usage.ts:36-40` 逐字相同：目录（`logs/` `skills/` `sessions/`）都是扫描根，往里塞文件就多一个所有遍历都要认识并跳过的东西。

### 4.3 `prompt-history.jsonl`

#### 4.3.1 为什么是 JSONL 追加，而不是 JSON 数组整体重写

四条理由，任意一条单独成立：

1. 需求原话是「记录在**日志类**的文件中」。JSON Lines + 每行带时间戳，就是本仓库 `logs/` 已经在用的形态（`file-sink.ts` 写的就是 JSONL），用户打开一看就知道这是流水而不是设置。
2. 追加是 O(1)，与历史长度无关；整体重写是「每提交一次，读全量 → 去重 → 写全量」。
3. `O_APPEND` 下多个 `aragon` 进程并发追加互不截断；而「读-改-写」的整体重写在两个实例之间会**互相吞掉对方的条目**（后写的那个用的是旧快照）。这不是理论问题——用户在多个终端同时开 `aragon` 是常态。
4. 崩溃语义更好：进程在写到一半被杀，最多留下一行残行（加载时按行丢弃），而不是一个被截断的、读回来等于「历史全没了」的 JSON 数组。

#### 4.3.2 行格式

每行一个 JSON 对象，无缩进，以 `\n` 结尾：

```json
{"v":1,"ts":1753600000000,"text":"帮我把这个函数拆一下"}
```

- `v`：行 schema 版本，恒 `1`。解析时 `v !== 1` 的行直接跳过（前向兼容：将来加字段不会让旧版 CLI 读崩）。
- `ts`：`Date.now()`，毫秒。
- `text`：用户提交的原文，**不做任何脱敏**（见 D-5）。

#### 4.3.3 加载（`loadPromptHistory()`）

1. 读整个文件（不存在 → 返回 `[]`）。
2. 按 `\n` 切行，逐行 `JSON.parse`；**任何一行解析失败或字段不合法就跳过该行**，绝不因为一行坏数据丢掉整个历史。
3. 按 `text` 去重，**保留最后一次出现**（与 `App.tsx:501` 现有的 `filter(p => p !== text)` + 追加语义一致）。
4. 取末尾 `PROMPT_HISTORY_CAP`（100）条，**从旧到新**返回 `string[]`。
5. 结果在模块内缓存（`memory: string[] | null`），与 `usage.ts:90` 同构——`/reload`（`builtins.ts:246`）会再次调 `loadConfig()`，不能因此重读磁盘并丢掉本次会话中新追加的条目。同时记下本次实际读到的物理行数 `loadedLines`，供 §4.3.5 的压实阈值使用。

**读不受 `historyEnabled` 约束（RV-12）**：`historyEnabled === false` 只停止**写入**，`loadPromptHistory()` / `listPromptHistory()` 照常读已有文件。范本是 `usage.ts:190-194` 的同一条理由——一个想「先看看到底存了什么，再决定要不要删」的用户，绝不能因为刚关掉开关就被告知「这里什么都没有」，而文件其实还在磁盘上。

#### 4.3.4 追加（`appendPrompt(text): string[]`）

**返回值是更新后的完整历史数组**（从旧到新、已去重、已截断），不是 `void`。这一点是硬要求而非风格选择：调用方 `App.tsx::recordPrompt` 必须拿它去 `setPromptHistory(...)`，否则本会话内按 `↑` 召回不到刚提交的内容（RV-1）。让函数把新数组交出来，比让调用方再调一次 `loadPromptHistory()` 更难写错。

1. 若模块级 `historyEnabled` 为 `false` → **不写盘**，直接返回当前内存数组（`loadPromptHistory()`）。该标志的初值是 `true`（RV-5）：`loadConfig()` 尚未调用 `setHistoryEnabled()` 的窗口里（启动迁移期就在这个窗口内），默认按「记录」处理，与该键的默认值一致；需要在该窗口里尊重用户显式关闭的场景只有一处，见 §4.6 步 3。
2. `text.trim().length === 0` → 返回当前内存数组，不写盘。
3. `text.length > PROMPT_ENTRY_MAX_CHARS`（16 384）→ **不记录**，写一条 `debug` 日志（`prompt_history_entry_too_large`）后返回当前内存数组。理由见 D-6。
4. 先确保内存已初始化（内部调 `loadPromptHistory()`，这同时初始化了 `loadedLines`），再更新内存数组（同 §4.3.3 第 3–4 步的去重与截断）。
5. 落盘：**`mkdirSync(getHomeRoot(), { recursive: true })`**（RV-2）→ `fd = openSync(path, 'a', 0o600)` → `writeSync(fd, line)` → `closeSync(fd)`，全程 `try/catch` 吞掉，失败时 `getLogger().warn('history','history_append_failed',{reason})`。
   - **mkdir 这一步不是防御性噪音，删了会静默作恶**：`<home>` 并不保证存在。`installLogging()` 只在 `log.toFile !== false` 时创建 `logs/`（从而顺带创建 `<home>`），而 `config.json` 只在用户第一次写配置时才被创建。一个「首次运行 + 关掉文件日志 + 没改过任何设置」的用户，`openSync` 会抛 `ENOENT`，被 C2 的「永不抛」策略吞掉，结果是**历史永远不落盘且毫无迹象**。范本 `usage.ts:164` 正是先 `mkdirSync` 再写。
   - 短生命周期 fd 而非常驻 fd：这是「每次提交一次」的低频写，不值得为它持有一个跨进程生命周期的句柄，而常驻句柄会让 Windows 上的 `aragon history clear` 删不掉自己正打开的文件（`logging/cli-commands.ts:7-13` 记录过同样的坑）。
6. `appendedLines += 1`；若 `loadedLines + appendedLines > HISTORY_COMPACT_AT_LINES`（400）→ 触发压实。
7. 返回更新后的内存数组。

#### 4.3.5 压实（compaction）

**压实前必须重新读盘，不得直接用进程内存数组覆盖文件（RV-3）。** 步骤：

1. 重新按 §4.3.3 的规则解析磁盘上的**当前**文件内容（逐行容错、坏行跳过）。
2. 把本进程内存数组里的条目按同一套「去重保留最后一次出现」规则合并进去（本进程刚追加的条目理论上已经在文件里，重读即可见；这一步只是防止读盘瞬间失败时丢掉本会话的召回能力）。
3. 取末尾 `PROMPT_HISTORY_CAP` 条，写 `<path>.tmp-<pid>`（`0600`）→ `renameSync` 覆盖 → **POSIX 下 `chmodSync(path, 0o600)`**（RV-6，与 `store.ts:93-100` 同理：rename 在某些平台不保留 mode，而这个文件装的是用户提示词原文）→ `loadedLines` 重置为新行数、`appendedLines` 归零。
4. 失败则 `rmSync(tmp, {force:true})` 并保持原文件不动（文件继续长，下次再试）。

**为什么不能省掉第 1 步**：v1 的写法是「用本进程内存数组整体覆盖」，那会把 §4.3.1 理由 3 声称已经解决的问题原样搬回来——本进程 `loadPromptHistory()` 之后其它实例追加的**全部**条目都会被抹掉，而不是「几条尾部条目」。用户在另一个终端跑了一晚上，这边一次压实就清空，这与「JSONL 追加正是为了让多实例互不干扰」的立论直接冲突。重读一个 ≤400 行的文件是微不足道的代价。

重读之后仍存在的残余竞态只剩「两个实例的读-写窗口精确重叠」，最坏结果是丢掉重叠窗口内的少量条目——这才是 `usage.ts:153-176` 所接受的那个量级。

### 4.4 `state.json`

形状：`{"schema":1,"submitCount":16,"mouseNoticeSeen":true}`。

- 读：`loadUiState()`，缓存于内存；文件缺失 / 解析失败 / `schema !== 1` → 返回默认值 `{submitCount:0, mouseNoticeSeen:false}`。逐字段容错（数字非法回落 0，布尔非布尔回落 false），不因一个坏字段丢掉另一个。
- 写：**`mkdirSync(getHomeRoot(), { recursive: true })`**（RV-2，理由与 §4.3.4 步 5 逐字相同——`<home>` 不保证存在，缺这一步会让 `submitCount` 静默永不落盘）→ `tmp + renameSync` 原子替换 → **POSIX 下 `chmodSync(path, 0o600)`**（RV-6）。**立即写、不做防抖**（D-7）。
- `submitCount` 与 `mouseNoticeSeen` 各自的写路径见 §4.8。

> **文件头必须写死这条规矩（原 §11 Q-4，评审已拍板升格为强制约定，RV-8）**：`state.json` **只允许存 UI 记账标量**（计数器、一次性提示的已读标记这类）。任何带用户内容、任何会随使用量线性增长的东西一律另开文件。没有这条，它会在两个版本内变成什么都往里塞的垃圾抽屉——而它恰恰是为了把 `config.json` 从这个下场里捞出来才存在的。

模块命名注意：新模块叫 `config/ui-state.ts`，与既有的 `config/migrate-legacy-state.ts`（0.4.x 品牌迁移 `.argon → .aragon`，与本文件毫无关系）**不是**一回事，只是名字相近。

### 4.5 `config.json` 的净化：单一收口

**这是整份方案里最容易漏、漏了就等于没改的一处。**

`store.ts:107-122` 的 `loadPersistedConfig()` 做的是 `{ ...DEFAULT_CONFIG, ...partial }`，其中 `partial` 是**磁盘上文件的原始解析结果**。也就是说：即使从 `PersistedConfig` / `DEFAULT_CONFIG` 里删掉 `promptHistory`，磁盘上那个 `promptHistory` 键仍会被展开进 `merged`，然后由 `updatePersistedConfig()` → `writeConfigFile()` **原样写回去**。用户会看到「删了又长回来」。

修法：在 `schema.ts` 增加

```ts
/** 曾经被误存进 config.json 的运行时状态键。读路径一律剥离（§4.5）。 */
export const LEGACY_STATE_KEYS = ['promptHistory', 'submitCount', 'mouseNoticeSeen', 'recentModels'] as const;

export function stripLegacyStateKeys<T extends object>(raw: T): T { /* 浅拷贝后 delete 上述键 */ }
```

并在 `loadPersistedConfig()` 内对 `partial` **先剥离再合并**。因为**每一次写**都必然经过 `updatePersistedConfig()` → `loadPersistedConfig()`（`store.ts:149`），这一处收口即可保证：

- 迁移完成后不会再长回来；
- 用户手工把 `promptHistory` 编辑回文件里，下一次任何写操作都会把它清掉；
- 降级运行旧版 0.5.x 再升回来（旧版会重新写入这些键）也能自愈。

与 `clampSkillsConfig` / `clampLogConfig` 同构——**读写共用同一个门**。

### 4.6 一次性迁移

新模块 `config/migrate-state-out-of-config.ts`，函数 `migrateStateOutOfConfig()`。

**在启动链中的位置**（`cli.tsx::main()`，现有链见 `cli.tsx:816-841`）：

```
① migrateLegacyState()        品牌迁移（.argon → .aragon）
② migrateToHome()             env-paths → ~/.aragon-agent
③ installLogging()            日志系统就位
③.5 migrateStateOutOfConfig() ← 新增，插在这里
④ readConfigFile() 的 parseError 提示
⑤ buildProgram() / parseAsync   （命令 action 内才会调 loadConfig()）
```

放在 ③ 之后是因为迁移要写日志记录；放在 ④/⑤ 之前是因为任何 `loadConfig()` 都必须看到迁移后的世界。

**算法**（全程 `try/catch`，返回结果而非抛出）：

1. `readConfigFile()`；`config === null`（文件不存在或解析失败）→ 返回 `{moved:[]}`。**绝不在文件损坏时改写它**——那会毁掉用户手工修复的机会。
2. 四个 legacy 键一个都不存在 → 返回 `{moved:[]}`。这就是**幂等键**：迁移是否已完成，由「源数据是否还在 config.json 里」判定，而不是由某个面包屑判定（同 `migrate-home.ts:26-30`）。
3. `promptHistory` 存在且非空 → `importLegacyPromptHistory(entries)`：只追加**当前历史文件中尚不存在**的文本（防止第 5 步失败后下次启动重复导入）。
   - **但先看 `config.historyEnabled === false`（RV-5）**：若用户已显式关掉历史记录，跳过本步，只把 `promptHistory` 键从 `config.json` 里删掉（第 5 步照做）。迁移运行在 `setHistoryEnabled()` 之前，模块级开关此刻还是默认的 `true`，所以这个判断必须由迁移自己从第 1 步已经读到的 `config` 上取，不能指望 `appendPrompt` 内部的开关拦住。
   - 触发场景不是理论上的：升级 → 关掉开关 → 回退到 0.5.x（旧版会把 `promptHistory` 重新写进 `config.json`）→ 再升级。少了这个判断，用户明确拒绝记录的提示词会被搬进新文件，一个隐私开关被静默绕过。
4. `submitCount` / `mouseNoticeSeen` 存在 → `importLegacyUiState({...})`：**只填补 `state.json` 中尚为默认值的字段，绝不覆盖已有的更新值**。
5. `updatePersistedConfig({})` —— 空 patch 走一次完整的读-剥离-写，legacy 键随 §4.5 的剥离一起消失。
6. `getLogger().info('migrate','migrate_state_split',{ moved, promptEntries })`。

**不打印 stderr 提示**（D-8）。

### 4.7 「agent 启动正确读取配置」的兑现

现有解析链（`load.ts:180-357`）本身是对的，四层优先级为 `flags › env › file › DEFAULT_CONFIG`（部分字段刻意只有三层，如 `hints`、`transcriptWindow` 不读 env——这是既有设计，本方案不动）。本方案在此链路上做三件事：

1. **移除**对 `file.promptHistory`（`load.ts:330`）与 `file.recentModels`（`:329`）的读取；`CliConfig` 同步删掉这两个字段。
2. `submitCount` 改为从 `readSubmitCount()`（state store）取，位置从「持久化字段区」移到 `CliConfig` 的「Resolved, non-persisted fields」注释块里，与 `cwd` / `color` 同列。
3. **新增一条 `config_loaded` 日志记录**，在 `loadConfig()` 返回前发出，`info` 级，只带非密钥字段：

```ts
getLogger().info('config', 'config_loaded', {
  provider, model, baseUrl, thinkingLevel, theme,
  fullscreen, toolTimeoutMs, idleTimeoutMs,
  logLevel: log.level, hasApiKey: Boolean(apiKeys[provider]),
  configPath: getConfigPath(),
});
```

这条记录是「我在配置里改了 model，为什么没生效」第一次可以被离线归因的手段：日志里直接能看到本次真正生效的是哪个值。密钥本身不入记录（只记布尔），且 `logging/redact.ts` 的注册表兜底仍然生效。

### 4.8 「TUI 修改正确写入配置」的兑现

`App.tsx:444-457` 的 `persistConfig()` 是 TUI 唯一的配置写入口，本身不改（它已经做了 try/catch + 失败 toast + 日志）。改的是**谁还在调它**：

| 调用点 | 现在 | 改后 |
|---|---|---|
| `App.tsx:500-509` `recordPrompt` | `setPromptHistory(next)` + `persistConfig({promptHistory, submitCount})` | **保留 `setPromptHistory`，只把持久化换掉**：`setPromptHistory(appendPrompt(text))` + `const n = bumpSubmitCount()` + `controller.setSubmitCount(n)`。**不再调 `persistConfig`** |
| `App.tsx:329` `onSeen` | `persistConfig({mouseNoticeSeen:true})` | `setMouseNoticeSeen(true)` |
| `App.tsx:580` 设置页保存 | `persistConfig(patch)` | **不变** |
| `App.tsx:589` 模型选择器 | `persistConfig({provider,model})` | **不变** |
| `commands/builtins.ts:53` `/thinking` | `ctx.persistConfig({thinkingLevel})` | **不变** |
| `commands/builtins.ts:76` `/theme` | `ctx.persistConfig({theme})` | **不变** |

> **`setPromptHistory` 这一行删不得（RV-1）。** 上表第一行最容易被读成「`recordPrompt` 整个函数体换成右列那三句」——那正是本方案评审前的写法，也正是 P0。`history` prop（`App.tsx:988` / `1007`）只吃 React state；`prompt-history.ts` 的模块级内存数组更新了不会触发任何重渲染。删掉这一行的症状极具迷惑性：**重启进程后 `↑` 一切正常（磁盘是对的），只有「提交完不重启就按 `↑`」才召回不到**，而 v1 的 §8.3 手工验收直接跳到重启之后，抓不到它。AC-2 的「同一会话中」四个字与 §8.2 的用例 12 是这条的护栏。
>
> 让 `appendPrompt` 返回新数组（§5.1）而不是让调用方自己拼，是为了让这里只剩一种写法：`setPromptHistory(appendPrompt(text))`。去重与截断规则从此只有 `prompt-history.ts` 一个实现，`App.tsx:501` 那行手写的 `filter + slice` 一并删除。

改完之后，**提交提示词不再产生任何 `config.json` 写操作**。§8 的 AC-5 用一条「提交 3 次后 `config.json` 的 mtime 与内容字节均不变」的用例把它钉死。

### 4.9 决策表

| # | 决策 | 理由 | 被否的替代方案 |
|---|---|---|---|
| **D-1** | 历史文件独立于 `logs/` | `logs/` 归 `log.toFile` / `log.maxFiles` / `aragon logs clear` 管辖。用户关掉诊断日志、或清理日志释放磁盘，**不应该**顺手删掉自己的 `↑` 召回历史；反过来，`enforceRetention()` 只按 `aragon-*.log` 前缀清理，历史文件放进去会变成一个「所有遍历都要特判」的异类。 | 放 `logs/prompt-history.jsonl` |
| **D-2** | 文件名 `prompt-history.jsonl` | `.jsonl` 后缀直说格式；`prompt-` 前缀避免与将来可能出现的命令历史 / 会话历史撞名。 | `history.log`（看不出是结构化的）、`history.json`（暗示整体重写） |
| **D-3** | 历史与 `state.json` 分两个文件 | 二者写频率、写方式、用户可见性都不同：历史是高频追加、用户会想看和清；`state.json` 是极低频全量重写、用户永远不需要看。合成一个文件就意味着「每提交一次重写一次全量历史」，等于回到 `config.json` 的老问题。 | 合并为单个 `state.json` |
| **D-4** | `CliConfig` 删 `promptHistory`，但**保留** `submitCount` | 不对称是刻意的。`promptHistory` 的唯一消费者是 `App.tsx:123` 的一次性 `useState` 种子，留在 `CliConfig` 会让**每一次** `loadConfig()`（含 `aragon logs tail`、`aragon skills list`）都去读一个自己永远用不到的、可达数 MB 的历史文件。`submitCount` 是一个标量，已经通过 `controller.getConfig()` / `controller.setSubmitCount()` 完整 plumb 好，且 `Composer` 在渲染期读它，拆出去要动 3 个文件换 0 收益。**代价须如实记账（RV-11）**：`submitCount` 改从 `readSubmitCount()` 取，等于给每次 `loadConfig()` 新增了一次 `state.json` 读——量级完全不同（约 60 字节的定长文件 vs. 上限 400 行、单条可达 16 KiB 的流水），且 `loadUiState()` 有进程内缓存，一次进程里最多读一次。这个不对称是「按文件大小与增长性取舍」，不是「历史文件贵、状态文件免费」。 | 两个都留 / 两个都删 |
| **D-5** | 历史文本**不脱敏** | 它的全部价值就是「原样召回我上次敲的东西」。脱敏后的历史召回出来是错的，用户按 `↑` 拿到一个被打码的提示词再回车发出去，比不记录更糟。用 `0600` + `aragon history clear` + `historyEnabled` 三件事来对冲隐私风险。 | 复用 `logging/redact.ts` |
| **D-6** | 单条 > 16 384 字符**不记录**，而不是截断记录 | 截断记录会让用户按 `↑` 召回一个**看起来完整、实际被砍掉一半**的提示词并发出去——静默错误。不记录只是少一条召回。16 KiB 远超任何手敲提示词；到这个量级的粘贴内容应该走文件引用。 | 截断存储 / 无上限 |
| **D-7** | `state.json` 立即写，不防抖 | 文件约 60 字节，一次原子写；防抖会引入「退出时必须 flush」的新义务，而 `usage.ts:141-150` 已经证明那条路要额外处理定时器、`unref`、以及 `resetUsage` 时清 `dirty` 的坑（`usage.ts:206-217` 整段注释都在讲这个）。省掉整类问题。 | 2s 防抖 + 退出 flush |
| **D-8** | 迁移**不打印** stderr 提示 | ①② 两个既有迁移会打印，是因为不打印的话用户的 API Key 和会话看起来凭空消失了。本次迁移对用户完全无感（历史照常召回，计数照常），一行提示只是噪声，何况一次启动打三行更糟。日志里有 `migrate_state_split` 记录，`aragon config home` 会新增一行指向新文件。 | 打印一行 |
| **D-9** | 新增配置键 `historyEnabled`（扁平，非嵌套） | ①它满足 §4.1 的配置判据（用户主动声明 + 丢了是「设置没了」）；②把提示词原文写进一个新文件是必须给用户一个总开关的改动，`skills.usageTracking` 已有先例；③**扁平而非 `history.enabled` 嵌套段**，因为 `store.ts:124-142` 白纸黑字规定新增嵌套段要先替换手写合并，而 plan-mode 的三个扁平键（`schema.ts:135-142`）已经把「少量标量就走扁平」立为惯例。 | 不给开关 / 新增 `history{}` 嵌套段 |
| **D-10** | `recentModels` 直接删除，不搬到 `state.json` | 全仓库无写者、无 UI 读者，`RECENT_MODELS_CAP` 也无消费者。把死字段搬进新文件只是把技术债换个地方放。`CliConfig` 不是本包对外导出的公开 API（`package.json` 只有 `bin`，没有 `exports`/`main`），删除不构成对外破坏性变更。 | 搬进 `state.json` 并补上写路径 |
| **D-11** | 迁移幂等键 = 「legacy 键是否还在 config.json 里」 | 与 `migrate-home.ts:26-30` 同理：用面包屑或「新文件是否存在」做幂等键，都会让一次半途失败的迁移**永远**被跳过。用源数据本身做幂等键，失败必然重试，而第 3/4 步的去重与「不覆盖」保证重试安全。 | 面包屑文件 / `existsSync(prompt-history.jsonl)` |

---

## 5. 接口设计

### 5.1 `config/prompt-history.ts`（新）

```ts
export const PROMPT_HISTORY_FILENAME = 'prompt-history.jsonl';
export const PROMPT_HISTORY_LINE_VERSION = 1;
/** 超过此长度的单条提示词不记录（D-6）。 */
export const PROMPT_ENTRY_MAX_CHARS = 16_384;
/** 追加到这么多行之后触发一次压实。 */
export const HISTORY_COMPACT_AT_LINES = 400;

export interface PromptHistoryEntry {
  v: number;
  ts: number;
  text: string;
}

/**
 * 从旧到新、已去重、已截断到 PROMPT_HISTORY_CAP。进程内缓存。永不抛。
 * 不受 historyEnabled 约束——关掉开关只停写不停读（§4.3.3 / RV-12）。
 */
export function loadPromptHistory(): string[];

/**
 * 记录一条，返回**更新后的完整历史数组**（从旧到新、已去重、已截断）。
 *
 * 返回值不是可有可无的便利：调用方 `App.tsx::recordPrompt` 必须拿它去
 * `setPromptHistory(...)`，否则本会话内按 `↑` 召回不到刚提交的内容（§4.8 / RV-1）。
 * 被 historyEnabled / 空串 / PROMPT_ENTRY_MAX_CHARS 拦下时不写盘，但**仍返回**
 * 当前数组，调用方无需分支。永不抛。
 */
export function appendPrompt(text: string, now?: number): string[];

/** 迁移专用：只导入历史文件中尚不存在的文本，返回实际写入条数。永不抛。 */
export function importLegacyPromptHistory(entries: string[]): number;

/** `aragon history list` 用：带时间戳的原始条目，从新到旧。永不抛。 */
export function listPromptHistory(): PromptHistoryEntry[];

/** `aragon history clear` 用：删文件 + 清缓存，返回被清除的条目数。永不抛。 */
export function clearPromptHistory(): number;

/**
 * 由 loadConfig() 在解析出 historyEnabled 后调用一次。
 *
 * 模块级标志的初值是 `true`（§4.3.4 步 1 / RV-5）：启动链里的迁移（③.5）跑在
 * 任何 loadConfig()（⑤）之前，那个窗口内必须有一个确定的行为，而 `true` 与该
 * 配置键的默认值一致。窗口内唯一需要尊重「用户显式关闭」的场景是迁移导入，
 * 它自己从 readConfigFile() 的结果上判定，不依赖这个标志（§4.6 步 3）。
 */
export function setHistoryEnabled(enabled: boolean): void;

/** 测试专用：忘掉缓存与计数器。 */
export function resetPromptHistoryForTests(): void;
```

### 5.2 `config/ui-state.ts`（新）

```ts
export const UI_STATE_FILENAME = 'state.json';
export const UI_STATE_SCHEMA = 1;

export interface UiState {
  schema: number;
  submitCount: number;
  mouseNoticeSeen: boolean;
}

export function loadUiState(): UiState;              // 缓存 + 逐字段容错，永不抛
// 写路径（bump / set / import）内部先 mkdirSync(getHomeRoot()) 再 tmp+rename
// 再 chmod 0600 —— 见 §4.4，缺 mkdir 会让 submitCount 静默永不落盘（RV-2）。
export function readSubmitCount(): number;
export function bumpSubmitCount(): number;           // 自增、落盘、返回新值
export function getMouseNoticeSeen(): boolean;
export function setMouseNoticeSeen(seen: boolean): void;
export function importLegacyUiState(patch: Partial<Pick<UiState,'submitCount'|'mouseNoticeSeen'>>): void;
export function resetUiStateForTests(): void;
```

### 5.3 `config/migrate-state-out-of-config.ts`（新）

```ts
export interface StateMigrationResult {
  /** 实际搬走的键名，如 ['promptHistory','submitCount']。 */
  moved: string[];
  /** 导入的历史条目数，用于日志。 */
  promptEntries: number;
  /** 用返回代替抛出（C3）。 */
  error?: string;
}

export function migrateStateOutOfConfig(): StateMigrationResult;
```

### 5.4 `config/app-paths.ts`（改）

```ts
export function getPromptHistoryPath(): string;  // join(root, 'prompt-history.jsonl')
export function getUiStatePath(): string;        // join(root, 'state.json')
```

### 5.5 新的 CLI 表面

```
aragon history [path|list|clear] [-n <N>] [--json] [--yes]
```

| 子命令 | 行为 | 退出码 |
|---|---|---|
| `path`（默认） | 打印 `prompt-history.jsonl` 的绝对路径 | 0 |
| `list` | 从新到旧打印条目；`-n` 限制条数（默认 20）；`--json` 输出原始 `PromptHistoryEntry[]` | 0 |
| `clear` | **必须带 `--yes`**，否则打印提示并退出 2；清除后打印 `Removed N entries.` | 0 / 2 |

退出码沿用既有约定（`logging/cli-commands.ts:3-5`）：0 成功 · 1 运行期失败 · 2 用法错误。子命令组与 `aragon logs` 一样**豁免**「每个子命令记一条 info 日志」的规则——同样的 Windows 句柄问题（`logging/cli-commands.ts:7-13`）。

### 5.6 新的配置键

| 键 | 类型 | 默认 | 通道 |
|---|---|---|---|
| `historyEnabled` | boolean | `true` | `aragon config set historyEnabled true\|false`；`aragon config get/list`；手工编辑 |

`CONFIG_SET_KEYS`（`cli.tsx:458-493`）与 `runConfigSet` 的 `switch`（`cli.tsx:495-608`）**必须同时**加。`cli.tsx:474-478` 的注释已经把「只加进 Set 不加进 switch」记为踩过的坑（P1-2）：那样会静默地什么都不写却照常打印 `Set historyEnabled = false`。

**这条无需新增测试（RV-7）**：`__tests__/config.test.ts:292-322` 已有一条源码文本护栏 `config set: every accepted key actually writes something`——它正则抽出 `CONFIG_SET_KEYS` 里的每个字面量键，断言源码中存在对应的 `case '<key>':`。新键自动落入覆盖范围，漏改 `switch` 会直接把这条既有用例打红。实施时只需确认它仍为绿，不要另起炉灶写重复用例。

`aragon config get/list` **无需改动**：两者都遍历 `loadPersistedConfig()` 的返回值（`config/cli-commands.ts:115` / `:126`），因此 `historyEnabled` 自动出现、四个 legacy 键自动消失。

**不新增环境变量、不新增 CLI flag**：它是一个「设一次就不动」的隐私开关，不是需要按次覆盖的运行期旋钮。

---

## 6. 数据模型

### 6.1 `config.json` 变更前后

```diff
  {
    "version": 1,
    "provider": "anthropic",
    "model": "glm-5.1",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "thinkingLevel": "medium",
    "maxTokens": null,
    "theme": "auto",
    "reducedMotion": false,
    "fullscreen": true,
    "exitTranscript": true,
    "transcriptWindow": 300,
    "confirmTools": false,
    "toolTimeoutMs": 180000,
    "idleTimeoutMs": 210000,
    "apiKeys": { "anthropic": "sk-…" },
-   "recentModels": [],
-   "promptHistory": ["…", "…", "…"],
    "density": "comfortable",
    "hints": true,
    "mouse": true,
-   "mouseNoticeSeen": true,
-   "submitCount": 16,
    "planModeDefault": false,
    "planModeMaxAskRounds": 4,
    "planModeHumanTimeoutMs": 1800000,
+   "historyEnabled": true,
    "skills": { … },
    "log": { … }
  }
```

字段数 27 → 23（删 4 加 1，净 -3）。**写频率从「每次提交一次」降为「用户改设置时才写」。**

### 6.2 `prompt-history.jsonl`

```
{"v":1,"ts":1753600001111,"text":"帮我把这个函数拆一下"}
{"v":1,"ts":1753600123456,"text":"跑一下测试"}
{"v":1,"ts":1753600200000,"text":"帮我把这个函数拆一下"}
```

不变量：

- **I-1**：每行独立可解析；坏行被跳过，绝不导致整文件作废。
- **I-2**：文件里允许存在重复 `text`（第 1 行与第 3 行）；去重发生在**读取时**（保留最后一次出现），压实时把去重结果写回。
- **I-3**：内存返回值恒为「从旧到新、无重复、长度 ≤ `PROMPT_HISTORY_CAP`」，与 `PromptInput.tsx:297-313` 的索引语义完全对齐。

### 6.3 `state.json`

```json
{
  "schema": 1,
  "submitCount": 16,
  "mouseNoticeSeen": true
}
```

`schema !== 1` → 整体回落默认值（同 `usage.ts:68`）。

### 6.4 内存模型变更

| 类型 | 变更 |
|---|---|
| `PersistedConfig` | 删 `promptHistory` / `submitCount` / `mouseNoticeSeen` / `recentModels`；加 `historyEnabled: boolean` |
| `DEFAULT_CONFIG` | 同上；`historyEnabled: true` |
| `CliConfig` | 删 `promptHistory` / `recentModels`；`submitCount` 移入「Resolved, non-persisted fields」块；加 `historyEnabled: boolean` |
| 常量 | 删 `RECENT_MODELS_CAP`；`PROMPT_HISTORY_CAP` 保留，消费者从 `App.tsx` 改为 `prompt-history.ts` |

---

## 7. 文件 / 模块变更计划

### 7.1 新增

| 文件 | 意图 |
|---|---|
| `packages/cli/src/config/prompt-history.ts` | 提示词历史 store：加载 / 追加 / 压实 / 列出 / 清除，全部永不抛 |
| `packages/cli/src/config/ui-state.ts` | `state.json` store：`submitCount` / `mouseNoticeSeen` 的读写，全部永不抛 |
| `packages/cli/src/config/migrate-state-out-of-config.ts` | 一次性把四个 legacy 键搬出 `config.json`，幂等、永不抛 |
| `packages/cli/src/config/history-commands.ts` | `aragon history path\|list\|clear` 的实现（与 `logging/cli-commands.ts` 同构） |
| `packages/cli/src/__tests__/prompt-history.test.ts` | 历史 store 的正常路径 + 坏行 / 超长 / 压实 / 并发追加 |
| `packages/cli/src/__tests__/ui-state.test.ts` | state store 的往返、容错、默认值 |
| `packages/cli/src/__tests__/migrate-state-out-of-config.test.ts` | 迁移的搬运、幂等、部分失败重试、损坏配置不改写 |
| `packages/cli/src/__tests__/config-purity.test.ts` | **机械护栏**：`DEFAULT_CONFIG` 不含任何 legacy 键；写一个带 legacy 键的文件后任意一次写操作都会把它剥掉 |

### 7.2 修改

| 文件 | 改什么 |
|---|---|
| `config/app-paths.ts` | 加 `getPromptHistoryPath()` / `getUiStatePath()`；更新头部 LAYOUT 注释块 |
| `config/schema.ts` | `PersistedConfig` / `DEFAULT_CONFIG` / `CliConfig` 增删字段（§6.4）；新增 `LEGACY_STATE_KEYS` + `stripLegacyStateKeys()`；删 `RECENT_MODELS_CAP` |
| `config/store.ts` | `loadPersistedConfig()` 对 `partial` 先 `stripLegacyStateKeys` 再合并；删 `recentModels` / `promptHistory` 两行合并 |
| `config/load.ts` | 删 `file.promptHistory` / `file.recentModels`；`submitCount` 改读 `readSubmitCount()`；解析 `historyEnabled` 并调 `setHistoryEnabled()`；新增 `config_loaded` 日志 |
| `config/cli-commands.ts` | `runConfigHome()` 追加两行，指出历史与状态文件的位置 |
| `ui/App.tsx` | ① 第 123-124 行 `promptHistory` 种子改 `loadPromptHistory()`；② `recordPrompt`（500-509）改为 `setPromptHistory(appendPrompt(text))` + `bumpSubmitCount()` + `controller.setSubmitCount(n)`，**移除 `persistConfig` 调用**，并删掉第 501 行手写的 `filter + slice`（去重截断改由 `prompt-history.ts` 独家实现）。**`setPromptHistory` 必须保留**（RV-1）；③ 第 329 行 `onSeen` 改 `setMouseNoticeSeen(true)` |
| `ui/use-startup-notices.ts` | 第 79 行的 `readConfigFile().config?.mouseNoticeSeen` 改 `getMouseNoticeSeen()` |
| `cli.tsx` | `main()` 中 ③ 之后插 `migrateStateOutOfConfig()`；注册 `aragon history` 命令组；`CONFIG_SET_KEYS` + `runConfigSet` 加 `historyEnabled` |
| `__tests__/config.test.ts` | 删 `promptHistory` / `recentModels` 断言；`mouseNoticeSeen` 往返用例（266-274 行）迁到 `ui-state.test.ts`；补 `historyEnabled` 往返 |
| `__tests__/app.test.tsx` | `CONFIG` fixture（65-66 行）删 `recentModels` / `promptHistory`；第 473 条用例（`does not recall prompt history on Shift+Up`）现在靠 `fc.config.promptHistory` 注入历史，改为 `vi.mock('../config/prompt-history.js')`；补 `vi.mock('../config/ui-state.js')`（否则 `recordPrompt` 会在 vitest 临时根下产生真实文件 I/O） |
| `__tests__/mouse-routing.test.tsx` | ① 第 34 行的 `readConfigFile` mock 改为 mock `config/ui-state.js` 的 `getMouseNoticeSeen`；② fixture（356-361 行）删两字段；③ **第 538 / 552 / 574 行的三处 `store.writes` 断言必须一并改写**（RV-4）——它们经由被 mock 的 `updatePersistedConfig` 观测 `{mouseNoticeSeen:true}`，改用 `setMouseNoticeSeen()` 之后：第 538 行（`toContainEqual`）会硬失败，**而 552 / 574 行（`not.toContainEqual`）会静默常绿**，守的是一个永远不会被写的对象。把 `store.writes` 换成 mock 的 `setMouseNoticeSeen` 调用记录，三处断言语义逐字不变 |
| `__tests__/skills-controller.test.ts` | fixture（57-58 行）删 `recentModels` / `promptHistory` |
| `packages/cli/README.md` | 更新 §Files & logs 的目录树；新增「Prompt history」小节（存了什么 / 存在哪 / 怎么清 / 怎么关）；命令表加 `aragon history` |
| `packages/cli/CHANGELOG.md` | 新版本条目：行为变更 + 迁移说明 + `historyEnabled`；**并写明降级窗口的表现（RV-15）**——回退到 0.5.x 期间旧版读不到新文件，`↑` 看起来「历史空了」，数据仍在 `prompt-history.jsonl`，重新升级即恢复 |

---

## 8. 测试与验收标准

### 8.1 验收标准（AC）

| # | 断言 |
|---|---|
| **AC-1** | 一次完整的 TUI 会话（≥3 次提交）之后，`config.json` 中 `promptHistory` / `submitCount` / `mouseNoticeSeen` / `recentModels` 四个键**均不存在** |
| **AC-2** | **同一会话中**（不重启、不重新挂载组件）按 `↑` 能依次召回刚才提交的 3 条，顺序与旧版逐字一致；**另外**重启进程后仍能召回。两个半句都要断言——只测重启那半句会漏掉 RV-1（React state 未更新）这整类缺陷 |
| **AC-3** | 重复提交同一句后，历史中只出现一次且位于最新端 |
| **AC-4** | `prompt-history.jsonl` **与 `state.json`** 都存在、`prompt-history.jsonl` 每行可独立解析、POSIX 下**两者权限均为 `0600`**（含一次触发过压实之后再断言一次——rename 不保证保留 mode，见 RV-6） |
| **AC-5** | 连续提交 3 次后，`config.json` 的**字节内容与 mtime 均不变**。基线在**启动期迁移完成之后**取（RV-10）：迁移本身会写一次 `config.json`，拿进程启动前的 mtime 当基线会让这条用例假红 |
| **AC-6** | 用一份含 4 个 legacy 键的旧 `config.json` 冷启动：历史全部出现在新文件里、`submitCount` 保值、`config.json` 里键消失；**再次启动不重复导入** |
| **AC-7** | 若第一次迁移在写 `config.json` 前失败，第二次启动能完成且不产生重复历史条目 |
| **AC-8** | 写一份 provider/model/baseUrl/thinkingLevel/toolTimeoutMs/theme 全为非默认值的 `config.json`，在干净环境下 `loadConfig({})` 逐字段返回该值；`idleTimeoutMs` 仍满足 `≥ toolTimeoutMs + 30_000` 的不变量。「干净环境」= 清掉 `ARAGON_*` 覆盖项与 flag，**但必须豁免 `ARAGON_HOME`**（RV-14 —— `app-paths.ts:38-40` 测试隔离契约第 2 条：删掉它会让后续解析指向开发者的真实主目录） |
| **AC-9** | 模拟设置页保存（`updatePersistedConfig(patch)`）后重新 `readConfigFile()`，patch 中每个字段都已落盘，且 `skills` / `log` 段的其余字段**未被清空** |
| **AC-10** | `aragon history list` 能列出条目；`aragon history clear --yes` 后文件消失且 `loadPromptHistory()` 返回 `[]`；不带 `--yes` 时退出码为 2 且文件仍在 |

### 8.2 单元测试清单

**`prompt-history.test.ts`**
1. 空文件 / 文件不存在 → `[]`
2. 三条正常行 → 从旧到新
3. 中间夹一行 `{oops` → 跳过坏行，其余照常返回
4. 同一 `text` 出现两次 → 去重且保留最新位置
5. 超过 `PROMPT_HISTORY_CAP` 条 → 只返回最后 100 条
6. `appendPrompt` 追加后文件多一行且内存立即可见
7. 超过 `PROMPT_ENTRY_MAX_CHARS` → 文件行数不变
8. `historyEnabled=false` → `appendPrompt` 不写文件
9. 追加到 `HISTORY_COMPACT_AT_LINES` 之上 → 文件被压实且内容等价
10. 目录只读（`chmod 0500`，仅 POSIX）→ 不抛，返回值仍可用
11. `clearPromptHistory()` 后文件消失、缓存清空、返回值等于原条目数
12. **`appendPrompt` 的返回值就是更新后的完整数组**，末位是刚追加的 `text`，且长度 / 顺序与紧随其后的 `loadPromptHistory()` 完全一致（RV-1 的单元级护栏；AC-2 的前半句是它的集成级对应物）
13. **`<home>` 目录不存在时 `appendPrompt` 仍能落盘**：删掉整个 vitest 临时根后调用一次，断言文件被创建且内容正确（RV-2）。`ui-state.test.ts` 需要一条对称用例
14. **压实不吞掉外部追加**：`loadPromptHistory()` 之后由测试直接向文件追加一行（模拟另一个实例），再触发压实 → 该行仍在结果中（RV-3）
15. `historyEnabled=false` 时 `loadPromptHistory()` / `listPromptHistory()` 仍能读出已有条目（RV-12）

**`ui-state.test.ts`**
1. 缺文件 → 默认值
2. `bumpSubmitCount()` 三次 → 磁盘上是 3，`readSubmitCount()` 也是 3
3. `schema: 2` → 回落默认值
4. `submitCount: "abc"` → 该字段回落 0，`mouseNoticeSeen` 仍被读出
5. `setMouseNoticeSeen(true)` 往返

**`migrate-state-out-of-config.test.ts`**
1. 四键齐全 → 全部搬走，`moved.length === 4`
2. 无 legacy 键 → `moved: []`，不写任何文件
3. 连跑两次 → 第二次 `moved: []`，历史条目数不翻倍
4. `state.json` 已有 `submitCount: 99`、config 里是 5 → 保留 99（不覆盖）
5. `config.json` 是坏 JSON → `moved: []` 且**文件字节未变**
6. 历史文件已含其中两条 → 只导入另外两条
7. **`config.json` 含 `historyEnabled: false` + 非空 `promptHistory` → 键被删除，但一条历史都不导入**（RV-5）

**`config-purity.test.ts`（机械护栏）**
1. `Object.keys(DEFAULT_CONFIG)` 与 `LEGACY_STATE_KEYS` 交集为空
2. 手写一份含 `promptHistory` 的 `config.json` → `updatePersistedConfig({theme:'cool'})` → 重新读文件，`promptHistory` 已消失、`theme` 已生效
3. `loadPersistedConfig()` 的返回值上不存在任何 legacy 键

### 8.3 手工验收（Windows，需求原场景）

1. 备份 `C:\Users\<you>\.aragon-agent\config.json`
2. 装新版 → 启动 `aragon` → 提交 3 句
3. **不要退出**，就在当前会话里按 `↑` 三次 → 三句按序召回（RV-1 的手工护栏；这一步是新增的，v1 的清单直接跳到重启后验证，抓不到 React state 未更新那类缺陷）→ 然后退出
4. 打开 `config.json`：**没有** `promptHistory`；打开 `prompt-history.jsonl`：3 行俱在
5. 重开 `aragon`，按 `↑` 三次 → 三句按序召回
5. 在 TUI 里 `/theme cool` → 退出 → `config.json` 的 `theme` 已是 `"cool"`
6. `aragon config set model gpt-4o` → 重开 → 状态栏显示 `gpt-4o`
7. `aragon history clear --yes` → `↑` 无内容可召回，`config.json` 不受影响

对应清单落到 `docs/plans/config-state-separation/manual-test.md`（由开发节点补齐）。

---

## 9. 风险与缓解

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| **R-1** | legacy 键「删了又长回来」 | 只从 `PersistedConfig` 删字段，忘了 §4.5 的剥离；`loadPersistedConfig` 的 `...partial` 把磁盘上的键原样带回并写回 | 需求核心诉求完全落空，且现象诡异（迁移日志说搬走了，文件里还在） | §4.5 单一收口 + `config-purity.test.ts` 用例 2 与 3 直接钉这条 |
| **R-2** | 迁移半途失败导致历史重复导入 | 第 3 步成功、第 5 步写 `config.json` 失败 | 用户看到成对重复的历史 | 幂等键选「源数据是否还在」（D-11）+ `importLegacyPromptHistory` 只导入不存在的文本 |
| **R-3** | 多实例并发写坏历史 | 用户同时开两个终端跑 `aragon` | 条目丢失或行交错 | `O_APPEND` + 单次 `writeSync` 保证整行原子；读取端逐行容错；**压实前重新读盘**再 `tmp+rename`（§4.3.5），使损失范围收敛到「两实例读-写窗口精确重叠时的少量条目」。**注意**：若按评审前的写法直接用进程内存数组覆盖，损失的是「本进程 load 之后其它实例追加的全部条目」，与 §4.3.1 理由 3 的立论直接冲突 |
| **R-4** | 巨型粘贴撑爆历史文件 | 用户粘贴一份 5 MB 日志作为提示词 | 文件膨胀、加载变慢 | 单条 16 KiB 上限（D-6）+ 400 行压实阈值双层约束 |
| **R-5** | 提示词原文落盘的隐私暴露面比以前**更显眼** | 文件名直白，用户可能没意识到内容一直在存 | 用户不知情 | 内容量与以前完全相同（以前也在 `config.json` 里）；`0600` + README 明写 + `aragon history clear` + `historyEnabled=false` 四重对冲 |
| **R-6** | 单测误删开发者真实主目录 | 新 store 的测试直接 `rmSync(getHomeRoot(), {recursive:true})` | 不可恢复的数据丢失 | 严守 `app-paths.ts:25-49` 的测试隔离契约：只删单个文件（`rmSync(getPromptHistoryPath(), {force:true})`），或删测试自己在 `os.tmpdir()` 下建的目录 |
| **R-7** | `mouse-routing.test.tsx` 的 mock 与断言漏改 | ① 第 34 行 mock 的是 `readConfigFile`，返回 `{config:{mouseNoticeSeen}}`，改后 `use-startup-notices` 不再读它；② 第 538 / 552 / 574 行经由被 mock 的 `updatePersistedConfig` 观测 `{mouseNoticeSeen:true}`，改后不再有人这样写 | 测试**照常变绿**，但守的已经不是真实链路。②的 552 / 574 是 `not.toContainEqual` 负向断言，会永久空转——**这是本条风险最隐蔽的一半，v1 只覆盖了 ①** | §7.2 逐条列出这四个改点（RV-4）；`ui-state.test.ts` 另立一条独立于 App 的 `mouseNoticeSeen` 往返用例做交叉验证 |
| **R-8** | 删 `CliConfig.promptHistory` 打断 4 个测试 fixture | `app.test.tsx:66`、`mouse-routing.test.tsx:357`、`skills-controller.test.ts:58` 等 | 编译失败 | **这是好事**：TypeScript 编译期报错，比运行期静默行为变化好得多。§7.2 已逐个列出 |
| **R-9** | Windows 上 `renameSync` 覆盖失败 | 另一个 `aragon` 实例正持有目标文件句柄，抛 `EPERM` | 压实 / 状态写失败 | 全部包在 `try/catch` 里；失败时清理 tmp 并保持原文件，下次再试（同 `file-sink.ts:284-299` 的既有取舍） |
| **R-10** | `submitCount` 迁移丢失导致输入框提示重新出现 | `state.json` 导入失败 | 用户看到 8 次以内才有的完整提示行 | 纯观感回退，无功能影响；迁移的「不覆盖」策略保证不会把已有的更大值改小 |
| **R-11** | `historyEnabled` 只加进 `CONFIG_SET_KEYS` 忘了加 `switch` | 照抄 `mouse` 那一行 | `aragon config set historyEnabled false` 打印成功却什么都没写 | `cli.tsx:475-478` 的注释已把这条记为踩过的坑（P1-2）；§5.6 显式要求两处同时改；**无需新增用例**——`config.test.ts:292-322` 的源码文本护栏会自动扫到新键并要求存在对应 `case`（RV-7） |
| **R-12** | `↑` 在本会话内召回不到刚提交的内容 | `recordPrompt` 改写时连 `setPromptHistory(next)` 一起删掉（RV-1） | 需求点名的召回体验在**最常见的路径**（提交完立刻按 `↑`）上失效，而重启后一切正常，极难归因 | §4.8 的显式警告 + `appendPrompt` 返回新数组的签名设计（§5.1）+ AC-2 前半句 + §8.2 用例 12 + §8.3 手工验收新增第 3 步 |
| **R-13** | 新 store 在 `<home>` 不存在时静默不落盘 | 首次运行 + `log.toFile:false` + 从未写过配置 | 提示词历史 / `submitCount` 永远不持久化，且 C2 的吞异常策略保证用户看不到任何迹象 | 两处写路径都先 `mkdirSync(getHomeRoot(),{recursive:true})`（§4.3.4 步 5 / §4.4）+ §8.2 用例 13 |

---

## 10. 实施顺序

必须按此顺序，每步结束时 `npm run build` 与 `npx vitest run` 都应为绿：

1. **路径与常量**：`app-paths.ts` 加两个 getter + 更新 LAYOUT 注释。（无行为变化）
2. **两个 store**：`prompt-history.ts` + `ui-state.ts` 及其单测。此时它们还没有任何调用者，可以独立跑绿。
3. **schema 净化**：`schema.ts` 增删字段 + `LEGACY_STATE_KEYS` / `stripLegacyStateKeys`；`store.ts` 接上剥离。**此时全仓库编译会红**，红点即是 §7.2 的清单，逐个修完。
4. **读路径**：`load.ts`（删两字段、接 `readSubmitCount`、解析 `historyEnabled`、加 `config_loaded` 日志）。
5. **写路径**：`App.tsx` 三处 + `use-startup-notices.ts` 一处。**改 `recordPrompt` 时对照 §4.8 的警告框**：`setPromptHistory` 必须留下（RV-1）。
6. **迁移**：`migrate-state-out-of-config.ts` + `cli.tsx::main()` 接线 + 单测。
7. **CLI 表面**：`history-commands.ts` + `cli.tsx` 命令注册 + `historyEnabled` 的 `CONFIG_SET_KEYS`/`switch` 两处。
8. **测试收尾**：`config-purity.test.ts`，以及 §7.2 中所有 fixture 的更新。
9. **文档**：README 目录树 + Prompt history 小节 + 命令表；CHANGELOG 条目。

**第 3 步与第 6 步不能拆成两次发布**：只做 3 而不做 6，老用户的历史与计数会在升级瞬间被剥离且无处可去——那才是真正的数据丢失。

---

## 11. 未决问题（评审节点已逐条拍板）

| # | 问题 | v1 倾向 | **评审裁定** |
|---|---|---|---|
| **Q-1** | `historyEnabled` 是否真的要新增？还是复用 `log.redactSecrets` 那种「命令行 only、无设置页入口」的形态？ | 倾向新增且**不**进设置页 | **照办**。新增该键、**不**进设置页、**不**加 flag / env。把提示词原文写进一个新文件是必须配总开关的改动（D-9），而设置页多一行的注意力成本高于它的使用频率。实现成本经复核为零额外测试（RV-7）。 |
| **Q-2** | `aragon history` 是否要提供 `--follow`（像 `aragon logs tail -f`）？ | 倾向不提供 | **不提供**。`--follow` 的价值来自「别处在往里写、我要盯着」，而提示词历史的唯一写者就是用户自己按下的回车。将来若出现多实例场景的真实诉求再单独提。 |
| **Q-3** | 提示词历史是否应该按 `cwd` 分桶（不同项目不同历史）？ | 倾向本期不做 | **本期不做**。行格式的 `v` 字段与「解析时跳过 `v !== 1`」规则（§4.3.2）已经把演进路径留好：将来加 `cwd` 字段是纯追加式变更，旧版 CLI 不会读崩。现在做则要同时回答「跨项目的通用提示词怎么召回」，属于另一个需求。 |
| **Q-4** | `state.json` 将来会不会变成「什么都往里塞」的垃圾抽屉？ | 建议在文件头注释里立规矩 | **升格为强制约定**（RV-8），已写进 §4.4：只允许 UI 记账标量，任何带用户内容或随使用量线性增长的字段一律另开文件。放在建议层面不够——本方案存在的全部理由就是 `config.json` 当年没有这条规矩。 |
| **Q-5** | 是否顺手给 `recentModels` 补上写路径（模型选择器写入 MRU）而不是删掉？ | 倾向删（D-10） | **删**。已复核 `recentModels` / `RECENT_MODELS_CAP` 全仓库无写者、无 UI 读者，且 `packages/cli/package.json` 只有 `bin`、没有 `exports` / `main`，删除不构成对外破坏性变更。补写路径是一个新功能，应该走自己的需求。 |

---

## 12. 评审结论（Review Verdict）

### 结论：**有条件通过**

方案的判断是对的，而且对得很具体。它没有停在「把历史挪个地方」，而是抓住了本次改动真正的承重点——§4.5 的 `stripLegacyStateKeys` 单一收口。评审独立复核了 `updatePersistedConfig` 的全部 6 个调用点，确认无一绕过 `loadPersistedConfig()`，该收口成立；若少了它，`store.ts:111` 的 `...partial` 展开会把磁盘上的 legacy 键原样写回，需求的核心诉求会以「删了又长回来」的形式完全落空。同样值得肯定的是坚持把 `submitCount` 一起搬走：只搬 `promptHistory` 的话，每次提交仍会重写整个含明文 API Key 的 `config.json`，「把热文件变回冷文件」这个运维目标只兑现一半。方案引用的每一处行号、每一条既有范本（`usage.ts` / `file-sink.ts` / `migrate-home.ts` / `clampSkillsConfig`）、以及四个测试 fixture 的位置，逐条实读复核**全部属实**，没有编造。范围克制得当：0 新依赖、不碰 core、不碰宿主、不动任何协议，只新增扁平配置键因而不触碰 `store.ts` 明令禁止的第三层嵌套。

v1 的问题集中在**同一类**：把「模块内存里的状态」当成了「用户看得见的状态」。P0（RV-1，`setPromptHistory` 被顺手删掉）、P1 中的 RV-2（缺 `mkdirSync`）与 RV-3（压实用过时内存数组覆盖文件），三者都是这个模式——数据在内存里是对的，落到用户面前就不对了，而且症状都极难归因。这也解释了为什么 v1 的 AC 抓不到它们：AC-2 原文只说「重启进程后仍能召回」，恰好是 RV-1 唯一正常的那条路径。上述 6 项 P0/P1 已在本版正文中逐条修复，并各配了单元级或手工级护栏；9 项 P2 亦已落到正文。

### 放行条件（实施节点必须逐条兑现，缺一不可）

1. **`recordPrompt` 保留 `setPromptHistory`**（RV-1）。`appendPrompt` 按 §5.1 返回 `string[]`，调用点写成 `setPromptHistory(appendPrompt(text))`。§8.2 用例 12 与 §8.3 手工验收第 3 步是它的双重护栏，**两者都不得省略**——只有单元测试会漏掉真实 React 挂载下的行为。
2. **两个新 store 的写路径都先 `mkdirSync(getHomeRoot(), { recursive: true })`**（RV-2），并有 §8.2 用例 13 那条「删掉整个临时根后仍能落盘」的对称用例守住。这是 C2「永不抛」策略下唯一能把静默数据丢失暴露出来的手段。
3. **压实前重新读盘**（RV-3），§8.2 用例 14 断言「测试直接追加的外部行不被压实吞掉」。
4. **`mouse-routing.test.tsx` 的四个改点全部落实**（RV-4），特别是第 552 / 574 行两条 `not.toContainEqual` 负向断言——它们不改也会绿，正因如此必须在 code review 时逐行确认，不能靠跑测试确认。
5. **迁移显式尊重 `historyEnabled === false`**（RV-5），§8.2 迁移用例 7 覆盖。
6. **`state.json` 与压实路径在 POSIX 上 rename 之后补 `chmodSync(0o600)`**（RV-6），AC-4 扩展到两个文件、并在触发过压实之后再断言一次。
7. **§10 第 3 步与第 6 步必须同一次发布**（v1 已提出，此处重申为放行条件）。只做 schema 净化而不做迁移，老用户的历史与计数会在升级瞬间被剥离且无处可去——那是本方案唯一可能造成真实数据丢失的路径。
8. **`aragon config set historyEnabled` 不新增测试**（RV-7），改为确认 `config.test.ts:292-322` 的既有源码文本护栏仍为绿。多写一条重复用例会让下一个人误以为那条既有护栏不覆盖新键。

### 交付节点还需补齐

- `docs/plans/config-state-separation/manual-test.md`（§8.3 已把清单写全，含新增的第 3 步）。
- 实施完成后，若出现本文档未预见的偏差，按本仓惯例在 spec 末尾追加「实施过程发现的方案缺陷」小节，不要静默改设计。

**未解决的 P0 / P1：无。**

---

## 13. 实施过程发现的方案缺陷

实施 + Review 节点按 §10 顺序落地全部代码后记录。**没有一条推翻设计**，都是方案未预见的
落点偏差，已就地修复并在此存档。放行条件 1–8 全部兑现（逐条核对见 §13.7）。

### IF-1 · `LogScope` 是封闭联合，`'history'` 不在其中

§4.3.4 步 5 与 §5.1 都写了 `getLogger().warn('history', 'history_append_failed', …)`，但
`logging/logger.ts:35` 的 `LogScope` 是八个字面量的封闭联合，`'history'` 直接编译不过；而
§7.2 的修改清单里没有 `logging/logger.ts`。

**处置**：给 `LogScope` 增加 `'history'` 成员（纯类型加宽，唯一的两个消费者
`logging/install.ts:45/87` 只把它当字段类型用），并注明理由——提示词历史既不是 `config`
也不是 `log`，一个按 `scope` 过滤日志的人不该在 `config` 里翻到历史文件的写失败。这不违反
§2.2「不改日志子系统的行为、格式与轮转策略」：行为、格式、轮转全部未动。

替代方案「复用 `'config'`」被否：它会把两类记录混在一起，恰好与本方案「配置与状态是两件
事」的立论相反。

### IF-2 · `config_loaded` 会在 `aragon logs *` 里也发一条

§4.7 要求 `loadConfig()` 返回前发 `config_loaded`。但 `logging/cli-commands.ts:53` 的
`resolveLogsDir()` 自己调 `loadConfig(flags)`，于是 `aragon logs clear --yes` 也会先写一条
info 记录——而该文件头部整段注释说的正是「这一组命令豁免记录 info，否则 Windows 上
`logs clear` 删不掉自己刚创建的文件」。

**复核结论：不构成缺陷，无需改动。** `runClear()` 在删除前先调 `getLogger().closeSink()`
（`cli-commands.ts:226`），句柄已经关闭，删除照常成功；最坏后果是当天日志文件被创建后立刻
删除、`Deleted N log file(s)` 里的 N 多算一个。记录在此，是因为下一个给 `logs` 组加功能
的人如果去掉了那句 `closeSink()`，失效路径会从「历史无关的地方」冒出来。

### IF-3 · 压实的合并方向按「以磁盘为准」实现，而非「内存追加到末尾」

§4.3.5 步 2 的字面写法是「把本进程内存数组里的条目按同一套去重规则合并进去」。照字面实现
要把 `memory` 拼在重读结果**之后**，那会让本进程的条目在「保留最后一次出现」下一律排到最
新端，把另一实例更晚写入的条目挤到前面——顺序失真，且丢掉磁盘条目原本的 `ts`。

**处置**：改为「重读结果为主序，只补进磁盘上缺失的内存条目（`ts` 取当下）」，并把
**重读失败时整体跳过压实**（而不是拿内存数组覆盖）写成硬规则。语义与 §4.3.5 的目的完全
一致（「防止读盘瞬间失败时丢掉本会话的召回能力」），且严格更强：RV-3 想避免的
「用进程内存覆盖文件」在读失败路径上也不可能发生了。`prompt-history.test.ts` 的
「does not swallow entries another instance appended」守这条。

### IF-4 · `mouse-routing.test.tsx` 的改点是**五**处，不是四处

§7.2 / RV-4 列了四处（`readConfigFile` mock + fixture + 538/552/574 三条断言）。实际还有
第五处：该文件 `CONFIG` fixture 里的 `promptHistory: HISTORY` 是「wheel 在 composer 带上
召回历史」用例（第 469 行 `toContain('newest prompt')`）的唯一数据来源，字段删掉后该用例
硬失败。

**处置**：新增 `vi.mock('../config/prompt-history.js')` 返回同一个 `HISTORY` 常量。同理
`app.test.tsx` 也必须 mock `prompt-history.js` **与** `ui-state.js`（§7.2 只提了后者的一半
理由），否则每次提交都会在 vitest 临时根下产生真实文件 I/O。`app.test.tsx` 还需要一条
`beforeEach` 复位 mock 的模块级数组——它跨用例共享，一个用例的提交会变成下一个用例的召回。

### IF-5 · `clearPromptHistory()` 的返回值口径

§5.1 只说「返回被清除的条目数」。文件里允许重复 `text`（I-2），所以「条目数」有两个口径：
磁盘物理条目数，还是去重后的召回条数。**实现取物理条目数**——用户看到的
`Removed N entries.` 应该等于真正被删掉的东西，而不是删除前 `↑` 能走到几个。

### IF-6 · 并发的 `team-subagents` 开发占用了同一批文件（交付纪律，非方案缺陷）

Review 节点实施期间，另一条执行线正在把 `team-subagents` 特性写进本方案要改的同几个文件
（`config/schema.ts`、`config/store.ts`、`config/load.ts`、`config/cli-commands.ts`、
`cli.tsx`），并新增了 `packages/cli/src/team/`。其 `src/team/report.ts:202` 当时尚未编译通过
（TS2322），使整树 `tsc` 无法作为本特性的验收信号。

**处置**：本特性的提交按文件逐个精确构造暂存内容（`HEAD` 版本 + 本特性改动），
`team-subagents` 的在途改动一行未纳入，其工作区文件一字未动。验收信号取
`packages/cli` 的 vitest 全量结果：825 例中仅 `tools.test.ts` 的 2 例失败，二者断言的是
`HOST_TOOL_NAMES` 多出一个 `task` 工具，属对方在途改动，与本特性无关。

### §13.7 放行条件核对

| # | 条件 | 落点 |
|---|---|---|
| 1 | `recordPrompt` 保留 `setPromptHistory` | `App.tsx::recordPrompt` 写作 `setPromptHistory(appendPrompt(text))`；单测用例 12 = `prompt-history.test.ts::returns the updated list…`；手工第 2 节 |
| 2 | 两个 store 写路径先 `mkdirSync` | `prompt-history.ts::appendLine` / `ui-state.ts::writeToDisk`；两份对称用例 `creates <home> when it does not exist yet` |
| 3 | 压实前重新读盘 | `prompt-history.ts::compact` 首行；用例 `does not swallow entries another instance appended`（见 IF-3） |
| 4 | `mouse-routing.test.tsx` 四个改点 | 三条断言改为观测 `store.noticeSeenWrites`（mock 的 `setMouseNoticeSeen` 调用记录），两条负向断言因此重新守住真实链路；另见 IF-4 的第五处 |
| 5 | 迁移尊重 `historyEnabled === false` | `migrate-state-out-of-config.ts::importHistory`；用例 `drops the key without importing it when historyEnabled is false` |
| 6 | POSIX rename 后补 `chmodSync(0o600)` | `prompt-history.ts::compact` / `ui-state.ts::writeToDisk`；用例 `re-applies 0600 after the rename` |
| 7 | §10 第 3 步与第 6 步同一次发布 | 同一个提交 |
| 8 | 不为 `config set historyEnabled` 新增用例 | 未新增；`config.test.ts:292-322` 的源码文本护栏自动扫到新键，实测为绿 |

