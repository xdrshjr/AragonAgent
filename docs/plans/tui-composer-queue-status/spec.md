# TUI 输入、待处理队列与底部状态区设计

**版本：v2（2026-10-07，Subtask #1 设计评审修订完成）**

> 交付类型：方案设计与评审。本文不代表功能已经实现或完成真实终端验收。
> 下游实施：按第 8 节顺序逐项执行，可使用 `superpowers:executing-plans` 技能；本节点不修改源码、不提交 Git。

**目标：** 在现有全屏 TUI 中完成可靠的多行输入、显式复制、持续队列反馈和紧凑且含义准确的底部布局。

**架构：** 保留 Core 的 steering 队列、接收回执与 CLI reducer 投影；输入框和队列面板沿用统一滚动文档。将操作提示集中到现有固定反馈行，将运行阶段、队列数量和上下文占用集中到全局状态栏。

**技术栈：** npm workspaces、TypeScript strict / NodeNext、React 18、Ink 5、Yoga、string-width 7、strip-ansi、Vitest 4、ink-testing-library；无新增运行时依赖。

## 上游方案复核说明（历史）

本轮任务是 Subtask #0「方案设计」。开始时本路径已经存在未跟踪的 v2 文档，以下评审记录来自已有工作区，予以保留，不将它冒充本轮新执行的评审，也不据此代替后续 Subtask #1。此次重新读取需求、README、CLAUDE、项目索引与实际源码，复核六项需求，补充确定性的字段分配规则、队列投影接口、指标统计范围及本轮验证记录。所有产品源码保持原状，交付范围只有本设计文档。

核查时 Git 根目录为 `M:/takoAI/JRAgentMesh`，项目目录为其下的 `aragon-agent-core`；因此验收与后续暂存应限定本项目路径，不能把父仓库的其他未跟踪产物纳入本次工作。已有 package / lockfile 修改保留。宿主设置以第 7.3 节官方资料为依据，实际输入、IME 和系统剪贴板仍须在实施后验证。

## 评审记录

本轮为 Subtask #1「设计评审」，基于 `1b635d3f3` 及当前工作区源码，逐节核对可行性、完整性、仓库一致性与范围适配。R01–R10 为上游保留的评审历史，本轮复核后保留；R11–R15 为本轮新增关注项。没有发现 P0。以下 P1 均已在正文修订闭环，“已解决”指设计问题已解决，不代表代码已实现。上游的测试成绩单独标为历史，本轮不借用它宣称实现验收通过。

| 编号 | 严重度 | 问题、证据及影响 | 正文处置与状态 |
| --- | --- | --- | --- |
| R01 | P1 | `controller::enqueueSteering` 在 `agent.steer` 前加入保护集合，抛错会留下幽灵 ID；仅检查 pending 不能拦截接收后的重复 `steerQueued`；缺失条目全部追加会把被裁剪的早消息放到后消息之后 | 3.3、5、6、Q08–Q09：入队事务、会话级去重及复用有序合并；已解决 |
| R02 | P1 | 全局复制忙标志未覆盖 `/copy`，取走选区后连续 Ctrl+C 可能退出；超时只清 timer 不能阻止旧子进程迟到覆盖新剪贴板 | 3.2、4、6、C07：统一复制协调入口、同步占用、取消和资源生命周期；已解决 |
| R03 | P1 | `runPhase.starting` 没有对应 reducer action；工具状态依赖转录会受 `/clear` 和 `todo_write` 无普通卡片影响；任意 error notice 不能证明 Agent 失败 | 3.5、5、6、L07：独立运行事实、事件映射与准确结束状态；已解决 |
| R04 | P1 | App 的受控 overlay 名单只有 help/settings/plan，新增组件本身无法响应分页；逻辑行锚点无法定位长代码行的软折行，原方案也未处理控制字符和内部宽度 | 3.4、6、Q10：按键接线、字素偏移锚点和安全全文投影；已解决 |
| R05 | P1 | queue、team、composer、popup 分别限高仍可共同超过短窗口预算；输入行宽不能直接使用终端总列数 | 3.1、3.7、4、L08：明确预算顺序、余量和实际内容宽度；已解决 |
| R06 | P1 | DEL 规范化依赖 stdin filter，但其创建失败有显式降级路径；此时直接让 `key.delete` 向后删除会将 Backspace 反转；粘贴关闭后的换行保障也不成立 | 3.1、6、I06：能力传递及保守降级，不修改 Ink；已解决 |
| R07 | P1 | starting 仍显示“Enter 发送”、overlay 仍显示“Esc 中断”会与真实操作冲突；固定提示占满原 update 槽会使更新通知不可见 | 3.5、L09：上下文提示优先级与原更新入口保留；已解决 |
| R08 | P2 | Windows 宿主/IME/剪贴板以及持续流式性能尚无本轮真实证据；配置文档不能替代验收 | 7.3–7.4：保留发布门槛，由下游实施与验收节点记录证据；待实施后验收 |
| R09 | P2 | 原文无版本标识，模块表漏掉协调入口和能力端口，且无回退边界；新导航算法没有明确保持单按键一次提交 | 3.1、6、8、10：版本、接线清单、分步回退及原子编辑约束；已解决 |
| R10 | P2 | 原 `Transcript` 仍渲染 queued 条目，新增面板会重复展示同一待处理消息 | 3.4、6、Q01：仅过滤显示投影，保留存储与回执所需条目；已解决 |
| R11 | P1 | `PromptInput::resolveSubmit` 在可见 slash 菜单下提交所选命令，Esc 先 dismiss 菜单；3.5 和 ActionHintInput 却只有 overlay / phase，运行中仍可能提示 Enter 入队、Esc×2 中断 | 3.5、4、6、L10：传递实际可见的补全类型，提示优先于一般阶段；已解决 |
| R12 | P1 | 3.1 的单行边界召回规则缺少现有 `verticalOrHistory` 的空草稿 / historyIndex 条件，会允许上下键覆盖用户未发送的单行草稿 | 3.1、I07：保留召回门槛与单次编辑事务；已解决 |
| R13 | P1 | 3.2 同时要求 Promise settle 清 busy 和超时后保持 busy 至 close；4 节仅返回 CopyResult，无法表达失败已反馈但进程尚可迟到写入的状态 | 3.2、4、5、C08：分开结果完成和资源释放信号，锁仅跟随释放；已解决 |
| R14 | P1 | 3.5 要求未知工具显示原名，3.6 始终保留阶段，但未限定任意工具名 / 错误内容的宽度；核心短字段本身即可超宽，数值降级不能解决 | 3.6、L11：阶段有固定完整短标签，动态名称净化后仅在余宽允许时展示；已解决 |
| R15 | P2 | v2 头部与第 10 节仍将“本轮”指向方案节点；已有通过结论容易被读成此次独立评审或产品验收证据 | 头部、7.1、10、评审结论：区分上游历史、本轮静态评审及下游发布门槛；已解决 |

逐节结论：第 1–2 节总体目标与技术栈可行；第 3–5 节按 R01–R07 补足机制与接口；第 6 节同步完整接线范围；第 7 节新增反例验收并区分历史证据；第 8–10 节补回退、责任和本次交付边界。保留 Core、统一滚动及现有持久化格式，不增加消息代理、自动重放或新的依赖，范围适当。

本轮逐节复核：第 1–2 节与仓库的宿主 / Core 分层和 ASCII 源码约定一致；第 3.1、3.2、3.5、3.6 节分别按 R12、R13、R11、R14 修正边界，3.3、3.4、3.7 节的队列回执、覆盖层接线及高度预算可沿用现有机制；第 4–5 节同步最小必要的提示状态与复制生命周期契约；第 6 节只扩充现有计划内文件职责；第 7 节补充四项对应反例，第 8–9 节的实施顺序和整步回退仍成立；第 10 节明确本轮证据。无需引入新的队列系统、导航框架或终端库。

## 1. 概述

本次改进解决输入结果不够明确、排队消息难以持续查看，以及状态栏信息挤压的问题。用户在输入过程中必须能够区分换行、发送和入队；正在运行的 Agent 接受补充说明后，界面必须持续展示真实待处理状态，直到引擎已将消息写入会话记录并在执行循环中接收它。复制是独立操作：鼠标建立选区，Ctrl+C 才发起复制，反馈必须区分已确认写入、已发送但不可确认、明确失败。

项目已经具备大部分底层机制，本设计采用增量补齐。现有字节级 Enter 解码、粘贴事务、选区镜像、steering ID 和 `steering_accepted` 回执继续使用；新增有限高度的 Queue 面板、全文查看入口、统一操作提示与按显示宽度分配的状态字段。保留历史内容、编辑器和右侧 TODO 的统一滚动及对齐关系，不恢复旧版固定输入框布局，也不更换 TUI 框架。

本文覆盖六组用户需求，明确正常、失败、中断、缩放和宿主兼容性的行为。当前节点只完成设计及现状验证；真实 Windows Terminal、VS Code 集成终端、中文输入法、系统剪贴板和持续流式性能属于实施后的发布验收门槛。旧黑板中的滚动自动化结果属于历史证据，不能替代本功能的验收。

## 2. 现状核查与边界

### 2.1 仓库与约定

已读取根 `README.md`、`CLAUDE.md`、两个 workspace 的 `package.json`，并结合 `.claude-index/index.md` 定位源码。核查基线为提交 `1b635d3f3`；当前工作区已有 `package-lock.json`、`packages/cli/package.json`、`packages/core/package.json` 改动，本文不处理这些改动。清单版本为 CLI 0.6.12、Core 0.2.24；索引版本较旧，判断实现以当前源码为准。

遵循现有纯函数与宿主适配分层。Core 不引入 Node、React、剪贴板或终端依赖。新模块控制在 1000 行以内、函数优先少于 60 行、公开输入使用 options 对象。`App.tsx`、`controller.ts`、`reducer.ts` 和 `builtins.ts` 已超过项目建议规模，不继续向其中塞入独立算法，新增逻辑抽成小模块。`glyphs.test.ts` 扫描 ASCII 源码；中文产品文案集中到新 `ui/interaction-copy.ts`，源码使用 Unicode 转义，运行时仍显示中文，符号继续来自 `pickGlyphs`。

### 2.2 已实现与实际差异

