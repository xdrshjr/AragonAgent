# AragonAgent CLI · 用户主目录配置与日志系统（aragon-home-config-and-logging）— 设计方案

- **Feature slug**：`aragon-home-config-and-logging`
- **Version**：**v2**（design review 后修订；v1 = solution architect 首版。评审记录见 §0，评审结论见 §12）
- **Status**：**有条件通过**（conditions listed in §12）
- **实施范围**：**仅** `aragon-agent-core/packages/cli/`（TUI 包）+ 两份 README / CHANGELOG
- **不涉及**：`@aragon-agent/core` 引擎包（一行不改，见 §2.3 C1）、宿主 `server/` `src/` `desktop/` `homepage-web/` `android/`、任何 DB / WS / REST 协议
- **新增运行时依赖**：**0 个**（只用 `node:fs` / `node:os` / `node:path` / `node:crypto`）

### 阅读导航

| 想知道什么 | 去哪一节 |
|---|---|
| **评审发现了什么、怎么改的** | **§0 评审记录** |
| 要建什么、为什么 | §1 概述 |
| 做 / 不做的边界 | §2 目标与非目标（含 7 条硬约束） |
| 现在代码长什么样 | §3 现状核对（含精确文件行号） |
| 路径怎么解析、测试怎么隔离、迁移链怎么走 | §4.1 / §4.2 |
| config.json 变成什么形状 | §4.3 + §6.1 |
| 日志系统怎么设计 | §4.4（分级 / 记录 / 脱敏 / 落盘 / 进程钩子所有权 / 自身故障） |
| **进程级钩子谁负责退出** | **§4.4.5**（P0-1 / P0-2 的落点） |
| **密钥怎么保证不进日志** | **§4.4.3**（SecretRegistry，P0-3 的落点） |
| TUI 配置怎么自动写进文件 | §4.5 |
| CLI / env / 内部函数签名 | §5 接口设计 |
| 数据模型 | §6 |
| 改哪些文件 | §7 文件 / 模块改动计划表 |
| 怎么算做完了 | §8 测试与验收标准 |
| 哪里会炸 | §9 风险与缓解 |
| 从哪一行开始写、哪两步不能拆开发布 | §10 实施顺序 |
| 未决问题 | §11（v2 已全部拍板） |
| 评审结论与放行条件 | §12 |

---

## 0. 评审记录（Review Notes）

评审方式：逐节对照**真实源码**而非对源码的描述，`packages/cli/src` 与 `packages/core/src` 全部相关文件实读；行号在评审时逐条核对。

**v1 做对了的部分，而且是大部分。** 几乎所有承重判断都成立：`env-paths` 在 win32 下确实把 config 与 data 分到 `%APPDATA%` / `%LOCALAPPDATA%` 两棵树（跨卷 rename 会 `EXDEV`，所以 rename→cpSync 降级是必要的）；`store.ts:115-131` 那段告警注释确实白纸黑字写着嵌套合并的纪律；`ui/console-bridge.ts` 的 I-4 不变量确实禁止日志器走 `console.*`；`migrate-legacy-state.ts` 的「永不抛 / 逐产物不覆盖 / 面包屑不是幂等键」三条纪律确实是现成的范本，而 v1 正确地继承了它们；把迁移顺序定为「品牌迁移 → home 迁移」也确实是对的（理由在 §4.2 修正后仍然成立）；`no-host-coupling.test.ts` 确实机械禁止 core 引入 `node:*`，因此日志系统整体活在 CLI 包内是唯一可行的形状；`controller.subscribe()`（`agent/controller.ts:250`）确实返回退订函数，事件侧不需要 core 改一行。

评审发现 **4 个 P0、10 个 P1、15 个 P2**。P0 集中在一处：**v1 详尽设计了「日志怎么写」，但没有设计「谁拥有进程级钩子与密钥集合」**——而这两件事在 Node 里都是「注册即改变默认语义」的，一旦漏掉，症状不是日志缺失，而是 CLI 挂死、终端回不来、或者密钥照样进文件。P0-4 是一条纯工程安全问题：新布局让一个既有测试的 `rmSync` 从「删配置目录」变成「删整个用户根」。

### P0

| # | 位置 | 维度 | v1 的问题 | v2 的处置 |
|---|---|---|---|---|
| **P0-1** | §4.4.5 ③ | 可行性 / 完整性 | 「挂 `process.on('uncaughtException')` → error 记录 + flushSync + **原有 stderr 行为**」。但 `cli.tsx:595-598` 是 `main().catch()`——一个 promise 链的 catch，**不是**进程级处理器。注册 `uncaughtException` 监听器会**取代 Node 默认的「打栈 + 退出」**，进程带着已损坏的状态继续跑；全屏模式下 alternate screen 永不恢复，Ink 还在往一个死掉的 controller 上渲染，用户只能 `reset`。`unhandledRejection` 同理（Node 18 默认 `throw` → 退出，加监听器即压制）。 | §4.4.5 新增「进程钩子所有权」小节，把两个处理器的**函数体逐句写死**：记录 → `flushSync()` → 写 stderr → **`process.exit(1)`**，且退出前必须先调用已注册的 `screenRestore` 钩子。§8.1 用例 11 是机械护栏。 |
| **P0-2** | §4.4.4 / §4.4.5 | 可行性 | 「在 `SIGINT/SIGTERM/SIGHUP` 的既有处理器（`cli.tsx:226-231`）中补 `flushSync()`」——但那三个处理器**只存在于 `runInteractive()` 的 `mode === 'fullscreen'` 分支**。inline 模式、`-p` headless、以及全部子命令**根本没有信号处理器**，Ctrl+C 时 Node 走默认终止，`'exit'` 回调不执行，整个队列丢失。若 `installLogging()` 自己补注册，它在 ③ 注册，**早于** `runInteractive`，而 EventEmitter 按注册顺序触发；同时「只要存在 SIGINT 监听器，Node 就不再默认终止」，所以它**必须**自己 `process.exit`——于是它抢在 `restore()` 之前退出，alternate screen 永不恢复。这正是 I-4。 | §4.4.5 引入**单一所有者**模型：`installLogging()` 只注册 **flush-only** 监听器（不退出），并导出 `setSignalTerminator(fn)`；默认 terminator 是裸 `process.exit(128+signo)`（覆盖 headless / inline / 子命令），`runInteractive` 全屏分支把它换成 `restore(); process.exit(128+signo)`。`cli.tsx:226-231` 的既有循环随之改为只设置 terminator，不再各自注册。§8.1 用例 12。 |
| **P0-3** | §4.4.3 | 完整性 / 安全 | 真正的护栏是「`config.apiKeys` 里当前实际持有的每个非空 key 的字面量」，但 `installLogging()` 在 ③ 运行，**早于** `loadConfig()`（④）、早于 commander 解析 `--api-key`；而用户在 settings 界面里**新填**的 key（`controller.setApiKey` + `patch.apiKeys`）永远进不了这个启动期快照。也就是说：**key 进入进程最常见的那条路径**——也正是 AC-5 逐字描述的场景——不在 `literals` 里。它只是恰好被格式正则兜住了；而 `literals` 这条规则存在的理由恰恰是**兜住不匹配任何正则的自定义端点 key**，那种 key 在这条路径上会原样落盘。 | 新增 `logging/secret-registry.ts`：一个**活的可变集合** `registerSecret(v)` / `getSecrets()`。§4.4.3 穷举列出全部注册点（5 处），并规定 `redactRecord` 每次都从 registry 现取。§8.1 用例 4b 专测「installLogging 之后才注册的 key 也必须被脱敏」。 |
| **P0-4** | §4.1 / R-6 / §7.2 | 可行性 / 完整性 | 新布局下 `getConfigDir()` 会返回 **home 根**，而它在全仓**唯一的非定义 caller** 是 `__tests__/config.test.ts:32` 的 `rmSync(getConfigDir(), { recursive: true, force: true })`——那一行就此变成「递归删除整个用户根（config + sessions + skills + logs）」。同文件 `clearEnv()`（`config.test.ts:24-28`）又会在**每个 `beforeEach`** 里删掉所有 `ARAGON_*` 变量，**包括 R-6 打算用来做隔离的 `ARAGON_HOME`**。两件事叠在一起，一次顺序写错的编辑就能把 `npm test` 变成开发者本机的 `rm -rf ~/.aragon-agent`：API key、全部会话、全部已装 skills。 | §4.1 新增「测试隔离契约」四条硬性要求：①删除 `getConfigDir()`（唯一 caller 是测试）；②`clearEnv()` 显式豁免 `ARAGON_HOME` 并注释原因；③测试只删单个文件或自己在 `TMP` 下拼出来的路径，**禁止**递归删已解析的根；④`resolveHomeRoot()` 在 `process.env.VITEST` 为真且 `ARAGON_HOME` 未设时**重定向到 `os.tmpdir()` 下的临时根**，绝不返回真实 home。§8.1 用例 1c。 |

### P1

| # | 位置 | 维度 | v1 的问题 | v2 的处置 |
|---|---|---|---|---|
| **P1-1** | §4.4.5 ③ / §5.2 | 一致性 / 完整性 | 日志级别被**解析两次且永不收敛**：③ 自己扫 argv + 读 config.json + 读 `process.env`；④ `loadConfig()` 又独立解析一遍 `log` 层（defaults › file › env › flags），而没有任何一步把 ④ 的结果推回日志器。更糟的是 `loadDotenv(cwd)` 在 `loadConfig()` **内部**（`load.ts:108`），所以 `.env` 里写的 `ARAGON_LOG_LEVEL` / `_DIR` / `_FILE` 在 ③ 完全不可见；`ARAGON_HOME` 同理（模块加载期求值，比 dotenv 早得多），**永远不能**从 `.env` 提供，而 §5.2 只写了「最高优先级」没说这一条。 | §4.4.5 明确区分 **bootstrap 级**（③，只看 `process.env` + config 文件 + argv 手工扫描）与**权威级**（④，`loadConfig()`），并规定唯一收口点：`makeController()` 与不构造 controller 的子命令路径**各自**在 `loadConfig()` 之后调 `getLogger().reconfigure(config.log)`。§5.2 表格加一列「可否来自 `.env`」并逐项标注。 |
| **P1-2** | §5.1 | 一致性 | `--no-log-file` 复刻了本仓已经踩过两次并留了注释的三态陷阱（`cli.tsx:461-472`：`--compact/--no-compact`、`--fullscreen/--no-fullscreen`）。只声明负向形式会让 commander 把默认值定成 `true`，「没有意见」被折叠成「显式为真」，于是 config.json 里的 `log.toFile: false` 永远不可能生效。 | §5.1 改为先声明正向 `--log-file` 再声明 `--no-log-file`；`CliFlags.logFile?: boolean` 保持三态；新增 `resolveLogToFile(flags, env, file)`，形状逐字对齐 `resolveFullscreen()`（`load.ts:78-87`）。§8.1 用例 13。 |
| **P1-3** | §4.4.5 | 可行性 | bootstrap 扫描要找 `--verbose` / `-vv`，但 §5.1 只声明了 `--verbose`，而 `-v` 早被 `.version(VERSION, '-v, --version')`（`cli.tsx:447`）占掉。用户敲 `aragon -vv`，commander 在 ④ 之前就以 unknown option 报错退出——一个被内部文档承认、却必然失败的 flag。 | 删掉 `-vv`，只保留 `--verbose`，并在 §5.1 注明「`-v` 已是 `--version`」。 |
| **P1-4** | §2.3 C3 vs §4.4.4 | 可行性 / 完整性 | 写通道自相矛盾且兑现不了 G3。C3 说「日志器直接持有 fd」，§4.4.4 却用 `fs.createWriteStream`。三个后果：①WriteStream 的内部缓冲在 `process.exit()` 时**直接丢弃**，而 `flushSync()` 只排空日志器自己的数组，已交给流但未落盘的记录恰好是崩溃前的最后几条；②`appendFileSync`（退出路径）与流（稳态）是**同一文件上的两个写者**，彼此顺序未定义；③流的写失败以异步 `'error'` 事件到达，**没有 `'error'` 监听器时 Node 会抛**→ 未捕获异常 →（叠加 P0-1 的处理器）挂死，AC-9 按原样必然失败。另外 Windows 上持有句柄时 `renameSync` 会 `EPERM`，v1 没写轮转的开关顺序。 | §4.4.4 收敛为**单一同步通道**：`openSync(file, 'a', 0o600)` + 批量 `writeSync(fd, batch)`。所有错误变成同步 `try/catch`，`flushSync()` 与稳态 flush 走同一段代码，C3 的说法也终于成真。轮转序列写死为 `flush → closeSync → renameSync → openSync`。`mkdirSync(logsDir, { recursive: true, mode: 0o700 })`（debug 级文件含提示词正文）。 |
| **P1-5** | §4.4.4 | 完整性 | 保留策略写在「按体积」小节里（「轮转后按 mtime 升序删到只剩 `maxFiles`」）。一个从不触发 `maxFileBytes` 的用户会每天多一个文件、永不回收，而配置项写着 `maxFiles: 10`。一年后目录里 365 个文件，跨天路径从来不剪枝。 | 保留提升为**独立步骤** `enforceRetention(dir, maxFiles)`，在**跨天换文件、体积轮转、以及本进程第一次写**三个时机各跑一次，独立单测。 |
| **P1-6** | §5.1 / AC-8 | 可行性（Windows） | §4.4.5 ④ 说「各子命令记一条 info」，于是 `aragon logs clear --yes` 执行时 sink 已经握着当天文件的句柄。Node 打开文件不带 `FILE_SHARE_DELETE`，`unlinkSync` 删自己进程打开的文件在 **Windows（本需求的首要平台）** 上会 `EBUSY` / `EPERM`。AC-8 的「分别正确」按原样过不了。 | §5.1 规定 `logs` 子命令组**整体豁免** ④ 的 info 记录（理由：它们是日志的运维入口，不该给自己制造被观测的副作用），且 `clear` 仍在删除前显式 `sink.close()`，逐文件失败**上报而不抛**。AC-8 增补该断言。 |
| **P1-7** | §4.3 / G2 / §5.1 | 完整性 | `readConfigFile()`（`store.ts:47-61`）在 JSON 解析失败时返回 `null`，这是有意的（「绝不因坏配置崩掉 CLI」）。但本方案把「手改配置」升为一等公民（G2 承诺「手改后重启即生效」，还新增 `aragon config edit`），于是**一个多余的逗号会静默把每一项设置回落默认**——模型、主题、超时、skills、以及用户视角里的 API key——而任何地方都不会说为什么。今天这条路径罕见，这个特性会让它变成日常。 | 三处一起补：①`readConfigFile()` 增加带外信号（`{ config, parseError }`），解析失败记 `error`/`config` 日志并输出一行 stderr / 一次 warn toast；②`config edit` 在 spawn 编辑器**之前**写 `config.json.bak`，编辑器退出后重新 `JSON.parse`，失败则明确告知文件非法**且备份仍在**；③AC-13 覆盖。 |
| **P1-8** | §7.1 / §7.2 / C5 | 一致性 / 右尺寸 | `cli.tsx` 今天 598 行，§7.2 往里塞：4 个 flag、5 个 `logs` 子命令、4 个 `config` 子命令、7 个 `CONFIG_SET_KEYS` 条目 + 7 个 switch case、②③ 接线、信号改造。而 `runConfigSet` 已经有 21 个 case（圈复杂度早已远超本包 CLAUDE.md 写死的 10）。§7.1 给了 `logs` 一个实现模块，却**没有给 `config get/list/edit/home` 任何归属文件**。跨方案还有两个在飞：`plan-mode`（v2，同包，`§1440-1443` 要给 `PersistedConfig`/`CliConfig`/`CONFIG_SET_KEYS` 各加三个键 + `--plan/--no-plan`）与 `allow-insecure-tls-without-warning`（v2，用回归测试**冻结 `cli.tsx` 的 import 顺序**）。 | 新增 `src/config/cli-commands.ts` 承接 `runConfigGet/List/Edit/Home` 与 `runConfigSet` 的 `log.*` 分支（`applyLogConfigSet(key, value)`），`cli.tsx` 只留接线。§2.3 新增 **C6**（import 顺序契约，TLS 方案的 ordering 测试计入本方案绿线）与 **C7**（`cli.tsx` 改完须 ≤900 行，为 plan-mode 预留余量）。§7.4 新增跨方案冲突面。 |
| **P1-9** | §4.4.5 事件映射表 | 可行性 / 完整性 | `AgentEvent` 联合有 **9 个成员**（`core/src/types.ts:74-83`），表里只映射 6 个。漏掉的 `turn_start` 恰好是 `turn_end.ms` 的**唯一来源**——`TurnEndEvent` 只带 `{message, usage}`，**没有 duration**（`types.ts:33-37`），所以 §4.4.2 样例里的 `"ms":4210` 与表里的 `{in,out,ms}` 在 v1 的设计下**不可导出**。`code_execution_start/end` 也未映射，而后者恰好带 `duration` 与 `error`。另外 `AgentStartEvent` **没有任何字段**（`types.ts:20-22`），`{provider, model, thinking}` 只能从 `controller.getConfig()` 取；`TokenUsage` 的键是 `inputTokens`/`outputTokens`（`llm/types.ts:84-90`）不是 `in`/`out`。§8.1 用例 7 本来就写着「喂 9 种」。 | 表补齐到 9 行，新增 turn 计时器（`turn_start` 记时间戳，`turn_end` 相减），并逐项写清字段来源与改名映射。 |
| **P1-10** | §10 | 完整性（发布） | 步骤 1 单独落地时「行为等价于换了个目录，尚无迁移」。任何在这个状态下**发布**出去的产物会让每一个既有用户的配置 / 会话 / skills 全部失联。本仓有活的发布管线（`publish-latest.ps1`、`scripts/release-preflight.mjs`），这不是理论风险。 | §10 明确 **P1 + P2 是一个发布单元**：两者之间不得 `npm publish`、不得 bump 版本号；`release-preflight` 不得在「`app-paths.ts` 已是 home 解析器但 `migrate-home.ts` 缺席」的树上运行。§9 新增 R-14。 |

