# `/clear` 之后，右侧 TODO 面板（rail）没有被清除

**Bug slug**: `slash-clear-leaves-todo-panel`
**版本**: v1（Subtask #0 · 问题定位与分析）
**日期**: 2026-08-01
**代码基线**: `aragon-agent-core` @ `64ebe3f9`，`packages/cli` v0.5.11

> **下游（评审 / 修复节点）阅读顺序**：先读 §3.4「这不是漏写，是被明确写下来的设计」——
> 它决定了本次修复不是"补一行"，而是**修订一条被写进不变量、测试、README 与 spec 的既有约定**。
> 然后读 §6 推荐方案的落地清单，那里列的 5 处文档 / 测试同步是修复的一部分，不是可选项。

---

## 0. 代码位置声明（下游必读）

本任务图的工作目录是 `M:/takoAI/JRAgentMesh/aragon-agent-core`，**本次缺陷确实就在该子项目内**
（与本仓库上一份诊断 `docs/diagnoses/new-plan-project-task-dropdown-empty/analysis.md` 的结论相反，
那次的缺陷在宿主 AragonMesh，这次不是）。判定依据：

1. 用户描述的"右侧 TODO 显示"是 **aragon CLI 的 Ink TUI 右侧 rail**，实现在
   `packages/cli/src/ui/TodoPanel.tsx`，由 `packages/cli/src/ui/layout/AppShell.tsx` 的 `rail` 插槽承载。
2. `/clear` 是 **CLI 的 slash 命令**，注册在 `packages/cli/src/commands/builtins.ts:963-967`。
3. 宿主 AragonMesh（`M:/takoAI/JRAgentMesh/src`）全树只有一个 `/clear`，在
   `src/components/orchestration/nl-chat-panel.tsx:35,199`，语义是 *"Clear all nodes and connections"*
   （编排画布清空），既没有 TODO 面板也没有"清除上下文"语义 —— **排除**。

本文所有 `path/to/file.ts:NN` 引用，若无特别说明，**均以 `M:/takoAI/JRAgentMesh/aragon-agent-core/` 为根**。

---

## 1. 问题描述

用户原话：

> 这个项目现在执行完任务了以后，其右侧的这样的一个 TODO 对应的这样的结果虽然显示出来了，
> 但是当用户去输入杠 clear 去清除上下文了以后，其右侧的 TODO 这样的一个显示结果没有正确的被清除掉，
> 这个是不对的，需要把这个问题进行修复

拆成可验证的两句：

| # | 事实 | 判定 |
|---|---|---|
| A | 任务跑完后右侧 rail 显示 `7/7 done` 的 TODO 列表 | **符合预期**（`store.ts:147-149` 有意为之：让用户拿到"7/7 done"这一刻的反馈） |
| B | 用户输入 `/clear` 后，正文（transcript）清空了，但右侧 TODO 面板**原样留在屏幕上** | **就是本 bug** |

一个必须先摆正的语义分歧（它决定了候选方案的取舍，见 §5）：

- **用户的心智模型**：`/clear` = 清除上下文（Claude Code 语义）。
- **本 CLI 当前的实现与文档**：`/clear` = *Clear the visible transcript*，**只清屏、不清对话**；
  清对话的是 `/reset`。见 `packages/cli/README.md:110-111`：

  ```
  | `/clear` | Clear the visible transcript |
  | `/reset` | New conversation |
  ```

  代码侧一致：`/clear` 只 `dispatch({type:'clearTranscript'})`，**从不触碰 `messages`**
  （`builtins.ts:966`），而 `/reset` 会 `controller.clearMessages()`（`builtins.ts:972`）。

也就是说：**用户说的"清除上下文"，`/clear` 今天并没有做**。但无论按哪一种语义，
"清屏之后右侧还挂着上一轮任务的 TODO"都是缺陷 —— 只是**根因归属**与**推荐修法**不同，见 §5 / §6。

---

## 2. 复现步骤

### 2.1 交互式复现（用户路径，端到端）

前置：`packages/cli` 已 `npm run build`，配置好任意可用模型（`aragon config`），
终端宽度 **≥ 80 列**、高度 ≥ 约 14 行（低于阈值 rail 本身就不挂载，`TODO_LIMITS.panelMinRows = 6`，
`App.tsx:1521-1522`），且未使用 `--no-todo` / `/todo panel off`。

1. 启动：`node packages/cli/dist/cli.js`（或已安装的 `aragon`）。
2. 输入一个**三步以上**的任务，逼模型调用 `todo_write`，例如：
   > `分三步：先列出 packages/cli/src/todo 下的文件，再逐个读一遍，最后写一句话总结每个文件的职责。`
3. 等模型跑完。此时右侧 rail 显示完整清单，末态为 `3/3`（全部 `completed`）。
4. **输入 `/clear` 回车。**
5. 观察：
   - **正文区**：清空 ✅
   - **右侧 rail**：**仍然完整显示上一轮的 TODO 列表** ❌ ← 缺陷
   - 若终端在 inline 模式（非全屏），等价症状出现在底部 inline strip 上（`App.tsx:1535`）；
     若 rail 因窄屏未挂载，则等价症状是状态栏右侧的 `todo 3/3` 筹码（`App.tsx:1946-1948`）。
6. 对照组：把第 4 步换成 `/reset`，右侧 rail **立刻消失** —— 这个对照把缺陷精确夹在
   "`/clear` 这条路径"上，而不是渲染层。

**自愈时间窗（为什么用户一定会撞上）**：见 §4.2。用户此刻刚跑完任务、正准备开新话题，
面板会一直挂到他**下一条真实消息**发出为止；`/clear` 本身是 slash 命令，
不经过 `controller.prompt()`，因此**不会**触发那次自愈。

### 2.2 机械复现（可直接粘贴，10 秒出结果）

把下面这个文件存成 `packages/cli/src/__tests__/repro-clear-todo.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { initialViewState, viewReducer, type ViewState } from '../agent/reducer.js';
import { TodoStore } from '../todo/store.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

function harness() {
  let clock = 0;
  const store = new TodoStore(() => ++clock);
  let state: ViewState = initialViewState();
  const dispatch = (action: Parameters<typeof viewReducer>[1]): void => {
    state = viewReducer(state, action);
  };

  // 逐字复刻 App.tsx:663-670 的订阅
  store.subscribe((event) => {
    if (event.type === 'updated') dispatch({ type: 'todoUpdate', snapshot: event.snapshot });
    else if (event.type === 'cleared') dispatch({ type: 'todoCleared' });
  });

  // "任务跑完"：全部 completed，就是用户看到的那一屏
  store.write([
    { content: 'Read the reducer', activeForm: 'Reading', status: 'completed' },
    { content: 'Patch the store', activeForm: 'Patching', status: 'completed' },
    { content: 'Run the tests', activeForm: 'Running', status: 'completed' },
  ]);

  const controller = {
    clearMessages: () => store.clear('reset'), // controller.ts:1238-1248
    clearAllQueues: () => {},
    clearTodos: () => store.clear('user'),     // controller.ts:1094-1096
    getTodoSnapshot: () => store.snapshot(),
    isRunning: () => false,
  } as unknown as CommandContext['controller'];

  return {
    store,
    railMounted: () => state.todos !== null, // App.tsx:1520 的挂载判据
    entryCount: () => state.entries.length,
    ctx: (args: string) =>
      ({
        args,
        controller,
        get state() { return state; },
        dispatch,
        notify: () => {},
        toast: () => {},
      }) as unknown as CommandContext,
  };
}

describe('REPRO: /clear leaves the todo rail on screen', () => {
  it('/clear empties the transcript but keeps state.todos AND the TodoStore', async () => {
    const h = harness();
    expect(h.railMounted()).toBe(true);
    expect(h.entryCount()).toBe(1);

    await runSlashInput(registry, '/clear', h.ctx);

    expect(h.entryCount()).toBe(0);              // 正文没了
    expect(h.railMounted()).toBe(true);          // <-- BUG：rail 还挂着
    expect(h.store.snapshot()).not.toBeNull();   // <-- BUG：store 根本没被通知
  });

  it('/reset does clear both — the contrast that localizes the gap', async () => {
    const h = harness();
    await runSlashInput(registry, '/reset', h.ctx);

    expect(h.entryCount()).toBe(0);
    expect(h.railMounted()).toBe(false);
    expect(h.store.snapshot()).toBeNull();
  });
});
```