| 需求 | 已核实代码路径 | 本轮差异与处理 |
| --- | --- | --- |
| Shift+Enter | `input/enter-sequences.ts`、`stdin-filter.ts` 在 Ink 前将 CSI-u / Alt+Enter 转为换行帧 | 保留解码，增加端到端与宿主实测；不依赖 Ink 单独识别 `key.shift` |
| 多行输入 | `PromptInput.tsx`、`editor-reducer.ts`、`composer-input.ts`、`composer-rows.ts` 支持草稿事务、粘贴展开、限高 | 补齐 Delete 向前删除和字素边界；统一视觉行移动与换行文案 |
| 显式复制 | `selection-controller.ts::finishSelection` 只保留选区，`App` 在退出逻辑前调用 `takeSelection` | 已有优先级保留；`clipboard.ts` 的 `spawn` 返回即视为尝试成功，需等待退出结果并明确失败 |
| 队列 | `controller::queueUserMessage` 生成 ID；Core `acceptSteering` 先写历史再发回执；reducer 才移除 pending | 保留消费机制；补齐重复入队动作与 queued 转录已裁剪时的回执处理 |
| 队列展示 | `StatusBar` 有 pending 时提前返回 `QueueStatusBar`，只显示第一条摘要和剩余数 | 不再替换状态栏，增加独立逐条面板和全文覆盖层 |
| 文案层级 | 运行提示同时散落于 `PromptInput` 占位、`Composer::RunRow` 和 `StatusBar` | 占位只提示输入；操作说明集中到固定一行；真实阶段进入状态栏 |
| 状态字段 | `StatusBar` 以全终端列数作阈值，左右多个不可收缩片段竞争剩余空间 | 改为纯函数先选完整字段，再按精确 cell 宽度渲染 |
| 布局 | `AppShell` 固定 header / toast / status 三行；`ScrollViewport` footer 已含 team 和 composer | 新队列沿用 footer；提示复用 toast 槽；不增加第四个固定槽 |

`layout/budget.ts::viewportRows` 当前为 `frameHeight(rows) - 3`，不再扣除 composer；部分旧注释仍描述固定输入框。实施必须遵循当前 `document-layout.ts` 与 `ScrollViewport` 的实际测量，不能照搬旧 spec 的预算公式。

## 3. 技术设计

### 3.1 输入链路与编辑行为

链路固定为：真实 stdin → `createStdinFilter` → Ink → `splitEnterFrames` → `planComposerInput` → `editorReducer` → `layoutComposer`。过滤层先识别粘贴区域，区域内 CR/LF 是内容；区域外独立 CR 是提交，LF / Ctrl+J 是换行，`ESC [13;2u` 是 Shift+Enter 换行，`ESC CR` 是 Alt+Enter 换行。保留现有半包缓存和上限，不全局启用 kitty 扩展键盘模式，不新增第二个 stdin 监听器。

Enter 的业务结果由 `submitMessage` 当前阶段决定：idle 启动新消息，running 调用 `queueUserMessage`，starting 保持现有拒绝且保留草稿的契约。排队调用抛错时返回 `{ accepted:false, reason }`，草稿不得清空；正常返回 ID 后才派发 `steerQueued`。`ComposerSubmitResult.accepted` 只表示 UI 已接管输入，不能作为队列接收凭据。斜杠命令、补全弹窗和既有启动取消流程沿用当前语义。

编辑器原始内容仅在用户明确换行或粘贴携带换行时写入 `\n`；自动折行只改变布局。Home / End 定位当前逻辑行首尾；上下键按视觉行移动并保留目标显示列。R12：只有视觉导航已到边界且 `buffer.length === 0 || historyIndex !== null` 时才允许沿用历史召回；非空的新草稿即使只有一行，也不能被 Up/Down 替换。多行新草稿的边界保持光标；历史召回内容先正常导航，到边界后可继续已有历史遍历。沿用现有编辑 action 对 historyIndex 的清理，编辑召回内容后即退出历史遍历；不新增草稿历史恢复机制。左右、Backspace 和 Delete 以 `Intl.Segmenter` 的 grapheme 为单位，索引仍使用 UTF-16。Backspace 删除光标前字素，Delete 删除后字素；跨逻辑行删除换行会合并两行。粘贴占位 token 继续按 `expandRangeOverTokens` 原子删除，不能留下半个 token 或代理项。

特别注意已安装的 `node_modules/ink/build/parse-keypress.js` 同时把单字节 DEL（`0x7f`，很多宿主的 Backspace）和 `ESC [3~` 标成 `key.delete`，`use-input.js` 随后清空原序列。因此不能直接把目前的 `key.delete` 分支改为向前删除。必须先在现有 stdin filter 的非粘贴文本路径将 `0x7f` 规范化成 `0x08`，保留前导 ESC 以维持 Alt+Backspace 的词删除语义；真正的 `ESC [3~` 保持原样。完成此规范化后，PromptInput 才能用 `key.backspace` 与 `key.delete` 分派前后删除。不得修改 node_modules 或粘贴 payload；通过真实 Ink 输入链路回归三种字节序列及补全 / 覆盖层的退格行为。

R06 降级契约：`tryCreateStdinFilter` 返回 null 时没有上述保证。由 `cli.tsx` 将实际过滤器是否就绪以 `deleteDisambiguated` 能力传至 App / Composer / PromptInput，缺省 false；false 时保留旧 `key.delete` 退格语义，帮助明确前向 Delete 暂不可用，不能猜测已丢失的原始字节。规范化在 mouse/paste 均关闭时仍对非粘贴键输入生效，但 bracketed 或 burst payload 不改写。过滤器失效或 paste 关闭时不承诺多行粘贴零发送，帮助提示开启支持的粘贴通道；不得把原始粘贴解释为安全能力已就绪。

将分段、宽度、换行映射抽到 `ui/editor-navigation.ts`，`composer-rows.ts` 和移动处理共用映射，避免分别计算 CJK 宽度。Tab 保留原字符，显示按现有 4 列 tab stop；零宽组合符和 ZWJ emoji 与所属字素一起布局。`layoutComposer` 只渲染包含光标的有限窗口；不加入 editor 的独立鼠标滚轮，滚轮仍归统一文档。

导航宽度必须使用 PromptInput 实际正文列宽：从左侧 `contentCols` 中扣除边框、padding、提示前缀和 overflow chip，与渲染传入 `layoutComposer` 的值一致。软折行边界约定使用同一映射的下一行起点；上下移动在目标列无精确字素边界时落在该列左侧最近边界。左右、词移动、删除、补全替换都不得留下字素内部 cursor；粘贴 token 的进入与展开仍沿用 `snapOutOfToken` / `expandRangeOverTokens`。`preferredVisualColumn` 随当前一次编辑 action 一起更新，每个 stdin 回调最多一次 editor dispatch，不能为导航新增第二个 setState/dispatch。

草稿行上限调整为 `max(1, min(6, floor(terminalRows / 4)))`：12 行终端最多 3 行、20 行最多 5 行、24 行及以上最多 6 行。这是本轮明确的产品上限，替代目前 3 / 6 / 10 档；高度由相同函数决定渲染和预算。内部超出部分保留现有上 / 下隐藏行提示。新增行造成 footer 高度变化时只按既有锚点调整一次，不 remount 编辑器。长粘贴继续使用现有折叠 token，不复制或截断原始文本。

中文 IME 的候选面板由宿主管理，PTY 字节流没有 DOM composition 事件。应用不能凭 20ms、字符种类或“刚输入中文”推断是否在组合输入，否则会吞掉正常 Enter。本轮不加时间防抖伪装 IME 支持。正常宿主确认候选只交付文本，必须插入草稿；独立提交 CR 才提交。若宿主把候选确认也编码成同样 CR，须记录真实输入证据并将该宿主组合列为不通过，提供先在外部编辑、再括号粘贴的替代路径，不能宣称所有 IME 已支持。

### 3.2 选区、复制与反馈

应用选区与宿主选区是两种所有权。`mouseSelect` 开启时普通拖动由应用的 SGR 鼠标事件和 frame mirror 管理；Shift+拖动或 `/mouse off` 可能由宿主管理。应用不改写用户终端配置，不能检测或抑制宿主的自动复制，也不能为宿主复制结果发应用成功提示。

应用 Ctrl+C 的顺序固定为：已完成且非空选区 → 取走选区快照并清除退出预备状态 → 异步复制 → 返回；没有选区才走原来的服务停止、双 Ctrl+C 退出规则。原有 Esc 双击中断不变。拖动尚未完成不算 pending selection。复制分支不因失败继续落入退出、中断或服务停止分支。

`clipboard.ts` 保持唯一剪贴板写入模块，`copyText` 改为返回 Promise 的包装入口，`/copy` 与选区复制通过共享协调器使用同一结果类型。正常本机优先使用平台原生工具，等待 stdin 错误、进程 error、close 和 1500ms 超时；用户结果只允许 settle 一次，计时器随结果清理，进程监听按下述释放契约清理。Windows 使用固定 PowerShell 原生脚本，将 stdin 明确按无 BOM UTF-8 解码后调用 `Set-Clipboard`；这是依据真实读回修正的方案，取代原 `clip.exe` 带 BOM UTF-16LE 要求，证据见“实施过程发现的方案缺陷”。macOS / Linux 保持 UTF-8 的 `pbcopy` / `xclip -selection clipboard`。所有进程使用参数数组、`shell:false`、`windowsHide:true`，正文通过 stdin 传送，绝不拼入命令行。

原生工具正常退出码 0 且 stdin 无错误，返回 `confirmed/native`；这确认的是系统写入工具成功，逐字符一致性由真实剪贴板读回验收。工具不可用、超时或非零退出时尝试现有 OSC 52，仍受 `MAX_OSC52_BYTES` 限制且必须通过 `writeForeign`。远端环境（存在 `SSH_CONNECTION` 或 `SSH_TTY`）直接采用 OSC 52，不把远端系统剪贴板当成本机成功；无法确认的远程桥接由 `/terminal-setup` 说明。OSC 52 写入完成仅返回 `sent/osc52`，不能用 success 级别显示“已复制”。两种方法均失败返回 `failed`，不抛出到 UI 事件循环。

反馈文案确定为：“已复制 N 行”“已请求终端复制，结果未确认”“复制失败：工具不可用 / 写入失败 / 超时 / 内容超限”。确认或提示显示 2.5 秒；失败另写入 notice 保留排查依据，不记录被复制正文。复制期间设置 `copyInFlight`，重复 Ctrl+C 只提示“正在复制”，不能意外进入退出阶梯；结果完成不等于资源已释放，锁的释放按下述 R13 契约执行。选区在调用前被取走，OSC 52 引发的 frame invalidation 不得再次消费或复制。已有选区冻结及内容变动清除机制保持。

R02 生命周期细则：在 `ui/clipboard-task.ts` 集中协调选择复制与 `/copy`，App 拥有唯一实例，`CommandContext` 注入同一 `requestCopy` 端口。调用入口先同步占用 ref，再启动 Promise；全局 Ctrl+C 先查 busy，再查已完成选区，最后才进入旧服务/退出逻辑。busy 时不取走新选区、不启动第二任务；两个入口都清除旧 Ctrl+C 退出计时器。反馈仅由协调器发一次，`SelectionBridge.onCopied` 作为结果通知，不能让 `/copy` 再发第二份 toast。

