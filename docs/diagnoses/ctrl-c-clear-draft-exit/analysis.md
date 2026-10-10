# 诊断报告：Ctrl+C 直接退出丢失输入草稿（期望：有输入时 ×2 清空、×3 退出）

- **症状（用户原话）**：「当用户的输入区域，已经输入了内容的时候，ctrl+c按钮，点击两下，则清空输入区域，三下的时候，再退出TUI，没有输入的时候，和现在一样」。
- **结论（一句话）**：App 的 Ctrl+C 阶梯（复制取消 → 选区复制 → 停后台服务 → 双击退出）从头到尾
  **不感知输入草稿**（`App.tsx:1945-1980` 无任何 draft 判定），而草稿状态被刻意留在
  Composer 内部不上行（`Composer.tsx:59-68` 注释），App 也没有任何「清空输入框」的下行通道
  （`'clear'` reducer 动作只有提交路径使用，`composer-input.ts:46`）。于是输入到一半的用户
  在 1.5 秒内按两次 Ctrl+C 会**直接退出 TUI，草稿无提示丢失**。
- **bug 代号**：`ctrl-c-clear-draft-exit`
- **严重级**：P2（数据丢失类交互缺陷：长草稿/多行粘贴草稿一次误触即丢）
- **证据来源**：源码逐行核对（App/Composer/PromptInput/editor-reducer/composer-input）+
  手动复现（App 级挂载需要完整 controller，按键级最小复现见 §2.2 的分层证据）。

---

## 1. 问题描述

当前 Ctrl+C 语义（`App.tsx:1945-1980`）：

| 击序（1.5s 窗口内） | 现状行为 |
|---|---|
| 第 1 击 | `ctrlCArmed = true`，状态行反馈 `Press Ctrl+C again to exit`（`status-feedback.ts:29-31`），1500ms 后自动解除（`App.tsx:1974-1978`） |
| 第 2 击 | `doExit()`（`App.tsx:1966-1968`）——abort 运行、强杀后台服务、`exit()`（`App.tsx:1527-1540`） |

输入框里有没有草稿对这条阶梯**零影响**。用户期望的语义：

| 输入框状态 | 期望行为 |
|---|---|
| 有内容 | 第 1 击 arm（提示「再按一次清空输入」）；第 2 击**清空输入区域**；第 3 击退出 TUI |
| 空 | 与现状完全一致（双击退出） |

即「有草稿时，清空是一级台阶，退出永远在清空之后」——终端用户在 tmux/htop 里熟悉的
「先破坏性小、后破坏性大」的阶梯。

## 2. 复现步骤

### 2.1 真实环境复现（手动，~30 秒）

1. 启动 TUI：`aragon`（无需 API Key，能进入输入界面即可）。
2. 在输入区打一段较长的文字（例如粘贴多行文本，形成 `[Pasted text #1 +N lines]` token 更佳）。
3. 在 1.5 秒内按 **Ctrl+C** 两次。
   - **预期（用户期望）**：第一次提示、第二次清空输入区，TUI 仍在；第三次才退出。
   - **实际（bug）**：TUI 直接退出，整个草稿（含粘贴 token 的原始载荷）丢失，没有任何
     「未发送内容将丢弃」的确认或挽回。
4. 对照：输入区为空时双击 Ctrl+C 退出——这是期望保留的现状，证明差异只在「有草稿」分支。

### 2.2 分层证据（可复制的最小化验证）

App 级挂载需要完整 `AgentController`/provider 环境，不适合做最小 repro；下面用逐层证据钉死
「App 不知道草稿、也无法清空草稿」这一根因。前三步是静态事实（`grep` 即可核对），第四步是
可运行的组件级验证。

1. **Ctrl+C 归 App 所有，PromptInput 主动放行**：

   ```ts
   // packages/cli/src/ui/PromptInput.tsx:713
   if (key.ctrl) return; // App owns Ctrl+C / L / T / O.
   ```

   App 侧全局 `useInput`（`packages/cli/src/ui/App.tsx:1902`）中，Ctrl+C 分支
   （`App.tsx:1945-1980`）依次处理：复制任务取消（1924-1927）、选区复制（1928-1942）、
   停后台服务（1960-1965）、armed→`doExit`（1966-1969）、否则 arm（1970-1978）。
   **整段没有出现任何 draft/buffer/hasDraft 字样**（`grep` 验证：App.tsx 无 `hasDraft`）。