运行：

```bash
cd packages/cli
npx vitest run src/__tests__/repro-clear-todo.test.ts --reporter=verbose
```

**实测输出（2026-08-01，本机）：**

```
 RUN  v4.1.9 M:/takoAI/JRAgentMesh/aragon-agent-core/packages/cli

 ✓ src/__tests__/repro-clear-todo.test.ts > REPRO: /clear leaves the todo rail on screen > /clear empties the transcript but keeps state.todos AND the TodoStore 3ms
 ✓ src/__tests__/repro-clear-todo.test.ts > REPRO: /clear leaves the todo rail on screen > /reset does clear both — the contrast that localizes the gap 1ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

两条断言全绿 ⇒ 缺陷成立且可稳定复现：`/clear` 之后 `state.todos !== null`（rail 继续挂载）
且 `TodoStore` 里的条目一条没少。

> 本诊断节点不留改动：该复现文件跑完即已删除，`git status` 与诊断开始前一致
> （只有本次之前就存在的 `package.json` / `package-lock.json` 修改）。
> 修复节点应把它**转成正式回归用例**（见 §6.3）。

### 2.3 现网行为已被单元测试"钉死"

这不是"忘了写"，而是有一条测试**正面断言**当前行为，位置
`packages/cli/src/__tests__/todo-reducer.test.ts:118-134`：

```ts
it('AC-17 (view half): /clear keeps the list, /reset drops it (I-2)', () => {
  ...
  const cleared = viewReducer(base, { type: 'clearTranscript' });
  expect(cleared.todos).not.toBeNull();     // ← 断言"rail 保留"
  expect(cleared.todoEntryId).toBeUndefined();
  ...
});
```

实跑确认通过：

```
 ✓ src/__tests__/todo-reducer.test.ts > the todo entry (§5.2) > AC-17 (view half): /clear keeps the list, /reset drops it (I-2) 1ms
 Test Files  1 passed (1)   Tests  8 passed (8)
```

**含义**：这条用例正面钉住了旧行为，是本 bug 属于"设计约定需要修订"而非"实现漏写"的第一手证据。

> **【评审更正 · 2026-08-01】** 原文此处写的是"修复必须同时改这条测试，**否则修完必红**"，
> 这句话**只对方案 B 成立，对推荐的方案 A 不成立**，且方向恰好相反 ——
> 方案 A 不改 `reducer.ts` 的 `clearTranscript` 分支，而这条用例是**直接调 `viewReducer`** 的
> （`todo-reducer.test.ts:127`，不经过命令层），所以修完之后 `cleared.todos` 依然非 null，
> **测试照常全绿**。
>
> 这比"修完必红"**更危险**：套件里会留下一条名叫
> *"/clear keeps the list"* 的绿色用例，正面断言与已发布行为相反的事实，
> 而 CI 不会发出任何声音。评审复核（见 §8 R-2 / R-4）据此调整了推荐方案与落地清单的强制性。
>
> 复核方法：全仓 grep `runSlashInput` 与 `'/clear'`，确认**没有任何现存用例经命令层驱动 `/clear`**
> ⇒ 方案 A 落地后**零条现存用例变红**，§6.3 的新增回归用例是这次修复**唯一**的 CI 信号。

---

## 3. 根因分析

### 3.1 数据通路（一句话版）

> 右侧 rail 的挂载条件是 `ViewState.todos !== null`，而 `ViewState.todos` 只有两个写入源：
> `TodoStore` 的 `updated` / `cleared` 事件。`/clear` 走的 `clearTranscript` 分支
> **既不清 `ViewState.todos`，也不通知 `TodoStore`**，所以两个源都没动，面板自然留着。

```
用户输入 /clear
   │
   ▼  builtins.ts:966
dispatch({ type: 'clearTranscript' })
   │
   ▼  reducer.ts:1181-1204
{ entries: [], todoEntryId: undefined, … }      ← 正文清空
   ✗ 没有 todos: null                            ← 镜像原封不动
   ✗ 全程不经过 AgentController                  ← TodoStore 从未被告知
   │
   ▼  App.tsx:1516-1522 / 1846-1858
showRail = … && state.todos !== null            ← 仍为 true ⇒ 面板继续渲染
```

### 3.2 证据一：`/clear` 的实现只有一行，且刻意不碰 controller

`packages/cli/src/commands/builtins.ts:963-977` —— 两条命令并排放着，差异一目了然：

```ts
{
  name: 'clear',
  description: 'Clear the visible transcript',
  run: (ctx) => ctx.dispatch({ type: 'clearTranscript' }),   // 966：只有这一行
},
{
  name: 'reset',
  description: 'Start a new conversation',
  run: (ctx) => {
    ctx.controller.clearMessages();                          // 972
    ctx.controller.clearAllQueues();                         // 973
    ctx.dispatch({ type: 'resetConversation' });             // 974
    ctx.toast('info', 'Started a new conversation.');
  },
},
```

而 `TodoStore` 的**唯一命令级清除入口**挂在 `clearMessages()` 内部
（`packages/cli/src/agent/controller.ts:1238-1248`）：

```ts
clearMessages(): void {
  this.agent.clearMessages();
  this.skills.getRegistry().clearActive();
  // `/reset` clears `messages`, so the belief that justifies the panel is gone
  // with them and the list must go too (I-2). `/clear` reaches the transcript
  // and NOT this method, which is the whole distinction: it tells the model
  // nothing, so it may not change the list.
  this.todos?.clear('reset');                                // 1247
}
```

注释把话说死了：**"`/clear` 够不到这个方法，这就是全部区别所在"**。

### 3.3 证据二：reducer 里 `todos` 被显式跳过，并写明理由

`packages/cli/src/agent/reducer.ts:1181-1204`（`/clear`）：

```ts
case 'clearTranscript':
  return {
    ...state,
    entries: [],
    droppedEntries: 0,
    streamingId: undefined,
    expandedToolIds: {},
    teamEntryId: undefined,
    // The entry it pointed at is gone, so the id goes with it. `todos` is
    // DELIBERATELY UNTOUCHED (I-2): `/clear` wipes the transcript and not
    // the conversation, so the model still believes in the plan, and a panel
    // that disagrees with the model is worse than no panel.
    todoEntryId: undefined,                                   // 1197
    retryEntryId: undefined,
    retry: null,
  };
