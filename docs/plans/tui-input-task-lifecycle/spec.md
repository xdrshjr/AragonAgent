# TUI 输入光标与任务生命周期设计规格

> 版本：v3；日期：2026-10-03；阶段：已实施，代码终审核验。
> 下文设计节点及实施节点记录保留其当时范围；本轮终审结果见文末。

**目标：** 输入框正确显示闪烁光标；连续两次 ESC 才中断运行中的 Agent；开始新任务时清空上一次任务的 TODO，直到产生新计划才恢复显示。

**架构：** 保持 CLI 内部的 React/Ink 渲染、Controller 运行控制、TodoStore 数据来源三层边界。光标动画局限在叶子组件；ESC 通过明确的按键归属进入独立状态机；TODO 在显式任务边界通过现有事件流清理。

**技术栈：** npm workspaces、TypeScript strict / NodeNext、Node.js 18+、React 18、Ink 5、Vitest、ink-testing-library；使用现有 string-width，不增加依赖。

## 评审记录

本轮逐节核对了 `CLAUDE.md`、项目索引、实际安装的 Ink 输入实现，以及输入框、Controller、Core 运行生命周期、TODO 工具/Store、选择复制和命令代码。评审维度为可行性、完整性、项目一致性与范围适度；以下问题均已在正文修正。P0：0 项；P1：5 项；P2：3 项；未解决 P0/P1：0 项。

| 编号 | 级别 | 问题与代码依据 | 正文修正及验证要求 | 状态 |
| --- | --- | --- | --- | --- |
| R-01 | P1 | `controller.ts::prompt` 吞掉启动前错误后只调用 notify；没有 `agent_end`，而 App 已 dispatch submit，等待超时会留下假 running | §6.2/§7 增加仅说明是否启动的返回结果，App 按提交序号复位；T-06/T-11 | 已修正 |
| R-02 | P1 | 强停后 prompt 在 `waitForEngineIdle` 中等待；此时再按 ESC 只 abort 旧引擎，等待恢复后仍会启动用户已取消的消息并清空 TODO | §5.2/§6.2 使用 Controller 私有启动请求序号，使 abort、强停、会话替换撤销等待；T-12/T-13 | 已修正 |
| R-03 | P1 | 手势读取 React stateRef，不能保证同步 `agent_end` 后已更新；仅要求“仍 running”不足以防止同 tick 误提示、重复强停或跨运行继承 | §5.2 规定同步交互阶段 ref 与提交序号，事件结束先失效再 dispatch；E-10 | 已修正 |
| R-04 | P1 | `splitRowAtColumn` 可以选中独立零宽码点；单色降级 `Math.max(1, width)` 会把零宽变成一列，破坏闪烁不改变布局的承诺 | §4.3 规定零宽码点的视觉归并与有限降级，禁止相位增列；C-10 | 已修正 |
| R-05 | P1 | 单色光标固定替换为下划线，在原字符就是 `_` 时完全没有相位差；常亮降级也可能看不出输入位置 | §4.2 定义不同于原显示文本的等列标记；C-05 | 已修正 |
| R-06 | P2 | §4.2 声称降级字符不进入复制源，但 `screen-mirror.ts` 对最终帧 stripAnsi，`selection-controller.ts` 直接从该镜像复制 | §4.2/§10.3 区分编辑器数据与屏幕选择，记录单色屏幕复制包含当时标记的限制，不扩大为复制系统重构 | 已修正 |
| R-07 | P2 | 已安装 Ink 的 `use-input.js` 对普通 ESC 也设置 `meta=true`；“排除 Alt”若实现为拒绝 meta 会让双 ESC 失效 | §5.3 明确以 key.escape 判断、不得用 !key.meta 过滤，补真实 stdin 验证 | 已修正 |
| R-08 | P2 | 文件计划和交付检查仍写“本节点新增”及 index=0，容易误报上游节点；评审门槛与实施发布门槛未分开 | §8/§12 更正为仅修订本文件、index=1，并明确本轮检查范围 | 已修正 |

逐节结论：§1–3 的产品规则与三层边界适度；§4 的叶子动画可行，补齐单色与零宽边界；§5 的输入归属符合 Ink 多监听机制，补齐同步运行阶段；§6–7 的 Store 清理方向正确，补齐可取消启动与结果契约；§8–9 更新受影响模块与顺序；§10–11 扩展验收和风险；§12 区分本轮设计评审与未来功能交付。无需 Core 公共 API、持久化格式、新依赖或完整 grapheme 编辑器改造。

## 1. 概述

AragonAgent 的终端界面已经具备多行输入、补全、流式输出、任务计划、自动继续和强制停止能力。本次改进解决三个彼此关联的交互问题：用户无法稳定确认输入位置，单次 ESC 容易误中断工作，以及新任务沿用旧 TODO 造成进度误导。修复必须同时覆盖 fullscreen 与 inline 输入，不能破坏已有的行数预算、光标定位、后台服务控制和任务继续机制。

交互规则采用明确、可预测的边界。输入框获得应用内焦点时，默认光标以 500 ms 明暗交替；编辑后立即亮起。运行期间，第一次 ESC 仅提醒，1,500 ms 内的第二次 ESC 才请求中断；若仍未停止，再按一次 ESC 强制停止。关闭覆盖层和补全菜单仍只需一次 ESC，并且关闭动作不算中断的第一击。新任务以空闲时成功进入运行的普通消息为边界，旧 TODO 无论是否被模型完整标记完成都清空；任务结束当刻保留最终计划，供用户查看。

本需求中的“后续继续进行任务”默认指提交下一条普通用户消息。只有 `/todo continue` 与自动 follow-through 被视为显式延续原计划；普通文本“继续”仍是新任务输入，模型可以根据对话重新调用 `todo_write` 建立计划。运行中的 steering 不开始新任务。这个选择避免用自然语言猜测任务归属，并将可验证的产品规则交给下游工程师直接实施。

## 2. 项目依据与当前行为

已读取根目录 `README.md`、`CLAUDE.md`、`.claude-index/index.md`、CLI 的包配置与相关 README 章节，并以当前源代码校准索引中较旧的版本和行数。Core 是无宿主耦合的执行引擎，CLI 负责交互、持久化和 TODO；本设计不增加 Core API，不改变数据库或持久化格式。

| 现有位置 | 核实到的机制 | 对设计的约束 |
| --- | --- | --- |
| `packages/cli/src/ui/PromptInput.tsx::rowNodes/inputRow` | 非空草稿用常亮的 `<Text inverse>`；空草稿直接显示 placeholder | 空草稿必须进入光标展示路径，不能只给现有反色增加定时器 |
| `packages/cli/src/ui/composer-rows.ts::layoutComposer/splitRowAtColumn` | 将 UTF-16 索引映射为显示列，并预留末尾光标位置 | 闪烁只改变外观，不得改变 active、行数或换行结果 |
| `packages/cli/src/ui/frame-differ.ts` | 差分输出结束后将硬件光标停在 H+1 行 | 不直接移动或显示硬件光标，否则破坏后续重绘原点 |
| `packages/cli/src/ui/App.tsx::useInput` | 首次 ESC 调用 abort；四秒内第二次 forceStop | 必须更换状态语义，保留强制停止恢复能力 |
| `packages/cli/src/ui/PromptInput.tsx::useInput` | 补全菜单自己处理 ESC，而 App 也监听该按键 | 多监听器不是事件冒泡，子组件 return 不能阻止父监听器中断 |
| `packages/cli/src/agent/controller.ts::prompt/startPrompt` | 有界等待旧引擎退出；每次 prompt 调用 beginUserTurn | 清理应在等待结束且确认引擎空闲后执行 |
| `packages/cli/src/todo/store.ts::beginUserTurn` | 完成列表下轮清除；未完成列表按 staleTurns 延迟清除 | “运行已结束”与“所有 TODO completed”不同，后者不足以判断旧计划 |
| `packages/cli/src/agent/reducer.ts::todoCleared` | 清除实时 snapshot 和 todoEntryId，保留历史卡片 | 复用这条链路，不直接操作面板配置 |
| `packages/cli/src/ui/App.tsx::submitMessage` | 普通提交和自动继续共用入口，userInitiated 控制历史记录 | 任务归属需要独立选项，不能复用 userInitiated |