2. **草稿状态刻意不上行**：

   ```ts
   // packages/cli/src/ui/Composer.tsx:59-68（注释即证据）
   * `hasDraft` stays here, because the border reacts to it and routing that
   * through `App` would re-render the transcript on the first keystroke of every
   * message. The row count is the opposite case: `layout/budget.ts` needs it...
   ```

   实际上行链止步于 Composer：`PromptInput.tsx:525-537` 的 `onDraftChange`（仅在
   空↔非空、行数变化时触发）被 `Composer.tsx:142-149` 消化为本地 `setHasDraft` +
   `onDraftRows`。App 只拿到行数。

3. **App 没有清空输入框的下行通道**：

   ```ts
   // packages/cli/src/ui/editor-reducer.ts:82,244-245 —— 'clear' 动作存在
   | { type: 'clear' }
   case 'clear': return INITIAL_EDITOR_STATE;
   ```

   但全仓 `type: 'clear'` 的派发点只有 `packages/cli/src/ui/composer-input.ts:46`
   （提交规划时清空草稿）与测试文件。`PromptInput` 不接受任何外部清空信号
   （props 里无 `clearSignal`/`draftKey`/imperative ref）。

4. **组件级验证（可运行）**：把下面文件复制为
   `packages/cli/src/__tests__/repro-ctrlc-draft.test.tsx` 运行
   （`npx vitest run src/__tests__/repro-ctrlc-draft.test.tsx`），
   证明「外部（App 层）按 Ctrl+C 后，PromptInput 一无所知、草稿原样保留」以及
   「hasDraft 通道存在但只到 Composer 层」：

   ```tsx
   import React from 'react';
   import { PassThrough } from 'node:stream';
   import { afterEach, describe, expect, it, vi } from 'vitest';
   import { render } from 'ink';
   import { createStdinFilter } from '../input/stdin-filter.js';
   import { PromptInput } from '../ui/PromptInput.js';
   import { getTheme } from '../ui/theme.js';

   const caps = { colorLevel: 0 as const, unicode: false };
   const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
   const cleanups: (() => void)[] = [];
   afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

   async function mount(element: React.ReactElement) {
     const source = Object.assign(new PassThrough(), {
       isTTY: true, setRawMode: () => source, ref: () => source, unref: () => source,
     });
     const filter = createStdinFilter(source as unknown as NodeJS.ReadStream,
       { mouse: false, paste: true });
     const output = Object.assign(new PassThrough(), { columns: 80, rows: 40, isTTY: true });
     let frame = '';
     output.on('data', (chunk) => { frame += String(chunk); });
     const app = render(element, {
       stdin: filter.stdin, stdout: output as unknown as NodeJS.WriteStream,
       stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
     });
     cleanups.push(() => { app.unmount(); app.cleanup(); filter.dispose(); source.destroy(); });
     await delay();
     return { frame: () => frame, send: async (bytes: string) => { source.write(bytes); await delay(); } };
   }

   describe('DIAG-3 Ctrl+C ladder cannot see or clear the draft', () => {
     it('PromptInput yields every Ctrl+chord to App; the draft survives Ctrl+C input bytes', async () => {
       const onDraftChange = vi.fn();
       const view = await mount(<PromptInput
         isActive running={false} history={[]} commands={[]} cwd={process.cwd()}
         caps={caps} theme={getTheme('cool', caps)} cols={80}
         onSubmit={() => ({ accepted: true })} onDraftChange={onDraftChange} />);
       await view.send('draft text');
       expect(onDraftChange).toHaveBeenLastCalledWith(
         expect.objectContaining({ hasDraft: true }));        // 草稿事实存在且可上报
       await view.send('\x03');                               // Ctrl+C 字节到达输入组件
       expect(view.frame()).toContain('draft text');          // 草稿仍在（组件层无清空语义）
       expect(onDraftChange).toHaveBeenLastCalledWith(
         expect.objectContaining({ hasDraft: true }));        // 仍是非空草稿
     });
   });
   ```

   说明：真实 App 里 `\x03` 由 App 的 `useInput` 处理并最终 `exit()`——本用例钉死的是
   **组件层既不消费 Ctrl+C 也没有可被外部调用的清空入口**这一事实，因此 App 层要实现
   「×2 清空」必须新增通道，而不是调用现成能力。