### P2（已在正文修订或明确记录）

| # | 位置 | v1 的问题 | v2 的处置 |
|---|---|---|---|
| P2-1 | §3 | 「白名单 18 键」——实测 `CONFIG_SET_KEYS` 是 **21 键**（14 个平铺 + 7 个 `skills.*`）。 | 更正为 21。 |
| P2-2 | §3 | 「只对 `apiKeys` 与 `skills` 做深合并」——`loadPersistedConfig` 还对 `recentModels` / `promptHistory` 做了缺省归一（`store.ts:107-108`）。 | 表述改精确。 |
| P2-3 | §4.5 #3 | 误引 `store.ts:127-130`：那段说的是 `SkillsConfig` 被**封顶在一层嵌套**，**第三层**（`skills.a.b`）才需要换真正的 deep-merge。`log` 是第三个嵌套**段**，仍在同一层，手写合并完全够用。v1 的结论（各加一行）是对的，但按它给的理由，实施者会跑去造一个 deep-merge 工具。 | 重述理由，并把「为什么手写合并仍然够用」写清楚。 |
| P2-4 | §2.1 G4 | 把「主题、密度、skills 开关」列为 TUI 可写：`theme` 只走 `/theme` 斜杠命令，`density` / `hints` **在 TUI 里根本没有入口**（只有 flag + `config set`）。 | G4 收窄为「TUI 里**存在入口**的每一项配置」，并逐项列明入口。 |
| P2-5 | §7.2 | `store.ts:35` 的 `getSkillsDir()` 全仓零非测试 caller，活的是 `skills/paths.ts::getUserSkillsDir()`。 | 改为**删除**而不是改指向——两个名字指同一个目录，正是 `app-paths.ts` 文件头警告的那种漂移形状。 |
| P2-6 | §4.4.4 | 队列越界丢**最老**的。洪水场景里最老那几条恰好是解释事发原因的那几条。 | 改为丢**最新**并保留头部窗口；`records_dropped` 计数不变。 |
| P2-7 | §4.4.4 | 文件名用本地日期，`ts` 用 `toISOString()`（UTC）。UTC-5 用户傍晚的记录会落在本地前一天的文件里、带次日的时间戳。 | `ts` 改为带本地偏移的 ISO 8601（`2026-07-27T04:11:02.913+08:00`），与文件名同一时钟。 |
| P2-8 | §4.4.2 | `ts/lv/sid/msg/data` 是缩写，而 `data` 正是本包 CLAUDE.md §三 点名禁止的名字。 | 保留（wire format 的体积取舍是正当的），但在 §4.4.2 与模块 docstring 里**显式声明这是有意的例外**，免得下一个人来「修正」它。 |
| P2-9 | §4.1 | `isHomeOverridden()` 若实时读 `process.env` 会被 `config.test.ts:24-28` 的 `clearEnv()` 打成 false。 | 规定在模块加载期捕获，与 `homeRoot` 同一次求值。 |
| P2-10 | §4.1 | 「（doctor / logs path 展示用）」——本 CLI 没有 `aragon doctor`（只有 `aragon skills doctor`）。 | 改为 `aragon config home` / `aragon logs path`。 |
| P2-11 | §7.2 | 把 `getLogger().flushSync()` 塞进 `agent/headless.ts`——那是一个刻意保持可注入的模块（`HeadlessController` + `options.stdout/stderr`），且有一条提前 `return 2`。 | 改放 `runOneShot()`（`cli.tsx`）里 `await runHeadless(...)` 之后；`process.on('exit')` 才是真正的兜底。 |
| P2-12 | §4.2 R-1 | R-1 的机制描述略偏：逐产物幂等下，顺序写反在**下一次启动**会部分自愈（sessions / skills 仍会搬），但 `config.json` 不会——用户已重输 key、新文件已存在，旧配置就此孤立。 | 保留顺序结论，修正机制叙述。 |
| P2-13 | §4.2 | ② 会把 `%APPDATA%\aragon-agent-nodejs\Config` / `%LOCALAPPDATA%\...\Data` 两棵空树永久留在磁盘上（且有意保留旧 `config.json`）。 | 这是为可回退付的正确代价；补写明说，并规定 `aragon config home` 在面包屑存在时**打印旧位置**，保留一个 release。 |
| P2-14 | §11 Q2 / §5.1 | `logs open`（spawn explorer/open/xdg-open）与 `logs tail --follow` 是本方案里「平台特定风险 / 收益」最差的两项，而 Q2 还挂着未决。 | Q2 当场拍板：`watchFile` 轮询。`logs open` 保留，但规定失败即降级为「打印路径」，不引入任何新依赖。 |
| P2-15 | 文档位置 | 本文放在宿主仓 `docs/plans/`，而同一子项目的两个在飞设计（`plan-mode`、`allow-insecure-tls-without-warning`）都在 `aragon-agent-core/docs/plans/`。 | 记录为放行条件 C-4（§12）：落地时把本目录移到 `aragon-agent-core/docs/plans/`，三份设计放一起。评审阶段不动文件位置（本次评审只允许改 `spec.md`）。 |

**P0 / P1 状态：全部已在下方正文修订，无遗留。**

---

## 1. 概述（Overview）