```

对照 `resetConversation`（`reducer.ts:1206-1223`），只差一行：

```ts
    // `/reset` clears `messages`, so the belief is gone and the list goes
    // with it — the other half of I-2. `controller.clearMessages()` clears
    // the STORE; this clears the mirror.
    todos: null,                                              // 1219
```

**`clearTranscript` 缺的就是这一行 `todos: null`，且是有意缺的。**

### 3.4 证据三：这不是漏写，是被写进不变量、测试、README、spec 的既有设计

同一条约定在 5 个地方留下了痕迹，修复时必须一起处理（这也是本 bug 的真实工作量所在）：

| # | 位置 | 原文（节选） |
|---|---|---|
| 1 | `packages/cli/src/todo/store.ts:12-18` | *"INVARIANT I-2 — the list is a PROJECTION OF WHAT THE MODEL BELIEVES… `/clear` wipes the transcript but not the conversation, so it must NOT reach this class; `/reset` clears `messages`, so it must."* |
| 2 | `packages/cli/src/agent/reducer.ts:1193-1197` | *"`todos` is DELIBERATELY UNTOUCHED (I-2)"* |
| 3 | `packages/cli/src/__tests__/todo-reducer.test.ts:118` | `it('AC-17 (view half): /clear keeps the list, /reset drops it (I-2)')` |
| 4 | `packages/cli/README.md:503` | *"- `/clear` wipes the transcript but not the conversation, so the plan stays."* |
| 5 | `docs/plans/todo-plan-execution/spec.md:325`（另见 `:1460`、`:1731`、`:1895`）与 `docs/plans/todo-plan-execution/manual-test.md:40`（手测第 13 行：*"`/clear` KEEPS the rail"*） | 同上 |

### 3.5 那么"根因"到底是什么？

分两层，缺一不可：

**RC-1（机械层，直接原因）**
`clearTranscript` 分支不写 `todos: null`，且 `/clear` 的命令体不调用任何 controller 方法 ⇒
`ViewState.todos` 与 `TodoStore` 双双保留 ⇒ `App.tsx:1520` 的挂载判据恒真 ⇒ 面板留屏。
证据：§3.2 / §3.3 / §2.2 实跑。

**RC-2（语义层，为什么当初这么写、以及为什么该改）**
设计把 `/clear` 定义为"只清屏、不清对话"，并由此推出"模型仍然相信这份计划 ⇒ 面板必须留下"。
这条推理链的**前提**是：*rail 属于"模型信念的投影"，而不属于"屏幕上的东西"*。
用户的反馈恰恰否定了这个前提 —— 在用户眼里 rail 就是屏幕上的东西，`/clear` 应该带走它。

而这条不变量**本来就自带一个用户覆写的口子**，所以修订它不需要推翻整套设计：

- `packages/cli/src/todo/types.ts:47-56` 定义 `TodoClearReason = 'user' | 'reset' | 'turn' | 'stale'`，
  其中 `'user'` 的注释就是 *"`user` - `/todo clear`"*；
- `packages/cli/src/agent/controller.ts:1093` 对 `clearTodos()` 的注释写得更直白：
  *"A user override of a projection"*。

也就是说：**"用户明确要求清掉"早已是 I-2 的合法例外**（`/todo clear` 就是），
`/clear` 只是没有被归到这一类里。这使得 §6 的推荐方案是"把 `/clear` 归入既有例外"，
而不是"打破不变量"。

补充一条同向证据：`store.ts:159-166` 在讲 `stale` 清除时，把"面板没了但模型还记得"
明确称为**安全方向**：

```
// Self-healing, because the model's next write is a full
// replacement: the panel is ABSENT while the model still knows the plan,
// which is the safe direction (I-9).
```

修复后落到的正是这个状态。

---

## 4. 影响面

### 4.1 受影响的显示面（同一个根因，6 个出口）

| # | 面 | 代码位置 | `/clear` 后的表现 |
|---|---|---|---|
| 1 | 右侧 rail `TodoPanel`（全屏 + ≥80 列） | `App.tsx:1516-1522, 1846-1858` | **用户报告的症状**：整块面板留屏 |
| 2 | inline strip `TodoStrip`（非全屏） | `App.tsx:1535, 1859-1863` | 同源症状，底部一行清单条留屏 |
| 3 | 状态栏 `todo 3/7` 筹码（rail 未挂载时） | `App.tsx:1946-1948` → `StatusBar.tsx:246-251` | 窄屏 / `/todo panel off` 下同样残留 |
| 4 | `/save` 会把这份"已清屏"的清单写进会话文件 | `builtins.ts:1013` | `/resume` 之后旧计划复活 |
| 5 | `/todo status` / `/todo continue` 仍认这份清单 | `builtins.ts:704, 827-831` | 用户以为已清掉，`/todo continue` 却能继续 |
| 6 | **follow-through 自动续跑** | `App.tsx:505-522`；预算 `follow-through.ts:204-210` | `followThrough: 'auto'` 且清单**未完成**时，`/clear` 之后的下一次 run 结束仍可能自动续跑一份用户认为已经清掉的计划 —— **这条是花钱的**，不只是显示问题 |

### 4.2 自愈时间窗（决定"用户多大概率撞上"）

面板不是永远不消失，它会在**下一次真实用户消息**时按 `TodoStore.beginUserTurn()` 的规则自愈
（`controller.ts:782` → `store.ts:151-167`）：

- 清单**全部完成**（= 用户描述的"执行完任务了以后"）⇒ 下一条消息发出时 `clear('turn')`；
- 清单**未完成** ⇒ 还要再撑 `TODO_LIMITS.staleTurns = 3` 个无关轮次（`limits.ts:64-71`）才 `clear('stale')`。

关键点：**slash 命令不走 `controller.prompt()`**（`registry.ts:125-148` 直接 `await command.run(ctx)`），
所以 `/clear` 本身**不会**触发这次自愈。用户的典型动线正好是
"任务跑完 → `/clear` 清场 → 停下来想下一步该问什么"，
面板就在这段"停下来想"的时间里一直挂着 —— 命中率接近 100%。

### 4.3 不受影响

- 非交互模式 `aragon -p`（`agent/headless.ts`）：没有 slash 命令，也没有 rail。
- `--no-todo` / `/todo panel off` 的会话：本来就没有 rail（面 3 仍受影响）。
- `packages/core`：完全无关，`TodoStore` 是 CLI 本地对象，`TodoEvent` 刻意不进 core 的
  `AgentEvent` 联合（`todo/types.ts:6-11`）。
- 宿主 AragonMesh：见 §0，零改动。

---

## 5. 候选修复方案对比

| | **A · `/clear` 同时清 TodoStore**（推荐） | **B · 只清视图镜像** | **C · 让 `/clear` 等同 `/reset`** |
|---|---|---|---|
| 改法 | `builtins.ts:966` 改成先 `ctx.controller.clearTodos()`（reason `'user'`）再 `dispatch({type:'clearTranscript'})` | `reducer.ts:1204` 的 `clearTranscript` 分支加一行 `todos: null` | `/clear` 也调 `clearMessages()` + `clearAllQueues()` + `resetConversation` |
| 代码改动量 | 1 处（+ 注释与文档同步） | 1 行（+ 注释与文档同步） | 1 处，但语义大改 |
| 侵入性 | 低 | 最低 | **高** |
| 修好几个显示面 | **全部 6 个**（store 是单一真相源） | 只修面 1、2、3；面 4/5/6 仍错 | 全部 6 个 |
| 是否引入新的不一致 | 否。store 与镜像仍然同步 | **是**。`state.todos === null` 但 `store` 非空 ⇒ `/save`、`/todo status`、`/todo continue`、follow-through 与屏幕说法不一 | 否 |
| 与不变量 I-2 的关系 | 归入既有的 `'user'` 例外（`types.ts:51`、`controller.ts:1093`），落到 `store.ts:163` 自称的"安全方向" | **绕过** I-2 而不是修订它：把唯一真相源分叉成两个 | 不触碰 I-2（模型信念真的没了） |
| 用户数据风险 | 无（不动 `messages`） | 无 | **有**：一个文档为 *"Clear the visible transcript"* 的命令会静默丢弃整段对话；只想清屏的老用户会丢上下文 |
| 与用户"清除上下文"心智的契合 | 部分（清屏 + 清计划，不清对话） | 部分 | 完全 |
| 已知副作用 | 见 §6.4（1 条，有界） | 见上"新的不一致" | 破坏性行为变更，需要单独的产品决策 + CHANGELOG breaking 条目 |
| 需同步修改的测试 / 文档 | 5 处（§6.3） | 5 处 | 5 处 + README 命令表 + CHANGELOG breaking |

---

## 6. 推荐方案

### 6.1 结论

**采用方案 A**：`/clear` 在清空正文的同时，通过 `AgentController.clearTodos()`（reason `'user'`）
清除 TODO 清单；**不改动 `messages`，`/clear` 与 `/reset` 的分工保持不变**。

参考实现（修复节点落地时以实际代码风格为准）：

```ts
{
  name: 'clear',
  description: 'Clear the visible transcript and the todo panel',
  run: (ctx) => {
    // 用户覆写一个投影，与 `/todo clear` 同类（reason 'user'），
    // 不触碰 `messages` —— 清对话仍然只有 `/reset`。
    ctx.controller.clearTodos();
    ctx.dispatch({ type: 'clearTranscript' });
  },
},
```

`clearTodos()` 会 emit `cleared` → `App.tsx:669` dispatch `todoCleared` →
`reducer.ts:1391-1392` 置 `todos: null` → rail / strip / 状态栏筹码同时消失。
`reducer.ts` 的 `clearTranscript` 分支**无需改代码**（只需改那段已经说反了的注释）。

### 6.2 理由

1. **命中单一真相源**。`TodoStore` 是 rail、strip、状态栏筹码、`/save`、`/todo status`、
   follow-through 的共同上游；清它一处，§4.1 的 6 个面全部一致。方案 B 只修 3 个，
   剩下 3 个会以更难排查的形态（存档里冒出旧计划、自动续跑一份"已清掉"的计划）二次爆发。
2. **不打破不变量，而是把 `/clear` 归入它既有的例外**。I-2 已经有 `'user'` 这一档，
   语义就是"用户明确覆写投影"（`types.ts:51` / `controller.ts:1093`）。`/clear` 是用户敲进去的，
   与 `/todo clear` 同类。
3. **落点是代码自己承认的安全方向**。修复后状态为"面板没了、模型还记得"，
   `store.ts:159-166` 原文称之为 *the safe direction (I-9)*，且自愈：模型下一次 `todo_write`
   是全量替换，面板自然回来。
4. **不碰用户数据**。方案 C 会让一个文档写着"清可见正文"的命令悄悄丢掉整段对话，
   这是比原 bug 更严重的失望。若产品上确实想要 Claude Code 的 `/clear` 语义，
   那是一个独立的、需要 CHANGELOG breaking 条目的产品决策，**不应搭在这次修复里**。

### 6.3 落地清单（缺一项即为未完成）

| # | 文件 | 动作 |
|---|---|---|
| 1 | `packages/cli/src/commands/builtins.ts:963-967` | 命令体加 `ctx.controller.clearTodos()`；`description` 同步改口径 |
| 2 | `packages/cli/src/agent/reducer.ts:1193-1197` | 改注释：`todos` 不再是"DELIBERATELY UNTOUCHED"，改述为"由 `/clear` 命令经 store 的 `'user'` 清除路径带走，此处只丢弃 entry 指针" |
| 3 | `packages/cli/src/todo/store.ts:12-18`、`types.ts:47-56` | 修订 I-2 表述与 `'user'` 的注释：`'user'` = `/todo clear` **与** `/clear` |
| 4 | `packages/cli/src/__tests__/todo-reducer.test.ts:118-134` | 该用例目前正面断言旧行为，**必须改**；建议改为命令级用例（走 `runSlashInput`，见 §2.2 的 harness），断言 `/clear` 后 `state.todos === null` **且** `store.snapshot() === null`，并保留 `/reset` 对照 |
| 5 | `packages/cli/README.md:110`、`:503`；`docs/plans/todo-plan-execution/manual-test.md:40`（手测第 13 行）；`docs/plans/todo-plan-execution/spec.md:325`（并在 `:1460` / `:1731` / `:1895` 处标注本次修订） | 文档口径同步；`CHANGELOG.md` 追加一条 `fix:` |
| 6 | **【评审补充】** `packages/cli/src/ui/overlays/HelpOverlay.tsx:54` | `description` 的**第二份手工副本**，必须与第 1 项同步改。它**不是**从 registry 派生的：`App.tsx:430` 只把 `registry.all()` 的 `{name, description}` 喂给 `PromptInput.tsx:171` 的斜杠补全提示，而 `HelpOverlay` 的 `COMMANDS` 是一张**硬编码常量表**。只改 `builtins.ts` ⇒ 补全气泡说新口径、`/help` 说旧口径，**且全仓无任何用例覆盖 `HelpOverlay`（grep 零命中）**，这处漂移不会被 CI 发现 |

回归护栏（§2.2 的复现文件转正）：新增用例必须**同时**断言
`state.todos === null` 与 `store.snapshot() === null` —— 只断言前者，方案 B 的半修状态也能过。

### 6.4 已知副作用（有界，建议接受）

`/clear` 之后 `TodoStore.isEmpty()` 变为 `true`，这会重新武装 `todo_write` 的"新计划至少 2 项"闸门
（`packages/cli/src/todo/todo-tool.ts:112-122`）：

```ts
// 2. GATED ON AN EMPTY STORE, and that gate is the whole subtlety.
//    Shrinking an EXISTING list to one item is legitimate - the model
//    merged two steps - so the guard must fire only on a fresh plan.
if (deps.store.isEmpty() && Array.isArray(todos) && todos.length < TODO_LIMITS.minFreshItems) {
```

即：若用户在**运行中**敲 `/clear`，而模型紧接着把一份既有计划**缩成 1 项**重写，
这次写入会被判成"新计划太小"而拒绝（返回 `TOO_SMALL_REFUSAL` 文本，模型可据此重试，
不是错误、不中断运行）。

评估：概率低、后果轻、模型可自恢复；**不建议**为它去改 `minFreshItems` 的闸门语义
（那会削弱 R-c 这条独立约束，属范围蔓延）。修复节点在源码注释里记一句即可。

另一条需知悉但无需处理的连带：清单被清后，下一次 `agent_end` 的
`advanceBudget(..., null, ...)` 会把 follow-through 预算归零（`follow-through.ts:204-210`）。
这是**预期且正确**的 —— 计划没了，它的经济账也该清零，与 `/todo clear`、`/reset` 一致。

### 6.5 不在本次范围

- 把 `/clear` 改成"清对话"（方案 C）——独立产品决策。
- 为 `/clear` 加 `/todo clear` 那样的运行中拒绝守卫（`builtins.ts:805-808`）：
  会让 `/clear` 在运行中连正文都清不掉，是新的回归。运行中清掉的清单由模型下一次
  `todo_write` 自然复原（`store.ts:163` 的 self-healing）。
- 面 4/5/6 不需要各自打补丁：它们全部从 `TodoStore` 派生，方案 A 一处即全解。

---

## 7. 验收（供修复 / Review 节点使用）

1. §2.1 第 5 步：`/clear` 后右侧 rail **消失**；正文同样清空。
2. 窄屏（<80 列）与 inline 模式下重跑 §2.1：状态栏 `todo x/y` 筹码、底部 strip 一并消失。
3. `/clear` 后立刻 `/save`，存档文件里 `todos` 为 `[]`（`builtins.ts:1013`）。
4. `/clear` 后 `/todo status` 报告"无清单"，`/todo continue` 回 `Nothing left to continue.`。
5. `/reset` 的既有行为逐字节不变（对照用例保留）。
6. `cd packages/cli && npx vitest run` 全绿；`npm run typecheck` 全绿。
7. 运行中（模型正在跑）敲 `/clear`：正文清空、面板消失、**运行不中断**；模型下一次
   `todo_write` 后面板正常回归。

---

## 附录 A · 修订后的 I-2 建议表述

> **I-2** — 清单是"模型所信"的投影。任何**不告知模型**的机制都不得改动它；
> 但**用户的明确指令**是这条规则的既有例外，并以 `TodoClearReason = 'user'` 标记 ——
> 今天有两个入口：`/todo clear` 与 `/clear`。
> 用户覆写后落到的状态是"面板缺席、模型仍记得"，即 I-9 所称的安全方向：
> 模型下一次 `todo_write` 是全量替换，面板自愈。
> `/reset`（reason `'reset'`）仍是唯一因"模型信念被销毁"而清单的路径。

## 附录 B · 关键代码索引

| 主题 | 位置 |
|---|---|
| `/clear` 命令体 | `packages/cli/src/commands/builtins.ts:963-967` |
| `/reset` 命令体 | `packages/cli/src/commands/builtins.ts:968-977` |
| `/todo clear` 命令体（既有的 `'user'` 覆写先例） | `packages/cli/src/commands/builtins.ts:801-816` |
| `clearTranscript` reducer 分支 | `packages/cli/src/agent/reducer.ts:1181-1204` |
| `resetConversation` reducer 分支 | `packages/cli/src/agent/reducer.ts:1206-1223` |
| `todoCleared` reducer 分支 | `packages/cli/src/agent/reducer.ts:1389-1392` |
| `AgentController.clearMessages` / `clearTodos` | `packages/cli/src/agent/controller.ts:1238-1248` / `:1093-1096` |
| `TodoStore`（I-2、`clear`、`beginUserTurn`） | `packages/cli/src/todo/store.ts:12-18, 131-136, 151-167` |
| `TodoClearReason` | `packages/cli/src/todo/types.ts:47-56` |
| `todo_write` 的 `minFreshItems` 闸门 | `packages/cli/src/todo/todo-tool.ts:112-122` |
| rail / strip / 状态栏筹码的挂载判据 | `packages/cli/src/ui/App.tsx:1516-1522, 1535, 1846-1863, 1946-1948` |
| 事件订阅（store → 视图） | `packages/cli/src/ui/App.tsx:662-676` |
| 钉住旧行为的测试 | `packages/cli/src/__tests__/todo-reducer.test.ts:118-134` |
| 文档口径 | `packages/cli/README.md:110, 503`；`docs/plans/todo-plan-execution/spec.md:325`；`docs/plans/todo-plan-execution/manual-test.md:40` |
| **【评审补充】** `/clear` description 的第二份手工副本 | `packages/cli/src/ui/overlays/HelpOverlay.tsx:54` |
| **【评审补充】** description 的唯一派生消费者（斜杠补全） | `packages/cli/src/ui/App.tsx:430` → `packages/cli/src/ui/PromptInput.tsx:171` |
| **【评审补充】** `clearTranscript` / `resetConversation` 的**全部**生产端 dispatcher | `packages/cli/src/commands/builtins.ts:966` / `:974`（各 1 处，无第二处） |
| **【评审补充】** `TodoClearReason` 的消费者 | **无**。全仓 grep 确认没有任何分支读 `event.reason`（`App.tsx:668` 只 dispatch，不看 reason）⇒ 该字段今天纯文档性 |
| **【评审补充】** 命令级用例的既有房规写法 | `packages/cli/src/__tests__/perf-command.test.ts:4-10, 126`（文件头明写"经 `runSlashInput` 驱动而非直调命令对象"）；另见 `max-tokens-ui.test.tsx:273-279` |
| **【评审补充】** store→rail 卸载路径的既有绿灯护栏 | `packages/cli/src/__tests__/app.test.tsx:1055-1075`（已断言 `{type:'cleared', reason:'user'}` 后 rail 消失） |

---

## 8. 评审结论（Review Verdict）

**评审人**：Subtask #1 · 方案评审与修复节点  **日期**：2026-08-01
**基线**：`aragon-agent-core` @ `64ebe3f9`，`packages/cli` v0.5.11（与 §0 一致）
**评审方式**：逐条回读被引用源码（未采信原文转述）+ 实跑钉住旧行为的用例 + 反向 grep 找遗漏出口。

### R-1 · 根因证据审计：**成立，可直接作为修复依据**

| # | 待核事实 | 复核方法 | 结论 |
|---|---|---|---|
| 1 | `/clear` 的命令体只有 `dispatch({type:'clearTranscript'})` | 读 `builtins.ts:963-967` | ✅ 逐字属实 |
| 2 | `clearTranscript` 分支不写 `todos`，且注释写明"DELIBERATELY UNTOUCHED (I-2)" | 读 `reducer.ts:1181-1204` | ✅ 逐字属实 |
| 3 | `TodoStore` 的命令级清除入口只挂在 `clearMessages()`（`/reset`）上 | 读 `controller.ts:1238-1248`、`:1093-1096` | ✅ 属实，且注释自陈"`/clear` 够不到这个方法" |
| 4 | rail / strip / 状态栏筹码三个面的挂载判据都是 `state.todos !== null` | 读 `App.tsx:1516-1522`、`:1535`、`:1846-1863`、`:1946-1948` | ✅ 三处逐字确认 |
| 5 | `state.todos` 只有 `todoUpdate` / `todoCleared` 两个写入源，后者由 store 的 `cleared` 事件驱动 | 读 `reducer.ts:1350-1392`、`App.tsx:662-679` | ✅ 属实；`todoCleared` 是纯状态写 `{todos:null, todoEntryId:undefined}`，无副作用、无 toast |
| 6 | `/save` / `/todo status` / `/todo continue` / follow-through 读的是 **store** 而非镜像 | 读 `builtins.ts:1013`、`:704`、`:827-831`、`App.tsx:505-506` | ✅ 四处全部 `controller.getTodoSnapshot()` |
| 7 | slash 命令不经 `controller.prompt()`，故 `/clear` 不触发 `beginUserTurn()` 自愈 | 读 `registry.ts:125-148` | ✅ 属实（`await command.run(ctx)` 直调） |
| 8 | 旧行为被用例正面钉住 | **实跑** `npx vitest run src/__tests__/todo-reducer.test.ts` | ✅ 8/8 绿，含 `AC-17 (view half): /clear keeps the list` |

**未发现反例，也未发现替代解释。** 我另外做了一次反向排查，用于确认"症状只可能由这条链路产生"：

- `clearTranscript` 在**生产代码里只有一个 dispatcher**（`builtins.ts:966`）。曾怀疑存在
  `Ctrl+L` 之类的第二条清屏路径，实读 `App.tsx:1347` 确认 `Ctrl+L` 是**重绘**（I-5 redraw carrier，
  见 `StatusBar.tsx:147-155`），**不** dispatch `clearTranscript`。
- `resetConversation` 同样只有一个 dispatcher（`builtins.ts:974`），且必与 `clearMessages()` 成对。

这条排查是**推荐方案的承重论据之一**（见 R-4），原文没有做，补记于此。

### R-2 · 本次评审补入的证据（原文缺失，且每条都改变了下游动作）

| 编号 | 补充事实 | 对修复的影响 |
|---|---|---|
| **M-1** | `HelpOverlay.tsx:54` 是 `/clear` description 的**第二份手工副本**，与 registry **无派生关系**（`App.tsx:430` → `PromptInput.tsx:171` 只喂斜杠补全），且**零用例覆盖** | §6.3 落地清单**从 5 项变 6 项**。漏改 ⇒ 补全气泡与 `/help` 各说一套，CI 静默 |
| **M-2** | §2.3 的"修完必红"**对方案 A 不成立**（详见该处【评审更正】）：`todo-reducer.test.ts:127` 直调 `viewReducer`，方案 A 不动 reducer ⇒ 该用例**修完仍绿** | 把"旧用例会自己报警"从**事实**降级为**幻觉**；直接推出 R-4 的收口决定 |
| **M-3** | 全仓**没有任何现存用例经 `runSlashInput` 驱动 `/clear`**（grep 确认） | 两个后果：① 给命令体加 `controller` 调用**不会**打挂任何持 mock controller 的既存用例（风险面清零）；② 方案 A 落地后**零条现存用例变红**，新增回归用例是**唯一**的 CI 信号，因此它**不是"建议"而是必需项** |
| **M-4** | `app.test.tsx:1055-1075` 已绿灯断言 `{type:'cleared', reason:'user'}` ⇒ rail 消失 | 修复机制的**后半段（store→视图）已有护栏**；新增用例只需覆盖**前半段（命令→store）**，不必重造渲染级断言 |
| **M-5** | `TodoStore.clear()` **无条件 emit**（`store.ts:131-136`，没有 `isEmpty` 早退），而 `todoCleared` 是纯状态写 | "屏幕上本来就没有清单时敲 `/clear`" 是**静默安全**的：emit 一次、reducer 写两个已经是缺省值的字段，**不产生任何提示或噪音**。这条堵死了"是否需要在命令体里先判空"的伪问题 |
| **M-6** | `TodoClearReason` **零消费者**（全仓 grep：无任何分支读 `event.reason`） | 复用 `'user'` 的**运行期风险为零**，它是纯标注决定；同时否掉"新增一个 `'transcript'` reason"的诱惑（见 R-6） |
| **M-7** | `decideFollowThrough` 首条分支即 `if (!snapshot) return {kind:'none'}`（`follow-through.ts:115`） | 使 §4.1 面 6 与 §6.4 的第二条连带**双向闭合**：清掉 store 之后，follow-through 既不会自动续跑，也不会打印"还剩 N 步"的噪音通知 |
| **M-8** | `perf-command.test.ts:4-10` 的文件头明写"经 `runSlashInput` 驱动而非直调命令对象" | 新增用例有**现成房规**可循，§2.2 的 harness 与它同形，可直接转正 |

### R-3 · 候选方案审计

**方案 B（只改 reducer 加 `todos: null`）—— 驳回，理由比原文更强。**
原文说它"只修 3 个面"。实测更硬：面 4/5/6 的四个读取点（`builtins.ts:1013` / `:704` / `:827-831` / `App.tsx:505`）
**全部**直接调 `controller.getTodoSnapshot()`，即**绕过镜像直读 store**。所以方案 B 不是"修得不全"，
而是**制造一个屏幕与数据对不上的会话**：面板消失了，`/save` 仍写入旧清单、`/todo continue` 仍能续跑、
`followThrough:'auto'` 仍可能自动花钱。这比原 bug 更难归因。

**方案 C（`/clear` 等同 `/reset`）—— 驳回，同意原文。**
它把一个文档为 *"Clear the visible transcript"* 的命令变成静默销毁整段对话，属破坏性行为变更，
需要独立产品决策与 CHANGELOG breaking 条目，不应搭车。

**方案 A（命令体调 `clearTodos()`）—— 采纳为承重部分，但需要一处收口。**
边界逐项复核，**未发现新回归**：

| 边界 | 复核结论 |
|---|---|
| `--no-todo` 会话 | `clearTodos()` = `this.todos?.clear('user')`，`todos` 为 undefined ⇒ 静默 no-op；此时 `state.todos` 本就是 null。✅ |
| 屏幕上无清单时 `/clear` | 见 M-5：emit 一次、写两个缺省值、零噪音。✅ |
| **运行中**敲 `/clear` | 与 `/todo clear`（`builtins.ts:805-808` 明确拒绝）形成刻意的不对称。同意原文 §6.5 **不加**该守卫：加了会让 `/clear` 在运行中连正文都清不掉，是**新的回归**；清掉的清单由模型下一次 `todo_write`（全量替换）自愈，落在 `store.ts:159-166` 自称的 *safe direction (I-9)*。✅ |
| 运行中清单被清 ⇒ `todo_write` 的 `minFreshItems` 闸门重新武装 | 原文 §6.4 属实（`todo-tool.ts:112-122` 逐字确认）。后果是一次 `TOO_SMALL_REFUSAL` 文本，模型可据此重试，**不是错误、不中断运行**。同意接受、同意**不**改闸门语义。✅ |
| 运行中清单被清 ⇒ 本轮 `agent_end` 的 follow-through | `advanceBudget(prev, null, …)` → `emptyBudget()`（`follow-through.ts:204-210`）；`decideFollowThrough({snapshot:null})` → `{kind:'none'}`（`:115`）。即**预算归零 + 完全静默**，与"用户刚把计划清了"一致。✅ |
| 命令体内两条语句的**先后顺序** | 无关紧要但值得写明：`clearTodos()` 同步 emit ⇒ `App.tsx:669` 同步 `dispatch({type:'todoCleared'})`，与随后的 `dispatch({type:'clearTranscript'})` 落在**同一事件回合**，按序归约，终态恒为 `{todos:null, entries:[], todoEntryId:undefined}`。两种顺序等价。✅ |
| 是否会打挂既存用例 | 见 M-3：**零条**。✅ |

### R-4 · 最终推荐修复

> **采用方案 A′ = 方案 A（承重）+ `clearTranscript` 分支一行收口。**
> `/clear` 在清空正文的同时经 `AgentController.clearTodos()`（reason `'user'`）清除 `TodoStore`；
> **并**在 `reducer.ts` 的 `clearTranscript` 分支补上 `todos: null`。
> **`messages` 一行不动 —— 清对话仍然只有 `/reset`。**

```ts
// packages/cli/src/commands/builtins.ts:963-967
{
  name: 'clear',
  description: 'Clear the visible transcript and the todo panel',
  run: (ctx) => {
    // 用户覆写一个投影，与 `/todo clear` 同类（reason 'user'）。
    // 不触碰 `messages`：清对话仍然只有 `/reset`。
    // 刻意不抄 `/todo clear` 的两道守卫（见下方"不要做"清单）。
    ctx.controller.clearTodos();
    ctx.dispatch({ type: 'clearTranscript' });
  },
},
```

```ts
// packages/cli/src/agent/reducer.ts，clearTranscript 分支
    // 由 `/clear` 命令经 store 的 'user' 清除路径带走；这里把镜像一并收口，
    // 使本 action 单独成立（与 `resetConversation` 同形）。
    todos: null,
    todoEntryId: undefined,
```

**为什么是 A 而不是 B**（承重论据，两条，缺一不可）：

1. **命中单一真相源**。§4.1 的 6 个出口里有 4 个**绕过镜像直读 store**（R-3 已逐点验证），
   只有清 store 才能让 6 个面同时一致。
2. **命令级修复没有覆盖损失**。这一条原文没写，但它是"A 不比 B 少修"的**唯一**证明：
   `clearTranscript` 在生产代码里**只有一个 dispatcher**（`builtins.ts:966`），
   `Ctrl+L` 是重绘而非清屏（`App.tsx:1347`）。因此把清除动作放在命令层，
   与放在 reducer 层覆盖的**是同一个入口集合**。

**为什么额外要那一行 `todos: null`**（三条，均非"防御性冗余"的空话）：

1. **它让 `clearTranscript` 单独成立**。第 2 条论据依赖的是"今天只有一个 dispatcher"这个
   **可被下一次提交推翻**的事实。第二个 dispatcher 一旦出现（一个真正的清屏快捷键、
   一条会话恢复路径），本 bug 会以**完全相同的形态**静默复发。
2. **与 `resetConversation` 同形，是本仓自己的先例**。`/reset` 今天就是"清 store（`clearMessages`）
   **且** reducer 里写 `todos: null`（`reducer.ts:1219`）"——后者在今天同样是冗余的
   （`clearMessages` 已经 emit 过一次）。让 `/clear` 与 `/reset` 保持同形，读者不必去追
   "为什么这两条命令的写法不一样"。
3. **它把 M-2 那条"绿色的谎言"变成 CI 红灯**。加了这一行，`todo-reducer.test.ts:118-134`
   立刻变红，修复节点**无法跳过** §6.3 第 4 项；不加，那条断言 `/clear keeps the list` 的用例
   会一路绿着活下去，与已发布行为**正相反**。

**关于"最小改动"的诚实交代**（供人工复核时行使否决权）：
严格意义上，**仅方案 A 就能修好用户可见的缺陷**，那一行 `todos: null` 不修任何新的面。
把它列为必需项是一个**明示的取舍**：用一行"绝不可能与 store 产生分歧的同值写入"
（两处都写 `null`，同一回合，无第三种取值），换取上面三条。
若复核者坚持严格最小化而删掉它，**则 §6.3 第 4 项从"必需"升格为"唯一防线"** ——
因为那时全套测试对本次修复**一个信号都不会给**（M-3）。

**明确"不要做"清单**（修复节点最可能踩的三个坑，全部来自把 `/todo clear` 当模板抄）：

| # | 不要做 | 后果 |
|---|---|---|
| 1 | 不要抄 `builtins.ts:805-808` 的 `if (controller.isRunning())` 拒绝守卫 | `/clear` 在运行中将**连正文都清不掉**，是比原 bug 更明显的回归 |
| 2 | 不要抄 `builtins.ts:809-812` 的 `if (!controller.getTodoSnapshot()) { notify('info','No todo list.'); return; }` 早退 | 该 `return` 会在没有清单时**跳过 `dispatch(clearTranscript)`**，`/clear` 直接失效；且平白多出一条"No todo list."提示。见 M-5：无清单时的清除本就静默安全 |
| 3 | 不要像 `/reset` 那样加 `ctx.toast(...)` | `/clear` 今天无 toast；清屏是高频动作，给它配一条 toast 是在刚清干净的屏幕上立刻写字 |

### R-5 · 修订后的落地清单（在 §6.3 基础上的**强制性**调整）

| §6.3 项 | 评审后状态 |
|---|---|
| 1（`builtins.ts` 命令体 + description） | **不变，必需**。另遵守 R-4 的"不要做"三条 |
| 2（`reducer.ts:1193-1197` 注释） | **升级**：由"只改注释"改为"**改注释 + 加 `todos: null` 一行**"（R-4 理由 1/2/3） |
| 3（`store.ts:12-18`、`types.ts:47-56` 的 I-2 与 `'user'` 表述） | **不变，必需**。`'user'` 改述为 `/todo clear` **与** `/clear`；沿用附录 A 的表述 |
| 4（`todo-reducer.test.ts:118-134`） | **由"建议"升级为"必需"，且要求"替换"而非"并存"**：删掉/反转旧的 reducer 级断言，新增经 `runSlashInput` 的命令级用例（房规见 M-8），**同时**断言 `state.todos === null` **与** `store.snapshot() === null`；保留 `/reset` 对照。只断言前者，方案 B 的半修状态也能过 |
| 5（README / manual-test / spec / CHANGELOG） | **不变，必需** |
| **6（新增）** | `HelpOverlay.tsx:54` —— description 的第二份手工副本（M-1） |

§7 的 7 条验收全部有效，**追加两条**：

8. `/help` 覆盖层里 `/clear` 一行的说明与斜杠补全气泡里的说明**逐字一致**（M-1 的验收面）。
9. 屏幕上**没有**清单时敲 `/clear`：正文清空，**不弹任何提示**（M-5 的验收面）。

### R-6 · 明确不做的事（防止修复节点范围蔓延）

- **不**为 `/clear` 新增 `TodoClearReason = 'transcript'`。该字段**零消费者**（M-6），
  新增一个成员只会让一个纯文档性的封闭联合多一个分支，不改变任何行为。
- **不**改 `todo_write` 的 `minFreshItems` 闸门语义（同原文 §6.4：那会削弱 R-c 这条独立约束）。
- **不**碰 `messages` / `/reset` 的既有行为（`/reset` 的对照用例必须保留并保持绿）。
- **不**为面 4/5/6 各自打补丁：它们全部从 `TodoStore` 派生，一处即全解（R-3 已验证）。

### R-7 · 结论

证据链闭合，可以进入修复。**推荐修复：方案 A′** —— `builtins.ts` 的 `/clear` 命令体调用
`ctx.controller.clearTodos()`（reason `'user'`），并在 `reducer.ts` 的 `clearTranscript` 分支
补 `todos: null` 收口；`messages` 不动。配套 6 项落地清单（§6.3 + R-5）与 9 条验收（§7 + R-5）
全部为必需项，其中 §6.3 第 4 项（回归用例）是本次修复**唯一**的自动化信号，不可省。

---

## 9. 实施过程发现的方案缺陷

**记录人**：Subtask #2 · 修复实施节点  **日期**：2026-08-01
**结论**：推荐方案 A′ 本身成立，落地后行为符合 §7 全部 9 条验收。以下是**落地清单的遗漏**，
不是方案的错误 —— 但第 1 条如果不补，修完之后源码里会留下一句与已发布行为**正相反**的断言。

### IF-1 · 落地清单漏了第 7 处：`controller.ts` 的 `clearMessages()` 注释

§6.3 + R-5 收敛出 6 项，附录 B 也把 `AgentController.clearMessages` 列进了索引，
但**没有任何一项要求改它的注释**。而那段注释（`controller.ts:1247-1250`）原文是：

```ts
// `/reset` clears `messages`, so the belief that justifies the panel is gone
// with them and the list must go too (I-2). `/clear` reaches the transcript
// and NOT this method, which is the whole distinction: it tells the model
// nothing, so it may not change the list.
```

最后一句 —— *"it tells the model nothing, so it may not change the list"* —— 在修复后**字面为假**：
`/clear` 现在确实改清单，只是走 `clearTodos()` / reason `'user'` 而非本方法。
它与 §3.2 引用的那句"`/clear` 够不到这个方法，这就是全部区别所在"是同一段文字，
诊断把它当作**根因证据**引用了，却没把它列进**待修订清单**。

这属于 M-1（`HelpOverlay` 那份手工副本）的同类问题、同样零测试覆盖，只是载体是注释而非用户可见文案：
下一个读者会拿它当权威解释，然后得出与代码相反的结论。

已按 R-4 的口径改写为"两者都清，区别在**为什么**清"：`/reset` 是信念已不存在，
`/clear` 是用户覆写一个模型仍持有的信念的投影。

**对落地清单的修订**：第 3 项（I-2 表述）的范围应从 `store.ts` + `types.ts` 扩到
**凡是复述 I-2 的源码注释**，共 4 处：`store.ts:12-24`、`types.ts:47-56`、
`reducer.ts` 的 `clearTranscript` 分支、`controller.ts:1242-1252`。
全仓判据：`grep -n "I-2" packages/cli/src --include=*.ts --include=*.tsx`，逐条回读是否仍成立。

### IF-2 · 回归用例的覆盖面应比 §6.3 第 4 项要求的更宽（已照做）

R-4 的"不要做"清单点名了三个最可能踩的坑（抄 `isRunning()` 守卫、抄空清单早退、加 toast），
但 §6.3 第 4 项只要求断言 `state.todos === null` 与 `store.snapshot() === null`。
只有这两条断言时，坑 1 和坑 2 **都能过测**：两者都只在特定入参下才 `return`，
而唯一的用例走的恰好是"有清单 + 不在运行中"这条不触发它们的路径。

新增的 `packages/cli/src/__tests__/clear-command-todo.test.ts` 因此有 4 条用例：
两条主断言（有清单 / 双半清空）之外，补了**空清单静默**（钉死坑 2 + M-5，断言
`notices` 与 `toasts` 皆空）与**运行中仍清正文**（钉死坑 1）。
`/reset` 对照保留并加断 toast 文案不变。

**反向验证已实跑**：临时移除 `builtins.ts` 里的 `ctx.controller.clearTodos()` 一行后，
该文件 4 条中 2 条转红（均断在 `store.snapshot()` 上），确认用例非空转；随即还原。

### 未构成缺陷、但值得下游知悉的两点

1. **§6.3 第 4 项预测的"AC-17 会因 `todos: null` 变红"属实**，且方向正确：
   `todo-reducer.test.ts` 的 `AC-17 (view half)` 已按 R-5 要求**替换**（而非并存）为
   *"both /clear and /reset drop the list"*，命令级断言另起新文件，两者职责不重叠。
2. **§6.4 的已知副作用（`minFreshItems` 闸门重新武装）未在本次改动中触碰**，
   按 R-6 只在 `builtins.ts` 的命令体注释里记了一句，`todo-tool.ts` 零改动。

### 验收执行情况

§7 的 7 条 + R-5 追加的 2 条，共 9 条：

| 条 | 方式 | 结果 |
|---|---|---|
| 1 / 2 / 3 / 4 / 9 | 对**构建产物 `dist/`** 跑端到端脚本（真实 registry + `TodoStore` + reducer + `App` 订阅逐字复刻） | ✅ 8/8 断言通过：rail 卸载、正文清空、`store.snapshot()` 为 null、`/save` 写空表、`/todo status` 报 "No todo list."、`/todo continue` 回 "Nothing left to continue."、`/clear` 零提示 |
| 5 | `/reset` 对照用例（含 toast 文案断言） | ✅ 绿 |
| 6 | `npx vitest run` / `npm run typecheck` / `npm run build` | ✅ 145 文件 2072 用例全绿；两个 tsconfig 均无错；构建成功 |
| 7 | 运行中 `/clear` 的命令级用例 | ✅ 正文清空、面板消失、无拒绝提示 |
| 8 | `grep "Clear the visible transcript"` 全仓（排除 `dist/` 与本诊断文档） | ✅ 仅 3 处且逐字一致：`builtins.ts:965`、`HelpOverlay.tsx:54`、`README.md:110` |

§2.1 的**交互式**复现（真实 TUI + 真实模型）未执行：本节点无可用模型凭据，
且 §2.2 的机械复现已被转正为常驻回归用例并做过反向验证。
`docs/plans/todo-plan-execution/manual-test.md` 第 13 行已同步改写为新预期，供人工手测。