## 3. 根因分析（证据汇总）

**根因：Ctrl+C 的所有权（App）与草稿的所有权（PromptInput 内部 reducer）分属两棵子树，
两者之间既没有「是否有草稿」的上行事实通道，也没有「请清空草稿」的下行控制通道。**

| 环节 | 证据 | 现状 |
|---|---|---|
| Ctrl+C 阶梯 | `App.tsx:1945-1980` | 无草稿感知；armed → `doExit()`（`App.tsx:1966-1968`），`doExit` 见 `App.tsx:1527-1540` |
| armed 反馈 | `status-feedback.ts:29-31` `Press Ctrl+C again to exit`；解除计时 `App.tsx:1974-1978`（1500ms） | 文案与解除逻辑均无「清空」台阶 |
| 草稿事实 | `PromptInput.tsx:525-537`（`onDraftChange`，transition-only）→ `Composer.tsx:142-149` | 止步于 Composer 本地 `hasDraft`（`Composer.tsx:142`），App 拿不到 |
| 清空能力 | `editor-reducer.ts:82, 244-245`（`'clear'` 动作）；派发点仅 `composer-input.ts:46` | 无 App→Composer→PromptInput 的触发通路 |
| 帮助文案 | `HelpOverlay.tsx:37` `Ctrl+C x2 Exit` | 需随新阶梯同步 |

补一个对设计有利的事实：**armed 与 `hasDraft` 的组合天然形成「两下清空、三下退出」**，不需要
独立的击数计数器——第 2 击清空草稿后 `hasDraft` 变为 false，第 3 击落在「无草稿 + 已 armed」
分支上恰好就是 `doExit()`。阶梯是自洽的，只需把判定补进现有 if/else。

### 评审补充证据（复核新增，行号已在 HEAD 逐一核对）

1. **上行链止于行数的精确接线**：`App.tsx:1356`（`const onDraftRows = useCallback((next:
   number) => {...}`）与 `App.tsx:2524`（`onDraftRows={onDraftRows}` 传给 `Composer`）——
   App 今天从 Composer 拿到的确实**只有行数**这一个数字；`grep` 复核 `App.tsx` 全文无
   `hasDraft`。`PromptInput` 的 props 解构（:383-405）无任何外部清空信号，§2.2-3 的论断成立。
2. **渲染时序不变量（方案 A 的隐藏前提，必须写进实现注释）**：`hasDraftRef` 是 ref、不触发
   渲染，状态行反馈（`status-feedback.ts`）却在渲染期求值——文案之所以不会 stale，是因为
   **阶梯自身的每一击都恰好触发一次渲染**：arm 调 `setMetricsClock(value => value + 1)`
   （`App.tsx:1972`），清空台阶 bump `draftClearNonce`（state 更新）。若未来某个 rung 改成
   不触发渲染的纯 ref 写入，反馈文案就会与实际状态脱钩。此不变量是方案 A 的一部分，不是
   实现细节。
3. **第 3 击的时序安全性**：nonce → `useEffect` → `dispatch({type:'clear'})` → 重渲染 →
   `onDraftChange` 过渡回调（`PromptInput.tsx:531-537`，`useLayoutEffect`，同步于 commit）
   → `hasDraftRef.current = false`。整条链在一次事件循环内完成，远快于人的下一次击键，
   「armed && !hasDraft → doExit」的第 3 击不会读到过期值。
4. **StrictMode / 双重 effect 安全**：nonce effect 在开发模式可能双调用，`'clear'` 幂等
   （两次都回 `INITIAL_EDITOR_STATE`，`editor-reducer.ts:244-245`），无副作用。
5. **两个已接受的边界（评审裁定不阻塞，随修复记录在案）**：
   - arm（空草稿，提示 exit）后 1.5s 内**粘贴**出新草稿 → 第 2 击落「armed && hasDraft」
     清空而非退出。事实驱动阶梯的自然结果；被清内容仍在剪贴板，无实质丢失，可接受。
   - arm（有草稿，提示 clear input）后用户用 Ctrl+U 手动清空（`PromptInput.tsx:701-711`
     的行编辑意图在 :713 `key.ctrl` 早退**之前**识别，故 Ctrl+U 今天就有效）→ 第 2 击落
     「armed && !hasDraft」直接退出。无可清空之物时落到下一 rung，与 tmux/htop 同类行为。