现有约定继续有效：生产 UI 源码保持 ASCII，特殊符号取自 `pickGlyphs`；本交付文档使用中文，界面字符串沿用产品现有英文。新增模块不超过 1,000 行、单函数不超过 60 行；已有超限的 App 和 Controller 只做接线，新逻辑拆入小模块。测试先覆盖行为缺口，再实施修复。

## 3. 范围、决策与备选方案

### 3.1 固定产品决策

| 编号 | 决策 |
| --- | --- |
| D-01 | 光标为 Ink 管理的视觉光标，不输出独立 ANSI 控制字节 |
| D-02 | 默认亮 500 ms、暗 500 ms；输入、移动、焦点恢复后重新亮起并重新计时 |
| D-03 | 尊重已有 `cfg.reducedMotion`：开启时显示常亮光标；不使用运行活动派生的 `viewReducedMotion` 禁止闪烁 |
| D-04 | 双 ESC 时间窗为 1,500 ms，包含边界；超过时间窗的 ESC 作为新的第一击 |
| D-05 | 第二击只请求普通中断；第三击在同一运行仍未结束时强制停止；不自动计时强杀 |
| D-06 | 任何非 ESC 键取消尚未确认的第一击；关闭菜单或覆盖层也取消第一击 |
| D-07 | 普通新任务清空所有旧 TODO，包括 pending/in_progress；显式续跑保留计划 |
| D-08 | 保留 `agent_end` 时的最终 TODO；不等待新模型输出才清理旧计划 |
| D-09 | CLI 的程序化与 headless 调用未提供新增选项时保持已有 beginUserTurn 策略 |
| D-10 | 不增加用户配置项、环境变量、命令行参数或网络接口 |

### 3.2 方案比较

光标有三种实现选择：操作硬件光标、在 PromptInput 上维护闪烁状态、独立光标叶子组件。选择第三种：它符合当前渲染所有权，且不会每 500 ms 重新执行草稿布局或 App 逻辑。硬件光标会与 Ink 的隐藏及 H+1 停靠冲突；父组件定时器会扩大重绘范围并威胁现有“一次按键一次编辑器提交”的回归约束。

ESC 可采用第二次直接强杀，或第二次正常中断、第三次强杀。选择后者，保留协作退出机会，并避免普通取消就杀前台进程树。单纯给现有 `abort()` 增加计数仍无法解决补全菜单和 App 同时监听 ESC，因此必须一并调整按键归属。

TODO 可只隐藏面板、结束时删除、或新任务边界清空 Store。选择第三种：只隐藏会留下 `/todo status`、自动续跑与状态栏中的旧数据；结束即删除会失去完成反馈，也破坏自动续跑所需的快照。无需引入模型分类器、任务 ID 持久化或新的事件协议。

## 4. 技术设计：闪烁光标

### 4.1 光标组件与数据流

新增 `ui/PromptCaret.tsx`，作为现有嵌套 `<Text>` 中的叶子组件，只管理可见相位与一个定时器。它接收当前位置展示文本 `text`、焦点 `active`、`reducedMotion`、颜色能力 `colorLevel`、原文本颜色 `color`、以及用于重新计时的 `resetKey`。其中 text 至少为一个空格，颜色继承文本或 token 样式。

`PromptInput` 继续通过 `layoutComposer` 和 `splitRowAtColumn` 计算 before、at、after。at 存在时把完整 at.text 交给 PromptCaret；at 为 null 时传一个空格。光标灭时必须原样显示 text，亮时仅施加 inverse，不替换草稿字符。before/after 的文本与 token 颜色保持不变。CJK 宽字符应整体反色，不能把双列字符分成两个字符；视觉“一个光标”不等于固定占一个显示列。

空草稿单独按 placeholder 的第一个 Unicode 码点分割：PromptCaret 展示首字符，后面继续显示剩余 placeholder，整体保持 muted 与 truncate。这样光标位于输入起点，且没有为它额外插入一列造成窄终端折行。inactive 时展示完整 placeholder 的普通样式，不显示焦点光标。

### 4.2 计时、编辑恢复与可访问性

初始 visible=true。active 且未开启 reducedMotion 时启动 500 ms interval；每次 tick 只修改 PromptCaret 的本地状态。active=false 时销毁计时器并渲染原文本；reducedMotion=true 时销毁计时器并保持亮态。卸载也必须清除计时器，切换输入模式不能积累旧 timer。

resetKey 使用 `useMemo` 生成的对象标识，依赖 buffer、cursor、isActive、实际 usableCols；不要以整份草稿作为 React key，否则每次编辑都重新挂载组件。叶子组件在 layout effect 中响应 resetKey、active、reducedMotion 的变化，先恢复亮态，再重启定时器。无关的流式输出、TODO 更新和时间状态不改变 resetKey，因此连续输出不能把光标永远推迟到不闪烁。用户输入没有改变编辑状态的无效按键不必重启周期。

从 App 向 fullscreen Composer 与 inline PromptInput 传递 `reducedMotion={cfg.reducedMotion ?? false}`，Composer 继续透传。现有 `viewReducedMotion = reducedMotion || activityVisible` 是输出动画的节流策略，不代表用户关闭输入光标；不能传这个派生值。

颜色等级 0 下不得假定 inverse 一定产生可见终端属性。对正显示宽度 w 的 text，亮相位默认显示 `'_'.repeat(w)`；若与原 text 相同，则改为 `'^'.repeat(w)`，暗相位恢复 text，保证原字符为下划线时也有可见变化。零宽输入按 §4.3 先处理，不使用 Math.max 将零宽偷偷扩成一列。减少动画模式下标记常亮；宽字符保持同等列宽。颜色模式下使用反色字符保留文字可读性，所有模式都不依赖 Unicode 方块字符。

降级标记不进入 buffer、历史或提交内容，但屏幕选择复制的是最终帧：现有 `ui/selection/screen-mirror.ts` 的 plain 来源于 raw 帧 stripAnsi，不能恢复被标记替代的字符。因此单色模式下选择输入行会复制当时可见的标记；终端原生选择也有同样限制。本次接受并在 README 与人工验收中注明这一降级边界，不承诺屏幕复制与原草稿一致，不增加第二套复制数据源；有色反色模式保持原字符，复制不引入标记。

### 4.3 定位边界与渲染不变量

layoutComposer 的 active 始终使用输入焦点，与闪烁 visible 无关。末尾预留列、draftRows、溢出标记、补全面板预算均不随相位变化。现有光标按 UTF-16 索引移动，可能进入代理对内部；为避免此时 cursorRow=-1，在 composer-rows 内对**视觉定位索引**作规范化：限制到 0..buffer.length，若落在低代理项且前一个是高代理项，则向前移一位。只用于渲染，不在本次改写编辑器的删除/移动语义。

行末换行字符处若当前列已等于 cols，必须和文本末尾光标一样先 ensureRoom(1)，再记录 cursorRow/Col，防止光标额外撑开一行而预算未计入。相位切换不重新运行布局；焦点和真实布局变化可以重新计算。组合附加符及 ZWJ 序列继续沿用当前码点宽度算法，不承诺完整 grapheme 编辑；该既有限制需在人工验收中记录，不能宣称已修复整个 Unicode 编辑器。