超时/取消时终止仍未结束的原生子进程、关闭 stdin，并保留吞收迟到 error 的最小监听直至 close；不得一次性移除所有 error 监听。最多等待额外 500ms 清理，未确认终止则返回明确失败并禁止本次 OSC 52 降级，协调器保持占用至该进程 close，避免旧任务覆盖下一次复制。正常退出才释放任务资源；应用卸载通过 AbortSignal 取消并屏蔽迟到反馈、禁止再写终端。正常复制成功不杀死 X11 剪贴板持有者；`xclip` 默认后台持有选区，等待的是启动进程完成而非选区寿命，参见 [xclip 上游说明](https://github.com/astrand/xclip)。没有可用原生工具仍可以返回 `sent/osc52`，同时保留降级原因供失败排查，不能报告 confirmed。

R13 将内部任务表示为 `ClipboardTask { result, released }`（第 4 节）：`result` 一次性完成用户结果，`released` 仅在原生写入者已 close、或确定从未启动，且没有后续 OSC 52 写入时完成。`copyText` 仍为 Promise 包装，但交互生产调用者只能通过共享 `requestCopy`；协调器直接使用内部 `startClipboardTask`，不能用 `copyText(...).finally(clearBusy)`。结果失败而尚未释放时显示“复制失败，正在清理”，保留占用并拒绝新的复制，不持续显示“正在复制”。迟到 close 只释放资源，不重复反馈或改写失败为成功；卸载先 dispose 协调器并取消任务，永久拒绝新请求，底层最小监听留到 close，不能为消除 busy 而启动替代写入者。无进程的 OSC 52 分支在写调用结束后释放；原生成功分支在 close 确认后释放。两个 Promise 都必须正常兑现而不产生未处理 rejection，错误使用结构化结果。该机制只分离已有生命周期，不增加任务排队、自动重试或新的用户配置。

### 3.3 真实队列状态与接收时序

不新增业务队列。Core `MessageQueueManager` 是消费权威，CLI `pendingSteering` 是按同一 ID 跟踪未收到接收凭据的可靠投影，QueuePanel / 状态数量 / 全文入口都直接读此投影。`controller.pendingUserSteering` 保持现有对自动 steering 清理的保护，不从渲染侧操作 Core 队列。

标准时序：

1. 用户 Enter，`queueUserMessage(text)` 为本次提交创建唯一 ID 并同步调用 `agent.steer(text,id)`。
2. 返回成功后派发 `steerQueued`，保留完整文本，队尾追加 queued 转录条目和 pending；此时即可显示 Queue。
3. Core 在既有执行检查点按 FIFO 取出，先把整个 batch 写进 `messageManager`，再同步发 `steering_accepted(ids)`。
4. Controller 清除相应保护 ID；App 将凭据立即派发为 `steeringAccepted`，不能与 33ms 文本 delta 合并器混在一起延迟。
5. reducer 在一个状态变换里把已接收消息转换为正常 user 转录，再移除这些 ID 的 pending；UI 下一帧同时出现会话消息和队列数量变化。

这里“开始处理”定义为执行循环在安全检查点接收并纳入会话，非仅 `drain`，也不要求等到模型首 token；之后模型请求失败属于已接收任务失败，不应把已纳入历史的内容再入队。`acceptSteering` 已满足先写历史再回执的要求，正常情况下不修改 Core API。

R01 入队事务：保留 `enqueueSteering` 的预登记顺序，但对 `agent.steer(text,id)` 增加限定 catch；抛错时只删除本次预登记的保护 ID，再原样抛错。正常返回才向调用者返回 ID。失败不得清除其他已入队消息，ID 序号不回退。Core 的 steer 当前只同步追加、不发接收事件，因此 App 在返回后派发 `steerQueued` 的顺序成立；增加 controller 失败测试防止此契约漂移。

reducer 增加会话内 `seenSteeringIds`，记录本会话已经登记过的 ID；不因接收、`/clear` 或转录裁剪删除，只在 reset / restore 清空。同 ID 的重复 `steerQueued` 在接收前后均无操作，相同文本但不同 ID 必须保留为两次提交。这个集合只用于进程内动作去重，不是第二个队列，不保存正文、不序列化、不承诺跨进程去重；规模按本会话累计提交数增长，不能用 TTL 驱逐后又宣称会话内幂等。

收到凭据时只处理当前 pending 中匹配的 ID，忽略重复、未知和旧会话凭据。先使用 `mergePendingEntries` 的顺序规则补齐转录缺口，再转换匹配的 queued 为 user，最后移除这些 pending，在一次 reducer 返回中完成。不能把所有缺失条目简单追加到末尾：例如 pending 为 A/B 而仅 B 尚在转录，应先恢复 A 再保留 B 原 ID，不能成为 B/A。补回条目的 ID 必须稳定且不与 seq 分配冲突；沿用正常转录保留上限和 droppedEntries 记账，不绕开现有裁剪。超出保留窗口的历史仍以 Core 会话为权威，不允许把裁剪解释为重新入队。

App 保留当前 `steering_accepted` 位于 runGeneration 过滤之前的处理顺序：已写入历史的凭据即使恰逢 force-stop 也必须结算；会话切换后由 pending ID 匹配隔离旧回执。恢复文件中的 queued 按现有 `normalizeLoadedEntries` 转为未发送历史，不重新登记 seen 或 pending。

| 事件 | 队列处理 | 用户可见结果 |
| --- | --- | --- |
| 入队同步失败 | 不添加 pending；原始草稿保留 | 明确错误 |
| agent_end / Esc 中断 / provider 错误，尚无凭据 | 保留 pending 和 Core 中尚未消费消息 | 面板“已暂停，尚未接收”；数量不归零 |
| 下一次正常执行 | 由既有 Core 检查点消费保留消息 | 收到凭据才移除，不重投递同 ID |
| 重绘、输入清空、滚动、/clear | 不改变 pending | 固定数量仍可见，详情仍可查看 |
| /reset 或切换会话 | 沿用显式清队列动作，同时在新界面报告取消数量 | “已取消 N 条未接收消息”；不静默丢失 |
| 保存 / 正常退出 | 沿用 `mergePendingEntries`，保留完整文本与 ID | 会话文件保留 queued 条目 |
| 恢复旧会话 | 不自动发送保存的 queued 消息 | 明确它是未发送历史，可复制后主动重新发送 |

不承诺进程崩溃后的持久队列或 exactly-once 网络投递；现有队列是进程内结构，本轮不增加数据库、消息代理或自动重放机制。

### 3.4 Queue 面板与全文查看

新增 `QueuePanel`，放在 `ScrollViewport.footer` 的 `team` 后、`composer` 前。仅 pending 非空时占高度，独立标题 `Queue · 待处理 N`，空闲而有 pending 时显示暂停状态。终端不少于 20 行时最多显示 3 条，每条一行；更低时最多 1 条。标题占一行，面板总高分别不超过 4 / 2 行。摘要取首个非空逻辑行，剥离 ANSI / 控制码但不改变底层文本；显示编号与被折叠的行数，按 grapheme 截断摘要，不能截断编号。

同一个活动 queued 条目不同时画在普通转录和 QueuePanel。App 从 `entries + pendingSteering` 派生 memo 化的显示 entries，仅滤掉 queueId 仍在 pending 的 queued，交给同一 TranscriptList 测高/窗口路径；原始 state.entries 保留，保存和接收转换照常工作。接收后它变为 user，自然进入显示 entries；恢复文件的未发送历史保留原有历史提示，不误当成当前队列。不得只隐藏 JSX 但继续按旧显示条目计算占位高度。

标题空间足够时标明“另 N 条 · /queue 查看全文”；窄屏标题只显示数量与 `/queue`，完整列表由覆盖层提供。面板无 TTL、无动画、不会因 toast 或普通工具输出被覆盖。用户滚动查看历史时面板随编辑器滚出，这是统一滚动的预期；全局状态栏始终保留待处理数量，不以是否可见判断业务状态。

新增只读 `/queue`，打开 `QueueOverlay`。使用既有 `ui/layout/OverlayFrame.tsx`，将每一条完整文本按保留空格和换行的显示规则展开成行，通过 App 的 `overlayScroll` 和 `overlayMaxRows` 分页。App 将 queue 加入 controlled overlay 的 PgUp/PgDn 名单与 help/plan 的上下键名单；QueueOverlay 不再注册同一组 useInput，避免一次按键滚两次。Esc 仅关闭，不进入中断阶梯；全局复制优先级保持。

全文投影复用字素、tab stop 和硬换行映射，不使用会合并空格的 prose wrapper。bordered 模式内宽为 cols−4，无完整边框模式为 cols−2（与 OverlayFrame 的 border/padding 一致）；每个正文节点恰好一行，防止渲染再次折行。正文保留所有可见内容；ANSI、ESC、其他不可打印控制码显示为可见转义，不能把任意原文控制序列写到终端，也不能静默丢弃它们。底层 pending 文本不变。

标题显示实时待处理数量；内容直接从 pending 派生，不复制成第二份队列。列表变化或 resize 时按顶部 `queueId + 原文 UTF-16 字素起点` 恢复位置，覆盖长逻辑行软折行场景；若该条已接收则移到原顺序下一条，没有下一条时移到前一条；全部接收后显示“队列已处理完毕”。同时 clamp 回 App 的真实 overlayScroll；行投影只在 pending 或正文宽度变化时更新，不随每个 token 重建全文 React 节点。关闭覆盖层不清空已有草稿，不重挂载 PromptInput；通过输入框提交 `/queue` 时命令文本仍按既有提交契约被消费，不承诺恢复用户在键入命令前主动覆盖的草稿。覆盖层打开时状态栏仍收到真实 pending，移除当前 `state.overlay ? undefined : state.pendingSteering` 的屏蔽。

### 3.5 底部布局、操作提示与运行状态

布局从上到下如下，保留单个文档滚动条：

```text
固定 Header：品牌 / 当前模型 / 工作目录
┌ 左侧统一文档（转录、必要填充、Team、Queue、输入框） ┬ TODO ┐
│ 共享可视区域高度；右缘滚动条                         │      │
└─────────────────────────────────────────────────────┴──────┘
固定操作提示 / 短反馈行
固定全局状态栏
```

沿用 `AppShell.toast` 槽承载新的操作提示行，组件名保留 `BottomStatusRow` 以减少装配变更；`Composer` 删除自己的 RunRow 和下方提示，输入框占位统一为闲时“输入任务或问题…”、运行时“输入补充说明…”。plan 模式通过状态字段表示，不再增长占位句。全局提示行不受 `cfg.hints` 或提交次数隐藏，`hints:false` 只隐藏 `/ commands`、`@ files` 等教学性次要提示。

基础提示为闲时 `Enter：发送 | Ctrl+J：换行`、运行时 `Enter：加入队列 | Ctrl+J：换行 | Esc×2：中断`。宽度足够时追加 `Shift+Enter：换行需终端支持`、模式切换、帮助、双 Ctrl+C 退出；有选区时优先显示 `Ctrl+C：复制`；复制中显示“正在复制”。40 列档使用完整但短的 `Enter 入队 | ^J 换行 | Esc×2 中断`，不是把长字符串硬截断。Esc 确认阶段以现有 `interruptHint` 语义显示“再按 Esc 中断 / 强制停止”，不自行改变阶梯。

操作行的每段作为完整 clause 测宽。没有反馈时显示按优先级能装下的 clauses；出现反馈时保留运行时的中断 clause，反馈占余宽，其他操作 clauses暂时收起。失败至少留下“复制失败”，详细原因进入 notice；toast 消退后恢复同一行，不增加空白。状态栏和输入框不再重复操作说明，帮助覆盖层提供完整列表。后台服务存在时保留“Ctrl+C 停止服务”及退出规则的完整帮助，绝不把服务停止描述为 Agent 中断。

R07 提示上下文先于 clause 优先级：starting 显示“启动中，请稍候”及对应取消入口，不显示 Enter 发送/入队；overlay 显示它实际支持的滚动、选择与 Esc 关闭，不显示输入框提交或 Esc 中断。选区复制与复制中反馈可覆盖这些提示，但不改变按键所有权。运行时保持中断 clause 的规则仅适用于普通文档界面；服务停止和双 Ctrl+C 退出按剩余空间保留入口，完整规则在帮助中。保留现有 `shouldRenderUpdateLine`、闲时且无 overlay 的显示条件；更新提示作为低于 toast、高于教学提示的次要 clause 参与测宽，空间不足提供 `/update` 短入口，不能因为永久操作提示而永远不可见。

R11 补全同样拥有按键，不能把它视为普通文档输入。PromptInput 从实际 `popupVisible` 和 `popupKind` 派生 `completion: 'none' | 'slash' | 'file'`，通过 Composer 的 `onCompletionContextChange` 回调同步到 App；只在此枚举变化时通知，不传正文、不随候选高亮移动重新通知。菜单因预算不足或输入失焦不可见时必须报告 none，不能仅看 suggestions 非空。提示优先级为复制 / 退出确认反馈、overlay、可见补全、starting、普通输入阶段；超时清理使用 R13 的独立反馈。slash 菜单显示“Enter 执行命令 | Tab 补全 | Esc 关闭补全”，file 菜单显示“Tab 补全 | Esc 关闭补全”，再按余宽添加真实阶段的 Enter 发送 / 入队（starting 时不可提交）。上下键提示为选择候选，不是移动草稿。Ctrl+J / Shift+Enter 继续插入换行而不执行候选。首次 Esc 仅关闭菜单并按现有 onEscapeDismiss 清中断预备；菜单关闭后恢复普通中断提示，不能在菜单上承诺 Esc×2 一定中断。toast 期间保留的是当前上下文实际拥有的 Esc clause。此次只补提示端口，不修改现有补全提交、取消或模式切换规则。

全局状态栏成为当前执行状态与唯一活动 spinner 的位置，toast 不影响它。沿用 `ActivityLine::liveSpinner` 的动画工厂，其他位置使用静态符号；`reducedMotion` 或 ASCII 能力下降时不启动动画。新 `runPhase` 从事件派生：starting → 启动中，runStart / turnStart → 等待模型，thinkingDelta → 正在思考，textDelta → 正在生成内容，toolExecStart → 正在运行工具，toolExecEnd → 等待模型，runEnd → 空闲 / 已中断 / 失败。压缩、等待用户确认、重试倒计时、停止中按实际状态覆盖一般阶段，优先级为等待确认、停止中、压缩、重试、当前工具、生成或思考、等待模型、闲置。

R03 事件落点：App 设置同步 `interactionPhase.current = 'starting'` 时同时派发轻量 `runStarting`，不伪造 agent_start；启动失败、取消、runEnd、reset、restore 均清理运行阶段。`thinkingStart` 即进入 thinking；tool_call_start/delta/end 在实际执行前显示“正在准备工具”，不能提前声称读取或修改文件。`reduceEvent` 将 `tool_execution_start` 自带的 toolName 和 toolCallId 放入 UI action，维护独立的 `activeTool`；toolExecEnd 只清理匹配 ID。阶段更新必须在查找普通工具卡片并 early-return 之前执行，`todo_write` 以及 `/clear` 后仍能显示真实工具；`/clear` 不清理运行事实。

普通 `notice(error)` 包含复制失败和斜杠命令错误，不能据此判断整次 Agent 失败。运行结局 `runOutcome` 只由 Core error 事件映射的运行错误标记、明确 abortMark 或现有无输出失败判定更新；未知的引擎结束原因只显示“已结束”，不猜测成功/中断。runStart 清除上一结局；结束后无 spinner。状态栏在 overlay 下继续承担运行指示，App 对其余动画站点的 reducedMotion 门控也以状态栏实际 spinner 是否存在为依据，不能沿用仅 `running && !overlay` 的旧条件。

`read_file` 工具明确映射为“正在读取文件”，`write_file` / `edit_file` 映射为“正在修改文件”，`bash` 映射为“正在执行命令”；未知工具显示真实工具名，不猜业务行为。普通旋转趣味短语不再作为执行阶段；保留原活动模块供已有组件引用，避免全局删除无关功能。

### 3.6 状态字段宽度与真实含义

先构造无 ANSI 的字段与候选短形式，再用 `stringWidth` 计算 cell。预留左边 1 cell 的 redraw carrier，余下宽度是唯一预算。统一分隔符为 ` | `（3 cells），每个字段 `Box width={field.cells} flexShrink={0}`，不使用左右 `space-between` 隐式挤压，也不让父级 overflow 截断数值。着色在测宽后施加，模型名称不再在顶部与底部重复。

| 字段 | 实际来源和统计范围 | 正常显示 / 紧凑显示 |
| --- | --- | --- |
| 运行状态 | 当前运行事件、实际工具、确认 / 压缩 / 重试状态 | 正在读取文件 / 读文件 |
| 待处理数 | `state.pendingSteering.length`，不是历史 queued 条目数 | 待处理 3 / 队 3 |
| 上下文 | `ContextUsageSnapshot.occupied / window`，仅当前 lead 上下文，不是会话累计 | 上下文 ~2.1k/128.0k tokens / 上下文 ~2.1k/128k tok |
| 估算标记 | `source === estimate` 或 `deltaTokens > 0`；未知窗口用 `windowKnown` | 分子前 `~`，未知分母后 `?`，不把未知值当精确测量 |
| 会话 token | `promptTokensOf(usageTotal)` = input + cacheRead + cacheWrite；另列 outputTokens | 会话 输入 12k 输出 3k tok；仅宽屏显示 |
| 会话费用 | `usageTotal.costUsd`；`addUsage` 汇总 turnEnd / teamUsage / fastUsage / compactionUsage；恢复会话承接已保存累计，reset 归零 | 会话估算 USD 0.0032；不称为本次任务费用或账单 |
| 速度 / 时长 | `App::tokPerSec`：本轮启动后 `usageTotal.outputTokens` 增量除以本轮 elapsedMs；仅运行中且超过 500ms 计算，使用已入账用量 | 本轮均速 12 tok/s、耗时 1m02s；按余宽显示 |
| 配置 | `agentMode`、pendingAgentMode、thinkingLevel | plan→build、think:xhigh；核心字段之后展示 |

`2.1k/12` 没有足够证据可还原原窗口值，不能根据截图猜成 12k 或 128k；当前源码明确用 occupied/window，旧片段可能是截断。`total 0↑` 是会话累计 prompt 侧 token（含缓存），`$0.0` 是格式化会话费用；`computeCost` 在缺价格时返回 0，因此所有费用统一标为估算，`/context` 说明“缺失价格贡献按 0，零值不保证免费”。不为本轮扩展 provider 价格模型。

速度并非当前模型逐 token 的瞬时生成速度：分子来自会话总量差值，可包含本轮期间入账的 Team、fast 与 compaction 输出；用量事件尚未到达时可能仍为零。保持现有计算但明确显示“本轮均速”，不显示“模型实时速度”；零值继续不占底栏。`/context` 同步说明这一统计范围，不为展示指标另造基于字符数的 token 估算。

布局算法：先给运行状态、非零待处理数和上下文保留最短完整形式；从低优先级字段中整项删除直到可容纳，再尽量提升这三个字段的详细形式。次要字段的保留优先级为非默认模式 / 活跃服务数量、会话估算费用、速度与时长、thinking、会话 token、百分比条、eco / fast。活跃后台服务不能完全消失：空间不足在操作提示行显示其数量和停止入口。TODO 可见时底栏不重复 TODO 计数。

上下文数值始终成对保留单位，不允许截成 `2.1k/12`。极端数值采用两位有效数字科学计数（例如 `1.2e9/2e9 tok`），优先于删掉分母。40 列用短状态、短数量及完整占用对；如果原始数量 / 数值连此形式仍放不下，则只显示状态及明确的 `/context` / `/queue` 查看入口，不能展示半个数字。小于既有 40 列或 12 行时沿用 too-small 占位，保留草稿和队列。

实施时采用以下确定性次序，不依赖 React 节点的自然收缩：

1. 将可用宽度取整并扣除 redraw carrier 的 1 cell；运行字段包含 spinner 和其后空格，它们也计入 cells。每两个字段之间预算 3 cells，无前后分隔符。
2. 构建核心最短字段：阶段短标签、非零数量 `队 N`、`上下文 ~已用/上限? tok`。近似与未知标记分别按真实快照决定，不能为节省一格删掉它们。数量为零时不显示 Queue 字段。
3. 为剩余字段建立顺序固定的候选列表：模式、服务数、会话估算费用、本轮均速、耗时、thinking、会话 token、占用条、eco、fast。依此尝试完整加入；放不下则跳过该候选，允许后续更短候选使用剩余空间。
4. 对已选择的核心字段按阶段、数量、上下文顺序尝试详细标签。每次仅在净增 cells 仍可容纳时替换；不为升级长标签挤掉已选次要字段。字段显示顺序固定为核心三项再接候选列表顺序，因此宽度变化不会任意交换字段。
5. 极端数据导致核心最短字段仍放不下时，先尝试成对科学计数；仍不适配则整项替换为 `/context`，队列数量仍放不下时整项替换为 `/queue`。保留阶段，不输出没有单位或缺分母的数字。完整值始终可从对应命令获得。
6. 数值非法或快照字段非有限值时显示“上下文未知”，不要输出 NaN、Infinity 或伪造 0；单元测试把这作为边界输入。最终断言总 cells 不超宽，主题颜色与 ANSI 在规划完成后施加。

`StatusField.tone` 到已有 Theme 的映射固定为 normal→primary、muted→muted、warning→noticeWarn、error→noticeError；不新增不存在的 `theme.error` 属性。40 列中文标签的长度通过 string-width 测量，不按 JavaScript 字符串 length 估计。正文摘要允许省略号，状态栏的数值字段不允许省略号。

R14 阶段自身也必须有有界候选。所有实际阶段提供完整短标签，例如“启动”“等待”“思考”“生成”“工具”“确认”“停止中”“压缩”“重试”“空闲”“中断”“失败”；已知文件工具可用“读文件 / 改文件”。未知工具的真实名称仅作为详细形式，先去除 ANSI、CR/LF 和其他控制字符，整段能放下才展示；否则使用准确但通用的“工具”，不把任意名称当成最短阶段。完整工具名仍保留在既有工具记录中。重试错误正文和文件路径也不拼入最短阶段。先以这些短形式完成核心字段及第 5 步降级，再加入次要字段并尝试详细形式，保证超长名称不能挤出全部数字或导致阶段本身换行；不增加第二套状态来源。

### 3.7 高度、对齐与渲染不变量

`frameHeight(rows) < rows` 不变，正常高度仍为 rows−1；固定三行不变，文档 viewport = frameHeight−3。`Composer` 高度变为边框 2 行加可见草稿行；Queue 高度由同一 `buildQueueLayout` 结果驱动渲染与布局预测。`buildTodoRailLayout` 的 footer 预算包含 queueRows，popupMaxHeight 不能只扣 composer；team 预算同样扣 queue 和 composer。TODO 的可视高度保持 viewport，不跟着 Queue 单独缩短。

R05 分配顺序固定且无循环：先求 viewport V 和 composer C，再以 `min(产品队列上限, max(0,V−C−1))` 给 Queue 可用行数 Q，至少保留一行文档空间；仅剩一行队列空间时合并标题和首条摘要。然后 team 使用 `max(0,V−C−Q−1)`，最后 popup 使用 `max(0,V−C−Q−teamRows−1)`；popup 不反向改变 team/queue 容量，不足既有最小高度时隐藏菜单而保留键盘编辑。Queue 的摘要宽度使用 rail 分配后的左侧 `contentCols`，不使用全终端宽度；rail 的可见性仍只依赖原条件，不能被 popup 占用反向驱动。把 `availableRows` 作为 queue planner 输入，所有消费者使用相同结果。12 行终端 V=8、三行草稿 C=5、Q=2，仅余 1 行给文档，team 与 popup 为 0；20 行 V=16、C=7、Q=4，team/popup 总共最多 4 行。跟随尾部时 footer 不超出 V−1，普通历史可继续统一滚动访问。

`ScrollViewport` 继续实测整个 footer；填充只存在于转录与 footer 之间，短会话输入框贴底，输入框下方不再产生额外空行。跟随尾部时新增 / 接收队列项按 footerDelta 调整，浏览历史时保留锚点；不每个 token 调用 pinToBottom，也不因队列变化清除用户正在编辑的草稿。首次用户入队沿用现有提交时回到底部行为。

Queue 摘要按 ID / text / width 缓存，状态字段规划只依赖语义字段和列宽。文本 delta 不重建稳定 Queue 项；Draft 行数变化才向上报告高度。沿用 render governor、frame differ、选区镜像与唯一 stdout 写入路径。中文颜色沿用 theme：输入焦点用 focusBorder / primary，排队标题用 accent，普通提示 muted，错误 noticeError，运行阶段用既有 toolRunning；不引入额外高亮背景或动画。

## 4. 接口设计

无新增 REST / WebSocket / 非交互 CLI 协议，`aragon exec` 事件 schema 不变。新增交互斜杠命令 `/queue`，无参数，空队列也可打开查看。`/terminal-setup` 继续只输出配置说明，增加宿主复制设置和替代键限制；`/copy` 等待异步结果后提示。

以下是接口契约，不是本节点实现代码：

```ts
interface ClipboardOptions {
  write?: (chunk: string) => void;
  remote?: boolean;
  timeoutMs?: number; // 默认 1500
  signal?: AbortSignal; // 卸载或显式取消，不发迟到反馈
}
type CopyResult =
  | { status: 'confirmed'; via: 'native' }
  | { status: 'sent'; via: 'osc52' }
  | { status: 'failed'; reason: 'empty' | 'unavailable' | 'write' | 'timeout' | 'too-large' | 'cancelled' };
interface ClipboardTask {
  result: Promise<CopyResult>; // 用户结果只兑现一次
  released: Promise<void>; // 所有可能的写入已结束，才可释放协调锁
}
// startClipboardTask(text: string, options?: ClipboardOptions): ClipboardTask
// copyText(text: string, options?: ClipboardOptions): Promise<CopyResult>
// requestCopy(request: { text: string; lines: number }): Promise<CopyResult | { status: 'busy' }>
// requestCopy 是 App 注入 CommandContext 的同一协调入口；busy 不代表失败或已复制。
// 协调器读取 task.result 发反馈，读取 task.released 解锁；两者不可混用。

interface QueueLayoutInput {
  pending: readonly PendingSteering[];
  columns: number;
  terminalRows: number;
  availableRows: number; // 第 3.7 节统一高度预算
  paused: boolean;
}
interface QueueLayout {
  rows: number;
  title: string;
  items: readonly { queueId: string; label: string }[];
  hiddenCount: number;
}
// buildQueueLayout(input: QueueLayoutInput): QueueLayout

interface StatusField {
  id: string;
  text: string;
  cells: number;
  tone: 'normal' | 'muted' | 'warning' | 'error';
}
// planStatusFields(input: StatusLayoutInput): readonly StatusField[]
// buildActionClauses(input: ActionHintInput): readonly string[]
```

`StatusLayoutInput` 聚合 columns、phase、pendingCount、context、usageTotal、thinkingLevel、elapsedMs、tokPerSec、mode、pendingMode、servicesActive 和当前已有可选状态参数；不重新采集 Core 数据。`ActionHintInput` 聚合 interactionPhase、interruptHint、selectionPending、copyInFlight、copyCleanupPending、completion、services、overlay、cols、hintsEnabled 和 toast；completion 缺省 none，copyCleanupPending 表示失败已报告但资源尚未释放。PromptInput / Composer 新增 `onCompletionContextChange?: (context: 'none' | 'slash' | 'file') => void`，由实际布局而非 App 推测菜单可见性。`SelectionBridge.onCopied` 参数从 CopyVia 改为 CopyResult，调用方及测试桩全部同步迁移，不能保留一处把 Promise 当同步值。

队列相关纯函数在 `agent/queued-messages.ts` 中使用以下签名，调用者不得绕过 reducer 改写集合：

```ts
// 返回显示投影；原始 entries 和 pending 均不修改。
// 无活动 pending 时可直接返回 entries，避免文本流触发无意义重建。
// selectTranscriptEntries(entries: Entry[], pending: readonly PendingSteering[]): Entry[]

// 先匹配 pending 中的 ID，再合并缺失条目，再转换匹配条目为 user。
// reconcileSteeringReceipt(options: {
//   entries: Entry[];
//   pending: readonly PendingSteering[];
//   ids: readonly string[];
// }): { entries: Entry[]; pending: PendingSteering[]; changed: boolean }
```

`reconcileSteeringReceipt` 只负责投影与匹配，不读写 `seenSteeringIds`、seq、droppedEntries。reducer 负责调用并应用现有条目裁剪策略；`changed:false` 时直接返回原 state。`steerQueued` 先查询 seen 集合，再通过新 Set 加入 ID，最后追加原文；这样接收与去重职责清晰，未来测试不必依赖整个 App。面板的 `hiddenCount` 必须等于 pending 总数减去实际摘要行数量，不能根据文字截断与否计算；无可用行时返回 rows=0、items=[]，状态栏和 `/queue` 仍提供真实数量及内容。

`/queue` 的命令注册必须进入同一个 registry，使用其现有命令补全与帮助元数据，不在 PromptInput 添加特殊分支。普通输入 `/queue` 成功打开后只消费命令文本；若是程序调用 setOverlay，则不动正在编辑的草稿。恢复历史的未发送 queued 不出现在活动 `/queue` 列表中，须通过普通会话历史查看，避免用户将它误认为已经重新入队。

## 5. 数据模型与不变量

不新增数据库或持久化 schema。`PendingSteering { readonly queueId:string; readonly text:string }` 保持原结构；paused 从运行状态派生，不额外存可能失真的 status。`ViewState` 增加会话内 `seenSteeringIds: ReadonlySet<string>`，不可原地修改既有 Set。增加运行事实 `runPhase: 'idle' | 'starting' | 'waiting' | 'thinking' | 'generating' | 'preparing-tool' | 'tool'`、可选 `activeTool: { toolCallId:string; name:string }` 和 `runOutcome: 'none' | 'ended' | 'interrupted' | 'failed'`；新增 runStarting / 运行错误 action 及携带 toolName 的 toolExecStart，按 3.5 更新。停止、重试、压缩和人类确认仍读原来的专用状态。以上都是 UI 内存投影，不进入会话文件或 Core 事件 schema。`Overlay` 扩展 `'queue'`，滚动偏移继续由 App 的 overlayScroll 管理。

编辑器继续保存 buffer、UTF-16 cursor、pastes、补全状态；增加可选 `preferredVisualColumn`，仅连续上下移动保留，插入、删除、左右移动、Home / End、召回或 resize 后清除。导航模块返回 UTF-16 索引与视觉列，不在原文本插入折行符。应用复制任务只保存快照和 in-flight 标志，不持久化正文。

必须长期满足：

1. 输入清空与队列接收是不同事件；只有合法接收凭据才正常移除 pending。
2. 每个 pending ID 对应同一份原始文本；面板摘要、全文和保存使用这一文本。
3. 接收转换后的 user 转录与 pending 移除在同一个 reducer 返回值中完成。
4. 重复凭据、未知 ID、旧会话 ID 均无副作用；相同文字的不同 ID 不能合并。
5. 复制按键永不同时中断、退出或停止服务；复制成功必须有原生工具完成信号。
6. 编辑器的显示折行不污染提交内容；字符导航不切断 Unicode 字素或粘贴 token。
7. 所有行的 cell 总宽不超过容器，测量数据不包含 ANSI，所有数值字段完整展示或整项隐藏。
8. 输入、队列、覆盖层、缩放不销毁编辑器实例；Core 不接触 UI、进程或宿主配置。
9. 入队失败不留下保护 ID；同 ID 登记动作在本会话接收前后均幂等；force-stop 不能丢掉已写历史的接收凭据。
10. 复制两个入口共享一个同步占用锁；超时任务不能与下一任务竞写；取消后不写终端、不更新已卸载 UI。
11. 运行事实不依赖转录是否可见；任意复制/命令错误不得污染 Agent 运行结局。
12. 可见补全的真实按键语义决定操作提示；隐藏菜单不占用提示上下文，非空新草稿不被上下键历史召回覆盖。
13. 剪贴板结果完成与写入资源释放分别跟踪；失败反馈不能提前解锁，迟到 close 不能再发成功反馈。

## 6. 文件 / 模块变更计划

表中均为下游实施文件；本轮评审节点唯一修改交付文件是本 `spec.md`。未列为修改的现有模块只做复用或回归验证。`C/` 代表 `packages/cli/src/`，表内路径按此前缀展开。

| 操作 | 文件 | 意图 |
| --- | --- | --- |
| 本节点修订 | `docs/plans/tui-composer-queue-status/spec.md` | 保留 v2 评审历史，补充本轮复核、确定性算法及验收规范 |
| 新增（实施时） | `docs/plans/tui-composer-queue-status/manual-test.md` | 记录宿主版本、输入字节、剪贴板读回、截图及性能数据 |
| 新增 | `C/ui/editor-navigation.ts` | 共用字素边界、视觉行 / UTF-16 索引映射与上下导航 |
| 修改 | `C/input/stdin-filter.ts` | 仅非粘贴路径规范化 DEL 为 Backspace，避免 Ink 丢失前后删除区别 |
| 修改 | `C/ui/editor-reducer.ts` | 分离 Delete / Backspace，保留视觉目标列，原子 token 删除 |
| 修改 | `C/ui/PromptInput.tsx` | 简短占位、导航接线、保留历史召回门槛、上报实际可见补全类型 |
| 修改 | `C/ui/composer-rows.ts` | 使用共用字素映射，维持宽度和光标一致 |
| 修改 | `C/ui/composer-limits.ts` | 采用不超过 6 行的统一输入高度上限 |
| 新增 | `C/ui/interaction-copy.ts` | 集中本轮中文文案与 ASCII 符号降级，源码使用转义 |
| 修改 | `C/ui/clipboard.ts` | 异步工具完成、编码、超时、OSC 52 未确认结果；内部任务分开 result / released |
| 新增 | `C/ui/clipboard-task.ts` | 共用复制协调、同步 busy、取消、单次反馈和清理；只由 released 释放锁 |
| 修改 | `C/commands/registry.ts` | CommandContext 注入统一 requestCopy；所有上下文工厂及测试 fixture 同步迁移 |
| 修改 | `C/cli.tsx` | 从实际 stdin filter 传递 deleteDisambiguated 能力，不改变终端启停顺序 |
| 修改 | `C/ui/selection/selection-controller.ts` | 更新 SelectionBridge 的结果类型及过时注释，保留选区机制 |
| 修改 | `C/agent/reducer.ts` | 会话去重、有序回填、运行事实 action 与清理、queue overlay 类型 |
| 修改 | `C/agent/controller.ts` | 入队异常只回滚本次保护 ID，保持既有回执与世代规则 |
| 修改 | `C/agent/queued-messages.ts` | 抽取凭据与转录显示投影纯函数，保留 mergePendingEntries |
| 新增 | `C/ui/QueuePanel.tsx` | footer 内的有限高度逐条待处理区域 |
| 修改 | `C/ui/QueueStatusRow.tsx` | 保留摘要净化，导出字素裁剪供新面板使用；不再替换状态栏 |
| 新增 | `C/ui/layout/queue-layout.ts` | 队列行数、摘要和隐藏数的唯一规划函数 |
| 新增 | `C/ui/overlays/QueueOverlay.tsx` | pending 全文及实时变更后的锚点恢复 |
| 新增 | `C/ui/interaction-hints.ts` | 完整操作 clauses 的优先级及测宽选择 |
| 修改 | `C/ui/Composer.tsx` | 删除重复 RunRow / hint，保留输入框与草稿回调，透传补全上下文回调 |
| 修改 | `C/ui/BottomStatusRow.tsx` | 将既有固定一行改为操作提示与短反馈组合 |
| 新增 | `C/ui/layout/status-layout.ts` | 核心数值优先、字段整体降级的 cell 布局，动态阶段名称使用有界短标签 |
| 修改 | `C/ui/StatusBar.tsx` | 独立字段渲染，运行状态和唯一 spinner，移除 QueueStatusBar 特判 |
| 修改 | `C/ui/run-status-row.ts` | 扩展活动 phase 数据，旧宽度函数兼容保留，不新增调用 |
| 修改 | `C/ui/ActivityLine.tsx` | 从真实阶段产生 label，保留现有 spinner 工厂 |
| 修改 | `C/ui/layout/budget.ts` | 更新 composer 预算与注释，viewport 固定三行规则不变 |
| 修改 | `C/ui/layout/todo-layout.ts` | 为 queueRows 纳入 popup / footer 预算，TODO 高度不变 |
| 最终审查补充 | `C/ui/use-wheel-routing.ts` | 将 queue 纳入受控覆盖层滚轮路由，与键盘分页共用偏移 |
| 修改 | `C/ui/App.tsx` | 接通 overlay 受控按键和真实 pending、能力端口、共享复制协调、阶段 action、补全提示上下文与完整预算 |
| 新增 | `C/commands/queue-command.ts` | 注册只读 `/queue`，复用 setOverlay 端口 |
| 修改 | `C/commands/builtins.ts` | 注册新命令、await /copy、补终端配置说明、reset / resume 取消数量反馈 |
| 修改 | `C/compaction/context-command.ts` | 明确 token 与估算费用统计范围及缺价格限制 |
| 修改 | `C/ui/overlays/HelpOverlay.tsx` | 统一快捷键和 /queue 说明 |
| 修改 | `packages/cli/README.md` | 新布局、队列、精确宿主配置及未经实测不得声称通用的限制 |
| 新增 | `C/__tests__/editor-navigation.test.ts` | CJK、emoji、组合符、逻辑 / 视觉换行导航 |
| 修改 | `C/__tests__/editor-reducer.test.ts`、`C/__tests__/composer-rows.test.ts`、`C/__tests__/prompt-input-commits.test.tsx` | 前后删除、光标与提交原文一致 |
| 修改 | `C/__tests__/input.test.ts` | 验证 DEL、BS、CSI Delete 的 Ink 前规范化及粘贴不受影响 |
| 修改 | `C/__tests__/stdin-filter.test.ts`、`C/__tests__/controller-prompt-boundary.test.ts` | 真实过滤器降级路径、入队抛错保护集合回滚 |
| 新增 | `C/__tests__/clipboard-task.test.ts` | 跨入口重入、迟到退出、取消后反馈屏蔽和资源回收 |
| 修改 | `C/__tests__/clipboard.test.ts`、`C/__tests__/app.test.tsx` | 异步结果、真实优先级、in-flight 与错误分支 |
| 修改 | `C/__tests__/queued-messages.test.ts`、`C/__tests__/queue-lifecycle.test.tsx`、`C/__tests__/queue-status-row.test.tsx` | 幂等、回填、面板摘要及回执联动 |
| 新增 | `C/__tests__/queue-panel.test.tsx`、`C/__tests__/queue-overlay.test.tsx`、`C/__tests__/queue-command.test.ts` | 逐条限高、全文分页、命令接线和草稿保存 |
| 新增 | `C/__tests__/status-layout.test.ts`、`C/__tests__/interaction-hints.test.ts` | 字段优先级、数值完整、clause 选择和中文宽度 |
| 修改 | `C/__tests__/status-bar-context.test.tsx`、`C/__tests__/status-bar-scroll.test.tsx` | 新标签、滚动时 pending 数量与上下文同时可见 |
| 修改 | `C/__tests__/bottom-status-row.test.tsx`、`C/__tests__/composer-run-row.test.tsx`、`C/__tests__/interrupt-ladder.test.tsx` | 适配单一操作行，保留中断 / 退出行为 |
| 修改 | `C/__tests__/activity-tool-label.test.tsx`、`C/__tests__/activity-line.test.tsx`、`C/__tests__/single-spinner.test.tsx` | 真实阶段、toast 不抢 spinner、低动态模式 |
| 修改 | `C/__tests__/budget.test.ts`、`C/__tests__/todo-layout.test.ts`、`C/__tests__/unified-scroll-layout.test.tsx`、`C/__tests__/todo-app-layout.test.tsx` | 新 footer 高度与共享基线 |
| 修改 | `C/__tests__/terminal-setup-command.test.ts`、`C/__tests__/queue-session.test.ts` | 文档配置、取消数量及历史恢复不重放 |

不计划修改 Core 源码、Core 公共接口、package 版本、lockfile、AppShell 固定槽数、ScrollViewport 的单文档滚动算法、主题配置或持久化 schema。相应现有测试纳入回归；若发现真正需要改变这些契约的失败，先更新本 spec 与变更表再实施。

## 7. 测试与验收标准

### 7.1 已有基线记录与复验命令

原设计记录执行以下命令，5 个文件、58 项测试全部通过，退出码 0；Vitest 4.1.9 输出总耗时 4.97 秒。上游方案节点的复验结果见第 10 节，历史耗时不作本轮评审的性能证据。这是基线验证，不代表新增设计已实现，也不代表真实宿主测试通过。

```powershell
npm exec -w packages/cli -- vitest run src/__tests__/enter-sequences.test.ts src/__tests__/enter-frames.test.ts src/__tests__/composer-input.test.ts src/__tests__/queue-lifecycle.test.tsx src/__tests__/clipboard.test.ts
```

源码已经把 LF / Ctrl+J 与 Alt+Enter 映射到换行，Enter 解码和粘贴事务基线通过；任何“所有终端都有效”的说法应从帮助中去掉，宿主能拦截快捷键。本文没有使用真实系统剪贴板测试冒充 mock 测试。

### 7.2 自动化验收矩阵

| 编号 | 场景 / 操作 | 必须观测的结果 |
| --- | --- | --- |
| I01 | 首、中、尾插入 Shift+Enter 的 CSI-u、Ctrl+J、Alt+Enter | 恰好一个 `\n`，无提交、无 `[13;2u` 残留；任意字节拆包结果相同 |
| I02 | 中文、英文、路径、代码、CRLF、空行、200 行 bracketed paste | 原换行及缩进保留，零自动发送，超限显式拒绝且旧草稿不损坏 |
| I03 | 重复 / 合包 Enter、starting 拒绝、队列调用抛错 | 不重复提交；拒绝或失败保留完整草稿 |
| I04 | 中文混合全角、`e` 加组合重音、emoji，自动折行与主动换行；DEL、BS、CSI Delete 及 Alt+DEL 经实际 Ink | 两种 Backspace 都向前删，CSI Delete 向后删；左右不拆字素；视觉上下正确；发送文本不含自动折行 |
| I05 | 12 / 20 / 24 / 30 行，连续输入 50 行 | 高度上限 3 / 5 / 6 / 6，光标一直可见，其余内容可通过光标滚动访问 |
| I06 | stdin filter 创建失败、mouse/paste 组合开关、分包 Alt+DEL；窄 rail 与 overflow chip 下导航 | 降级 Backspace 不反向删除；正常过滤时只有键输入规范化；粘贴 payload 不变；单按键一次 editor 提交，实际正文列宽一致 |
| I07 | 非空新草稿的单行首尾和多行边界按 Up/Down；空草稿召回后编辑再到边界 | 新草稿不被历史覆盖；空草稿可召回，召回内容先视觉导航；编辑后退出历史遍历，每次只提交一次编辑 action |
| C01 | 拖动并松开有效选区，不按键 | copyText 调用次数 0；Ctrl+C 后恰好 1 次 |
| C02 | 选区 + 正在执行 / 服务运行 / 已预备退出 | 复制不触发 abort、stopAllServices 或 exit；重置旧退出 timer |
| C03 | 无选区、空白选区、拖动未完成 | 原有 Ctrl+C 服务停止及双击退出规则完全保留 |
| C04 | 原生 exit 0、exit 1、ENOENT、EPIPE、超时、重复 close / error | confirmed 仅出现在真正正常完成时；其他分支降级或失败且只 settle 一次 |
| C05 | OSC 52 成功写出但无回执、超长 UTF-8 字节、writeForeign 抛错 | 不标成功，超长不截断复制，最终失败有明确反馈 |
| C06 | 复制中连按 Ctrl+C、卸载、resize / frame invalidation | 无重复复制或退出；无卸载后 setState、无正文泄漏 |
| C07 | `/copy` 与选区交错启动；超时后迟到 error/close；取消与成功同 tick | 共享占用，无竞写或双反馈；未终止任务不降级覆盖剪贴板；无未处理 error；正常 X11 持有者不被误杀 |
| C08 | result 已报 timeout、released 尚未完成时触发另一入口，再触发迟到 close / 卸载 | 先显示失败清理且继续 busy，零新写入；close 后才允许新任务；不重复反馈，卸载后永久拒绝新任务且无未处理 rejection |
| Q01 | 连续提交 3 条，第一、三条文字相同 | 三个 ID、FIFO 三条摘要，待处理 3；非文本去重；普通转录不重复展示 pending，保存仍有完整 queued |
| Q02 | 仅出队、发送返回、重绘、清草稿、工具输出、通知 TTL 到期 | pending 不减少，Queue 不被普通输出取代 |
| Q03 | 接收 batch 的监听器检查 Core 历史；重复 / 乱序 / 未知回执 | 历史先有完整 batch；只转换匹配 ID，正常转录与 pending 原子变更 |
| Q04 | /clear 或条目上限裁剪后再接收 | 从 pending 回填 user 文本，无“队列消失但消息不在会话”的间隙 |
| Q05 | abort、provider error、正常结束前未接收 | 保留并标暂停；下一执行只消费一次；不定时清空 |
| Q06 | /queue 查看 50 条含长代码的全文；期间接收其中几条 | 有界 viewport 可分页到每条全文、顺序正确、锚点稳定、草稿完整 |
| Q07 | /reset、/resume、保存退出及恢复 | 取消数量明确，保存 pending 文本，恢复不静默重发 |
| Q08 | steer 抛错；queued→accepted→重复 queued；/clear 后重复登记 | 无幽灵保护 ID、草稿保留；已接收 ID 不重新出现，其他 pending 不受影响 |
| Q09 | A/B/C 中 A 被裁剪；乱序凭据；接受后同 tick force-stop | 补回仍为 A/B/C，保留现有条目 ID；已提交历史的回执照常结算；裁剪计数正确 |
| Q10 | 通过 App 真实按键打开 /queue 并翻页；长逻辑行 resize；含 tab/ESC 的原文 | 一键只滚一次；正文宽度和锚点正确；无原文控制码执行；overlay 下 pending 数量仍可见 |
| L01 | 40 / 60 / 80 / 100 / 120 / 160 列及任意中间宽度 | 每行 cell 宽度不超限；核心数值和单位完整；think:xhigh 后有独立分隔 |
| L02 | 有队列、超大 token 值、未知窗口、缓存命中、缺模型价格 | 队列数与上下文并存；近似 / 未知标记正确；会话 token 含缓存；费用标估算 |
| L03 | idle→starting→generating→read_file→retry→runEnd | 阶段由事件变化，准确映射工具，不用旋转词伪装实际动作 |
| L04 | toast、服务存活、选区、中断预备、hints=false、提交 100 次 | 唯一操作提示行；中断仍可发现；没有重复完整 Esc 提示 |
| L05 | TODO 开关、队列 0→3→0、长输入、overlay、too-small 往返 | 左右 viewport 同底线，固定两条底栏不移动，编辑器不 remount |
| L06 | 30 秒高频文本流，同时复制、输入和调整窗口 | 一个活动 spinner，文字无残留，不整屏清屏，草稿和光标不丢失 |
| L07 | starting 取消、工具参数生成、todo_write、执行中 /clear、复制失败、引擎结束 | 阶段与事实一致；无工具卡也可显示工具；复制错误不把 Agent 标为失败；结束清理活动状态 |
| L08 | 40×12 / 80×20，最大草稿 + 队列 + Team + TODO + 补全同时存在 | C+Q+team+popup ≤ V−1，菜单按容量降级；光标和队列摘要可见，左右基线稳定 |
| L09 | starting、普通运行、queue/confirm overlay、闲时更新可用、选区、toast 交错 | 文案与实际按键所有权一致；更新仍有入口；overlay 与 toast 不新增或吞掉唯一活动指示 |
| L10 | running / starting 下可见 slash 或 file 菜单；一次 Esc、Enter、换行；resize 使菜单不可见 | slash Enter 执行所选命令而提示不说入队；file 的 Tab / Esc 与实际一致；首次 Esc 不预备中断，隐藏菜单恢复阶段提示，换行不执行命令 |
| L11 | 40–200 列，未知工具名长达 500 字符并包含中文 / ANSI / 换行，叠加大数量及未知窗口 | 阶段退为完整“工具”，无控制序列执行，无第二行；正常核心数值不因工具名消失，极端值按规定整项降级 |

纯函数测试遍历列宽 40–200，并验证 `sum(field.cells) + separators + gutter <= columns`。使用真实 Ink 渲染、`measureElement` 和现有 terminal harness 验证布局，不能仅断言组件 props 或静态字符串。对 Q03 继续运行 Core `steering-acceptance.test.ts`，保证 UI 设计没有反过来放宽引擎契约。

### 7.3 Windows 宿主配置与真实验收

Windows Terminal：打开设置中的 JSON 文件，在根级配置 `"copyOnSelect": false`，与 profile 设置区分开。该选项控制宿主鼠标选区自动复制，来源为 [Windows Terminal 交互设置](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/interaction)。Shift+Enter 配置使用具名 action 与 keybinding，合并现有数组，不覆盖用户配置；`sendInput` 的字节发送行为见 [Windows Terminal actions](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions)。

```json
{
  "copyOnSelect": false,
  "actions": [
    { "id": "User.AragonNewline", "command": { "action": "sendInput", "input": "\u001b[13;2u" } }
  ],
  "keybindings": [
    { "keys": "shift+enter", "id": "User.AragonNewline" }
  ]
}
```

VS Code：用户设置加入 `"terminal.integrated.copyOnSelection": false`；键盘快捷方式 JSON 加下列条目，用 `terminalFocus` 限定作用范围。复制设置来自 [Terminal Basics](https://code.visualstudio.com/docs/terminal/basics)，发送序列与 Unicode 转义格式来自 [Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)。

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "when": "terminalFocus",
  "args": { "text": "\u001b[13;2u" }
}
```

分别记录 Windows Terminal 与 VS Code 的实际版本、PowerShell 版本、Node 版本、字体、rows / columns、mouse / mouseSelect / paste / hints 配置。PowerShell 是 shell，不是终端宿主；不把上述绑定写入 PowerShell profile。两个主宿主都要在 Node 22.17+ 的版本及另一当前维护版本运行；旧 Node 对 Windows VT 鼠标的限制按现有项目说明做降级测试，不将无法收到鼠标报告误诊成复制错误。

每个宿主都执行：分别不绑定和绑定 Shift+Enter，验证 CR 不可区分的限制及绑定后的独立序列；验证 Ctrl+J 真正插入换行；若 Alt+Enter 被宿主全屏快捷键拦截，明确标“不适用”，不能笼统说三键通用。用微软拼音输入“你好，世界”，按 Enter 确认候选，再按 Enter 发送；前一次不得发送。对中文、英文、多行代码和 `M:/项目/a.ts` 拖选：松开后剪贴板保持原内容，Ctrl+C 后在纯文本编辑器和 `Get-Clipboard -Raw` 检查结果。比较时只允许 Windows CRLF 与应用 LF 的标准化差异；中文、空行、代码缩进、路径内容不得变化。手动验证前后保存并恢复原剪贴板，测试文字不用真实敏感信息。

终端配置核对完成不等于真实输入已实测。实施人员必须把每项 pass / fail、宿主版本与证据写入 `manual-test.md`；缺少真实宿主、IME 或系统剪贴板结果时标记“待验收”，不能标全功能验收通过。

### 7.4 实施后的命令与性能门槛

以下每条命令单独运行并检查退出码，禁止在 Windows PowerShell 5.1 用 `&&` 串接。新增测试先构造能失败的行为断言，修复后运行对应集合；最后一次性完成下列回归，不能只更新快照掩盖行为变化。

```powershell
npm exec -w packages/cli -- vitest run src/__tests__/editor-navigation.test.ts src/__tests__/clipboard.test.ts src/__tests__/queue-panel.test.tsx src/__tests__/queue-overlay.test.tsx src/__tests__/status-layout.test.ts src/__tests__/interaction-hints.test.ts
npm exec -w packages/core -- vitest run src/__tests__/steering-acceptance.test.ts
npm run typecheck
npm test
npm run build
```

继续运行现有 input / enter / paste / selection / unified-scroll / queue-session / glyphs / spinner 全量回归；非交互 exec 不新增 UI 输出。性能使用既有 render governor / frame observer 记录连续 30 秒，160×40 与 80×24、1000 条转录、50 条 pending、持续 30 次/秒 delta 的固定输入。比较同机同宿主基线：frame flush P95 不高于基线 20% 且不高于 50ms；按键到草稿渲染 P95 ≤100ms；无每 token 全屏清空，无随已结束复制任务持续增长的 timer / listener。若设备达不到绝对值，保留原始数据并记失败原因，不降低标准后宣称通过。

## 8. 下游实施顺序

1. 为入队失败、缺失转录顺序和接收后重复 ID 补失败用例；实现 controller 回滚、`queued-messages` 纯投影和 reducer 原子更新；跑 queued-messages、queue-lifecycle、queue-session 与 Core steering-acceptance。
2. 为异步复制的失败 / 超时 / 重复 Ctrl+C 写用例；先打通共享 clipboard-task 和 CommandContext 端口，再改 clipboard、SelectionBridge、App 与 /copy 的所有调用点；确认退出、服务停止、卸载和迟到子进程测试通过。
3. 以 Unicode 导航和 Delete 的最小失败用例驱动 editor-navigation；接入能力透传、reducer / PromptInput / composer-rows，调整上限并验证过滤器失败、粘贴与软硬换行。
4. 实现 queue-layout、QueuePanel、/queue 和 QueueOverlay；在 footer 和 App 按键名单接线，统一 queue/team/popup 高度预算；验证 50 条全文可访问和草稿不重挂载。
5. 实现完整运行事实 action 与状态标签、status-layout、interaction-hints 和中文文案常量；再迁移 Composer、BottomStatusRow 和 StatusBar，保留更新入口。一次迁移全部旧提示，不留两套有效路径。
6. 更新帮助、README、/terminal-setup 与 /context；按完整测试命令跑类型、回归及构建；补真实宿主和性能证据。

每一步的产出必须满足前述不变量；本设计不要求本节点创建实现分支、运行发布脚本、安装依赖或提交任何 Git commit。

下游合并按上述依赖顺序进行，每步通过相关测试再进入下一步；不新增用户可配置开关或两套长期并存 UI。回退以完整步骤为单位：异步复制 API 与所有调用者必须一起回退；Delete 能力透传与按键语义一起回退；queue footer、预算和状态栏一起回退。回退不得触碰 Core 已消费历史、重投递 pending 或清空用户草稿，也不得覆盖本工作区已有的 package/lockfile 改动。无需持久化迁移；发布门槛未过时保留当前发布版本，不能以设计评审通过替代功能发布批准。

## 9. 风险、缓解与备选方案

| 风险 | 缓解措施与明确边界 |
| --- | --- |
| 多份旧 spec 或注释与统一滚动现状冲突 | 以当前 ScrollViewport / AppShell 事实及本轮 spec 为准，更新触及模块过时注释；不恢复固定 composer |
| 移动提示行改变既有快照 | 先断言真实高度、位置、快捷键行为；然后更新有意变化的文字断言，不能直接批量接受快照 |
| 队列只展示前三条被误解为丢消息 | 标总数与隐藏数，/queue 逐条提供完整文本；固定状态栏数量永远读 pending |
| /clear 或条目裁剪使回执后内容消失 | 回执处理先从 pending 重建缺失 user，再移除 pending；重复凭据无副作用 |
| OSC 52 无可确认回执 | 只提示请求已发出，不能给绿色成功；本地使用原生工具完成结果 |
| 本地剪贴板工具超时、乱码或退出错误 | 明确编码、1.5 秒 timeout、stdin 错误处理、真实读回中文矩阵 |
| 应用选区和宿主选区混淆 | 帮助说明所有权，宿主配置只提供方法不自动改写；/mouse status 继续报告当前应用捕获能力 |
| 中文 IME / Shift+Enter 与普通 Enter 相同编码 | 不推断丢失的信息；记录宿主限制，使用独立换行绑定和括号粘贴替代 |
| 中文文案触发 ASCII 扫描 | 集中 Unicode 转义；glyphs 统一符号；测试检查运行时中文及源码规范 |
| 40 列无法同时显示所有指标 | 核心字段先分配完整短形式；次要指标整项隐藏；/context、/queue 保证完整查询 |
| 费用为零被误读为免费 | 明确会话估算 USD 和缺失价格按零统计的现状；不宣称真实账单 |
| 多行与队列增加 footer 导致跳动 | 渲染和预算共享 planner；沿用 footerDelta / 锚点；不增加固定槽或第二个滚动模型 |

比较过三种方案：直接扩展现有一行 QueueStatusBar 改动小，但无法同时保留核心指标和逐条消息，舍弃；新建 UI 专属队列并在发送成功后删条目实现容易，但会与 Core 的真实接收状态分离，舍弃；本方案保留 Core 凭据、新增只读投影面板并统一底栏，改动覆盖面较广，但每项状态有唯一来源，且不破坏现有滚动和运行协议。

## 10. 设计交付与验收责任

上游方案节点完成标准是：只修订本 spec，保留已有 v2 评审历史，提供概述、技术设计、完整文件计划、接口、数据模型、测试验收与风险；文件存在并在 git status 中可见，中文篇幅超过 800 字。方案节点完成不意味着第 7 节新增功能测试、构建或真实宿主验收已经通过。

第 7.1 节原有耗时及已有评审的 15.94 秒记录是历史证据。上游方案节点记录在 Node v22.18.0、npm 10.9.3、Vitest 4.1.9 下重新运行第 7.1 节 CLI 命令：5 个文件、58 项测试通过，退出码 0，总耗时 19.99 秒。另外执行 `npm exec -w packages/core -- vitest run src/__tests__/steering-acceptance.test.ts`：1 个文件、15 项测试通过，退出码 0，总耗时 5.70 秒。合计 73 项通过，仅验证当前实现基线，没有新增功能已实现的含义。

上游还记录核查了 `acceptSteering` 的先写历史后发凭据、controller 的预登记保护 ID、reducer 缺失转录的处理缺口、Ink 的 DEL/CSI Delete 解析、剪贴板两个生产调用点和 Theme 实际字段，并复核第 7.3 节 Windows Terminal / VS Code 官方配置资料。实现、补充测试、完整构建、Windows 双宿主输入 / IME / 剪贴板与 30 秒性能采样由下游按本 spec 完成；历史黑板中的待验收项继续保留，不在设计阶段清除。

本轮 Subtask #1 独立读取 CLAUDE、项目索引和相关源码，重点复核 `PromptInput::resolveSubmit/verticalOrHistory`、`App::handleSubmit/useInput`、`mergePendingEntries`、`acceptSteering`、`buildTodoRailLayout`、`OverlayFrame` 及复制入口；重新查阅第 7.3 节所链接的四份官方配置文档。R11–R14 的四项 P1 已落实到技术正文、接口和对应反例，R15 的历史归属已修正。本轮验收限于文档结构、引用路径、修订范围及设计一致性检查；不运行功能测试或构建，不把未实现的接口当成可执行代码。使用 verification-before-completion 技能核验实际落盘内容后再上报。当前节点仅修改 spec.md，不修改产品源码、不执行 git commit。

## 实施过程发现的方案缺陷

- 补列 `C/__tests__/app-follow-through.test.tsx` 与 `todo-reducer.test.ts`：前者仍匹配已删除的重复 Esc 英文 toast，后者把“无普通工具卡片”错误等同于“无运行事实 action”。更新为新中文反馈及状态/卡片分离断言。

- **Windows 原生读回证据推翻 BOM 要求**：本轮在 Windows 10.0.26200 实际执行 `clip.exe` 后通过 `Get-Clipboard -Raw` 读回英文、中文、多行代码和中文路径，四项均发现额外首字符 U+FEFF。原“UTF-16LE 带 BOM”方案不能保证逐字复制。修正为经真实读回验证的显式编码原生写入方案；仍保持参数数组、stdin传正文、异步 close 确认、超时/释放锁与远端 OSC 52 契约。原失败证据保存在运行记录中，后续修复读回另记，不以工具退出 0 代替一致性校验。
- 实施期间工作区另有模型配置任务并发修改 controller、App、SettingsScreen 和配置模块；本节点不回退其改动。相关测试桩需兼容新增的 `areModelSettingsBlocked()`（返回 false），并将与本 TUI 修改无关的类型/测试失败分开记录。

- 全量回归发现清单还漏列直接受中文占位、状态字段规划及固定 spinner 影响的现有测试：`C/__tests__/cli-stream-gate.test.ts`、`compaction-render.test.tsx`、`mouse-routing.test.tsx`、`reducer.test.ts`、`retry-render.test.tsx`、`scroll-chip.test.tsx`、`spinner-census.test.ts`、`team-panel.test.tsx`、`todo-panel.test.tsx`、`todo-responsive.test.tsx`。上述测试补入修改范围；保留队列、安全、滚动和实际布局断言，仅纠正旧展示契约，发现真实行为缺陷则修实现，不以删测绕过。

- 2026-10-07：固定操作提示行替代原空白/活动槽后，现有 `C/__tests__/update-bottom-row.test.tsx` 仍以旧槽占用规则断言，原文件表漏列该直接关联回归。补入修改范围，验证永久提示与 `/update` 入口并存，不改更新业务逻辑。
- 2026-10-07：原 TODO App 测试用 UTF-16 字符切片定位终端列；中文占位文案使这种测量无效。改为显示 cell 测量，并只检查正文视口，避免将底栏字段分隔符误计为 TODO 边框。
- 2026-10-07：`wait_async file_exists` 在当前任务宿主返回 `probe_template_not_supported_on_host`。长测试以后台执行加短时轮询和 progress 心跳推进，不将注册失败报告成已注册。

## 评审结论（保留原结论）

**有条件通过。** 当前没有未解决的 P0/P1 设计问题；保留并复核 R01–R10，本轮新增 R11–R14 四项 P1 均已直接修订技术正文、接口、文件计划及验收矩阵，R15 已完成历史归属修正。方案可在现有 TypeScript / React / Ink 栈上增量实施，不需要更换 Core 队列、滚动架构或持久化格式。

条件仅为实施与发布验收，不阻塞设计交付：

1. 下游按第 8 节实现，并通过第 7.2、7.4 节行为回归、类型检查和构建；尤其不能省略新增的错误路径和 App 实际按键接线验证。
2. 发布前由实施/验收节点完成 R08：将双 Windows 宿主、IME、剪贴板读回和 30 秒性能证据写入 `manual-test.md`；未测或失败项如实保留，不宣称已通过。
3. 终端组合键、鼠标和粘贴能力不足时按本文说明降级，帮助与真实行为一致；官方配置核验不替代真实终端验收。

## 最终代码审查（Subtask #3，2026-10-07）

本节是实现后的最终审查，前文设计节点措辞与旧测试成绩保留为历史记录。
依据文件计划及实施缺陷补列逐项核对，最终提交清单包含 82 个相关文件；没有修改 Core 源码、版本或依赖。

| 用户需求 | 核验路径与结论 |
| --- | --- |
| 多行输入 | stdin filter 能力透传、统一字素/视觉行映射、前后删除、粘贴事务与六行上限均已接线；宿主组合键和 IME 的字节限制明确记录 |
| 显式复制 | 选区消费优先于退出，/copy 与 Ctrl+C 共用协调器；原生完成、OSC 52 未确认、超时结果与资源释放独立处理 |
| 持续排队反馈 | controller 异常回滚、会话 ID 去重、reducer 回执回填、独立面板及 /queue 全文均读取真实 pending；保存和恢复不自动重发 |
| 提示与运行阶段 | 输入、操作提示、全局状态分层；补全/覆盖层按键优先级与独立运行事实具备回归 |
| 状态字段布局 | 按 cell 宽度分配完整字段，优先阶段、数量和上下文；/context 明确 token、会话费用及均速口径 |
| 底部布局 | queue/team/composer 共享预算，TODO 共基线，状态栏保留唯一动态 spinner；布局、缩放和滚动回归通过 |

最终审查修复两处遗漏：

1. `/queue` 已接通键盘却漏接鼠标滚轮。先在现有路由用例加入 queue，观测到预期 `[-3, 8]` 而实际 `[]` 的失败，再修正受控覆盖层名单；34 项鼠标路由回归通过。转录不同时滚动。
2. 帮助页仍解释已经取消的 `E2 / E!`、`S+ / T+` 与旧模式缩写，更新为当前模式文字和完整查询入口。

为避免并发模型配置改动污染提交，在 `.agentmesh/` 建立 HEAD 基线加本功能差异的验证快照，逐个显式路径暂存。
App/controller/cli/builtins/README 及测试桩按代码段分离；模型配置、package 版本、lockfile、构建和临时产物保持未暂存。
独立快照的全量测试为 CLI 3432 项通过、6 项跳过，Core 482 项通过；typecheck/build 通过。
完整工作区的较高测试数量含另一任务，不用于代替本次提交证据。

代码审查与提交可完成，R08 发布门槛继续开放：双宿主/微软拼音/第二 Node 版本和满足指定负载及基线的性能证据尚缺，不能据此宣称已完成发布验收。