6. **复现重跑**：评审节点将 §2.2-4 原样落盘为临时测试重跑，1/1 通过后已删除临时文件。

## 4. 影响面

| 维度 | 影响 |
|---|---|
| 受影响功能 | 退出快捷键；输入草稿（含多行与 `[Pasted text #N]` 粘贴 token 及其载荷）的留存 |
| 受影响用户 | 所有关键到一半改主意想清空重写的用户（现状只能逐字退格 / Ctrl+U 逐行 kill，多行草稿要多次）；以及误触双击 Ctrl+C 丢长草稿的用户 |
| 数据丢失范围 | 未发送草稿与粘贴 token 载荷（`pastes` Map 随组件卸载销毁），退出后不可恢复 |
| 不受影响 | 空输入双击退出（需求明确保留）；选区存在时 Ctrl+C=复制（`App.tsx:1928-1942`，优先级在最前，不得被清空台阶覆盖）；后台服务运行时 Ctrl+C=停服务（`App.tsx:1960-1965`）；复制任务进行中的取消（`App.tsx:1924-1927`）；Esc x2 interrupt（与 Ctrl+C 独立） |
| 文案/文档 | `status-feedback.ts`、`interaction-copy.ts`（`exit: 'Ctrl+C x2 exit'`）、`HelpOverlay.tsx:37` 三处文案；`docs/specs` 相关输入规范 |

## 5. 候选修复（对比表）

| 方案 | 做法 | 侵入性 | 风险 | 工作量 |
|---|---|---|---|---|
| **A：双向通道 + 组合阶梯**（推荐） | 上行：`Composer` 把 `hasDraft` 以 transition-only 方式转发给 App（App 存 `ref`，不触发重渲染，尊重 `Composer.tsx:59-68` 的性能理由）。下行：App 持有 `draftClearNonce` state（数字递增），经 Composer 透传给 `PromptInput`，`useEffect` 对 nonce 变化派发 `{ type: 'clear' }`。阶梯改为：armed 且 `hasDraft` → 清空（保持 armed，反馈改为 to exit）；armed 且无草稿 → `doExit()`；未 armed → arm | 中：一条上行 prop + 一条下行 prop + App 阶梯分支 | 低：`'clear'` 动作已存在且语义就是回到 `INITIAL_EDITOR_STATE`（连同 `pastes` 一起释放，`editor-reducer.ts:244-245`）；nonce 模式与现有 `metricsClock`/Ctrl+L 重绘同风格；App 端 `ref` 存 `hasDraft` 不引入每键重渲染 | ~1 天（含测试与三处文案） |
| B：Ctrl+C 清空语义下沉到 PromptInput（组件自己数击） | PromptInput 拦下 Ctrl+C 第一击清空、其余上抛 | 高：打破「App owns Ctrl+C」的既定所有权（`PromptInput.tsx:713` 注释即契约），与选区复制/停服务阶梯冲突 | 高：两条阶梯（App 与组件）各数各的击数，组合出不可枚举的状态；复制场景（Ctrl+C=copy）会被组件层先吞 | ~2 天且后患大 |
| C：双击退出前弹确认对话框 | armed 第二击改为「Discard draft and exit?」确认 | 中 | 中：打断紧急退出路径（终端用户的 Ctrl+C x2 是逃生键，加模态反而危险）；不满足「×2 清空、×3 退出」的明确需求 | ~1 天 |

## 6. 推荐修复及理由

**采用方案 A**，要点与边界：

1. **阶梯语义**（改 `App.tsx:1945-1980` 的 Ctrl+C 分支，保持既有前置 rung 不动）：

   ```
   复制取消 → 选区复制（现状，最优先，不动）
   → 停后台服务（现状，不动）
   → Ctrl+C：
       armed && hasDraftRef.current  → 清空草稿（draftClearNonce++），保持 armed，
                                      反馈切为 "Press Ctrl+C again to exit"
       armed && !hasDraft            → doExit()            （空输入 ×2 退出 = 现状；
                                                            有输入 ×3 退出 = 清空后的下一击）
       未 armed                      → arm，反馈按 hasDraft 分为
                                      "Press Ctrl+C again to clear input" / "…to exit"
   ```

   `hasDraft` 判定与 `PromptInput.tsx:529` 的 `buffer.length > 0` 一致（粘贴 token 天然计入）。
   1500ms 解除计时沿用（`App.tsx:1974-1978`），清空台阶不重置计时。