零宽码点不得单独成为需要绘制占位标记的 at。视觉索引落在宽度为 0 的码点时，优先归属同一逻辑行之前的最近正宽码点；没有前驱则归属后面的第一个正宽码点。`splitRowAtColumn` 将该基字符及相邻零宽附加码点放在同一个显示片段中，before/at/after 拼接仍等于原行文本。只有该行完全没有正宽字符时，保留零宽文本并像行尾一样由 layoutComposer 明确预留一个空格光标；明暗两相位都保留这一格。布局定位和切片必须使用同一规则，不能只在 PromptCaret 中补空格。此规则只保证光标投影与预算一致，不改变 UTF-16 编辑索引，也不承诺 ZWJ emoji 的 grapheme 宽度完全正确；验收明确覆盖 `e\u0301`、独立 `\u0301`、零宽字符开头与行尾四类输入。

不得修改 screen、stdout-frame-writer 的终端光标显隐责任。默认 fullscreen 下，稳定帧的光标 tick 只应使其所在输入行成为脏行；Ink/Yoga 仍可能进行树级布局，设计不声称消除该框架成本。现有 inline 模式仍由 Ink 自己重绘，保持布局正确是要求，行级差分性能只要求 fullscreen。

## 5. 技术设计：双 ESC 与按键所有权

### 5.1 一个按键只有一个 ESC 业务处理者

新增可选回调 `onEscape?: () => void`，从 App 传入 Composer/PromptInput。全局 App 的 ESC 分支只负责覆盖层；没有覆盖层时直接 return，不再在全局监听器中执行中断或取消 follow-through。PromptInput 激活时先处理补全菜单 ESC，执行 dismiss 后 return；菜单不存在时调用 onEscape 后 return。同一 ESC 不可能同时关闭补全和调用中断。

App 新增稳定的 `handleComposerEscape`，读取 stateRef、Controller 和中断状态引用。没有运行时，它保留现有取消自动继续等待的语义；普通空闲状态无副作用。运行时才调用第 5.2 节状态机。覆盖层仍按现有逻辑拒绝确认或 settle human request 并关闭，不能顺带调用 abort。通过真正挂载的 App 测试验证 listener 注册顺序两种情况下都成立，特别是关闭覆盖层导致 PromptInput 恢复 active 的同一次按键不能再触发回调。

输入归属以该次事件开始时的订阅状态为准：PromptInput 使用 `useInput(..., { isActive })`，不要在常驻回调里仅用最新 overlay ref 决定是否转交。已安装 Ink 对内部 input EventEmitter 订阅，关闭覆盖层后新增的监听器不参与已经开始的那次 emit。App 的 `handleComposerEscape` 仍应拒绝当前存在覆盖层的调用，覆盖旧监听器尚未清理的另一侧边界；不得让 overlay 关闭动作主动调用该回调。

App 全局键处理开头，非 ESC 输入清除“等待第二击”状态，然后继续既有 Ctrl+C、滚动、模式切换等逻辑。PromptInput 关闭 popup 时调用另一个可选回调 `onEscapeDismiss?: () => void`，只清除第一击，不执行运行控制；App 自己关闭覆盖层时同样清除第一击。开启覆盖层的 effect 也清除第一击。这里的清除不抹掉“中断已请求”状态，因为工具卡出现或用户键入内容并不让正在退出的引擎重新获得正常运行语义。

### 5.2 状态机

新增纯模块 `input/interrupt-gesture.ts`，导出 `INTERRUPT_CONFIRM_MS = 1500`、状态类型、`advanceInterruptGesture(state, now)` 和 `cancelInterruptConfirmation(state)`。now 为单调毫秒值，App 使用 performance.now()，测试直接传数值。状态存在 App 的 ref 中，必须在调用 Controller 前同步写入，避免同步 agent_end 与重复事件覆盖新状态。

| 当前状态 | 输入条件 | 后续状态 | 动作 |
| --- | --- | --- | --- |
| ready | ESC 且运行仍有效 | armed，记录 now | 仅提示再次按 ESC |
| armed | ESC，0 <= now-armedAt <= 1500 | stopping | 普通中断一次 |
| armed | ESC，超过 1500 ms 或时间倒退 | armed，重记 now | 作为第一击，仅提示 |
| armed | 其他按键、关闭 popup、打开/关闭 overlay | ready | 取消确认，不中断 |
| stopping | ESC 且运行仍有效 | ready | 强制停止一次，立即恢复 UI idle |
| stopping | 普通按键或菜单关闭 | stopping | 不重复中断，保留救援路径 |
| 任意 | agent_end、空闲时新的提交尝试、会话 reset/resume、卸载 | ready | 清理手势，不携带到下一次运行 |

armed 不需要独立 timer：比较 timestamp 才是时间窗权威，下一击在边界外自然重新 armed；提示文案直接写明时间窗，使用现有 toast 的生命周期。删除原 escArmed、escArmTimer、ESC_ARM_MS=4000 及 disarmEsc 中旧逻辑；新 resetInterrupt 在原 agent_end 位置执行，并接入 submitMessage 的非 steering 分支。stopping 没有超时，第三击始终可用于救援同一尚未结束的运行。Ctrl+C 的服务停止和退出梯级完全保持原有语义。

**同步阶段权威（R-03）：** App 为本次提交保留单调递增的提交序号及 `idle | starting | running` 交互阶段 ref，手势只属于该序号。新提交先同步写 starting，再 dispatch submit；有效 agent_start 先改为 running；有效 agent_end 先写 idle、reset 手势，再 dispatch 结束动作并计算 follow-through。强停、启动拒绝、成功 reset/resume、卸载同样先失效对应序号。旧运行因 runGeneration 不匹配而被过滤的 agent_end 不结束新提交的 starting 阶段。ESC 和中断后的 toast 都读取这个同步阶段与捕获的提交序号，不能只读取滞后一帧的 stateRef，也不能仅用 controller.isRunning() 把旧引擎退出等待误认成新任务。连续的真实 stdin 事件无需等待 React commit 也必须正确。

会话切换的 App 接线复用命令 dispatch：makeCtx 提供薄包装，在成功命令派发 `resetConversation` 或 `restoreEntries` 前同步失效提交序号、reset 手势、清除自动续跑标识与计时器并置 idle，再转发原 action。`clearTranscript` 不代表运行结束，不执行这组处理。Controller 的等待请求失效分别接在 `clearMessages` 与 `replaceMessages`；无需新增命令回调或靠 effect 观察一帧后的会话状态。

第一击显示 `Press Esc again within 1.5s to interrupt.`，不调用 abort/forceStop、不设置 abortMark、不取消子任务，也不更改 endReasonRef。第二击先写 stopping，再写 `endReasonRef.current.aborted = true` 与 dispatch abortMark，最后调用 controller.abort()。这个顺序保证 abort 同步触发 agent_end 时 follow-through 能看到已中断原因。仅在调用后状态仍 running 时提示 `Interrupt requested. Esc again to force-stop.`；不要在已结束的 idle 界面误导用户继续强停。

starting 阶段也采用双击确认，但第二击通过 controller.abort() 撤销待启动请求（§6.2），立即把当前提交置 idle、重置手势并 dispatch runEnd；提示 `Pending run cancelled.`。它不等待旧引擎退出才恢复交互，也不清除旧 TODO。running 阶段才进入 stopping 救援梯级。旧引擎仍在退出时允许用户再次提交，仍走有界等待；旧请求的返回不得覆盖这次新提交。

第三击先 reset 手势并标记 aborted，再调用原 controller.forceStop()，最后无条件 dispatch runEnd，显示 `Force-stopped.`。沿用 Controller 的前台进程强杀与 runGeneration 防迟到事件机制，后台服务不受 ESC 影响。事件结束优先于任意下一击，已空闲时 ESC 不能强杀旧运行或中断下一轮。