`@aragon-agent/cli` 目前把用户态数据交给 `env-paths` 解析。在 Windows 上这意味着配置文件落在 `%APPDATA%\aragon-agent-nodejs\Config\config.json`，会话与已装 skills 落在 `%LOCALAPPDATA%\aragon-agent-nodejs\Data\`。这两个位置**在功能上正确、在产品上失败**：用户 `npm i -g @aragon-agent/cli` 之后想改一下默认模型、想看一眼刚才那次调用为什么报错，第一反应是去自己的用户主目录找一个点开头的文件夹（Claude Code 的 `~/.claude`、npm 的 `~/.npmrc`、git 的 `~/.gitconfig` 都在那里），而不是去 `%APPDATA%` 里翻一个带 `-nodejs` 后缀的目录。更糟的是，**这个 CLI 今天没有日志系统**：`console.*` 在全屏模式下被 `ui/console-bridge.ts` 劫持成 transcript 里的 notice，进程一退就没了；顶层 promise 拒绝由 `cli.tsx:595-598` 打到 stderr，而全屏模式刚从 alternate screen 出来，用户通常什么都没看见。出了问题没有任何可以事后翻阅的现场。

本方案把两件事一次做完，并向 Claude Code 的产品形态对齐：**（一）** 把用户态根目录从 `env-paths` 迁到 `~/.aragon-agent/`（Windows 上即 `C:\Users\<用户名>\.aragon-agent\`），配置文件仍叫 `config.json`，会话、skills、usage 计数一并搬进来，并提供一条**永不抛异常、幂等、可回退**的一次性迁移；**（二）** 新建一个只依赖 Node 内置模块的结构化日志子系统，默认把 JSONL 日志写到 `~/.aragon-agent/logs/aragon-<YYYY-MM-DD>.log`，覆盖 CLI 生命周期、配置读写、模型调用、工具执行、skills 装载与所有未捕获异常，带分级、按天 + 按体积轮转、按数量保留，以及一条**不可绕过的密钥脱敏管线**。

配置与 TUI 的一致性是需求里被点名的一条：「如果在 TUI 中配置了，在这里就要自动写入」。这条今天**部分已经成立**（`ui/App.tsx:390-417` 的 settings 保存与模型选择都调 `persistConfig` → `updatePersistedConfig`），本方案要做的是把它**补全并变成可验证的不变量**：所有配置写入路径收敛到唯一的读-改-写函数、新增 `log` 段的深合并（漏掉就会静默吃掉用户的 skills 配置，见 §9 R-3）、给 `aragon config get/list/edit` 补上读取侧入口、让坏 JSON 不再静默回落全默认（§9 R-15），并让每一次写入都在日志里留下一条 `config_write` 记录，使「我在 TUI 里改了但文件没变」这类问题从猜测变成查证。

**v2 相对 v1 的实质变化**（细节见 §0）：进程级钩子（`uncaughtException` / `unhandledRejection` / 三个信号）获得了明确的**所有权与退出契约**；密钥脱敏的兜底从**启动期快照**升级为**活的注册表**；日志写通道从 `createWriteStream` 收敛为**单一同步 fd**；测试隔离获得**四条硬性要求**（否则 `npm test` 可能删掉开发者自己的 `~/.aragon-agent`）；事件映射表补齐到 9 种并解决了 `turn_end.ms` 无处可取的问题；日志级别的两次解析获得了**唯一收口点**。

---

## 2. 目标与非目标

### 2.1 目标（Goals）

- **G1**：用户态根目录 = `~/.aragon-agent/`，全平台统一，可用 `ARAGON_HOME` 覆盖。Windows 下必须精确落在 `C:\Users\<用户名>\.aragon-agent\`。
- **G2**：`~/.aragon-agent/config.json` 是唯一持久化配置文件，形状对人类友好（2 空格缩进、稳定键序、`version` 字段），手改后重启即生效；**手改成非法 JSON 时用户会被明确告知，而不是静默回落全默认**（v2 新增，见 §9 R-15）。
- **G3**：`~/.aragon-agent/logs/` 下按天产出 JSONL 日志，默认 `info` 级；**未捕获异常与信号终止都必须先落盘再退出**（v2 收紧，见 §4.4.5）。
- **G4**：**TUI 里存在入口的每一项配置**在保存的同一次事件循环内写入 `config.json`。逐项入口：settings 覆盖层（provider / model / baseUrl / thinking / maxTokens / API key / **log level**）、`/theme`、`/thinking`、`/skills *`、模型选择器（provider + model）。`density` / `hints` 今天没有 TUI 入口，仍只由 flag 与 `aragon config set` 提供，本方案不改这一点（P2-4）。
- **G5**：从 0.5.0 及更早版本升级的用户，配置 / 会话 / skills **零丢失**地迁移到新根目录。
- **G6**：日志中**永不出现**任何 API key（含 `apiKeys` 段、env 值、请求头、错误消息里回显的 key，**以及会话中途新输入的 key**——v2 收紧，见 §4.4.3）。
- **G7**：新增 `aragon logs` 与 `aragon config get/list/edit/home` 两组命令，让排障与配置检查不必手动 `cd` 到目录。

### 2.2 非目标（Non-goals）

- **NG1**：不做日志上传、遥测、崩溃上报。日志**永远只在本机**，无任何网络出口。
- **NG2**：不引入 `pino` / `winston` / `bunyan`。见 §9 R-7：这是一个 `npm i -g` 的 CLI，安装体积与依赖审计面是产品属性。
- **NG3**：不做 per-project 配置（`.aragon/config.json`）。当前 `.env` + `ARAGON_*` env + flags 三层已覆盖项目级需求，再加一层要重排整个优先级链，属独立迭代。
- **NG4**：不改 `@aragon-agent/core` 引擎包。
- **NG5**：不做日志查询 UI / TUI 内日志面板。`aragon logs tail` 够用。
- **NG6**：不迁移 `env-paths` 的 `cache` / `temp` / `log` 三个根（今天没有任何代码读它们，迁一个没人读的目录是把 bug 搬家而不是修 bug —— 这条纪律沿用 `migrate-legacy-state.ts:93-99` 的既有注释）。
- **NG7**（v2 新增）：不做日志文件的加密或完整性签名。`redactSecrets` 是脱敏而非加密；`log.dir` 指向哪里、谁能读那个目录，是操作系统的权限问题（§9 R-13）。

### 2.3 硬约束（改之前必须知道）

- **C1 · core 包禁止 `node:*` 导入**。`packages/core/src/__tests__/no-host-coupling.test.ts:119-130` 会机械扫描 `src/` 下所有 `.ts`，只放行 `llm/providers/google.ts` 的 `node:crypto`。**日志系统必须整体活在 CLI 包内**；引擎侧的可观测性通过既有的 `AgentEvent` 订阅（`controller.subscribe()` → `agent.subscribe()`，`agent/controller.ts:250`）获得，不需要 core 改一行。
- **C2 · 全屏模式下禁止直写 stdout / stderr**。`ui/console-bridge.ts` 头部注释与 `cli.tsx:243-246` 记录了不变量 I-4：固定帧下任何直写会让 `eraseLines(previousLineCount)` 永久错位，帧会「往上吃」内容。**日志器绝不能用 `console.*`，也不能在 TUI 挂载期间写 stderr**（§4.4.6）。
- **C3 · 日志器直接持有 fd，绝不经过 `console.*` 也不用流**。console 在全屏模式下已被 bridge 劫持成 transcript sink；日志器若走 console，就会 console → bridge → notice → （若 notice 也记日志）→ console 的自喂循环。**v2 收紧**：也不用 `createWriteStream`——见 §4.4.4 与 P1-4，流的内部缓冲在 `process.exit()` 时会丢，且其异步 `'error'` 事件在无监听器时会抛。唯一写通道是 `openSync` + `writeSync`。
- **C4 · 迁移函数永不抛异常**。沿用 `migrate-legacy-state.ts:17-21` 的既定纪律：「一个要重输 API key 的用户是被打扰，一个 CLI 起不来的用户是被阻塞」。
- **C5 · 单文件 ≤ 1000 行、单函数 ≤ 60 行、参数 ≤ 5 个、圈复杂度 ≤ 10**（`aragon-agent-core/CLAUDE.md` Clean Code 阈值）。这是 §7 把日志子系统拆成 6 个文件、并把 `config` 子命令与 `log.*` 分支挪出 `cli.tsx` 的原因。
- **C6 · `cli.tsx` 的 import 顺序是被测试冻结的契约**（v2 新增）。在飞方案 `allow-insecure-tls-without-warning`（`aragon-agent-core/docs/plans/allow-insecure-tls-without-warning/spec.md` v2）要求一个 CommonJS preload 位于「Node 内置之后、全部第三方 / 本地值导入之前」，并用回归测试固化。本方案往 `cli.tsx` 新增的每一个 import **必须排在那个 preload 之后**；那条 ordering 测试计入本方案的绿线。`installLogging()` 是运行期调用而非 import，不受此约束，但它的模块 import 受。
- **C7 · `cli.tsx` 改完后 ≤ 900 行**（v2 新增）。今天 598 行；C5 的天花板是 1000，而同包在飞的 `plan-mode`（v2，approved-with-conditions）还要往同一个文件加 `--plan/--no-plan`、三个 `CONFIG_SET_KEYS` 条目与 switch case、以及 `humanInputBridge` 构造。留 100 行余量给它，是为了不让两个方案在同一个文件上互相逼着拆分。

---

## 3. 现状核对（Code as-is）

以下每一条都经过实读并在 v2 评审时逐条复核，实施时可直接定位。

| 事实 | 位置 |
|---|---|
| `APP_NAME = 'aragon-agent'`，`appPaths = envPaths(APP_NAME)`，单一来源 | `packages/cli/src/config/app-paths.ts:13-15` |
| env-paths v3 在 win32 下：`config = %APPDATA%\<name>-nodejs\Config`，`data = %LOCALAPPDATA%\<name>-nodejs\Data`（两棵**不同的**树，跨卷 rename 会 `EXDEV`） | `node_modules/env-paths/index.js`（默认 `suffix='nodejs'`） |
| `getConfigDir() = paths.config`；`getConfigPath() = join(paths.config,'config.json')`；`getSessionsDir() = join(paths.data,'sessions')`；`getSkillsDir() = join(paths.data,'skills')` | `config/store.ts:22-37` |
| **`getConfigDir()` 全仓只有一个非定义 caller，而它是 `rmSync(..., {recursive:true, force:true})`** | `__tests__/config.test.ts:32` ← **P0-4 的核心事实** |
| **`getSkillsDir()`（store.ts）零非定义 caller**；活的是 `skills/paths.ts::getUserSkillsDir()` | grep 全仓，仅命中定义处 |
| 原子写 + POSIX `0600`（win32 显式跳过 chmod） | `config/store.ts:77-94` |
| `loadPersistedConfig()` / `updatePersistedConfig()` 是唯一读-改-写路径；对 `apiKeys` 与 `skills` 做深合并，对 `recentModels` / `promptHistory` 做缺省归一；注释写死「`SkillsConfig` 封顶在**一层**嵌套，加**第三层**（`skills.a.b`）前必须先换成真正的 deep-merge」 | `config/store.ts:100-143`（尤其 115-131 的告警注释） |
| **坏 JSON 时 `readConfigFile()` 返回 `null`**，调用方静默用全默认（有意设计：绝不因坏配置崩掉 CLI） | `config/store.ts:57-60` ← **P1-7 的核心事实** |
| 配置分层：defaults › file › env/.env › flags；超时不变量在合并后重新推导 | `config/load.ts:104-243` |
| **`loadDotenv(cwd)` 在 `loadConfig()` 内部**，即每条命令各自解析时才发生 | `config/load.ts:107-108` ← **P1-1 的核心事实** |
| 三态解析的既有范本（flag › env › file，且 file 的默认真值不算显式意见） | `config/load.ts:78-87`（`resolveFullscreen`） |
| env 覆盖键：`ARAGON_PROVIDER/MODEL/BASE_URL/THINKING/MAX_TOKENS/THEME/FULLSCREEN/SKILLS/SKILLS_PATH/SKILLS_DISABLED` + 三家 provider 的 `*_API_KEY` | `config/env.ts:55-115` |
| 嵌套 env 段的组装范本（`partial.skills`） | `config/env.ts:91-97` |
| `PersistedConfig` 21 个字段，其中 `apiKeys`、`skills` 为嵌套对象 | `config/schema.ts:306-337` |
| `clampSkillsConfig` 是「读 + 写共用的唯一闸门」，注释说明只硬化读路径会留下每次启动静默回落的坏值 | `config/schema.ts:251-278` |
| `maskSecret()`（保留前 3 + 后 4，≤8 字符全遮） | `config/schema.ts:447-457` |
| TUI 保存设置 → `controller.setModel/setThinkingLevel/setMaxTokens/setApiKey` + `persistConfig(patch)`；**覆盖 provider/model/baseUrl/thinking/maxTokens/apiKey，不含 theme/density/hints** | `ui/App.tsx:390-410` |
| TUI 选模型 → `persistConfig({provider, model})` | `ui/App.tsx:412-417` |
| `/thinking`、`/theme` 亦走 `ctx.persistConfig` | `commands/builtins.ts:50, 73` |
| `persistConfig` 的 catch 是**静默吞异常**（"Best-effort"） | `ui/App.tsx:311-317` |
| `SettingsValues` 是平铺形状，`FieldKey = keyof SettingsValues`，`FIELDS` 是 6 项的 `FieldDef[]`（`enum`/`text`/`secret` 三种 kind） | `ui/overlays/SettingsScreen.tsx:20-57` |
| `aragon config set <key> <value>` 白名单 **21 键**（14 平铺 + 7 个 `skills.*` 点号键）；`runConfigSet` 是一个 21-case 的 switch | `cli.tsx:318-435` |
| 三态 flag 的既有注释（先声明正向形式才能保住 `undefined`） | `cli.tsx:461-472` |
| `-v` 已被 `--version` 占用 | `cli.tsx:447` |
| `aragon config path` 打印配置文件路径；`aragon config`（无子命令）直接打开 settings 覆盖层 | `cli.tsx:520-538` |
| **`SIGINT/SIGTERM/SIGHUP` 处理器只存在于 `runInteractive()` 的 `mode==='fullscreen'` 分支**；inline / headless / 全部子命令没有任何信号处理器 | `cli.tsx:212-232` ← **P0-2 的核心事实** |
| `main()` 第一条语句是 `migrateLegacyState()`（`argon-agent` → `aragon-agent`），通知写 **stderr** | `cli.tsx:583-593` |
| **`main().catch()` 是 promise 链的 catch，不是 `process.on('uncaughtException')`**；它只把栈打到 stderr 并置 `exitCode = 1` | `cli.tsx:595-598` ← **P0-1 的核心事实** |
| 迁移幂等键是「新**根目录**是否存在」，非面包屑文件；跨卷失败降级为 `cpSync` 并**保留**旧树；面包屑写失败静默吞（并解释了为什么它不能冒泡） | `config/migrate-legacy-state.ts:102-151, 179-212` |
| skills 的 `<data>` 根来自 `appPaths.data`；`skill-usage.json` 是 `<data>` 的直接子文件 | `skills/paths.ts:28-35`、`skills/usage.ts:37-42, 164` |
| 会话文件默认落 `getSessionsDir()` | `session/persist.ts:26-34` |
| **全仓没有任何 logger / 日志文件写入**；`grep -E "logger\|writeLog\|logFile"` 仅命中 `ui/App.tsx` 一处无关标识符 | — |
| `AgentEvent` 联合有 **9 个成员**；`TurnEndEvent` 只带 `{message, usage}`（**无 duration**）；`AgentStartEvent` **无字段**；`ToolExecutionEndEvent` / `CodeExecutionEndEvent` 各带 `duration` | `core/src/types.ts:20-83` ← **P1-9 的核心事实** |
| `TokenUsage` 的键是 `inputTokens` / `outputTokens`（+ 可选 cache/cost） | `core/src/llm/types.ts:84-90` |
| `runHeadless()` 是刻意可注入的模块（`HeadlessController` 接口 + `options.stdout/stderr`），且有一条提前 `return 2` | `agent/headless.ts:13-40, 101` |
| 现有测试通过**改 `APPDATA` / `LOCALAPPDATA` / `XDG_*` 后动态 `await import()`** 来重定向 env-paths；**并在每个 `beforeEach` 删掉所有 `ARAGON_*` 环境变量** | `__tests__/config.test.ts:10-33` ← **P0-4 的第二个核心事实** |
| Node 引擎下限 `>=18`；`files` 白名单只发 `dist` / `skills` / 两份 md | `packages/cli/package.json:33-41` |
| 同包在飞的另外两份设计（会与本方案抢同一批文件） | `aragon-agent-core/docs/plans/plan-mode/spec.md` v2、`.../allow-insecure-tls-without-warning/spec.md` v2 |

---

## 4. 技术设计

### 4.1 路径层：home root

新的单一真相是 `packages/cli/src/config/app-paths.ts`（重写，仍是那个「一个名字只能有一处」的角色）。

```
~/.aragon-agent/                      ← ARAGON_HOME 可覆盖
├── config.json                       ← 持久化配置（0600 on POSIX）
├── config.json.bak                   ← `aragon config edit` 编辑前的备份（P1-7）
├── logs/                             ← 0700 on POSIX
│   ├── aragon-2026-07-27.log         ← 当天 JSONL
│   ├── aragon-2026-07-27.1.log       ← 体积轮转产物
│   └── aragon-2026-07-26.log
├── sessions/                         ← /save · /resume
│   └── session-<iso>.json
├── skills/                           ← aragon skills install 的默认目标
│   ├── .staging/  .staging/.trash/
│   └── <skill>/SKILL.md + .aragon-skill.json
├── skill-usage.json
├── .migrated-from-argon-agent        ← 品牌迁移面包屑（由 ② 从 <config> 搬来）
└── .migrated-from-env-paths          ← home 迁移面包屑（诊断用，非幂等键）
```

解析规则（`resolveHomeRoot()`，纯函数 + 一次性模块级求值）：

1. **测试隔离分支（最高优先，v2 新增）**：`process.env.VITEST` 为真且 `ARAGON_HOME` 未设 → 返回 `join(os.tmpdir(), 'aragon-agent-vitest-' + process.pid)`。理由见下方「测试隔离契约」。
2. `ARAGON_HOME` 非空 → `path.resolve(trim(value))`。若该路径存在且**不是目录** → 忽略，回落默认，并记一条 `warn` 日志（此时日志器尚未初始化，故把原因暂存进模块级 `homeResolutionWarning`，由 `installLogging()` 在初始化后补写，见 §4.4.5）。
3. 否则 `path.join(os.homedir(), '.aragon-agent')`。

**为什么全平台统一用 `~/.aragon-agent` 而不是在 Linux 上走 XDG**：需求要的是「和 Claude Code 类似」，而 Claude Code 在三个平台上都用 `~/.claude`。一个跨平台一致的路径让文档、排障话术、社区问答只有一种说法；坚持 XDG 的用户有 `ARAGON_HOME=$XDG_CONFIG_HOME/aragon-agent` 这条一等公民逃生舱。这是一个**有意的取舍**，不是疏忽。

**为什么模块级一次性求值**：`appPaths` 今天就是这个语义（`app-paths.ts:15`），既有测试依赖「先设 env，再 `await import()`」的模式（`config.test.ts:10-20`）。保持同一模型，测试改造就只是把 `APPDATA=` 换成 `ARAGON_HOME=`，而不是引入一套新的 mock 机制。**推论（P2-9）**：`isHomeOverridden()` 必须在同一次求值里把 `ARAGON_HOME` 是否生效**捕获成模块级布尔量**，不得在调用时实时读 `process.env`——`config.test.ts:24-28` 的 `clearEnv()` 会在每个 `beforeEach` 删掉所有 `ARAGON_*`，实时读会把它打成 `false`。

导出（全部为纯函数，除 `homeRoot` 外都基于它派生）：

```ts
export const APP_NAME = 'aragon-agent';          // 保留：迁移与 UA 仍需要
export const HOME_DIR_NAME = '.aragon-agent';
export function getHomeRoot(): string;           // ~/.aragon-agent（已 resolve）
export function getConfigPath(): string;         // <home>/config.json
export function getConfigBackupPath(): string;   // <home>/config.json.bak
export function getLogsDir(): string;            // <home>/logs
export function getSessionsDir(): string;        // <home>/sessions
export function getUserDataDir(): string;        // <home>  ← skills/paths.ts 的 <data>
export function getUserSkillsDir(): string;      // <home>/skills
export function isHomeOverridden(): boolean;     // 模块加载期捕获（P2-9）
export function getHomeResolutionWarning(): string | undefined;
/** 仅供 ①② 两个迁移模块使用。任何新代码引用它都是错的。 */
export { appPaths as legacyEnvPaths };
```

`config/store.ts` 与 `skills/paths.ts` 的同名函数**改为直接调用这里**，不得各自再拼一次 `join`——这正是 `app-paths.ts` 头部注释警告过的那类「两处拷贝，改一处、静默不一致」的形状。

> **删除而不是改指向（P2-5）**：`store.ts::getSkillsDir()` 与 `store.ts::getConfigDir()` 一并删除。前者零非测试 caller，活的是 `skills/paths.ts::getUserSkillsDir()`；两个名字指同一个目录正是上面那句注释在警告的形状。后者见下。

#### 测试隔离契约（v2 新增，P0-4；实施时必须逐条落地）

新布局有一个不显眼的放大效应：`getConfigDir()` 在旧布局下返回一个**只装 config.json 的目录**，在新布局下它会返回**整个用户根**。而它在全仓唯一的非定义 caller 是 `config.test.ts:32` 的

```ts
rmSync(getConfigDir(), { recursive: true, force: true });   // 每个 beforeEach
```

同一文件的 `clearEnv()`（`config.test.ts:24-28`）又会删掉所有 `ARAGON_*` 变量——**包括本方案打算用来做隔离的 `ARAGON_HOME`**。两件事叠起来，一次顺序写错的编辑就能让 `npm test` 递归删掉开发者本机的 `~/.aragon-agent`：API key、全部会话、全部已装 skills。这不是「测试污染」，是不可恢复的数据丢失，而且发生在没人预期文件系统被触碰的时刻。

四条要求，缺一条都不算做完：

1. **`getConfigDir()` 删除**（唯一 caller 是测试）。任何名字里说「config dir」的函数都不得返回用户根。需要根路径的地方调 `getHomeRoot()`，读者一眼就知道它有多大。
2. **`clearEnv()` 显式豁免 `ARAGON_HOME`**，并在旁边注释写清原因（「删掉它会让后续任何非模块级的路径解析回落到开发者真实 home」）。
3. **测试不得递归删除已解析的根**。删单个文件用 `rmSync(getConfigPath(), { force: true })`；需要清一片就删自己在 `TMP` 下拼出来的路径，绝不删一个函数返回给你的路径。
4. **`resolveHomeRoot()` 的 VITEST 分支**（上面规则 1）。`vitest` 会设 `VITEST=true`；在测试进程里、且没有显式 `ARAGON_HOME` 时，把根重定向到 `os.tmpdir()` 下的 per-pid 目录，**绝不返回真实 home**。选择「重定向」而不是「抛错」，是因为抛错会让所有只是间接 import 到 `app-paths` 的无关测试（glyphs、reducer……）一起变红，那种代价会诱使人把守卫删掉；重定向对无关测试完全无感，对忘记设隔离的测试也只是让它写进 tmp。

`app-paths.ts` 文件头必须把这四条写成契约段落。这是本方案里唯一一处「测试的写法属于设计的一部分」。

### 4.2 迁移链（三级，顺序不可交换）

`main()` 的前两条语句：

```ts
const legacy = migrateLegacyState();   // ① argon-agent → aragon-agent（env-paths 空间内）
const home   = migrateToHome();        // ② aragon-agent env-paths → ~/.aragon-agent
```

**顺序理由（必须写进代码注释）**：0.4.x 用户的数据在 `argon-agent` 的 env-paths 树里。若先跑 ②，②只会去看 `aragon-agent` 的 env-paths 树（空的），什么都不搬；随后 ① 把数据从 `argon-agent` 搬进 `aragon-agent` 的 env-paths 树——一个此后**没有任何代码会去读**的位置。

**这里的机制要说准（P2-12）**：因为 ② 的幂等键是逐产物的，顺序写反在**下一次启动**会部分自愈——`sessions` / `skills` 那时目标仍不存在，会被正常搬走。真正回不来的是 `config.json`：第一次启动时用户看到一个空配置，重输了 API key，于是 `<home>/config.json` 已经存在；第二次启动 ② 看到目标存在就跳过，那份带着历史设置的旧 config 从此孤立在 env-paths 树里，没人知道该去哪儿逆。所以结论不变（顺序必须是 ①→②），但它的严重性是「一部分设置永久孤立 + 一次莫名其妙的重新配置」，不是「全部数据蒸发」。§8.1 用例 9 是机械护栏。

`migrateToHome()` 的规格：

- **永不抛**（C4）。任何失败降级为 `{ moved: [], mode: 'none', error }`。
- **幂等键是「每个目标产物是否已存在」，绝不是「home 根目录是否存在」**。原因：日志器可能在同一进程稍后创建 `<home>/logs/`，`skills/usage.ts:164` 也会 `mkdirSync(getUserDataDir())`（新布局下就是 `<home>`），而未来任何调整都可能让某个组件更早地 `mkdir` 根目录；用根目录做键会让迁移在第二次运行时静默跳过一个还没搬完的树。逐产物键表：

  | 产物 | 源（env-paths） | 目标 | 幂等键 | 搬运方式 |
  |---|---|---|---|---|
  | 配置文件 | `<config>/config.json` | `<home>/config.json` | 目标文件已存在 | **复制，保留源** |
  | 会话 | `<data>/sessions/` | `<home>/sessions/` | 目标目录已存在 | rename，失败降级复制并保留源 |
  | skills | `<data>/skills/` | `<home>/skills/` | 目标目录已存在 | 同上 |
  | usage 计数 | `<data>/skill-usage.json` | `<home>/skill-usage.json` | 目标文件已存在 | 同上 |
  | 品牌迁移面包屑 | `<config>/.migrated-from-argon-agent` | `<home>/.migrated-from-argon-agent` | 目标文件已存在 | 同上 |

- **为什么 config.json 用复制而不是 rename**：它是唯一用户可能想拿旧版本继续跑的产物，体积以 KB 计，复制成本可忽略，而保留源让「装回 0.5.0」是一个无损动作。sessions / skills 体积大，用 rename。这条区别写进代码注释。
- **搬运失败策略**：先 `renameSync`；捕获任何错误（Windows 上 `%APPDATA%` 与 `%LOCALAPPDATA%` 是两棵树，跨卷会 `EXDEV`；杀软占用会 `EPERM`）后降级 `cpSync(recursive)` 并**保留源**。「半个副本 + 删掉的原件」是唯一比不迁移更坏的结局——同 `migrate-legacy-state.ts:120-128`。
- **面包屑** `<home>/.migrated-from-env-paths` 记 `{migratedAt, mode, from:{config,data}, moved:[...]}`，写失败静默吞（它是诊断品，不是幂等键；让它的 ENOENT 冒泡到外层 catch 会把一次**成功**的迁移报告成 `mode:'none'`，正是 `migrate-legacy-state.ts:179-191` 已经踩过的坑）。
- **残留（P2-13）**：② 只搬不删目录本身，所以迁移之后 `%APPDATA%\aragon-agent-nodejs\Config`（含保留的旧 `config.json`）与 `%LOCALAPPDATA%\aragon-agent-nodejs\Data`（可能已空）会留在磁盘上。**这是为可回退付的正确代价，不是遗漏。** 相应地：`aragon config home` 在检测到 `.migrated-from-env-paths` 时**额外打印旧位置**，保留一个 release；CHANGELOG 告诉用户确认无恙后可以自行删除。
- **通知**：`formatHomeMigrationNotice(result)` 返回单行 ASCII（`->` 而非箭头字形，因为它打印在任何终端能力探测之前），由 `main()` 写 **stderr**。stdout 必须保持 `aragon -p "…" > out.txt` 只有模型输出的不变量（`migrate-legacy-state.ts:214-224` 已把这条写成注释）。

### 4.3 config.json 的新形状

新增**一个**顶层嵌套段 `log`，其余字段一律不动（向后兼容：旧文件读进来缺 `log` → 用默认值填充，不写回、不 bump `version`，与 README「These are additive」的既有承诺一致）。

```ts
export interface LogConfig {
  /** silent | error | warn | info | debug | trace，默认 info */
  level: LogLevelName;
  /** 是否落文件，默认 true */
  toFile: boolean;
  /** 日志目录。空串 = <home>/logs（默认）；绝对路径 = 自定义 */
  dir: string;
  /** 单文件体积上限（字节），默认 5 MiB，clamp [64 KiB, 256 MiB] */
  maxFileBytes: number;
  /** logs 目录保留的文件数上限，默认 10，clamp [1, 200] */
  maxFiles: number;
  /** 脱敏开关。默认 true。设 false 需在 CLI 上给出显式告警 */
  redactSecrets: boolean;
  /** debug/trace 级下单条消息文本的截断长度，默认 512，clamp [0, 8192] */
  previewChars: number;
}
```

`clampLogConfig(raw): LogConfig` 与既有的 `clampSkillsConfig` **同形同纪律**：被 `loadConfig()`、`loadPersistedConfig()`、`updatePersistedConfig()` 三处共用。只硬化读路径会在磁盘上留下一个每次启动都静默回落默认值的坏值，症状是「我的设置存不住」（`schema.ts:251-258` 的原话）。

**`redactSecrets: false` 的特殊待遇**：它是唯一一个用户能把密钥写进磁盘的开关。`aragon config set log.redactSecrets false` 必须在 stdout 打印一行显式告警；TUI 侧不提供该开关（只能命令行改），避免误触。

**坏 JSON 不再静默（v2 新增，P1-7）**：`readConfigFile()` 的签名改为

```ts
export interface ConfigFileRead {
  config: Partial<PersistedConfig> | null;
  /** 文件存在但 JSON.parse 失败时填入（消息 + 文件路径），否则 undefined。 */
  parseError?: string;
}
export function readConfigFile(): ConfigFileRead;
```

「绝不因坏配置崩掉 CLI」这条纪律保持不变——仍然回落默认值，仍然不抛。改的只是**它不再是无声的**：`loadConfig()` 拿到 `parseError` 后记一条 `error` / `config` 日志；交互路径弹一次 warn toast，非交互路径写一行 stderr。理由是本方案主动邀请用户手改这个文件（G2 + `config edit`），而一个多余的逗号今天会静默把模型、主题、超时、skills 和（用户视角里的）API key 全部回落默认，且任何地方都不解释为什么。

调用点（三处，全部要改）：`load.ts:110`、`store.ts:101`、`store.ts:133`。为不让 `loadPersistedConfig` / `updatePersistedConfig` 也背上日志依赖，两者只取 `.config`；`parseError` 的唯一消费者是 `loadConfig()` 与 `config edit`。

### 4.4 日志系统

#### 4.4.1 分级

```ts
export const LOG_LEVELS = {
  silent: 0, error: 10, warn: 20, info: 30, debug: 40, trace: 50,
} as const;
```

**隐私分层是设计的一部分，不是副作用**：

| 级别 | 记录什么 | 含用户内容？ |
|---|---|---|
| `error` | 未捕获异常、LLM 请求失败、工具执行异常、配置写入 / 解析失败、日志自身故障 | 否（错误消息经脱敏） |
| `warn` | 迁移降级、配置坏值被 clamp、skills 完整性告警、日志轮转失败、记录被丢弃 | 否 |
| `info`（默认） | CLI 启动/退出、配置读写、模型切换、turn 开始/结束 + token 用量、工具名 + 耗时 + 成功与否、skills 装载 | **否** |
| `debug` | 上面全部 + 提示词/回复/工具参数/工具输出的**前 `previewChars` 字符** | 是（截断） |
| `trace` | 上面全部 + 完整消息体、完整工具参数与输出、HTTP 状态与耗时 | 是（完整） |

默认 `info` 不写任何对话内容。README 与 `aragon logs path` 的输出都要把这条说清楚——用户需要知道把 `--log-level debug` 的产物贴到 issue 里意味着什么。

#### 4.4.2 记录格式（JSONL，一行一条）

```jsonc
{"ts":"2026-07-27T12:11:02.913+08:00","lv":"info","sid":"7f3a91c2","pid":24188,
 "scope":"agent","msg":"turn_end",
 "data":{"provider":"anthropic","model":"claude-sonnet-4-5-20250929","in":1284,"out":377,"ms":4210}}