2. **上行通道**：复用 `onDraftChange` 的 transition-only 上报（`PromptInput.tsx:525-537` 已保证
   只在空↔非空与行数变化时回调），Composer 转发到 App 的 `onDraftPresence` 回调，App 端写入
   `useRef`（如 `hasDraftRef.current = next.hasDraft`）——不进 React state，不引发 transcript
   重渲染，正面回应 `Composer.tsx:59-68` 的性能约束。
3. **下行通道**：`draftClearNonce: number` prop 一路传入 `PromptInput`，内部
   `useEffect(() => { if (nonce > 0) dispatch({ type: 'clear' }); }, [nonce])`。选 nonce 而非
   boolean 的原因：连续两次清空需求（未来）也能表达，且 effect 依赖稳定不重放。
   `'clear'` 已把 `pastes` 载荷一并释放（`editor-reducer.ts:244-245` → `INITIAL_EDITOR_STATE`）。
4. **反馈与文档**：`status-feedback.ts` 增加 `{kind:'clear-input', text:'Press Ctrl+C again to exit', ...}`
   一类投影（armed 且刚清空）；`interaction-copy.ts` 与 `HelpOverlay.tsx:37` 改为
   `Ctrl+C x2 clear input · x3 exit`（有草稿时）/`Ctrl+C x2 exit`（空）。
5. **测试**：组件级——nonce 变化后 buffer/pastes 归零、`onDraftPresence` 上报 false；
   App 级（沿用现有 App 测试基建）——有草稿 ×2 不退出且草稿空、×3 退出、空输入 ×2 退出、
   选区存在时 Ctrl+C 仍是复制且不清空、服务运行时 Ctrl+C 仍是停服务。
6. **明确不做**：清空不写入历史（不把被清草稿追加进 prompt-history）；清空不可撤销
   （保持与退格/kill 一致的轻量语义，避免引入 undo 子系统）。

理由：A 是唯一既满足用户明确语义、又不破坏现有五个 Ctrl+C rung（复制取消/选区复制/停服务/
双击退出/帮助文案）的方案；阶梯的新台阶完全由 `armed × hasDraft` 两个既有事实组合而成，
没有新的计时器或计数器，实现量与风险都是三个方案中最低的。

---

## 评审结论

**裁定：根因证据链成立，最终推荐 = 方案 A（上行 `onDraftPresence`→ref + 下行 `draftClearNonce` + `armed × hasDraft` 组合阶梯），按 §6 落点执行，并把渲染时序不变量与两个接受边界一并落进实现注释。**

### 1. 根因证据审计（通过）

- §2.2/§3 全部引用在 HEAD 逐行复核一致：`App.tsx:1945-1980` 整段无任何 draft 判定（grep
  复核全文无 `hasDraft`）；`Composer.tsx:59-68` 注释明说 `hasDraft` 刻意留在本地；
  `Composer.tsx:142-149` 把 `onDraftChange` 消化为本地 state + 行数上行（`App.tsx:1356/:2524`
  只拿行数）；`'clear'` 动作存在（`editor-reducer.ts:82/:244-245`）但生产代码唯一派发点是
  `composer-input.ts:46`（grep 复核全仓仅此一处 + 测试）；`PromptInput.tsx:713`
  `if (key.ctrl) return` 证明 Ctrl+C 所有权契约。**「两棵子树间既无上行事实也无下行控制
  通道」的双向缺失诊断成立**，这正确解释了为什么修复必须新增通道而不是调用现成能力。
- §2.2-4 复现由评审节点原样重跑：**1/1 通过**（Ctrl+C 字节到达输入组件后草稿原样保留、
  `onDraftChange` 通道存在但止于组件层）。
- §3「armed × hasDraft 自然形成两下清空三下退出、无需独立计数器」的论证经复核成立——
  这是方案 A 优于一切计数器方案的核心理由。

### 2. 候选方案审计