### 5.3 文案与终端输入边界

Composer 的运行提示统一为 `esc` + `glyphs.times` + `2 interrupt`，包括有后台服务和没有后台服务两条分支。PromptInput placeholder 改为 `Type to steer the run; press Esc twice to interrupt...` 的 glyphs 省略号版本。HelpOverlay 分开说明关闭菜单、双 ESC 中断、已请求中断后再次 ESC 强停。README 同步更新快捷键表、计划卡取消说明、后台执行、团队中断与手工检查中的旧语义。

仅处理 Ink 识别出的独立 ESC 键，不对 raw input 做子串搜索；方向键、Alt 组合、bracketed paste 中的 escape 字节不得计数。每次 useInput 回调最多推进一次状态。同一原始事件中多字节 ESC 序列不可自行拆成连续点击。终端不提供 keyup/repeat 标识时，无法严格区分物理连按和系统重复 ESC，这是输入协议限制；验收以两次独立、解码后的 ESC 事件为准。

当前 Ink 的普通 ESC 同时满足 `key.escape === true` 与 `key.meta === true`，所以不能增加 `!key.meta` 条件。以解码后的 key.escape 为入口，方向键/Alt 字母等 key.escape 为 false 的输入不计数；对 Ink 已经归一化成同一 ESC key 的原始序列不作物理按键保证。测试必须经现有 stdin 过滤与 Ink 解码，不能仅构造错误的 `{ escape: true, meta: false }` 桩来证明正常 ESC 可用。

## 6. 技术设计：TODO 的新任务边界

### 6.1 显式提交意图

新增 CLI 内部 `agent/prompt-options.ts`：`PromptOptions` 包含可选 `todoPolicy: 'new-task' | 'continue'`；`SubmitMessageOptions extends PromptOptions` 再包含 `userInitiated?: boolean`。未提供 todoPolicy 表示兼容旧调用策略，不能在 Controller 内默认成 new-task。App 的普通提交则显式传 new-task。

`CommandContext.submit`、App 的 makeCtx、submitRef、submitMessage 统一使用 SubmitMessageOptions。自动继续调用和 `/todo continue` 都传 `{ userInitiated: false, todoPolicy: 'continue' }`；普通消息、初始消息、`//` 转义消息和动态 skill 消息默认为 new-task。userInitiated=false 仍只影响历史记录和提示学习计数，不决定清理行为。

| 入口或条件 | TODO 策略 |
| --- | --- |
| 空闲时普通消息成功启动 | clear('turn')，无论旧条目状态 |
| 正在运行时 Enter steering | 保留；不进入 prompt 的任务边界 |
| `/todo continue`，原列表存在未完成项 | continue，保留，不增加 stale 计数 |
| 自动 follow-through | continue，保留；继续使用原预算与无进展上限 |
| `/help`、`/settings`、未知命令、空输入 | 不启动任务，不清理 |
| preflight 失败或旧引擎等待超时仍 running | 不清理旧计划，反馈启动失败 |
| `/clear`、`/todo clear`、`/reset` | 复用已有显式清除 |
| `/resume` | 先按已有行为恢复所选快照；此后普通新任务清理 |
| headless/exec 无新增选项调用 | 保持现有 beginUserTurn 行为 |

### 6.2 从提交到清理的确定顺序

submitMessage 首先取消待执行自动继续，并调用 cancelInterruptConfirmation 清除尚未确认的第一击。若同步交互阶段为 running，走 steer 分支，保留 TODO 和可能存在的 stopping 救援状态。若为 starting，拒绝把第二条消息 steer 给旧引擎，提示 `A run is still starting. Press Esc twice to cancel.`，不记录为成功提交、不清理 TODO。否则 reset 全部手势，分配新的提交序号并同步写 starting，再保留现有记录历史、dispatch submit、preflight 的可见反馈顺序；preflight 不通过则同步回 idle、dispatch runEnd 并返回，旧 TODO 继续可查看。App 挂载到已运行的 Controller 时初始化 running；所有真实 agent_start 同步更新该阶段。

preflight 成功后调用 `controller.prompt(message, { todoPolicy: opts.todoPolicy ?? 'new-task' })`。Controller 等待旧引擎退出的逻辑保持有界；等待后在 try 内再次检查 `agent.state.isRunning`，若仍为 true，走现有 notifyHost 错误通路并返回 `{ status: 'not-started', reason: 'failed' }`，不能进入 startPrompt，也不能清理 TODO。等待、启动与错误处理都包含在不拒绝 Promise 的保护范围内。已进入本次引擎运行并结束则返回 `{ status: 'finished' }`；这只说明发生过本次运行，不代表模型或工具执行成功，实际成功与否仍由事件决定。

App 捕获提交序号处理返回值：not-started 且序号仍为当前、组件仍挂载时，先同步置 idle、reset 手势，再 dispatch runEnd，并清除该次自动续跑标识；不能伪造 agent_end，否则会对旧 TODO 发起自动继续。旧提交返回一律不得结束新提交。错误通知仅由 Controller 发出一次，取消不显示“启动失败”。finished 路径继续依赖正常 agent_end，不重复 dispatch runEnd。保持 headless/exec 调用方忽略返回值的现有行为：`HeadlessController.prompt` 改为 `Promise<void | PromptOutcome>`，保留现有 void 测试桩兼容性；`ExecRunnerController` 继承该接口，不另写一份。真实 App 的 Controller 桩应返回明确结果并更新断言。新增结果只属于 CLI，不修改 Core Agent.prompt 或直接使用 Core Agent 的子代理接口。

**可撤销启动（R-02）：** Controller 增加私有递增启动请求序号，区别于 forceStop 的 runGeneration。prompt 每次入场先递增并捕获自己的请求序号，废弃之前仍等待的启动请求；内部因等待旧引擎而停止它时，调用不修改启动请求序号的私有停止引擎方法，再进入 waitForEngineIdle。必须先捕获再停止，以保留同步事件回调中发生的外部取消。对外 abort() 则先递增请求序号，再调用该私有方法；forceStop() 复用对外 abort()，因此也撤销等待请求。`clearMessages`（/reset）与 `replaceMessages` 在 Core 方法成功返回后、后续同步广播前递增该序号；失败的 Core 会话切换不撤销请求。App 卸载时若仍 starting 则调用 abort() 撤销等待。

在启动前的每次 await 后，以及 startPrompt 修改 Store 前，都比较请求序号；失效返回 `{ status: 'not-started', reason: 'cancelled' }`，不进入引擎、不调用 beginUserTurn、不发失败通知。先校验序号，再判定等待超时，避免把主动取消报为失败。最后一次校验、beginUserTurn 与调用 engine.prompt 之间不得插入 await；其他准备工作应在清理 Store 之前完成。请求序号只保护尚未启动的消息，已经进入 engine.prompt 的本次运行结束后仍返回 finished，不因后续 abort 改报 not-started。已开始的运行仍使用原 abort/forceStop 和 runGeneration 机制，不增加持久化任务 ID 或 TODO 事件代次。新提交的 starting 阶段不接受 steering，是为了避免消息落到仍在退出的旧引擎。

startPrompt(text, options) 在启动新 engine.prompt 前，根据选项调用 `todos.beginUserTurn(options.todoPolicy)`：new-task 下非空列表立即 clear('turn')；continue 下直接返回，不清除也不增加 staleTurns；undefined 下保留原来“完成即清、未完成按轮数过期”的行为。空 Store 在三种路径都 no-op，避免没有计划也重复发送 cleared。