```

- `ts`：**带本地偏移的 ISO 8601**（v2 修订，P2-7）。v1 用 `toISOString()`（UTC），而文件名按本地日期切分，于是一个 UTC-5 用户傍晚的记录会落在本地前一天的文件里、带着次日的时间戳。文件名与时间戳必须用同一个时钟，否则「按天翻日志」这个最基本的动作就会骗人。
- `sid`：进程级会话 id，`randomUUID().slice(0,8)`。**必须有**：多个 `aragon` 实例往同一天的文件里追加，没有它就无法把交错的行分回各自的时间线。
- `pid`：同上，双保险（sid 只活在内存，崩溃分析时 pid 能和 OS 侧信息对上）。
- `scope`：`cli | config | agent | tool | skills | llm | migrate | log`。固定字符串联合类型，不是自由文本。
- JSONL 而不是人类可读行：`aragon logs tail` 负责渲染成人类可读；机器可读的原始格式让 `jq` / 脚本 / 未来的诊断命令零成本可用。

> **关于 `ts` / `lv` / `msg` / `data` 这几个名字（P2-8）**：本包 CLAUDE.md §三 要求不缩写领域词，并点名禁止 `data` 这类无信息量的名字。这里是**有意的例外**：它们是磁盘 wire format 的键，每条记录出现一次，短键在一个会写到 MiB 级的文件里是实打实的体积与可读性取舍。`logger.ts` 的 docstring 必须写明这一点，否则下一个读到 CLAUDE.md 的人会来「修正」它，而那次修正会让所有已存在的日志文件与解析脚本失配。TypeScript 侧的**变量与函数名**不享受这个例外。

#### 4.4.3 脱敏管线（不可绕过）

`redactRecord(record, secrets)` 在**序列化之前**跑，两遍：

1. **结构遍历**：递归 `data`，键名匹配 `/(api[-_]?key|token|secret|password|authorization|credential)/i` 的值整体替换为 `"«redacted»"`。深度上限 6、节点上限 500，超出即截断为 `"«truncated»"`（防御恶意深层对象把 CLI 卡死）。
2. **字符串扫描**：对 `msg` 与所有字符串叶子跑正则替换：
   - `sk-ant-[A-Za-z0-9_-]{16,}`（Anthropic）
   - `sk-[A-Za-z0-9_-]{20,}`（OpenAI 及兼容端点）
   - `AIza[A-Za-z0-9_-]{28,}`（Google）
   - `Bearer\s+[A-Za-z0-9._~+/-]{16,}=*`
   - 兜底：**SecretRegistry 里当前持有的每个字面量**（这一条是真正的护栏——它不依赖 key 长什么样，只依赖我们手上有它）。

**两遍都必须有**。只做结构遍历，一条把 key 拼进 URL 或错误消息的字符串就漏了；只做字符串扫描，一个未来新增的、格式不匹配任何正则的自定义端点 key 就漏了。`redactSecrets: false` 时两遍都跳过（且只有命令行能设成 false）。

##### SecretRegistry：为什么兜底不能是启动期快照（v2 新增，P0-3）

v1 把兜底写成「`config.apiKeys` 里当前实际持有的每个非空 key」，读起来滴水不漏，落到时序上却是一个**在 `installLogging()` 那一刻拍下的快照**：

- ③ 运行时，`loadConfig()`（④）还没跑，`--api-key` 还没被 commander 解析；
- 用户在 settings 覆盖层里**新填**的 key 走 `controller.setApiKey` + `persistConfig({apiKeys})`，永远不会回头补进那个快照。

于是 key 进入进程最常见的那条路径——也正是 AC-5 逐字描述的场景（「在 settings 里填入一个真实 API key，跑一轮对话」）——落在兜底之外。它今天只是恰好被格式正则兜住了；而兜底这条规则存在的全部理由，就是兜住**不匹配任何正则**的自定义端点 key。那种 key 沿这条路径会原样落盘。

所以兜底必须是一个**活的注册表**，`logging/secret-registry.ts`：

```ts
/** 进程级、只增不删、不落盘、不导出到任何序列化结构。 */
export function registerSecret(value: string | undefined | null): void;
export function getSecrets(): readonly string[];
export function clearSecretsForTest(): void;   // 仅测试
```

- `registerSecret` 忽略空值与 `length < 8` 的值（避免把 `"1"` / `"off"` 这类短串注册成密钥，那会把日志里所有出现该子串的地方糊成 `«redacted»`）。
- 内部用 `Set` 去重；按长度降序返回，保证长 key 先被替换掉（否则一个恰好是另一个前缀的 key 会留下尾巴）。
- **注册点必须穷举，漏一处就是一条泄漏路径**：

  | # | 位置 | 注册什么 |
  |---|---|---|
  | 1 | `installLogging()` 读 config.json 之后 | `config.apiKeys` 的每个非空值 |
  | 2 | `env.ts::readEnvConfig()` 返回前 | `apiKeys` 里解析出的每个值（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`） |
  | 3 | `load.ts::loadConfig()` 返回前 | 合并后的 `apiKeys` 每个值 + `apiKeyOverride`（即 `--api-key`） |
  | 4 | `controller.setApiKey(provider, key)` 的 CLI 侧包装 | `key` |
  | 5 | `store.ts::updatePersistedConfig(patch)` | `patch.apiKeys` 的每个非空值 |

  1 与 3 有重叠，2 与 3 也有——这是有意的冗余：注册是幂等的、代价是一次 `Set.add`，而少注册一处的代价是一次凭据泄漏。

- `redactRecord` **每次都现取** `getSecrets()`，不缓存。
- §8.1 用例 4b 专测这条：先 `installLogging()`，**之后**再 `registerSecret('my-custom-endpoint-key-xyz')`，断言随后写入的记录里它不出现。这条用例是 P0-3 的回归护栏。

单测还必须包含 v1 已经要求的那条「把三家真实格式的假 key 塞进 `msg`、`data.foo.bar`、`data.headers.Authorization` 三个位置，断言输出里一个字符都不剩」。

#### 4.4.4 落盘（FileSink）与轮转

**写通道：单一同步 fd（v2 修订，P1-4）**

v1 用 `fs.createWriteStream(file, { flags:'a', mode:0o600 })`，这与 C3「日志器直接持有 fd」自相矛盾，而且流这个选择本身兑现不了 G3：

- 流的内部缓冲在 `process.exit()` 时**直接丢弃**。`flushSync()` 只排空日志器自己的数组，已经交给流但尚未落盘的记录恰好是崩溃前最后那几条——最有价值的那几条。
- 退出路径的 `appendFileSync` 与稳态的流是**同一文件上的两个写者**，彼此顺序未定义。
- 流的写失败以**异步 `'error'` 事件**到达。没有 `'error'` 监听器时 Node 会抛，于是 AC-9（把日志目录改成只读再触发写入）按 v1 的设计必然表现为未捕获异常，叠加 P0-1 的处理器后是挂死。

v2 收敛为一条同步通道：

```ts
fd = openSync(file, 'a', 0o600);
// flush：
writeSync(fd, batch.join(''));     // batch 是若干条已 JSON.stringify 并带 \n 的行
```

`O_APPEND` 语义让多进程并发追加不会互相截断（POSIX 与 Windows `FILE_APPEND_DATA` 均如此），单次 `writeSync` 的批量远小于会撕裂的阈值，行不会被切开。所有错误都变成同步 `try/catch`，`flushSync()` 与稳态 flush 走**同一段代码**（差别只在「是否还要重新起定时器」），C3 的说法也终于成真。

- **缓冲**：内存队列（数组）+ 两个触发器：`length >= 64` 或 200 ms 的 `setInterval(...).unref()`。`unref()` 是必须的——否则一个只跑了 5 ms 的 `aragon --version` 会被定时器吊住 200 ms 不退出。
- **队列上限**：5000 条。越界时**丢最新的**并保留头部（v2 修订，P2-6）：洪水场景里最老的那几条恰好是解释事发原因的那几条，先丢它们等于在日志最有价值的时刻把最有价值的部分丢掉。丢弃计数攒进 `dropped`，在下一次 flush 时补一条 `warn` 记录 `{scope:'log', msg:'records_dropped', data:{count}}`。静默丢弃是不可接受的。
- **同步收口**：见 §4.4.5 的进程钩子所有权。`flushSync()` 是幂等的，可以被多个钩子重复调用。
- **按天**：文件名 `aragon-${YYYY-MM-DD}.log`，本地时区（用户排障看的是自己的钟，且与 §4.4.2 的 `ts` 同一时钟）。跨天由每次 flush 前的 `resolveTargetFile()` 检测。
- **按体积**：flush 前若当前文件 `size + pendingBytes > maxFileBytes` 即轮转。
- **换文件 / 轮转的动作序列必须是这个顺序**（v2 新增）：

  ```
  flushSync()  →  closeSync(fd)  →  renameSync(旧 → aragon-<date>.<n>.log)  →  openSync(新)  →  enforceRetention()
  ```

  `closeSync` 必须在 `renameSync` 之前：Windows 上对一个自己仍持有句柄的文件做 rename 会 `EPERM`。`n` 取当天已存在的最大序号 + 1。rename 失败（另一进程刚抢到，或另一个 `aragon` 实例正握着同一文件的句柄——**Windows 上这是常态**）**吞掉并继续写原文件**：两个进程都轮转一次的结果是多一个小文件，而让轮转失败阻断日志写入，是把可观测性换成了整洁度。