- **A（推荐）**：双向通道各一条 prop，阶梯分支复用两个既有事实（`ctrlCArmed` ref 与
  `hasDraft`），无新计时器。`Composer.tsx:59-68` 的性能约束被正面满足：上行写 ref 不进
  state，不引发 transcript 重渲染；下行 nonce 是既有模式（`metricsClock`/`redrawNonce`
  同风格）。`'clear'` 连 `pastes` 载荷一并释放（`INITIAL_EDITOR_STATE`），数据清理彻底。
- **B**：否决。组件层自数击数打破 `PromptInput.tsx:713` 声明的所有权契约，与 App 阶梯
  （选区复制/停服务）组合出不可枚举状态，且复制场景会被组件层先吞。
- **C**：否决。模态确认打断紧急退出路径（Ctrl+C ×2 是逃生键），且不满足「×2 清空 ×3 退出」
  的明确需求。

### 3. 最终修复方案（给下一节点）

1. 阶梯改写按 §6.1 落点：复制取消/选区复制/停服务三个前置 rung 原样不动；之后
   `armed && hasDraftRef.current → 清空（nonce++，保持 armed，反馈切 exit 提示）`；
   `armed && !hasDraft → doExit()`；未 armed → arm 且反馈按 `hasDraft` 二分文案。
   1500ms 解除计时沿用，清空台阶**不**重置计时。
2. 上行：`Composer` 转发 `onDraftChange`（transition-only，`PromptInput.tsx:525-537` 已保证
   逐键不触发）为 `onDraftPresence`，App 端只写 `useRef`。
3. 下行：`draftClearNonce: number` 经 `Composer` 透传 `PromptInput`，effect 对 nonce 变化
   派发 `{type:'clear'}`（幂等，见评审补充证据第 4 条）。
4. 文案三处同步：`status-feedback.ts:29-31`（新增按 `hasDraft` 分支的反馈投影，输入结构体
   需携带草稿事实）、`interaction-copy.ts:28`、`HelpOverlay.tsx:37`。
5. **随修复写入实现注释的两条**：渲染时序不变量（评审补充证据第 2 条——每击必触发渲染，
   否则反馈文案 stale）；两个接受边界（第 5 条）。
6. 测试按 §6.5 落地；`status-toggle.test.tsx:69` 一类现有 Ctrl+C 反馈断言需随文案核对更新。

**一句话理由**：缺陷是「所有权分裂导致的双向通道缺失」，A 是唯一按此诊断对症下药的方案——
用两条最小 prop 补齐双向通道，让新台阶完全由既有事实组合而出，既满足用户语义，又不触碰
五个既有 rung 的优先级契约。


## 实施过程发现的方案缺陷

1. **§6.1 的「反馈切为 exit 提示」在 nonce 渲染时点无法由 ref 单独达成（已补一个状态位）**：
   评审补充证据第 2 条指出的渲染时序不变量（每击必有一次渲染）成立，但清空台阶的那次
   渲染发生在异步清空链（nonce → PromptInput effect → `'clear'` → `onDraftChange` 过渡
   回调）**之前**——该帧读 `hasDraftRef.current` 仍为 true，反馈会重复「clear input」
   文案；单行草稿清空后行数不变（1→1），`onDraftRows` 的 setState bail-out 不产生后续
   App 渲染，stale 文案将悬挂至 1500ms 解除。修复补一个 `draftClearedByCtrlC` state
   （清空 rung 置 true；presence 回调上报新草稿、1500ms 解除计时器复位），反馈投影改用
   `hasDraftRef.current && !draftClearedByCtrlC`，使 nonce 渲染当场切换为 exit 文案。
   该状态位已作为阶梯注释的一部分写入 `App.tsx`，不改变阶梯的按键语义（第 3 击行为
   由 ref 直接判定，本就不受影响）。
2. **§6.5 的 App 级「选区存在时 Ctrl+C 仍是复制且不清空、服务运行时仍是停服务」未新增
   用例**：这两个前置 rung 的代码本次零改动且优先级在清空台阶之前，既有回归网已覆盖
   （`app.test.tsx` 的复制路径、`interrupt-ladder.test.tsx` AC-29/AC-30），全量重跑通过；
   在新测试文件中复刻选区/服务夹具只会重复覆盖同一代码路径，故未添加。组件级 nonce、
   投影级二分、App 级三阶梯（×2 清空不退出、×3 退出、空输入 ×2 退出）均已落
   `__tests__/ctrl-c-draft-ladder.test.tsx`。