Store 的 cleared 事件通过现有 subscribeTodos 同步映射为 todoCleared；reducer 设置 todos=null、todoEntryId=undefined。于是 right rail、inline strip、窄屏状态栏 TODO 计数同时消失，右栏布局自动回收。任务自己的第一条有效 todo_write 随后产生 updated，重新显示新计划；新历史卡片获得新的 id，不能改写旧任务历史卡片。

这里的“清空”是运行时 Store 与实时视图一致清空，并非删除对话中的历史计划。模型仍然记得旧内容，需要继续时可重新规划。无新 todo_write 时，普通消息、主题修改、resize、打开/关闭 overlay 都不能恢复旧快照。用户显式 `/resume` 属于加载另一份历史会话，是该规则的明确例外。

### 6.3 与既有 TODO 规则兼容

TodoClearReason 不新增枚举值，扩展 turn 注释为“新任务边界，或兼容旧调用时完成列表的轮次边界”。更新 TodoStore 顶部的不变量说明：新任务切换是用户意图导致的展示生命周期清理，允许面板为空而模型保留旧历史；不能声称只有手动 clear 能删除未完成列表。

TODO 条目验证、minFreshItems、全量替换、预算策略与持久化格式保持不变。新任务清空后，todo_write 再次受“新计划最少条目”校验；只有通过现有校验的新计划才恢复显示。无效或过短的新计划写入不能使旧计划复活。continue 保留列表以及 updatedAt，不因提交续跑制造伪进度。

不在本次引入 TodoEvent generation。当前 todo_write 的 Store 写入为同步操作；新任务又在旧引擎退出后开始，因此旧同步写入发生在清理之前，不会跨过清理后继续写。下游必须用强停后启动的回归覆盖这条前提；若未来把 todo_write 改为异步，需另外引入写入代次校验，不能依赖 App 对 AgentEvent 的 generation 过滤，因为 TODO 是独立订阅流。

## 7. 接口设计与内存模型

无 REST、WebSocket、DB schema 或公开 Core 接口变动；`aragon` 的启动签名与配置格式不变。以下 TypeScript 是下游接口契约，不是本节点写入源码的实现。

```ts
// packages/cli/src/agent/prompt-options.ts
export interface PromptOptions {
  todoPolicy?: 'new-task' | 'continue';
}
export interface SubmitMessageOptions extends PromptOptions {
  userInitiated?: boolean;
}

// 结果只描述启动边界，不替代运行成功/失败事件。
export type PromptOutcome =
  | { status: 'finished' }
  | { status: 'not-started'; reason: 'cancelled' | 'failed' };

// 现有方法扩展；第二参数缺省保持原 TODO 策略；Promise 不拒绝。
AgentController.prompt(text: string, options?: PromptOptions): Promise<PromptOutcome>;
TodoStore.beginUserTurn(policy?: 'new-task' | 'continue'): void;
CommandContext.submit(text: string, options?: SubmitMessageOptions): void;
// headless.ts 的结构接口兼容既有 void 夹具；exec 接口继承它。
HeadlessController.prompt(text: string): Promise<void | PromptOutcome>;

// 新增纯交互状态；App 用 ref 存储，不写入 session/config。
export type InterruptGestureState =
  | { phase: 'ready' }
  | { phase: 'armed'; armedAt: number }
  | { phase: 'stopping' };
export interface InterruptGestureResult {
  state: InterruptGestureState;
  action: 'hint' | 'abort' | 'force-stop';
}
advanceInterruptGesture(
  state: InterruptGestureState,
  now: number,
): InterruptGestureResult;
cancelInterruptConfirmation(state: InterruptGestureState): InterruptGestureState;

// PromptInputProps 与 ComposerProps 同步新增。
reducedMotion?: boolean; // 缺省 false
onEscape?: () => void;
onEscapeDismiss?: () => void;

// 光标组件只存可见相位，resetKey 仅是稳定比较标识。
export interface PromptCaretProps {
  text: string;
  active: boolean;
  reducedMotion: boolean;
  colorLevel: 0 | 1 | 2 | 3;
  color?: string;
  resetKey: object;
}
```

TodoSnapshot 的 items、doneCount、activeIndex、updatedAt 与 TodoEvent 的 updated/cleared/rejected 形状均不改变。clear('turn') 后 snapshot() 为 null；事件消费者无需新增分支。中断状态不能用 ViewState.aborted 代替：第一击并未中断，而强停可用性属于当前手势的运行阶段。

## 8. 文件与模块变更计划

本评审节点只修订本文件。以下表格是**下游实施时**的预期变更清单；不得在本评审节点直接修改它们。测试中的控制器桩凡断言 prompt 参数、返回类型或旧 ESC 语义，按实际引用更新；与行为无关的现有模块无需格式化。

| 文件 | 操作 | 意图 |
| --- | --- | --- |
| `docs/plans/tui-input-task-lifecycle/spec.md` | 本节点评审修订 | v2 评审记录、修正后的设计契约与评审结论 |
| `packages/cli/src/ui/PromptCaret.tsx` | 下游新增 | 局部闪烁、焦点、低动画与单色降级 |
| `packages/cli/src/input/interrupt-gesture.ts` | 下游新增 | 纯 ESC 状态转换与 1,500 ms 常量 |
| `packages/cli/src/agent/prompt-options.ts` | 下游新增 | 共用提交及 TODO 边界选项类型、PromptOutcome |
| `packages/cli/src/ui/PromptInput.tsx` | 下游修改 | 空/非空光标接线，唯一非覆盖层 ESC 入口 |
| `packages/cli/src/ui/composer-rows.ts` | 下游修改 | 代理对视觉索引及满列换行光标定位 |
| `packages/cli/src/ui/Composer.tsx` | 下游修改 | 透传光标/ESC 属性，更新运行提示 |
| `packages/cli/src/ui/App.tsx` | 下游修改 | 手势接线、覆盖层优先、提交意图与 reducedMotion 透传 |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | 下游修改 | 解释单 ESC 关闭、双 ESC 中断和强停 |
| `packages/cli/src/agent/controller.ts` | 下游修改 | 传递 options/结果，启动请求失效保护及停止方法拆分，确认空闲后才进入任务边界 |
| `packages/cli/src/agent/headless.ts` | 下游仅调整结构接口 | prompt 返回类型兼容 PromptOutcome 与既有 void 夹具，运行逻辑保持不变 |
| `packages/cli/src/todo/store.ts` | 下游修改 | 区分 new-task、continue、兼容旧策略 |
| `packages/cli/src/todo/types.ts` | 下游修改 | 更新 turn reason 文档，不变更事件形状 |
| `packages/cli/src/commands/registry.ts` | 下游修改 | CommandContext.submit 使用共用 options |
| `packages/cli/src/commands/builtins.ts` | 下游修改 | `/todo continue` 显式传 continue；reset/resume 沿用既有 dispatch，由 App 包装接收 |
| `packages/cli/README.md` | 下游修改 | 更新快捷键、续跑边界及人工检查说明 |
| `packages/cli/src/__tests__/prompt-caret.test.tsx` | 下游新增 | 验证相位、颜色、焦点、低动画、计时清理 |
| `packages/cli/src/__tests__/interrupt-gesture.test.ts` | 下游新增 | 纯状态表与时间边界测试 |
| `packages/cli/src/__tests__/controller-prompt-boundary.test.ts` | 下游新增 | 真 Controller 任务边界、退出等待与失败不清理 |
| `packages/cli/src/__tests__/prompt-input-commits.test.tsx` | 下游修改 | 验证按键提交次数不回退，并检查闪烁隔离 |
| `packages/cli/src/__tests__/composer-rows.test.ts` | 下游修改 | 代理对、宽字符、满行与多行窗口的光标定位 |
| `packages/cli/src/__tests__/interrupt-ladder.test.tsx` | 下游修改 | 把旧二级梯级改为确认、中断、强停的三阶段 |
| `packages/cli/src/__tests__/app.test.tsx` | 下游修改 | 覆盖层/补全 ESC 所有权、提示与两种模式接线 |
| `packages/cli/src/__tests__/app-follow-through.test.tsx` | 下游修改 | 第二击抑制续跑、第一击不抑制、continue 参数 |
| `packages/cli/src/__tests__/todo-store.test.ts` | 下游修改 | 三种策略、事件次数、空 Store 与兼容旧行为 |
| `packages/cli/src/__tests__/todo-commands.test.ts` | 下游修改 | continue 显式参数及拒绝路径 |
| `packages/cli/src/__tests__/todo-responsive.test.tsx` | 下游修改 | 新任务清理后 rail/strip/chip 同步隐藏及重新显示 |
| `packages/cli/src/__tests__/todo-reducer.test.ts` | 下游修改 | 清除后保留历史并为新计划分配新卡片 |
| `packages/cli/src/__tests__/frame-differ.test.ts` | 下游修改 | 光标相位仅更改输入行，保持 H+1 停靠 |
| `packages/cli/src/__tests__/mouse-routing.test.tsx` | 实施补充 | Controller 桩提供真实挂载需要的 isRunning |
| `packages/cli/src/__tests__/single-spinner.test.tsx` | 实施补充 | 将测试桩运行阶段与 agent_start/agent_end 同步 |