- **保留是独立步骤，两个时机都要跑**（v2 修订，P1-5）：

  ```ts
  export function enforceRetention(dir: string, maxFiles: number): void;
  ```

  在**跨天换文件**、**体积轮转**、以及**本进程第一次写**三个时机各调一次。v1 把它写在「按体积」小节里，于是一个从不触碰 `maxFileBytes` 的用户会每天多一个文件、永不回收，而配置项写着 `maxFiles: 10`——一年后目录里 365 个文件，跨天路径从来没剪过枝。按 mtime 升序删到只剩 `maxFiles` 个；删除失败静默（Windows 上另一进程可能正握着某个文件）。
- **懒创建**：`mkdirSync(logsDir, { recursive: true, mode: 0o700 })` 与 `openSync` 都发生在**第一条记录真正要写的时候**，不在 `installLogging()` 里。这样 `log.toFile=false` / `--log-level silent` 的用户磁盘上不会凭空多出一个空目录。目录模式取 `0700` 而不是默认（v2 新增）：`debug` / `trace` 级的文件含提示词与工具输出正文，目录权限该和 `config.json` 的 `0600` 同一档；win32 与既有 `chmodSync` 分支一致地跳过。

#### 4.4.5 生命周期、进程钩子所有权与接线

```
main()
 ├─ ① migrateLegacyState()          （env-paths 品牌迁移，永不抛）
 ├─ ② migrateToHome()               （→ ~/.aragon-agent，永不抛）
 ├─ ③ const log = installLogging({ pending: [...①②的结果, homeResolutionWarning] })
 │     ├─ 解析 bootstrap 级别（见下「两级级别解析」）
 │     ├─ 补写 ①② 的迁移结果与 home 解析告警（scope:'migrate' / 'cli'）
 │     ├─ registerSecret(config.apiKeys 的每个非空值)            ← §4.4.3 注册点 1
 │     ├─ 挂 process.on('uncaughtException')  → 见下「钩子契约」
 │     ├─ 挂 process.on('unhandledRejection') → 见下「钩子契约」
 │     ├─ 挂 process.on('exit')               → flushSync()
 │     └─ 挂 SIGINT/SIGTERM/SIGHUP            → flush-only + 默认 terminator
 ├─ ④ buildProgram().parseAsync(argv)
 │     ├─ makeController() → loadConfig() 之后 log.reconfigure(config.log)   ← 权威级
 │     ├─ runInteractive() → 进全屏时 setSignalTerminator(restore+exit)
 │     │                   → 渲染前 attachAgentEvents(log, controller)
 │     ├─ runOneShot()     → 同上（无全屏分支）；返回后 log.flushSync()
 │     └─ config/logs/skills/models 子命令 → 各自 loadConfig() 后 reconfigure；
 │                                          `logs` 组豁免 info 记录（P1-6）
 └─ ⑤ 正常退出：waitUntilExit → restore → replayTranscript → （'exit' 钩子）flushSync
```

**③ 为什么在 ①② 之后**：日志目录在 home 里，home 的位置可能刚被迁移改变；先初始化日志器就得在迁移完成后再重定位一次 sink，那是两条状态而不是一条。代价是①②自己的过程无法实时落盘——用「先攒进内存、③ 初始化后补写」解决（`installLogging({ pending })`）。

##### 两级级别解析与唯一收口点（v2 新增，P1-1）

v1 让 ③ 自己扫 argv + 读 config.json + 读 `process.env`，而 ④ 的 `loadConfig()` 又独立解析一遍 `log` 层（defaults › file › env › flags），两者之间没有任何联系。后果有两个：两次解析可以不一致，而**权威的那一次（④）永远不生效**；并且 `loadDotenv(cwd)` 在 `loadConfig()` **内部**（`load.ts:107-108`），所以 `.env` 里写的 `ARAGON_LOG_LEVEL` 在 ③ 完全不可见。

v2 把这件事说清楚，两级各有名字、各有职责：

- **bootstrap 级（③）**：只为覆盖「④ 之前发生的事」——迁移结果、home 解析告警、commander 解析失败、早期崩溃。输入只有三样：`process.env`（**不含 `.env`**）、`config.json` 的 `log` 段、以及一次**极小的手工 argv 扫描**。
- **权威级（④）**：`loadConfig()` 的结果就是真相。**唯一收口动作**是 `getLogger().reconfigure(config.log)`，它在两个地方各调一次：
  1. `makeController()` 内部，`loadConfig(flags)` 之后（覆盖 TUI / one-shot / models 三条路径——它们都构造 controller）；
  2. 不构造 controller 的子命令路径（`runConfigSet` / `runConfigGet/List/Edit/Home` / `runSkillsCommand` / `logs` 组）各自在自己的 `loadConfig()` 之后。
  `reconfigure()` 必须幂等，且允许在 sink 已经开始写之后改级别 / 改目录（改目录时先 `flushSync` + `closeSync`，再让下一次写懒开新目录）。

**`--log-level` 的读取时机**：commander 在 ④ 才解析 argv，而 ③ 需要级别。解法是 ③ 里做一次**极小的手工扫描**，只找 `--log-level <v>` / `--log-level=<v>` / `--verbose` / `--log-dir <v>` / `--no-log-file`，不复用 commander。这是有意的重复，写进注释：让「启动阶段的日志级别」不依赖一个尚未构造的对象，比让 ③ 挪到 ④ 之后（从而丢掉迁移与早期崩溃的日志）划算得多。

**扫描列表里不得有 `-vv`**（v2 修订，P1-3）：`-v` 已被 `.version(VERSION, '-v, --version')` 占掉（`cli.tsx:447`），`-vv` 不是任何已声明的 commander 选项，用户敲它会在 ④ 之前就被 unknown option 顶掉。一个「内部文档承认、实际必然报错」的 flag 比没有这个 flag 更糟。只保留 `--verbose`。

##### 钩子契约：谁负责让进程死掉（v2 新增，P0-1 / P0-2）

这是 v1 唯一真正缺失的一块。Node 里这四个钩子都有「注册即改变默认语义」的性质，而 v1 只说了「挂上去 + 记一条 + flush」，没说**退出由谁负责**：

- **`uncaughtException`**：注册监听器会**取代** Node 默认的「打栈 + 非零退出」。`cli.tsx:595-598` 的 `main().catch()` 不是这个东西——它是 promise 链的 catch，只能接到 `main()` 自己那条链上的错误。所以 v1 那句「原有 stderr 行为」并不存在可以被继承的对象：挂上监听器之后，一个在 Ink 渲染回调或定时器里抛出的异常**不再终止进程**，全屏模式下 alternate screen 永不恢复，Ink 还在往一个已损坏的 controller 上渲染，用户只能 `reset`。
- **`unhandledRejection`**：Node 18 的默认是 `--unhandled-rejections=throw`（转成未捕获异常 → 退出）。挂上监听器即压制默认行为，一个被吞掉的拒绝就从「崩溃」变成「静默挂着」。
- **三个信号**：`cli.tsx:212-232` 的处理器**只存在于全屏分支**。inline / headless / 全部子命令没有任何信号处理器，走 Node 默认终止，而**默认终止不触发 `'exit'` 回调**，队列全丢。若 ③ 自己补注册，它注册得比 `runInteractive` 早，EventEmitter 按注册顺序触发；同时「只要存在 SIGINT 监听器，Node 就不再默认终止」，所以它**必须**自己 `process.exit`——于是它抢在 `restore()` 之前退出，屏幕回不来。这正是 I-4。

契约（逐句写进 `install.ts` 的 docstring，并由 §8.1 用例 11 / 12 守护）：

```ts
// ── 单一所有者模型 ────────────────────────────────────────────────
// 日志器负责「落盘」，不负责「退出」；屏幕负责「恢复」，不负责「落盘」。
// 两者通过两个可替换的模块级钩子协作，绝不各自注册重复的监听器。

let screenRestore: () => void = () => {};                 // 由 runInteractive 全屏分支设置
let signalTerminator = (signo: number) => process.exit(128 + signo);

export function setScreenRestore(fn: () => void): void;
export function setSignalTerminator(fn: (signo: number) => void): void;
```

- **`uncaughtException(err)` 的函数体**（顺序不可换）：
  1. `logger.error('cli', 'uncaught_exception', { message, stack })`
  2. `logger.flushSync()`
  3. `screenRestore()` —— 恢复屏幕必须在写 stderr 之前，否则那行栈会打进 alternate screen 然后随屏幕一起消失
  4. `process.stderr.write(stack ?? message + '\n')` —— 保住「用户看得见崩溃原因」这个既有行为
  5. **`process.exit(1)`** —— 没有这一步，注册监听器这个动作本身就把崩溃变成了挂死
- **`unhandledRejection(reason)`**：同上五步，`msg` 改 `unhandled_rejection`。**必须也退出**，理由同上。
- **`exit`**：只 `logger.flushSync()`。这里只能同步 I/O，而 §4.4.4 已经把写通道做成全同步，所以这是一行。
- **三个信号**：`installLogging()` 注册的处理器只做两件事——`logger.flushSync()`，然后 `signalTerminator(signo)`。默认 terminator 是裸 `process.exit(128+signo)`，这就覆盖了 inline / headless / 全部子命令（v1 完全没有覆盖的三类路径）。
- **`runInteractive()` 的全屏分支不再自己注册信号监听器**，改为：

  ```ts
  setScreenRestore(restore);
  setSignalTerminator((signo) => { restore(); process.exit(128 + signo); });
  ```

  于是实际顺序是 `flushSync → restore → exit`。v1 主张的「先恢复屏幕、再 flush」在 v2 里被有意反转：写通道现在是同步 fd 写，一次批量 flush 是微秒级，把它放在 restore 之前换来的是「屏幕恢复的代码路径只有一处、且由屏幕的所有者持有」，这个简化远比省下那几微秒值钱。`process.on('exit', restore)`（`cli.tsx:225`）保持原样不动——它是四条恢复路径之一，与本方案无关。

**`attachAgentEvents(logger, controller)`** 订阅 `controller.subscribe()`（返回退订函数，`agent/controller.ts:250`），把 9 种 `AgentEvent` 映射成日志记录。**表必须是 9 行**（v2 修订，P1-9；`core/src/types.ts:74-83` 的联合有 9 个成员，§8.1 用例 7 本来就写着「喂 9 种」）：

| AgentEvent | level | msg | data（info 级） | 字段来源 |
|---|---|---|---|---|
| `agent_start` | info | `run_start` | `{provider, model, thinking}` | **事件本身无字段**（`types.ts:20-22`），三项均取 `controller.getConfig()` |
| `turn_start` | debug | `turn_start` | `{}` | 同时**在闭包里记下 `Date.now()`**——这是 `turn_end.ms` 的唯一来源 |
| `turn_end` | info | `turn_end` | `{in, out, ms}` | `in = usage.inputTokens`、`out = usage.outputTokens`（`llm/types.ts:84-90`，**不是** `in`/`out`）；`ms = Date.now() - turnStartedAt`，因为 `TurnEndEvent` 只有 `{message, usage}`，**不带 duration** |
| `message_update` | trace | `stream` | 仅 `{type: streamEvent.type, delta: <增量长度>}` | 绝不记内容 |
| `tool_execution_start` | debug | `tool_start` | `{toolCallId, toolName}` | `args` 仅 debug+ 且按 `previewChars` 截断 |
| `tool_execution_end` | info | `tool_end` | `{toolName, ms: duration, isError}` | `duration` 事件自带；`result` 仅 debug+ 且截断 |
| `code_execution_start` | debug | `code_start` | `{language}` | `code` 仅 debug+ 且截断（它是用户内容） |
| `code_execution_end` | info | `code_end` | `{ms: duration, isError: !!error}` | `output` / `error` 仅 debug+ 且截断 |
| `agent_end` | info | `run_end` | `{messages: messages.length}` | 事件自带 `messages: Message[]` |

`message_update` 在一次回答里是数千条，**必须只在 trace 记录且不记内容**，否则 `debug` 会把日志写爆——这是最容易在实现时想当然写错的一条。turn 计时器是 per-controller 的闭包变量，不是模块级的：一个进程里只有一个 controller，但把它做成模块级会让测试之间互相污染。

#### 4.4.6 日志器自身故障

日志失败**绝不能**变成 CLI 失败，也绝不能在 TUI 挂载期间往终端写字（C2）。设计：

- `FileSink` 内部计连续失败次数，达 3 次 → `disabled = true`，记下 `lastError`，此后所有写入变成 no-op（内存里仍保留最后一条错误）。因为写通道现在是同步的（§4.4.4），所有故障都是 `writeSync` / `openSync` / `mkdirSync` 抛出的同步异常，一个 `try/catch` 就能全接住——不再有「流的 `'error'` 事件没人听所以进程抛掉」这条路径（P1-4）。
- `logger.onFailure(cb)` 单播回调。`ui/App.tsx` 在 mount 时注册，把故障渲染成一次 **toast**（`dispatch({type:'pushToast', level:'warn'})`），这是全屏模式下唯一合法的用户可见通道。
- 非交互路径（`runOneShot` / 各子命令）注册的回调写 stderr，因为那里没有帧。
- `aragon logs path` 在 sink 已禁用时额外打印 `lastError`。

### 4.5 TUI ↔ config.json 的双向一致性

**写方向（TUI → 文件）** 今天已经成立，本方案做三件事把它变成不变量：

1. **收口**：`ui/App.tsx:311-317` 的 `persistConfig` 保持唯一写入点，但 catch 从「静默吞」改为「记 `error` 日志 + 弹 warn toast」。静默吞异常正是「我在 TUI 里改了模型，重启又变回去了」这类问题永远查不出原因的根。同一处补 `registerSecret(patch.apiKeys 的值)`（§4.4.3 注册点 5 的实际落点在 `store.ts`，这里是它的上游调用者，两处都注册是有意的冗余）。
2. **补全**：settings 保存路径（`App.tsx:390-410`）已覆盖 provider/model/baseUrl/thinking/maxTokens/apiKey；本方案在 `SettingsScreen` 增加 **Log level** 一个枚举字段（`FIELDS` 数组加一项 `{key:'logLevel', label:'Log level', kind:'enum', options: LOG_LEVEL_NAMES}`，`SettingsValues` 加一个 `logLevel`），保存时 `patch.log = { level } as PersistedConfig['log']`（与既有 `skills.*` 分支同形）。`FieldKey = keyof SettingsValues` 会自动带上新字段，`cycle()` 的枚举分支不需要改。**这是 `updatePersistedConfig` 的第三个嵌套段**，见下一条。
3. **深合并（R-3，最高优先级）**：`config/store.ts:100-143` 今天对 `apiKeys` 与 `skills` 深合并。**必须在 `loadPersistedConfig` 与 `updatePersistedConfig` 两个函数里各加一行**：

   ```ts
   log: clampLogConfig({ ...current.log, ...(patch.log ?? {}) }),
   ```

   漏掉的症状：用户在 TUI 里改一次日志级别，`log` 段被整体替换成 `{level:'debug'}`，`maxFiles` / `redactSecrets` 等字段悄悄回落默认值——**包括把 `redactSecrets` 从 false 改回 true 或反之**。这和当年 `/skills disable x` 会顺手清空 `trustedProjectDirs` 是同一个 bug。

   > **理由要说准（P2-3）**：`store.ts:127-130` 的注释说的是 `SkillsConfig` 被**封顶在一层嵌套**，出现**第三层**（`skills.a.b` 这种）时才必须换成真正的 deep-merge。`log` 是第三个嵌套**段**，但它自己只有一层（全是标量），所以手写合并**仍然够用**，加一行就够，不需要引入 deep-merge 工具。v1 把这句注释读成了「第三个嵌套段就要换工具」，结论（加一行）碰巧是对的，但按那个理由，实施者会先去造一个用不上的工具。同时这也划出了一条线：`LogConfig` 今后**不得**增加嵌套字段；真要加，先换 deep-merge。

**读方向（文件 → TUI）**：

- **冷启动**：`loadConfig()` 已经读文件（`load.ts:110`），无需改动。手改 `config.json` 后重启即生效。**新增**：解析失败时不再静默（§4.3 / P1-7）。
- **热更新**：**不做文件监听**（NG3 邻域）。理由：`updatePersistedConfig` 本就是**每次都从磁盘重读**再合并再写（`store.ts:133`），所以「用户手改文件的同时 TUI 又保存了一次」的结果是**只有本次 patch 涉及的键被覆盖，手改的其他键完好**。这已经解决了最痛的那类冲突。真正的实时同步需要 watcher + 冲突解决 + 中途改 provider 的引擎重建，收益远低于复杂度。
- **补一个显式入口**：新增 `/reload` 斜杠命令，重新 `loadConfig()` 并把 provider/model/baseUrl/thinking/maxTokens/theme 推进 controller，用于「我刚在另一个窗口改了文件」的场景。它是显式动作，不是隐式竞态。**约束（v2 新增）**：`stateRef.current.status === 'running'` 时 `/reload` 拒绝执行并 notify（「运行中不能重载配置」）——中途换 provider / model 会让正在进行的那一轮的后半段用另一套参数，而事后没有任何记录能解释那次回答为什么是那样。它同时记一条 `info` / `config` 日志 `reload`。