`TodoPanel`、`TodoStrip`、`StatusBar`、布局投影、exec runner、Core、配置 schema、会话文件、screen 和 stdout writer 预期无需修改，只运行相关回归。headless 仅放宽上述结构接口返回类型；所有 prompt 测试桩按真实使用方式校准，不重写 headless/exec 运行逻辑。若实施发现必须扩大范围，应在本规格中先记录实际依据。

## 9. 实施顺序

1. 在状态机纯测试与真实 App 的 interrupt-ladder 测试中加入“第一击 abort=0”的失败用例；加入 popup 关闭不触发任何运行控制的失败用例。
2. 实现 interrupt-gesture，接线 App/Composer/PromptInput，替换旧 ESC refs 与 timer；完成第二击同步结束、第三击强停、取消确认和覆盖层优先测试。
3. 加入空草稿、500 ms 相位、失焦与编辑恢复的光标失败用例；实现 PromptCaret，并从 fullscreen/inline 输入路径传 reducedMotion。
4. 添加代理对视觉定位与满列换行用例；修正 composer-rows 边界，并验证可见/不可见相位的行列不变。
5. 添加普通新任务带未完成列表、显式继续、失败启动不清理及等待中取消的失败测试；新增 options/结果类型，接线启动阶段与请求序号，再扩展 Store 策略。启动失败必须恢复 idle；过期请求不得修改新提交。
6. 挂载 App 跑实际 TODO 事件流，验证右栏、inline 条、状态栏计数一起消失，第一条有效新计划恢复显示；确认旧历史卡片未被删除或改写。
7. 更新帮助与 README 文案，运行定向测试、build/typecheck、全量回归与第 10.3 节人工场景。报告真实结果，不沿用黑板中的旧测试数量或旧失败结论。

每一步新增测试应先在旧行为上失败，再在实现后通过；先定位行为缺口，不编写只验证私有字段名称的测试。无需为了本设计执行构建，也不将本文列出的下游命令描述为本节点已执行。

## 10. 测试与验收标准

### 10.1 自动化验收矩阵

| 编号 | 场景与可观察结果 |
| --- | --- |
| C-01 | 空输入挂载即有光标；499 ms 仍亮，500 ms 暗，1,000 ms 亮；不吞 placeholder 首字符 |
| C-02 | 非空输入在首、中、末尾，有色反色两相位文本相同；单色按约定替换，但 buffer/提交文本不变；两种模式行列宽度均不变 |
| C-03 | 暗相位输入、退格、移动或恢复焦点，立即亮起并从零计时；无关父渲染不重置周期 |
| C-04 | overlay 打开无输入光标和活跃 timer；关闭恢复；卸载后没有计时更新 |
| C-05 | reducedMotion 常亮且无 interval；colorLevel=0 在普通字符、下划线、空格、CJK 上均有等列可见标记，不污染提交内容 |
| C-06 | CJK、单个非 BMP emoji、Tab、粘贴 token、软换行、显式换行和窗口裁剪下光标不丢失；代理对内部视觉定位有效 |
| C-07 | 满列后光标预留行在明暗相位相同；onDraftRows/onPopupRowsChange 不因 tick 调用 |
| C-08 | 一次按键仍只触发一次 PromptInput 编辑提交；隔离其他既有计时源后，连续 2 秒光标 tick 不额外触发 PromptInput/App 的 React render |
| C-09 | fullscreen 稳定帧明暗切换只输出光标所在行，并最终停靠 H+1；没有额外 showCursor/cursorTo 写入 |
| C-10 | `e\u0301`、独立 `\u0301`、零宽开头及行尾，两种颜色模式下无相位增列；视觉归并不更改 buffer，行宽和预算一致 |
| E-01 | 第一次 ESC 后 abort=0、forceStop=0、aborted=false，运行继续且提示存在 |
| E-02 | 第二次在 1,499 和 1,500 ms 调用 abort 各一次，不强停；1,501 ms 仅重新确认 |
| E-03 | 第一击后输入普通字符、方向键、Ctrl 组合或关闭菜单，再按 ESC 仍只是第一击 |
| E-04 | 第二击触发同步 agent_end 时 endReason 已 aborted，无自动继续；第一击后正常结束仍按原策略决定续跑 |
| E-05 | 卡住运行第三击调用 forceStop，没收到 agent_end 也立即 idle；后台服务未被停止 |
| E-06 | 两击之间运行自然结束，或旧运行结束后启动新任务，不得继承 armed/stopping |
| E-07 | slash/file popup 内第一次 ESC 只关闭菜单，再两次才中断；help/settings/question/plan/confirm 覆盖层同理 |
| E-08 | 空闲等待自动续跑时单 ESC 仍取消计时；有 popup/overlay 时先关闭它，再一击取消续跑 |
| E-09 | 方向键 escape 序列、Alt 键、bracketed paste 不触发手势；三击强停后下一条普通消息仍可启动 |
| E-10 | 第二击同步结束后立即送入 ESC，不出现强停提示或 forceStop；旧结束事件不清除新提交阶段；普通 ESC 的 meta=true 仍可触发手势 |
| T-01 | 前轮 TODO 全完成、部分完成、全部 pending 三组，在成功启动普通新任务前都变为 null |
| T-02 | cleared('turn') 对旧非空 Store 恰好一次；空 Store 不发多余 cleared |
| T-03 | 清理后 fullscreen rail、inline strip、窄屏 chip 全部消失，视口宽度收回；主题/resize 不复活旧列表 |
| T-04 | 无新 todo_write 保持隐藏；新的有效多步计划使面板恢复；过短或无效 payload 不恢复旧列表 |
| T-05 | 运行中 steering、显式 continue、auto continuation 保留 items/updatedAt；不因 continue 累加 stale 计数 |
| T-06 | preflight 失败及旧引擎等待后仍 running，旧 Store 不变；失败通知恰好一次，App 恢复 idle，可再次提交 |
| T-07 | 未传 options 的 Controller 调用保持既有完成清除和 staleTurns 行为；headless/exec 回归通过 |
| T-08 | `/todo continue` 与自动继续的参数均显式 continue；userInitiated 独立控制历史计数 |
| T-09 | 旧历史 TODO 卡片保留，新计划拥有新卡片 ID；保存新运行会话的 todos 是 null 或新列表 |
| T-10 | 恢复会话后可查看原计划，随后普通新任务清理；显式 clear/reset 原有行为不回退 |
| T-11 | 启动前失败返回 not-started，不产生伪 agent_end、不自动续跑；旧请求的延迟结果不能把新运行改为 idle；正常 finished 不重复结束 |
| T-12 | 强停后立即提交，等待中两次 ESC 取消；释放旧引擎后新消息从未进入 engine.prompt，Store 未被清理，取消不报启动失败 |
| T-13 | 等待中再提交不 steer 给旧引擎；强停、成功 reset/replaceMessages、卸载使等待请求失效；后续真正新任务仍能启动 |

组件测试使用 Vitest fake timers，避免真实 sleep 跨过 500 ms 导致随机提交数失败。不得在有 interval 时调用无界 runAllTimers；使用 advanceTimersByTimeAsync 等有限推进并在每例末尾 unmount、恢复 timers。颜色测试既检查明暗帧的 ANSI/文本差异，也检查 strip-ansi 后的显示宽度，不能只靠一个文本快照证明反色可见。

Controller 测试使用实际 TodoStore、可控 provider/engine 夹具和事件订阅，不能只 mock prompt 并断言 mock 自己清理了列表。集成输入测试通过真实 Ink stdin 发送分离的 ESC 事件，覆盖子父监听器接线；保留原来的 Ctrl+C、进程强停及 runGeneration 回归。

R-01/R-02 必须在真实 Controller 与挂载 App 两层验证：用可控 Promise 固定旧引擎退出时刻，分别测试超时、等待中取消与下一次提交；不可用真实 sleep 竞争碰运气。新增 5 条 C-10/E-10/T-11–T-13 后，本矩阵共 33 项。

### 10.2 下游验证命令

均从仓库根目录执行，一行一个命令，上一条失败时先定位，不使用 PowerShell 5.1 不支持的 `&&` 链接。

```powershell
npm run test -w packages/cli -- src/__tests__/prompt-caret.test.tsx src/__tests__/prompt-input-commits.test.tsx src/__tests__/composer-rows.test.ts src/__tests__/frame-differ.test.ts
npm run test -w packages/cli -- src/__tests__/interrupt-gesture.test.ts src/__tests__/interrupt-ladder.test.tsx src/__tests__/app.test.tsx src/__tests__/app-follow-through.test.tsx
npm run test -w packages/cli -- src/__tests__/controller-prompt-boundary.test.ts src/__tests__/todo-store.test.ts src/__tests__/todo-commands.test.ts src/__tests__/todo-responsive.test.tsx src/__tests__/todo-reducer.test.ts
npm run build
npm run typecheck
npm test
```

发布验收要求以上命令通过，或对确实无关的基线失败提供本分支与基线对照证据、日志和明确说明；不能仅引用历史黑板将失败归类。设计阶段仅做文档与代码路径核验，不需要执行这组未来命令。

### 10.3 人工终端验收

至少在本项目使用的 Windows Terminal + PowerShell 和一个 POSIX TTY（Linux 或 macOS）执行；fullscreen 与 inline 各一次。窗口覆盖 120×30、100×20、80×24 和 60×16，输入框为空、英文、中文、emoji、多行粘贴时观察至少三个完整周期。输入和 Agent 流式输出同时发生时，光标仍保持相位变化，输入边框与正文不出现整屏闪烁；减少动画模式常亮。

运行一个可持续观察的无副作用测试任务，单 ESC 应继续输出，两击才退出；另用测试夹具模拟忽略 abort 的前台工具，第三击回到 idle，随后输入仍能运行。打开 `/` 补全或帮助覆盖层后按 ESC，应只关闭菜单；不能出现“Run aborted”或实际停止。用现有服务测试夹具确认 ESC 不影响后台服务，Ctrl+C 原规则仍成立。

让测试任务产生至少三个 TODO 并结束，保留完成或未完成快照可见；再提交不需要计划的简单任务，旧右栏立即消失且没有旧计数。随后提交会创建新 TODO 的任务，应显示全新的计划。再验证 `/todo continue` 与自动续跑保留原计划，并检查 narrow/fullscreen、inline 的表现一致。

人工记录注明终端、尺寸、模式、颜色能力、reducedMotion、操作序列和结果。不以 ink-testing-library 的字符串测试代替真实光标可见性验收。截图只能证明位置，闪烁需短录像或明暗两帧及观察记录。

单色模式增加下划线与组合附加符输入；选择复制输入行，确认结果与当时屏幕一致并注明标记限制，同时用提交回调确认原草稿没有被改写。强停后立即提交，再在启动等待中两次 ESC，确认旧引擎结束后被取消的新消息不会自行启动。

## 11. 风险与缓解

| 风险 | 缓解与验收依据 |
| --- | --- |
| 500 ms 动画把旧输入闪屏问题带回 | 状态放在 PromptCaret；保留帧差分不变量和 C-08/C-09 |
| reducedMotion 在运行时被误判开启 | 传 cfg 的真实选项，不传 activityVisible 派生值 |
| 补全关闭与全局 ESC 同时生效 | 全局只处理覆盖层，PromptInput 只回调未消费的 ESC；真实 App 验证 |
| abort 同步结束导致 follow-through 错判 | 先写 aborted 与 stopping，再调用 abort；E-04 强制覆盖同步事件 |
| 第一击状态泄漏到下一次任务 | agent_end、提交、会话切换、卸载归零；E-06 |
| 简单双击直接强杀影响工作 | 第二击协作退出；只有明确追加第三击才强停；后台服务隔离 |
| 清理 TODO 后自动继续丢计划 | 独立 todoPolicy，自动与手动续跑明确标 continue |
| 启动失败却丢旧计划 | preflight 和引擎 idle 再校验先于边界清理；T-06 |
| 启动拒绝没有 agent_end，UI 永久 running | not-started 结果由 App 按提交序号复位，禁止模拟结束事件触发续跑；T-11 |
| 双 ESC 后待启动消息仍执行 | 对外 abort 失效启动请求序号，所有等待恢复后重新验证；T-12/T-13 |
| React state 尚未提交导致重复中断或串轮 | 同步交互阶段与提交序号先失效，再 dispatch；E-10 |
| 只有 UI 隐藏，其他消费者仍读旧数据 | 统一从 TodoStore 清除，用既有 cleared 广播同步所有投影 |
| 代理对内部让光标定位缺失 | 视觉索引规范化；完整 grapheme 编辑列为已知既有边界 |
| 单色终端不支持反色，原字符也可能是下划线 | 等列且不同于原字符的 ASCII 标记；零宽视觉归并；不污染提交文本，屏幕复制标记限制明确记录 |
| 旧测试仍要求第一次 ESC 中断 | 更新行为断言与所有用户文案，保留旧强停/服务保护能力的回归 |

本次设计不提供 OS 窗口焦点检测；active 表示应用内输入焦点，终端窗口失焦时是否继续动画由宿主决定。不加入任意“任务完成文本”识别，避免模型措辞影响 TODO 生命周期。若 provider 在成功进入新任务后失败，旧计划仍保持清空：新任务边界已经成立，这与启动前 preflight 失败保留计划不同。

## 12. 交付检查

本评审节点完成标准：仅修改本 spec，版本为 v2；顶部有评审记录，末尾有评审结论；所有 P0/P1 已在正文修正，记录与接口、文件计划、测试验收相互一致；未修改源代码，未执行 git commit。保留上游概述/技术设计/文件计划/接口/数据模型/测试验收/风险章节。下游实施完成标准另以第 10 节为准，不能将“设计评审通过”写成“功能已修复”。

完成前核查文档结构、评审条目与修正位置、引用文件以及本轮修改范围，使用任务工具记录本节点无源码改动，再上报 complete 并通过 status 核实 index=1 为 completed。文档中的所有新增接口、测试和行为都是后续实施契约，不是已运行或已发布的功能声明。