---

## 5. 接口设计

### 5.1 CLI 命令

```bash
# 既有（不变）
aragon config                       # 打开 settings 覆盖层
aragon config path                  # 打印 config.json 路径
aragon config set <key> <value>     # 白名单单键写入

# 新增
aragon config get <key>             # 打印单键值（apiKeys.* 恒为掩码）
aragon config list [--json]         # 打印全部有效配置（密钥掩码；--json 供脚本消费）
aragon config edit                  # 用 $VISUAL/$EDITOR（win32 回落 notepad）打开 config.json
aragon config home                  # 打印 home 根目录 + 是否被 ARAGON_HOME 覆盖
                                    #   + 若存在 .migrated-from-env-paths，附打印旧位置（P2-13）

aragon logs path                    # 打印当前日志文件路径（+ sink 故障原因，如有）
aragon logs list                    # 列出 logs 目录下的文件（名 / 大小 / mtime）
aragon logs tail [-n <N>] [--follow] [--level <lv>] [--json]
                                    # 默认 N=100；非 --json 时渲染成人类可读单行
                                    # --follow 用 watchFile 轮询 500 ms（§11 Q2 已拍板）
aragon logs clear --yes             # 删除全部日志文件（无 --yes 拒绝执行）
aragon logs open                    # 用系统文件管理器打开 logs 目录；失败即降级为打印路径
```

`logs` 子命令组的两条特殊纪律（v2 新增）：

- **整组豁免 §4.4.5 ④ 的「各子命令记一条 info」**（P1-6）。它们是日志的运维入口，给自己制造被观测的副作用没有意义，而副作用是有代价的：只要记了一条 info，sink 就已经 `openSync` 了当天的文件，而 Node 打开文件不带 `FILE_SHARE_DELETE`，于是 `aragon logs clear --yes` 在 **Windows（本需求的首要平台）** 上删不掉当天那个文件，报 `EBUSY` / `EPERM`。
- `clear` 仍然在删除前显式 `sink.close()`（覆盖「别的东西已经开了 sink」的情况），逐文件 `try/catch`，**失败上报而不抛**：输出「已删除 N 个，M 个被占用（列出文件名）」并返回非零退出码。AC-8 增补这条断言。

全局新增 flag（`buildProgram()` 的根命令上）：

```
--log-file            落文件（显式打开）
--no-log-file         本次运行不落文件
--log-level <level>   silent|error|warn|info|debug|trace（本次运行覆盖，不持久化）
--verbose             等价 --log-level debug（没有短形式：-v 已是 --version）
--log-dir <dir>       本次运行的日志目录覆盖
```

**`--log-file` 必须先于 `--no-log-file` 声明**（v2 修订，P1-2）。这是本仓已经写过两遍注释的规则（`cli.tsx:461-472`，`--compact/--no-compact` 与 `--fullscreen/--no-fullscreen`）：只声明负向形式会让 commander 把默认值定成 `true`，「没有意见」被折叠成「显式为真」，于是 config.json 里的 `log.toFile: false` 永远不可能生效。配套：`CliFlags.logFile?: boolean` 保持三态，新增

```ts
function resolveLogToFile(
  flags: CliFlags,
  env: Partial<PersistedConfig>,
  file: Partial<PersistedConfig>,
): boolean;
```

形状逐字对齐 `resolveFullscreen()`（`load.ts:78-87`）：flag › env › file 的显式 `false` › 默认 `true`。

`CONFIG_SET_KEYS`（`cli.tsx:318-343`，今天 **21 键**）新增 7 个点号键：`log.level`、`log.toFile`、`log.dir`、`log.maxFileBytes`、`log.maxFiles`、`log.redactSecrets`、`log.previewChars`。

**但这 7 个 case 不进 `cli.tsx` 的那个 switch**（v2 修订，P1-8）。`runConfigSet` 已经有 21 个 case，圈复杂度早已远超本包 CLAUDE.md 写死的 10；再加 7 个是在一个已经违规的函数上继续加码。改法：

```ts
// packages/cli/src/config/cli-commands.ts —— 新文件
/** `log.*` 点号键 → patch。不认识的键返回 null，由调用方走既有的未知键分支。 */
export function applyLogConfigSet(key: string, value: string): Partial<PersistedConfig> | null;

export function runConfigGet(key: string): void;
export function runConfigList(opts: { json?: boolean }): void;
export function runConfigEdit(): Promise<void>;
export function runConfigHome(): void;
```

`cli.tsx::runConfigSet` 只在 switch 之前加一句 `const logPatch = applyLogConfigSet(key, value); if (logPatch) { updatePersistedConfig(logPatch); … return; }`。这样 `cli.tsx` 只增接线不增分支，C5 与 C7 都保得住。`config get/list/edit/home` 四个实现也落在这个新文件里——v1 给 `logs` 安排了实现模块，却把这四个留在了 `cli.tsx` 里没人认领。

`runConfigList` 的掩码纪律：复用 `maskSecret`（`schema.ts:447-457`），`--json` 分支**同样掩码**（R-12）。`runConfigEdit` 的规格见 §4.3 / P1-7：spawn 前写 `config.json.bak`，编辑器以 `stdio:'inherit'` 同步等待，退出后重新 `JSON.parse`，失败则明确告知文件非法且备份仍在，并返回非零退出码。

### 5.2 环境变量

| 变量 | 作用 | 优先级 | **可否来自 `.env`** |
|---|---|---|---|
| `ARAGON_HOME` | 覆盖用户态根目录 | 最高（模块加载期即生效） | **否** —— 它在 `app-paths.ts` 模块求值时读取，比 `loadDotenv()`（`load.ts:108`）早得多 |
| `ARAGON_LOG_LEVEL` | 日志级别 | 高于 config 文件，低于 flag | 是，但**只对权威级生效**（③ 的 bootstrap 窗口看不到它，见 §4.4.5） |
| `ARAGON_LOG_FILE` | `0/false/off/no` 关闭落文件 | 同上 | 同上 |
| `ARAGON_LOG_DIR` | 日志目录 | 同上 | 同上 |

这一列是 v2 新增（P1-1）。v1 只写了优先级，没写 `loadDotenv` 的时序，于是「我在 `.env` 里设了 `ARAGON_HOME` 但它没用」和「`.env` 里的 `ARAGON_LOG_LEVEL` 对迁移日志没生效」都会变成无法自证的怪现象。README 与 `--help` 必须复述这一列。

在 `config/env.ts::readEnvConfig()` 里新增 `partial.log` 的组装（与既有 `partial.skills` 同形，`env.ts:91-97`），并在返回前调 `registerSecret()`（§4.4.3 注册点 2）。

### 5.3 内部 API 签名

```ts
// packages/cli/src/logging/levels.ts
export type LogLevelName = 'silent'|'error'|'warn'|'info'|'debug'|'trace';
export const LOG_LEVEL_NAMES: readonly LogLevelName[];   // SettingsScreen 的 enum options
export const LOG_LEVELS: Record<LogLevelName, number>;
export function isLogLevel(v: unknown): v is LogLevelName;
export function clampLogLevel(v: unknown, fallback: LogLevelName): LogLevelName;

// packages/cli/src/logging/secret-registry.ts   ← v2 新增（P0-3）
export function registerSecret(value: string | undefined | null): void;
export function getSecrets(): readonly string[];         // 按长度降序
export function clearSecretsForTest(): void;

// packages/cli/src/logging/redact.ts
export function redactRecord(record: LogRecord, secrets: readonly string[]): LogRecord;
export function redactText(text: string, secrets: readonly string[]): string;

// packages/cli/src/logging/file-sink.ts
export interface FileSinkOptions {
  dir: string; maxFileBytes: number; maxFiles: number;
}
export class FileSink {
  constructor(options: FileSinkOptions);
  write(line: string): void;      // 入队，永不抛
  flush(): void;                  // 定时器 / 阈值触发；内部就是 flushSync
  flushSync(): void;              // 幂等；exit / signal / uncaught 都可重复调
  close(): void;                  // flushSync + closeSync(fd)
  reconfigure(options: FileSinkOptions): void;   // v2 新增：改目录时先 close 再懒开
  get disabled(): boolean;
  get lastError(): string | undefined;
}
export function enforceRetention(dir: string, maxFiles: number): void;   // v2 新增（P1-5）

// packages/cli/src/logging/logger.ts
export type LogScope = 'cli'|'config'|'agent'|'tool'|'skills'|'llm'|'migrate'|'log';
export interface LogRecord {
  ts: string; lv: LogLevelName; sid: string; pid: number;
  scope: LogScope; msg: string; data?: Record<string, unknown>;
}
export class Logger {
  error(scope: LogScope, msg: string, data?: Record<string, unknown>): void;
  warn (…同上): void;
  info (…同上): void;
  debug(…同上): void;
  trace(…同上): void;
  child(scope: LogScope): ScopedLogger;
  setLevel(level: LogLevelName): void;
  reconfigure(log: LogConfig): void;    // v2 新增：权威级唯一收口（P1-1）
  onFailure(cb: (reason: string) => void): void;
  flushSync(): void;
}
export function getLogger(): Logger;    // 模块级单例；未 install 时返回 no-op 实例

// packages/cli/src/logging/install.ts
export interface InstallLoggingOptions {
  pending?: LogRecord[];              // ①② 阶段攒下的记录
  argv?: string[];                    // 便于测试注入
}
export function installLogging(opts?: InstallLoggingOptions): Logger;
export function attachAgentEvents(logger: Logger, controller: AgentController): () => void;
// 进程钩子所有权（v2 新增，P0-1 / P0-2）
export function setScreenRestore(fn: () => void): void;
export function setSignalTerminator(fn: (signo: number) => void): void;
```

`getLogger()` 在 `installLogging()` 之前返回**无操作实例**（所有方法为空函数）。这让任何模块都能无条件 `getLogger().info(...)`，不必到处做 null 检查，也不会因为导入顺序意外触发文件创建。

---

## 6. 数据模型