## 评审结论

**通过**。v2 已直接修正 5 项 P1 和 3 项 P2，未发现 P0，未解决 P0/P1 为 0。方案可在当前 React/Ink、CLI Controller 与 TodoStore 边界内实施，无需增加依赖或修改 Core 公共接口。

本结论批准设计进入实施；第 10 节自动化回归及 Windows/POSIX 真实终端验收仍是下游交付门槛。本轮只完成文档和现有代码路径核验，未执行未来功能测试、未声称三项功能已实现。单色屏幕复制标记及非完整 grapheme 编辑限制已明确记录，不构成未解决的 P0/P1。

## 实施过程发现的方案缺陷

### IF-01：Ink 零宽码点输出与单色替换的兼容

实际安装的 Ink `build/output.js::get` 对 token 中的字符推进输出网格，组合附加符也参与该过程。直接将 `e\u0301` 整体替换为 `_`，纯布局显示宽度虽然一致，挂载后的整行宽度却会在相位间变化。实现保留原片段中的零宽码点，仅将正宽码点替换为等宽下划线；若替换结果与原文一致，改用等宽 `^`。回归覆盖四类零宽输入、逐 UTF-16 位置和两种颜色模式，验证相位不改变每行宽度及提交原文。没有修改 Ink，也没有承诺修复其既有组合字符绘制或完整 grapheme 编辑。

### IF-02：运行中会话切换造成同步交互阶段与引擎分裂

`/reset` 和 `/resume` 原先没有运行中限制，Core 的消息替换也不会停止运行；reducer 的 `resetConversation`/`restoreEntries` 保留原 status。若仅按 §5.2 将同步阶段设为 idle，旧引擎继续运行而 ESC 无法再中断，旧 `agent_end` 还可能结束后续 starting 阶段。修正为 App 在实际 running 阶段拒绝这两个会话切换命令，提示先中断当前运行；idle 和 starting 仍允许切换。成功切换的 dispatch 包装同步失效请求，并显式派发 runEnd 使视图与阶段一致。`/clear` 保持原有语义。新增回归验证拒绝后 ESC 仍可用、starting 时 reset 可撤销等待并回到 idle。

starting 的主动会话切换先派发 abortMark，再派发 runEnd；idle 切换不重复结束。这避免 reducer 将未产出内容的主动取消误报为通用运行失败。

### IF-03：挂载运行状态需要校准其他既有测试桩

全量测试发现 `mouse-routing.test.tsx` 的 Controller 桩缺少 `isRunning()`，`single-spinner.test.tsx` 的夹具在真正 prompt 之前已经令 running=true，导致新挂载阶段正确识别为已有运行后走 steering。两者原先不符合真实 Controller 生命周期，补齐状态查询，并在事件发出时更新运行状态；不改变生产接口或鼠标、spinner 业务。文件清单已增加这两处最小测试修正。

## 实施交接与验证记录

本实施节点已落实文件计划：叶子组件驱动 500 ms 闪烁光标；同步交互阶段支持 1500 ms 内双 ESC 协作中断及第三击强停；Controller 在实际启动新任务时清空旧 TODO，显式与自动续跑保留计划，并用请求序号取消待启动任务、隔离过期结果。三项机制的逻辑记录已分别登记到任务服务器。没有新增依赖，没有执行 Git 提交。

验证结果：

- 共享工作区 `npm run typecheck`、`npm run build` 均通过；构建后 `node packages/cli/dist/cli.js --version` 成功输出 `0.6.7`。
- 从 Git HEAD 提取基线、叠加本任务计划内变更的隔离副本位于 `.agentmesh/lifecycle-validation/`。该副本构建、类型检查、CLI 启动检查均通过；`npm test` 全量通过：CLI 204 个测试文件、3,046 项通过、6 项跳过；Core 29 个测试文件、466 项通过。合计 3,512 项通过、6 项跳过、0 项失败。最终日志为 `.agentmesh/lifecycle-full-test-passed.log`。
- 光标宽度与帧差分、菜单 ESC 所有权、同步中断、启动取消与过期结果、TODO 清空和续跑边界已有自动化覆盖；只读复核未发现遗留 P0/P1。
- `git diff --check -- .` 通过。共享工作区同时有另一个 `tui-unified-scrollbar` 任务的修改，已保留；本任务未将其纳入隔离全量测试结论，因此不能声称整个共享工作区无其他改动，或其完整集成测试已经通过。

发布前仍需执行 §10.3 的 Windows Terminal 与 POSIX 真实 TTY 人工验收。本节点没有完成真实终端的闪烁观察、录像或复制交互记录；自动化测试不能代替这些验收。单色屏幕复制可能带入光标标记、既有非完整 grapheme 编辑行为等边界保持 §11 的说明。

## 代码终审与提交范围（2026-10-03）

终审结论：本功能可提交，未发现未解决的 P0/P1。逐项核对 §8 的 30 个源码、测试和 README 文件，以及 §10.1 的光标、中断和任务边界行为；未扩大到 Core API、配置格式或持久化结构。真实终端发布验收仍按上节保留，不将自动化通过表述为人工验收完成。

| 审查领域 | 核查结论与证据 |
| --- | --- |
| 光标显示 | PromptCaret 叶子持有 500 ms 相位；编辑、焦点和宽度变化重置，配置的 reducedMotion 保持常亮；零宽字符、代理对、行列预算及差分停靠由光标、输入和 composer-rows 测试覆盖 |
| ESC 所有权与生命周期 | PromptInput 先消费菜单关闭，全局仅处理覆盖层；纯状态机覆盖 1499/1500/1501 ms，挂载测试覆盖第二击同步结束、第三击强停、后台服务及 Ctrl+C 回归 |
| 新任务与续跑 | new-task/continue/缺省三种策略分别接入；真实 Controller 和 TodoStore 测试覆盖启动超时、取消、过期结果和清理时机；面板、条、计数与历史卡片的回归通过 |
| 相邻功能 | headless/exec 仅兼容返回类型；既有服务、团队、计划模式、粘贴、渲染和自动续跑包含在完整 CLI 回归中 |
| 命名与注释 | 修正 TodoClearReason 的重复且冲突的 turn 注释、Store 与 README 的旧清理规则，以及中断测试中“第二击强停”的过期说明；整理两处测试文件头导入及续跑调用排版 |
| 仓库规范 | 将 App、Controller 和 builtins 的历史尺寸与有限接线例外登记到 `.claude-index/config.md`，避免全面拆分扩大回归面；新增机制仍保持独立小模块 |

本轮重新执行的验证均成功，日志保存在 `.agentmesh/lifecycle-review-validation.log`，命令退出码保存在 `.agentmesh/lifecycle-review-validation.done.json`：

- 独立版本 `npm run build`、`npm run typecheck` 通过。
- 构建后 `node packages/cli/dist/cli.js --version` 输出 `0.6.7`。
- 全量 `npm test -- --reporter=dot`：CLI 204 个测试文件、3046 通过、6 跳过；Core 29 个测试文件、466 通过。合计 3512 通过、6 跳过、0 失败。
- `git diff --check -- .` 通过。

独立验证内容以 `21da100d0` 为基线，叠加本功能变更，保存在 `.agentmesh/lifecycle-validation/`。与并行滚动条任务交叠的 App、Composer、PromptInput、帮助、README 和测试文件仅选取本功能内容；暂存通过单独工作树映射逐文件执行 `git add <具体路径>`，并逐个比对 Git blob 与验证快照。提交清单为上述 30 个计划文件，加本规格及本功能的规范例外，共 32 个文件。临时脚本、日志、验证副本、构建输出与滚动条改动不属于该提交。