### 6.1 `config.json`（完整示例，含新 `log` 段）

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "baseUrl": null,
  "thinkingLevel": "off",
  "maxTokens": null,
  "theme": "auto",
  "reducedMotion": false,
  "fullscreen": true,
  "exitTranscript": true,
  "transcriptWindow": 300,
  "confirmTools": false,
  "toolTimeoutMs": 180000,
  "idleTimeoutMs": 210000,
  "apiKeys": { "anthropic": "sk-ant-…" },
  "recentModels": ["claude-sonnet-4-5-20250929"],
  "promptHistory": ["…"],
  "density": "comfortable",
  "hints": true,
  "submitCount": 42,
  "skills": { "enabled": true, "disabled": [], "…": "…" },

  "log": {
    "level": "info",
    "toFile": true,
    "dir": "",
    "maxFileBytes": 5242880,
    "maxFiles": 10,
    "redactSecrets": true,
    "previewChars": 512
  }
}
```

- `version` 保持 `1`。新增段是**加性**的，旧文件读进来自动补默认值——沿用 README「a config file written by an earlier version loads unchanged, with no migration and no version bump」的承诺。
- POSIX 下 `0600`；win32 下 `chmodSync` 分支跳过（`store.ts:86-93`，不改）。
- **`LogConfig` 不得再长出嵌套字段**，见 §4.5 #3 的 P2-3 注。

### 6.2 日志记录（TypeScript 形状见 §5.3 的 `LogRecord`）

磁盘形态是 JSONL：一行一个 `JSON.stringify(record)`，行尾 `\n`，UTF-8 无 BOM。空对象的 `data` 省略而不是写 `{}`（体积与噪声）。`ts` 带本地偏移（§4.4.2 / P2-7）。

### 6.3 迁移面包屑 `<home>/.migrated-from-env-paths`

```jsonc
{
  "migratedAt": "2026-07-27T12:10:59.001+08:00",
  "mode": "renamed",                          // renamed | copied | mixed | none
  "from": { "config": "C:\\Users\\u\\AppData\\Roaming\\aragon-agent-nodejs\\Config",
            "data":   "C:\\Users\\u\\AppData\\Local\\aragon-agent-nodejs\\Data" },
  "moved": ["config.json", "sessions", "skills", "skill-usage.json"]
}
```

`from` 是 `aragon config home` 打印「旧位置」时的数据源（P2-13）。

---

## 7. 文件 / 模块改动计划表

### 7.1 新增

| 文件 | 一句话意图 |
|---|---|
| `packages/cli/src/logging/levels.ts` | 级别常量、序、`LOG_LEVEL_NAMES`、`isLogLevel` / `clampLogLevel` 纯函数 |
| `packages/cli/src/logging/secret-registry.ts` | **v2 新增（P0-3）**：进程级活的密钥字面量集合；只增不删、不落盘 |
| `packages/cli/src/logging/redact.ts` | 结构遍历 + 字符串扫描两遍脱敏；导出 `redactRecord` / `redactText` |
| `packages/cli/src/logging/file-sink.ts` | 同步 fd 追加、内存队列、按天 + 按体积轮转、`enforceRetention`、`flushSync`、故障自禁用 |
| `packages/cli/src/logging/logger.ts` | `Logger` / `ScopedLogger` / `LogRecord` / `reconfigure` / 模块级单例与 no-op 回落 |
| `packages/cli/src/logging/install.ts` | 装配：bootstrap 级别解析、pending 补写、**进程钩子所有权**、`attachAgentEvents` 事件映射 |
| `packages/cli/src/logging/cli-commands.ts` | `aragon logs path/list/tail/clear/open` 的实现（与 `skills/cli-commands.ts` 同构） |
| `packages/cli/src/config/cli-commands.ts` | **v2 新增（P1-8）**：`runConfigGet/List/Edit/Home` + `applyLogConfigSet`，把 `cli.tsx` 的分支压力挪出来 |
| `packages/cli/src/config/migrate-home.ts` | env-paths → `~/.aragon-agent` 一次性迁移；逐产物幂等；永不抛；面包屑 |
| `packages/cli/src/__tests__/logging-levels.test.ts` | 级别解析 / clamp / 过滤阈值 |
| `packages/cli/src/__tests__/logging-redact.test.ts` | 三家 key 格式 × 三个位置的脱敏穷举；**installLogging 之后注册的 key**；`redactSecrets:false` 分支 |
| `packages/cli/src/__tests__/logging-sink.test.ts` | 轮转触发点与开关顺序、保留数（两个时机）、并发追加不撕行、`flushSync` 收口、故障自禁用 |
| `packages/cli/src/__tests__/logging-install.test.ts` | 9 种 AgentEvent → 记录映射；`message_update` 只在 trace；**四个进程钩子的退出契约** |
| `packages/cli/src/__tests__/migrate-home.test.ts` | 逐产物幂等、rename→cp 降级、面包屑失败不影响结果、永不抛 |
| `packages/cli/src/__tests__/app-paths-home.test.ts` | `ARAGON_HOME` 覆盖 / 指向文件时回落 / 默认 `~/.aragon-agent` / **VITEST 隔离分支** |

### 7.2 修改

| 文件 | 一句话意图 |
|---|---|
| `packages/cli/src/config/app-paths.ts` | 重写为 home-root 解析器；导出 §4.1 的函数集 + **测试隔离契约段落**；`appPaths` 降级为 `legacyEnvPaths`（仅供 ①② 使用） |
| `packages/cli/src/config/store.ts` | 路径函数改为委托 `app-paths.ts`；**删除** `getConfigDir()`（P0-4）与 `getSkillsDir()`（P2-5）；`readConfigFile()` 返回 `{config, parseError}`（P1-7）；`loadPersistedConfig` / `updatePersistedConfig` 各加一行 `log` 深合并（R-3）+ `registerSecret(patch.apiKeys)` |
| `packages/cli/src/config/schema.ts` | 新增 `LogConfig` / `DEFAULT_LOG_CONFIG` / `clampLogConfig`；`PersistedConfig` 与 `CliConfig` 各加 `log` 字段 |
| `packages/cli/src/config/load.ts` | 解析 log 层（file › env › flags）+ `resolveLogToFile()` 三态（P1-2）；`CliFlags` 加 `logLevel` / `logFile` / `logDir`；消费 `parseError` 记日志；返回前 `registerSecret` |
| `packages/cli/src/config/env.ts` | 读 `ARAGON_LOG_LEVEL` / `ARAGON_LOG_FILE` / `ARAGON_LOG_DIR` 组装 `partial.log`；返回前 `registerSecret(apiKeys)` |
| `packages/cli/src/config/migrate-legacy-state.ts` | 仅补注释：说明它是链条 ①，② 在其后运行且依赖它先完成；`appPaths` 改名为 `legacyEnvPaths` 的跟随修改 |
| `packages/cli/src/cli.tsx` | `main()` 插入 ②③；新增 5 个全局 flag（`--log-file` 先于 `--no-log-file`）、`logs` 命令组、`config get/list/edit/home` 接线；`CONFIG_SET_KEYS` + 7 键 + 一句 `applyLogConfigSet` 前置；**信号处理器改为设置 terminator 而非各自注册**；`runOneShot` 返回后 `flushSync`。**新增 import 必须排在 TLS preload 之后（C6）；改完 ≤900 行（C7）** |
| `packages/cli/src/ui/App.tsx` | `persistConfig` 的 catch 改为记日志 + warn toast；mount 时 `logger.onFailure` + `setScreenRestore` 的配合确认；`handleSettingsSave` 处理新增的 `logLevel` 字段 |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | `FIELDS` 增加 `Log level` 枚举项；`SettingsValues` 加 `logLevel` |
| `packages/cli/src/commands/builtins.ts` | 新增 `/logs`（打印当前日志路径）与 `/reload`（重读 config.json 并推进 controller；**running 时拒绝**） |
| `packages/cli/src/skills/paths.ts` | `getUserDataDir` / `getUserSkillsDir` 改为委托 `app-paths.ts`，删除本地 `paths.data` 拼接 |
| `packages/cli/src/__tests__/config.test.ts` | 隔离方式改 `ARAGON_HOME=<tmpdir>`；**`clearEnv()` 豁免 `ARAGON_HOME`**；`rmSync(getConfigDir())` 改为删单文件（P0-4 的三条要求） |
| `packages/cli/src/__tests__/migrate-legacy-state.test.ts` | 同上；并补一条「①②串联后数据落在 home」的集成用例 |
| `packages/cli/src/__tests__/config-skills-merge.test.ts` | 补 `log` 段的深合并回归（改 `log.level` 不得清空 `log.maxFiles`） |
| `packages/cli/README.md` | 新增「Files & logs」小节：目录树、日志级别与隐私分层、`aragon logs` 用法、`ARAGON_HOME`、**`.env` 不能提供 `ARAGON_HOME` 这一条** |
| `packages/cli/CHANGELOG.md` | 顶部追加版本条目：路径迁移（含用户可见影响与旧目录残留说明）、日志系统、新命令 |
| `README.md`（仓库根） | Layout 小节补一行用户态目录说明 |

### 7.3 明确不改

`packages/core/**`（C1）、`session/persist.ts`（它已经走 `getSessionsDir()`，路径变了它自动跟随）、`ui/console-bridge.ts`（日志器不经过 console，C3）、`ui/screen.ts`、`agent/headless.ts`（P2-11：flush 放调用方，不给这个刻意可注入的模块加单例依赖）、宿主仓库的任何文件。

### 7.4 跨方案冲突面（v2 新增，P1-8）

同一个包里有另外两份设计在飞，且都动本方案要动的文件。**注意：它们不只是「计划中」，评审时工作区里已经有未提交的实现**——`git diff --stat` 显示 `cli.tsx`（+3，TLS preload 的 import 块）、`config/schema.ts`（+48）、`config/load.ts`（+23）、`config/env.ts`（+9）、`tools/index.ts`（+49）、`core/src/engine/{agent,watchdog}.ts`（+63）已被改动，另有 `runtime/`、`agent/agent-mode.ts`、`agent/plan-prompt.ts`、`tools/human-input.ts`、`__tests__/insecure-tls-warning.test.ts` 等新文件未入库。**本文档 §3 的全部行号是对着这个工作区状态核对的**（也就是实施者实际会看到的状态），不是对着 HEAD。落地前必须确认合并顺序：

| 方案 | 状态 | 与本方案的重叠 | 处置 |
|---|---|---|---|
| `plan-mode`（`aragon-agent-core/docs/plans/plan-mode/spec.md` v2） | 有条件通过 | `config/schema.ts`（3 个平铺键 + 2 个 clamp）、`cli.tsx`（`--plan/--no-plan` + 3 个 `CONFIG_SET_KEYS` + switch case + `humanInputBridge`）、`ui/App.tsx`、`ui/overlays/SettingsScreen.tsx` | 两边都只做**加法**，无语义冲突。C7 为它预留 100 行；谁后合并谁负责跑对方的测试 |
| `allow-insecure-tls-without-warning`（同目录 v2） | 有条件通过 | `cli.tsx` 的 **import 顺序被回归测试冻结**（preload 必须在全部第三方 / 本地值导入之前） | C6：本方案新增的 import 一律排在 preload 之后；那条 ordering 测试计入本方案绿线 |

---

## 8. 测试与验收标准

### 8.1 单元测试（vitest，`packages/cli` 内 `npm test`）

1. **路径解析**：默认 = `join(os.homedir(), '.aragon-agent')`；`ARAGON_HOME` 生效；`ARAGON_HOME` 指向一个文件 → 回落默认且记录 warn；`ARAGON_HOME` 带尾随分隔符 / 相对路径均被 `resolve` 归一。
   - **1b**：`isHomeOverridden()` 在 `delete process.env.ARAGON_HOME` 之后仍返回加载期的值（P2-9）。
   - **1c**：`VITEST=true` 且无 `ARAGON_HOME` 时，`getHomeRoot()` 落在 `os.tmpdir()` 之下，且**不等于** `join(os.homedir(), '.aragon-agent')`（P0-4 要求 4）。
2. **配置深合并**：`updatePersistedConfig({ log: { level: 'debug' } })` 之后 `maxFiles` 仍是 10、`redactSecrets` 仍是 true、`skills.trustedProjectDirs` 未被触碰。
3. **clamp 纪律**：`log.maxFileBytes = 1`、`= "abc"`、`= -5` 三种坏值写入后读回都落在合法区间；坏值**写入时就被 clamp**（不是只在读时），即再次 `readConfigFile()` 拿到的就是合法值。
4. **脱敏**：三家 key 格式 × `msg` / 深层 `data` / `data.headers.Authorization` 三个位置 = 9 组断言，输出中 key 的任何 12 字符连续子串都不得出现。
   - **4b（P0-3 回归护栏）**：`installLogging()` **之后**才 `registerSecret('a-custom-endpoint-key-not-matching-any-regex')`，随后写入的记录里它不出现；且 `length < 8` 的值不被注册（`registerSecret('off')` 之后含 "off" 的正常文本不被打码）。
   - **4c**：两个 key 互为前缀时，长的先被替换，不留尾巴。
5. **轮转**：写到 `maxFileBytes` 之上触发轮转；序列是 flush → close → rename → open（用 spy 断言顺序）；同一天第二次轮转序号递增；rename 抛错时**不丢记录**（继续写原文件）。
6. **保留（P1-5）**：`enforceRetention` 在**跨天换文件**、**体积轮转**、**进程首写**三个时机都被调用；文件数超 `maxFiles` 时最老的被删；只跨天、从不触发体积轮转的场景下文件数依然被压到 `maxFiles`。
7. **事件映射（P1-9）**：喂**全部 9 种** `AgentEvent`，断言 `info` 级下 `message_update` **零记录**、`trace` 级下有记录且不含正文；`turn_end.ms` > 0（证明 `turn_start` 的计时器接上了）；`turn_end.in/out` 取自 `usage.inputTokens/outputTokens`；`code_execution_end` 被映射。
8. **收口**：`flushSync()` 后文件内容包含最后一条记录，且重复调用 `flushSync()` 不产生重复行；队列超上限时 `records_dropped` 出现、计数正确、且**保留的是最老的记录**（P2-6）。
9. **迁移**：源有 / 目标无 → 搬；源无 → no-op；目标已存在 → 不覆盖；`renameSync` 抛错 → `cpSync` 降级且源保留；`config.json` 走复制且源保留；面包屑写失败 → 结果仍报告实际搬运的产物；整个函数在任何注入故障下都不抛。
10. **①②串联**：构造一个 `argon-agent` env-paths 树，跑完 `main()` 前两步，断言数据最终落在 `<home>`；再跑第二次断言完全 no-op。
11. **`uncaughtException` / `unhandledRejection` 契约（P0-1）**：注入桩 `process`，断言处理器按 `log → flushSync → screenRestore → stderr → exit(1)` 的顺序调用，且**一定调用了 exit**。
12. **信号所有者（P0-2）**：默认 terminator 是 `exit(128+signo)`；`setSignalTerminator` 替换后，全屏版本先 `restore` 再 `exit`；`installLogging` 与 `runInteractive` 合计只为每个信号注册**一个**监听器。
13. **`--no-log-file` 三态（P1-2）**：flag 缺省时 `config.json` 的 `log.toFile:false` 生效；`--log-file` 能覆盖它；`--no-log-file` 能覆盖 `log.toFile:true`。
14. **坏 JSON（P1-7）**：写一个含多余逗号的 `config.json`，断言 `loadConfig()` 仍返回默认值**且** `parseError` 非空**且**记了一条 `error`/`config` 日志。
15. **回归护栏**：`packages/core` 的 `no-host-coupling.test.ts` 保持全绿（证明 C1 未被破坏）；TLS 方案的 `cli.tsx` import ordering 测试保持全绿（证明 C6 未被破坏）。

### 8.2 手工验收（Windows，用户场景逐字对应需求）

| # | 步骤 | 期望 |
|---|---|---|
| AC-1 | 干净机器 `npm i -g @aragon-agent/cli`，运行 `aragon --version` | `C:\Users\jdqqj\.aragon-agent\logs\aragon-<今天>.log` 存在，内含 `cli_start` 记录 |
| AC-2 | 运行 `aragon`，`/settings` 改 Model 为 `claude-opus-…`，Enter 保存 | `C:\Users\jdqqj\.aragon-agent\config.json` 的 `model` 字段**立刻**变更；日志出现 `config_write` |
| AC-3 | 退出，用记事本把 `config.json` 的 `model` 改成别的值，重启 `aragon` | Header 显示手改后的模型 |
| AC-4 | TUI 运行中，另开记事本改 `config.json` 的 `thinkingLevel` 并保存；回到 TUI 执行 `/theme light` | `config.json` 里 `theme` 变了，**手改的 `thinkingLevel` 仍在**（读-改-写证明） |
| AC-5 | 在 settings 里**新填**一个真实 API key，跑一轮对话，然后 `findstr /C:"<key 前 12 字符>" %USERPROFILE%\.aragon-agent\logs\*.log` | **零命中**（这条直接验 P0-3；用一个不匹配任何格式正则的自定义 key 再走一遍） |
| AC-6 | 用 0.5.0 版本先跑一次（数据落 `%APPDATA%\aragon-agent-nodejs\Config`），再装本版本运行 | 配置 / 会话 / skills 全部出现在 `~\.aragon-agent\`；stderr 有一行迁移提示；`.migrated-from-env-paths` 存在；旧 `config.json` **仍在原处** |
| AC-7 | `aragon config set log.maxFileBytes 65536`，跑一段长对话（`--log-level debug`） | 出现 `aragon-<date>.1.log`；文件总数不超过 `maxFiles` |
| AC-8 | `aragon logs path` / `list` / `tail -n 20` / `clear --yes` | 分别正确；**`clear --yes` 能删掉当天的文件（含本进程自己那个）**；被别的 `aragon` 实例占用的文件被逐个报告而不是整条命令抛错；`clear` 不带 `--yes` 时拒绝并返回非零退出码 |
| AC-9 | 全屏 TUI 下故意让日志目录只读（改 ACL），触发写入 | 帧**不错位**，出现一次 warn toast，CLI 继续可用，**不出现未捕获异常** |
| AC-10 | 同时开两个 `aragon` 窗口各跑一轮 | 同一日志文件里两个 `sid` 的记录都在，无撕裂行（每行都是合法 JSON） |
| AC-11 | `set ARAGON_HOME=D:\aragon-test` 后运行 | 所有产物落 `D:\aragon-test\`，`aragon config home` 标注被覆盖 |
| AC-12 | `aragon -p "hi" > out.txt` | `out.txt` **只有**模型输出（迁移提示、日志提示都不得混入 stdout） |
| AC-13 | `aragon config edit`，在编辑器里删掉一个引号存盘退出；再运行 `aragon` | `config edit` 当场报「文件非法 + 备份在 config.json.bak」并返回非零；重启后 stderr / toast 明确说明配置解析失败已回落默认，**而不是**静默变成全新用户（P1-7） |
| AC-14 | 全屏 TUI 里按 Ctrl+C；再在 `aragon -p "…"` 运行中按 Ctrl+C | 两次都：终端恢复正常（无残留 alternate screen），且最后一批日志记录**已落盘**（P0-2） |
| AC-15 | 在项目 `.env` 里写 `ARAGON_HOME=D:\nope` 后运行 | 它**不生效**（这是设计，见 §5.2），且 README 已说明；`aragon config home` 打印真实生效的根 |

### 8.3 Definition of Done

- 上述单测全绿；`packages/cli` 与 `packages/core` 的 `npm test` 均通过；TLS 方案的 import ordering 测试通过（C6）。
- `cli.tsx` ≤ 900 行（C7），`runConfigSet` 未新增 switch case（P1-8）。
- AC-1 ~ AC-15 全部人工走一遍并记录在 `docs/plans/aragon-home-config-and-logging/manual-test.md`。
- 两份 README + 两份 CHANGELOG 已更新。
- `npm pack` 后的 tarball 里不含任何日志或配置样例文件（`package.json` 的 `files` 白名单已经保证，仍需实测一次）。
- **§10 的发布单元约束被遵守**：P1 与 P2 之间没有任何 publish / 版本 bump（P1-10）。

---

## 9. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R-1** | 迁移顺序写反（②在①前） | 0.4.x 用户的 `config.json` 永久孤立在一个再无人读的目录，用户被迫重新配置一次且不知为何 | §4.2 的顺序理由写进 `main()` 与两个迁移模块的头部注释；§8.1 用例 10 是机械护栏 |
| **R-2** | 用 home 根目录存在与否做迁移幂等键 | 日志器或 `skills/usage.ts:164` 先创建了 `<home>`，迁移就此永久跳过 | 逐产物幂等键（§4.2 表）；迁移固定跑在日志初始化之前；用例 9 覆盖 |
| **R-3** | `updatePersistedConfig` 漏了 `log` 的深合并 | 改一次日志级别，`redactSecrets` 等字段静默回落默认——包括**把脱敏从 false 改回 true 或反之** | `store.ts:115-131` 已有的告警注释是现成的提醒；§8.1 用例 2 是回归护栏；code review 清单单列一条 |
| **R-4** | 日志写入拖慢 TUI | 每个流式 token 都记一条会让帧掉率肉眼可见 | `message_update` 仅 trace（§4.4.5）；批量 flush + 200 ms 定时器；队列硬上限 5000 |
| **R-5** | 密钥泄漏进日志 | 用户把日志贴进 issue 即泄漏凭据 | 两遍脱敏 + **SecretRegistry 活兜底**（§4.4.3，5 个注册点穷举）；默认 `info` 不记正文；用例 4 / 4b / 4c；README 显式说明 debug/trace 含正文 |
| **R-6** | 现有测试通过改 `APPDATA` 隔离，路径改后**测试会去写开发者的真实 home**；而 `getConfigDir()` 在新布局下就是 home 根，其唯一 caller 是递归 `rmSync` | 跑一次 `npm test` 就可能删掉开发者自己的 API key、全部会话、全部已装 skills——不可恢复 | **§4.1「测试隔离契约」四条，全部必须落地**：删 `getConfigDir()`、`clearEnv()` 豁免 `ARAGON_HOME`、测试不递归删已解析的根、`resolveHomeRoot()` 的 VITEST 重定向分支；用例 1c |
| **R-7** | 引入日志库 | `npm i -g` 体积、依赖审计面、Node 版本兼容 | NG2 明令禁止；只用 `node:fs/os/path/crypto` |
| **R-8** | 多进程轮转竞争 | rename 失败或文件被两次轮转；**Windows 上另一实例持有句柄时 rename 必失败** | 轮转序列固定为 flush→close→rename→open；rename 失败即吞并继续写原文件；序号取「已存在最大 + 1」；每行带 `sid`/`pid`；用例 5 与 AC-10 覆盖 |
| **R-9** | 全屏下日志故障写 stderr | 帧永久错位（不变量 I-4） | C2 硬约束；故障走 `onFailure` → toast；非交互路径才写 stderr；AC-9 覆盖 |
| **R-10** | `os.homedir()` 在域账户 / OneDrive 重定向 / 网络盘下指向慢或只读位置 | 每次日志写入卡顿，或 CLI 起不来 | `ARAGON_HOME` 逃生舱；sink 连续失败 3 次自禁用；日志故障永不阻断 CLI |
| **R-11** | `--version` / `config path` 这类纯查询命令也创建目录 | 脚本消费者意外看到副作用 | sink 懒创建（§4.4.4）；`logs` 组豁免 info 记录；`log.toFile=false` / `--no-log-file` / `ARAGON_LOG_FILE=0` 三条关闭通道；文档说明 |
| **R-12** | `aragon config list` 打印出密钥 | 直接泄漏 | 复用 `maskSecret`（`schema.ts:447-457`）；`--json` 分支同样掩码；单测断言 |
| **R-13** | 日志目录被用户配成 home 之外的共享路径 | 隐私外溢 | `log.dir` 只接受绝对路径；logs 目录 `0700`；`aragon logs path` 始终打印真实路径；不做任何自动上传（NG1）；不提供加密（NG7） |
| **R-14**（v2） | P1（路径层）与 P2（迁移）之间发生一次发布 | 每个既有用户的配置 / 会话 / skills 全部失联，且旧目录还在磁盘上没人知道去看 | §10 把两步定为**一个发布单元**：中间不 publish、不 bump；`release-preflight` 不得在「`app-paths.ts` 已是 home 解析器但 `migrate-home.ts` 缺席」的树上跑 |
| **R-15**（v2） | 手改 `config.json` 写坏 JSON | 每一项设置静默回落默认（模型、主题、超时、skills，以及用户视角里的 API key），无处可查——而本方案主动邀请用户手改这个文件 | `readConfigFile()` 返回 `parseError`；`loadConfig()` 记 `error` 日志 + 一行 stderr / 一次 toast；`config edit` 编辑前备份、退出后校验；用例 14 + AC-13 |
| **R-16**（v2） | 注册 `uncaughtException` / `unhandledRejection` 却不退出 | 「崩溃」变「挂死」；全屏下终端回不来，用户只能 `reset` | §4.4.5 的钩子契约逐句写死（含 `process.exit(1)`）；用例 11 |
| **R-17**（v2） | 日志的信号处理器抢在屏幕恢复之前退出 | alternate screen 永不恢复（I-4） | 单一所有者模型：日志只 flush，退出交给可替换的 `signalTerminator`；用例 12 |

---

## 10. 实施顺序

按此顺序提交，每步可独立编译、独立测试、独立回滚。

1. **P1 · 路径层**：重写 `app-paths.ts`（含测试隔离契约与 VITEST 分支），`store.ts` / `skills/paths.ts` 改为委托，删 `getConfigDir()` / `getSkillsDir()`。**同一 commit** 内改造 `config.test.ts` 与 `migrate-legacy-state.test.ts` 的隔离方式（R-6 的四条）。此时行为等价于「换了个目录」，尚无迁移。
2. **P2 · 迁移**：`migrate-home.ts` + `main()` 接线 + 单测。此时老用户升级已经无损。

> **P1 与 P2 是一个发布单元（v2 新增，R-14 / P1-10）。** 两者之间**不得** `npm publish`、不得 bump 版本号、不得跑 `publish-latest.ps1`。步骤 1 单独发布出去的产物会让每一个既有用户的配置、会话与 skills 全部失联，而且旧数据还静静躺在 `%APPDATA%` 里没人知道去看。本仓有活的发布管线（`publish-latest.ps1`、`scripts/release-preflight.mjs`），这不是理论风险。可以选择把 1 和 2 合成一个 commit；如果分开，PR 描述里必须写明这条约束。

3. **P3 · schema**：`LogConfig` / `clampLogConfig` / `PersistedConfig.log` / `CliConfig.log` / `store.ts` 两处深合并 / `readConfigFile` 的 `parseError` / `env.ts` / `load.ts`（含 `resolveLogToFile` 三态）。此时配置能存能读，只是还没人用。
4. **P4 · 日志内核**：`levels.ts` → `secret-registry.ts` → `redact.ts` → `file-sink.ts` → `logger.ts`，五个文件配五个单测，**不接线**。
5. **P5 · 接线**：`install.ts`（含四个进程钩子的所有权契约）+ `main()` 的 ③ + `runInteractive` 改为设置 `screenRestore` / `signalTerminator` + `runOneShot` 的 flush + `attachAgentEvents`（9 种事件）+ 五个 `registerSecret` 注册点 + 两处 `reconfigure` 收口。此时日志真正开始产出。
6. **P6 · 命令与 UI**：`logging/cli-commands.ts`、`config/cli-commands.ts`、`cli.tsx` 的命令与 flag、`CONFIG_SET_KEYS`、`SettingsScreen` 的 Log level 字段、`App.tsx` 的 `persistConfig` 改造与 `onFailure` 注册、`/logs` 与 `/reload`。
7. **P7 · 文档与验收**：两份 README / CHANGELOG、`manual-test.md`、AC-1 ~ AC-15 走查、C7 行数核对。

---

## 11. 未决问题（v2 已全部拍板）

- **Q1 · `promptHistory` 是否搬出 `config.json`？** **拍板：本迭代不动。** 搬到 `~/.aragon-agent/history.json` 会让配置文件对人类更友好（手改时不用滚过 100 行历史），但那是配置文件的**破坏性拆分**，需要一次读时兼容，而本迭代已经在同一个文件上做了三件事（新增 `log` 段、改 `readConfigFile` 签名、加深合并）。作为独立小迭代处理。
- **Q2 · `logs tail --follow` 用 `watchFile` 还是 `fs.watch`？** **拍板：`watchFile` 轮询 500 ms。** `fs.watch` 在 Windows 上对 rename 的行为不一致，而本方案的日志文件**恰好会被轮转 rename**——这正是它最不擅长的场景。轮询简单、跨平台一致、对轮转天然友好，代价是最多 500 ms 延迟，对一个人在看日志的场景无关紧要。
- **Q3 · Windows 上给 `~/.aragon-agent` 设隐藏属性？** **拍板：不设。** Claude Code / git / npm 都不设，用户需要能在资源管理器里直接找到它——这正是本需求的出发点。
- **Q4（v2 新增）· `logs open` 值得做吗？** **拍板：做，但只做最薄的一层。** `explorer` / `open` / `xdg-open` 三分支，spawn 失败即降级为「打印路径」并返回 0（它是便利功能，失败不该是错误）。不引入任何新依赖，不做「打开并选中文件」这类平台特化。

---

## 12. 评审结论（Review Verdict）

**有条件通过（Approved with conditions）。**

这份设计的骨架是对的，而且对得有分量：它把每一条约束都追到了源码里的具体一行，把 `migrate-legacy-state.ts` 已经付出过代价换来的三条纪律（永不抛 / 逐产物不覆盖 / 面包屑不是幂等键）原样继承下来，把「core 不能有 `node:*`」这条机械红线正确地翻译成了「日志系统整体活在 CLI 包内」，也没有为了「结构漂亮」去引入一个日志库。§4.4.1 那张隐私分层表和 §4.4.3 的两遍脱敏，是这份文档里最好的两段——它们把一个通常被当作工程细节的东西当成了产品承诺。

它缺的那一块很集中：**v1 详尽设计了「日志怎么写」，却没有设计「谁拥有进程级钩子与密钥集合」。** 这在 Node 里恰好是最不能省的一块——`uncaughtException`、`unhandledRejection`、三个信号，这四个钩子都有「注册即改变默认语义」的性质，挂上去而不接管退出，症状不是「日志少了几行」，而是崩溃变挂死、Ctrl+C 之后终端回不来。同一类疏忽也解释了 P0-3：「兜底用我们手上真实持有的 key」这个想法是对的，但它在时序上被写成了一个启动期快照，于是恰好漏掉用户新填 key 这条最常见的路径——也就是 AC-5 逐字描述的那个场景。P0-4 则是新布局的一个放大效应：一个名字里写着「config dir」的函数开始返回整个用户根，而它唯一的 caller 是一句递归删除。

以上 4 个 P0 与 10 个 P1 已在 v2 正文逐条修订，无遗留。15 个 P2 已修订或明确记录。

放行条件（实施期必须满足，否则不算完成）：

- **C-1 · §4.1 的测试隔离契约四条全部落地**，且 `app-paths.ts` 文件头写成契约段落。这四条里任何一条缺席，`npm test` 都有可能删掉开发者本机的 `~/.aragon-agent`；这是本方案唯一一处「测试的写法属于设计的一部分」。
- **C-2 · P1 与 P2 之间不发布**（§10 的发布单元约束）。若分成两个 commit，PR 描述必须写明；`release-preflight` 不得在中间态的树上跑。
- **C-3 · §4.4.5 的钩子契约与 §4.4.3 的 5 个注册点，逐条写进代码注释并各配一条单测**（用例 4b / 11 / 12）。这三处的共同特征是：删掉之后代码照样编译、照样跑绿，只在真实故障或真实凭据出现时才作恶——所以护栏必须是机械的，不能靠纪律。
- **C-4 · 落地时把 `docs/plans/aragon-home-config-and-logging/` 移到 `aragon-agent-core/docs/plans/`**，与同一子项目的 `plan-mode`、`allow-insecure-tls-without-warning` 放在一起（P2-15）。本次评审只允许改 `spec.md`，故未移动。
- **C-5 · 合并前确认 §7.4 的两个在飞方案的顺序。** 它们**已有未提交的实现躺在工作区里**（§7.4 列了 `git diff --stat`），所以这不是一句「将来注意」——开工前先把工作区的状态弄清楚，否则 §3 的行号、C7 的行数预算和 `cli.tsx` 的 import 顺序都会在合并时同时失准。本方案的绿线必须包含 TLS 方案的 `cli.tsx` import ordering 测试（C6）与 C7 的行数核对。

评审人建议的实施提示：先做 P4 的 `secret-registry.ts` + `redact.ts` 两个纯函数模块并把用例 4 / 4b / 4c 写足，再动 `install.ts`。这两个模块没有任何时序依赖，是整个方案里最容易被证明正确的部分，而它们守护的是唯一一类无法回滚的后果。

---

## 13. 实施过程发现的方案缺陷（Issues Found During Implementation）

实施期对照 v2 正文逐条落地，发现 4 处方案本身站不住的地方。每条都已按下述方式修正并配了测试，正文其余部分未作改动。

### IF-1 · 队列上限 5000 与「丢最新」在同步写通道下不可达，而**真正**会静默丢记录的是失败路径

**方案说的**：§4.4.4 规定内存队列上限 5000 条，越界丢最新、保留头部，丢弃计数在下一次 flush 补一条 `records_dropped` 的 warn 记录，并强调「静默丢弃是不可接受的」。

**实际情况**：P1-4 把写通道从 `createWriteStream` 收敛为同步 fd 之后，`write()` 在队列达到 64 条时**同步**触发 flush 并清空队列。于是队列在稳态下的最大长度就是 64，5000 这个上限**永远不会被触及**——`records_dropped` 这条记录在生产环境里不可能出现。第一版实现照 §4.4.4 写完后，为它写的测试（灌 5200 条记录、断言出现 `records_dropped`）直接失败，因为一条都没被丢。

同时，**真正会丢记录的那条路径 v2 没有覆盖**：`flushSync()` 的 `catch` 分支拿不到写成功的批次，只能把它丢掉（保留并重试会让队列在一个可能永远不可写的目录后面无限增长）。第一版实现就是 `this.queue = []` ——**一次静默丢弃**，恰好违反 §4.4.4 自己立的那条规矩，而且发生在最需要日志的时刻（磁盘满、目录被改成只读、杀软锁文件）。

**处置**：
- `MAX_QUEUED_RECORDS = 5000` **保留**，但在源码注释里明确降级为「批量阈值这个调参旋钮背后的兜底护栏」，而不是一个工作中的限制。
- 丢弃**计数器**改为在失败路径也累加：`flushSync()` 捕获异常时把本批条数（以及本批携带的旧计数）记回 `dropped`，由下一次成功的 flush 补上 `records_dropped`。丢弃仍然发生，但不再无声。
- 测试相应调整为两条：一条覆盖「失败 → 恢复后如实上报丢了几条」（可达路径），一条直接把队列灌到硬上限验证「丢最新、留最老」的顺序语义仍然正确（`logging-sink.test.ts`）。

### IF-2 · 默认 `signalTerminator` 闭包在全局 `process` 上，绕过了注入的 process port

**方案说的**：§4.4.5 的钩子契约写作

```ts
let signalTerminator = (signo: number) => process.exit(128 + signo);
```

**问题**：`installLogging()` 为了可测试性接收一个 process port（`opts.processPort`），四个钩子都注册在它上面。但上面这个**默认值是在模块顶层闭包捕获全局 `process` 的**，于是「注册」走注入的 port、「退出」走真实进程——两条不同的通道。测试里表现为用例 12 直接把 vitest 的 worker 打挂（`process.exit unexpectedly called with "130"`）；生产里它同样是一处隐蔽的分叉：任何未来把 port 换成别的实现的改动，都会得到一个仍然调用真实 `process.exit` 的信号处理器。

**处置**：`signalTerminator` 的类型改为 `((signo: number) => void) | null`，`null` 表示「用默认」，而默认由**安装时的那个 port** 提供：

```ts
if (signalTerminator) { signalTerminator(signo); return; }
port.exit(128 + signo);
```

对外行为完全不变（默认仍是 `exit(128 + signo)`），但退出只有一条通道。`setSignalTerminator` 的语义与 §4.4.5 一致。

### IF-3 · `--verbose` 不能只在 bootstrap 扫描里生效

**方案说的**：§5.1 声明 `--verbose` 等价 `--log-level debug`；§4.4.5 把它列进 ③ 的手工 argv 扫描。

**问题**：只做这两件事的话，`--verbose` 在 ③ 生效，随后 ④ 的 `loadConfig()` 重新解析 `log` 层时看不到它（`CliFlags` 里没有对应字段），于是 `makeController()` 的 `reconfigure(config.log)` 会把级别**降回** config 文件的值——`aragon --verbose "…"` 在真正开始跑之前就丢掉了 verbose。这是 P1-1「唯一收口点」这条修正自己引入的副作用：一旦 ④ 成为权威，任何只在 ③ 存在的输入都会被它覆盖。

**处置**：`--verbose` 在 `toFlags()` 里折叠成 `logLevel`：

```ts
logLevel: opts.logLevel ?? (opts.verbose ? 'debug' : undefined),
```

显式的 `--log-level` 优先，所以两个一起给也不会互相打架。③ 的扫描保持不变（它仍然需要在 commander 之前认识 `--verbose`）。

### IF-4 · `logs` 组豁免 info 记录并不足以让 `logs clear` 在 Windows 上删掉当天文件

**方案说的**：P1-6 认为 `aragon logs clear --yes` 在 Windows 上会 `EBUSY`，原因是 ④ 给每个子命令记一条 info，于是 sink 已经握着当天文件的句柄；处置是「`logs` 组整体豁免那条 info 记录」。

**问题**：豁免 ④ 的 info 记录是对的，但**不够**——`installLogging()` 在 ③ 就会把 `cli_start`（以及迁移结果）写出去，那是 `main()` 里发生的事，**对所有命令一视同仁**，`logs` 组也不例外。所以进入 `runClear()` 时句柄已经开着，仅靠豁免解决不了。

**处置**：P1-6 的第二条纪律（`clear` 在删除前显式 `sink.close()`）才是真正起作用的那条，实现里它是**必需**而非补充。已在 `logging/cli-commands.ts::runClear` 落地并在 Windows 上实测：`aragon logs clear --yes` 能删掉本进程自己刚创建的当天文件，退出码 0；被其它实例占用的文件逐个报告并返回非零。`cli_start` 记录对所有命令保留不变——AC-1 逐字要求 `aragon --version` 之后当天文件里有它。
