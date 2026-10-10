# 诊断报告：↑ 翻历史时弹出 `/` 命令联想，吞掉后续 ↑ 键（历史行走被打断）

- **症状（用户原话）**：「键盘在用户输入区域，点击"上"按钮的时候，如果切换到了之前使用命令的情况，不要弹出联想关联，比如"/clear"，现在历史切换到这个曾经输入的时候，会自动弹出关联，导致无法继续点击上按钮了，这体验不好」。
- **结论（一句话）**：联想弹窗的唯一开关是 `dismissed` 标志，而 `recall`（历史召回）这个 reducer
  动作**故意不重置也不设置** `dismissed`（`editor-reducer.ts:225-239` 的注释明说这是重构时
  「不改语义」的保守选择）；于是从空输入按 ↑ 召回出 `/clear` 这类命令时，`slashSuggestions`
  依据 buffer 内容重新命中，弹窗再次出现；弹窗一出现，`PromptInput` 的按键路由就把 ↑/↓/Tab/
  Enter/Esc 全部划给弹窗（`PromptInput.tsx:667-693`），第二次 ↑ 变成「上移高亮」，历史行走被
  打断。
- **bug 代号**：`history-recall-autocomplete-popup`
- **严重级**：P2（高频交互路径的可用性缺陷：任何用 ↑ 翻找历史命令的用户都会撞上；命令用户
  恰是重度用户）
- **证据来源**：源码逐行核对 + 真实 Ink 按键级运行时复现（下文可复制粘贴）。

---

## 1. 问题描述

用户在输入框为空时按 ↑，期望像 shell 一样连续按 ↑ 向更早的历史 walking（例如依次召回
`/clear` → 更早的一条 → …），按 ↓ 往回走。

实际行为：

1. 按 ↑ 召回到 `/clear`（或任何 `/word` 形态的历史条目）时，命令联想弹窗**自动弹出**；
2. 此时再按 ↑ 不再翻历史，而是上移弹窗高亮项；按 ↓ 同理被弹窗吞掉；
3. 用户必须先按 Esc 关掉弹窗，才能继续 ↑ 翻历史——但翻到下一条 `/xxx` 形态条目时弹窗
   已经不会再弹（见根因：Esc 置位 `dismissed` 后 `recall` 不清除它），行为表现「时好时坏」，
   更加困惑。

## 2. 复现步骤

### 2.1 真实环境复现（手动，~1 分钟）

1. 启动 TUI：`aragon`。
2. 先制造两条历史（顺序输入并回车）：
   - `older plain text`（普通消息）
   - `/clear`（或任意 `/` 开头命令，如 `/help`）
3. 等输入框清空后，按一次 **↑**：输入框召回 `/clear`，**同时**命令联想弹窗弹出（列出
   `/clear` 及其描述）。
4. 再按 **↑**：
   - **预期**：输入框召回更早的 `older plain text`。
   - **实际（bug）**：输入框仍是 `/clear`，弹窗高亮上移一行（只有一条候选时高亮纹丝不动，
     看起来像 ↑ 完全失灵）。
5. 对照：按 **Esc** 关闭弹窗后再按 ↑ → `older plain text` 正常召回（证明打断的正是弹窗）。

### 2.2 离线确定性复现（最小 repro，复制即跑）

将下面文件复制为 `packages/cli/src/__tests__/repro-history-popup.test.tsx` 后运行：

```
cd packages/cli
npx vitest run src/__tests__/repro-history-popup.test.tsx
```

**当前代码下三个用例都通过（即都复现了 bug 行为 / 钉死了机制）**：

```tsx
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { PromptInput, slashSuggestions } from '../ui/PromptInput.js';
import { editorReducer, INITIAL_EDITOR_STATE } from '../ui/editor-reducer.js';
import { getTheme } from '../ui/theme.js';

const caps = { colorLevel: 0 as const, unicode: false };
const common = { caps, theme: getTheme('cool', caps), cols: 80, maxRows: 30 };
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

const commands = [
  { name: 'clear', description: 'Clear the conversation history' },
  { name: 'compact', description: 'Compact the context' },
];

describe('DIAG-1 history Up re-arms the slash popup', () => {
  it('state level: recall does not dismiss, so suggestions re-arm', () => {
    const recalled = editorReducer(INITIAL_EDITOR_STATE,
      { type: 'recall', buffer: '/clear', cursor: 6, historyIndex: 1 });
    expect(recalled.buffer).toBe('/clear');
    expect(recalled.dismissed).toBe(false);                        // <- 弹窗重新武装
    expect(slashSuggestions(recalled.buffer, commands)!.length).toBeGreaterThan(0);
  });

  it('second Up moves the popup selection instead of stepping history', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/clear']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');                                     // 召回 /clear
    expect(view.frame()).toContain('/clear');
    expect(view.frame()).toContain('Clear the conversation history'); // 弹窗可见
    await view.send('\x1b[A');                                     // 应翻到更早历史
    expect(view.frame()).not.toContain('older plain text');        // BUG: 历史行走被吞
  });

  it('contrast: after Esc dismisses the popup, the same Up walk works', async () => {
    const view = await mount(<PromptInput {...common} isActive running={false}
      history={['older plain text', '/clear']} commands={commands} cwd={process.cwd()}
      onSubmit={() => ({ accepted: true })} />);
    await view.send('\x1b[A');
    await view.send('\x1b');                                       // Esc 关弹窗
    await view.send('\x1b[A');
    expect(view.frame()).toContain('older plain text');            // 行走恢复
  });
});
```

## 3. 根因分析（证据）

三个事实叠加成这个 bug，缺一不可：

**事实 1：联想的唯一抑制开关是 `dismissed`，判定只看 buffer 内容。**

```ts
// packages/cli/src/ui/PromptInput.tsx:413
const slashSug = dismissed ? null : slashSuggestions(buffer, commands);

// packages/cli/src/ui/PromptInput.tsx:350-357
export function slashSuggestions(buffer: string, commands: CommandOption[]): Suggestion[] | null {
  const m = /^\/([\w:-]*)$/.exec(buffer);   // buffer 是 /word 形态即命中
  ...
}

// packages/cli/src/ui/PromptInput.tsx:505
const popupVisible = isActive && popupLayout.rowCount > 0;
```

内容来源（打字 vs 历史召回）不在判定条件里。

**事实 2：`recall` 故意不动 `dismissed`。**

```ts
// packages/cli/src/ui/editor-reducer.ts:225-239
case 'recall':
  // ... `dismissed` 和 `sel` 是故意不动（LEFT ALONE）的：这段重构（F3）的承诺是
  // 输入语义与重构前逐字节一致（K-7）...
  return withPrune({
    ...state,
    buffer: action.buffer,
    cursor: snapGrapheme(action.buffer, action.cursor),
    preferredVisualColumn: undefined,
    historyIndex: action.historyIndex,       // 只设置 historyIndex
  });
```

初始状态 `dismissed: false`（`editor-reducer.ts:94-101`），且每次提交后 `clear` 回到
`INITIAL_EDITOR_STATE`（`dismissed: false`）。所以**每条新输入的第一段历史行走必然以
`dismissed === false` 起步**——第一条被召回的 `/xxx` 一定会弹窗。

**事实 3：弹窗可见时 ↑/↓ 归弹窗所有，历史分支排在后面。**

```ts
// packages/cli/src/ui/PromptInput.tsx:667-693
// Popup navigation owns Up/Down/Tab/→/Enter/Esc while it is open.
if (popupVisible) {
  if (key.upArrow) {
    onInteraction?.();
    dispatch({ type: 'select', sel: Math.max(0, clampedSel - 1) });   // <- 高亮上移
    return;                                                            // <- 历史分支到不了
  }
  ...
}

// packages/cli/src/ui/PromptInput.tsx:748-755（历史分支，在弹窗分支之后）
if (key.upArrow && !key.shift) {
  verticalOrHistory('up');
  return;
}
```

`verticalOrHistory`（`PromptInput.tsx:616-632`）在单行 buffer 上 `moveVisualCursor` 返回
`null`（`packages/cli/src/ui/editor-navigation.ts:100-103`：目标行越界即 `null`），
随后在 `buffer.length === 0 || historyIndex !== null` 时调用 `recallUp/recallDown`
（`PromptInput.tsx:582-601`）。

**因果链**：空输入（`dismissed=false`）→ ↑ → `recall('/clear')`（`dismissed` 保持 false）→
重渲染时 `slashSuggestions('/clear')` 命中 → `popupVisible=true` → 第二次 ↑ 进入弹窗分支
（`select`）→ 历史行走中断。Esc（`PromptInput.tsx:687-690`）置 `dismissed=true` 后，
后续 `recall` 不清除它（事实 2），所以行走「又好了」——这正是用户看到的时好时坏。

### 运行时证据（§2.2 输出，节选）

```
✓ state level: recall does not dismiss, so suggestions re-arm
✓ second Up moves the popup selection instead of stepping history
✓ contrast: after Esc dismisses the popup, the same Up walk works
```

### 评审补充证据（复核新增，行号已在 HEAD 逐一核对）

1. **必改测试（§6 遗漏的落点）**：`packages/cli/src/__tests__/editor-reducer.test.ts:137-146`
   存在 K-7 断言用例 `it('leaves dismissed and sel alone (K-7 — the old code did not touch
   them)')`——从 `dismissed: true` 起步断言 recall 后仍为 `true`。方案 A 落地后该用例会
   **空洞通过**（起点即 true），但用例名与注释仍在宣称旧契约，必须随修复改写为新语义
   （「recall 恒置 `dismissed: true`」，并补一条从 `dismissed: false` 起步的断言）。
   这是方案 A 的第四个必改文件，原报告只列了三个。
2. **回归面确认（不受影响的既有用例）**：`prompt-input-commits.test.tsx:147-168` 的两条
   recall 用例召回的是非斜杠草稿（`'old'`、`'abc\nx'`），无弹窗参与；`interrupt-ladder.test.tsx:358-376`
   的斜杠弹窗归属用例走「键入 `/`」路径，不经 recall。二者均不受方案 A 影响。
3. **「能力没有被拿走」的论证（补全 A 的正当性）**：现状下用户按 Esc 关掉弹窗后，想让弹窗
   在**未编辑**的召回内容上重现本来就做不到——`recall` 不清 `dismissed`（事实 2），只有
   缓冲变更动作经 `DRAFT_FLAGS`（`editor-reducer.ts:113-115`）把它复位。方案 A 只是把
   「Esc 之后的世界」提前到召回时刻：继续编辑（insert/backspace/replace/input 任一）联想即
   恢复，与今天 Esc 后的行为完全一致。它没有删除任何用户今天实际可达的能力。
4. **提交路径不受影响**：召回 `/clear` 后直接回车——修复后 `popupVisible` 为假，走
   `PromptInput.tsx:715-722` 普通提交分支，`resolveSubmit`（:548-558）在 `dismissed: true`
   时取 `expandPastes(buffer)` 即原文提交；现状下走弹窗分支提交的是高亮候选（`sel=0` 恰为
   同一条命令）。两端结果一致，无行为漂移。
5. **复现重跑**：评审节点将 §2.2 原样落盘为临时测试重跑，3/3 通过后已删除临时文件。

**同类隐患**：`@file` 联想走同一开关（`PromptInput.tsx:414-416`
`fileActive = !dismissed && ...`）。召回含 `@src/...` 的历史条目时文件弹窗同样会弹出并吞键，
本报告的修复对它一并生效。

## 4. 影响面

| 维度 | 影响 |
|---|---|
| 受影响功能 | ↑/↓ 历史召回与 `/` 命令联想、`@` 文件联想的交互 |
| 触发条件 | 历史（本会话内曾提交的输入）中存在 `/word` 形态条目（斜杠命令）或含 `@token` 的条目，且当前处于一次新输入的第一次历史行走 |
| 受影响用户 | 所有使用斜杠命令并习惯用 ↑ 找历史的用户；命令重度用户（`/compact`、`/settings`、`/clear`…）必现 |
| 观感 | 单候选弹窗下 ↑ 看起来完全失灵（高亮已在顶，`Math.max(0, sel-1)` 不变），用户会误以为历史功能坏了 |
| 不受影响 | 键入 `/` 主动唤起联想的路径（应当保留）；多行编辑内的 ↑/↓ 行内移动（`verticalOrHistory` 的 `moved` 分支）；Shift+↑/↓ 视口滚动 |
| 连带文档 | `docs/specs/` 输入规范若引用了「recall 不改 dismissed」的 K-7 语义，需随修复同步修订 |

## 5. 候选修复（对比表）

| 方案 | 做法 | 侵入性 | 风险 | 工作量 |
|---|---|---|---|---|
| **A：召回即抑制弹窗**（推荐） | `editorReducer` 的 `recall` 分支同时置 `dismissed: true`（一行），并更新 K-7 注释；必要时给 `recall` 动作加显式 `dismissPopup` 字段以表达意图 | 极低：一个 reducer 分支 + 注释 | 低：召回后想用联想，继续打字即恢复（`insert`/`replace` 等缓冲变更动作都会重置 `DRAFT_FLAGS.dismissed=false`，`editor-reducer.ts:113-115`） | ~0.5 天（含回归测试） |
| B：弹窗保留，但 `historyIndex !== null` 时 ↑/↓ 优先走历史 | 在弹窗分支前加条件跳过 | 中：按键路由加一层优先级 | 中：弹窗仍渲染，视觉上「显示着联想却对 ↑↓ 无反应」，困惑更甚；`sel` 与历史索引两个状态交织，边界（召回后用户真的想选联想）语义模糊 | ~1 天 |
| C：召回后弹窗只显示不拦截（如 ↑ 仍走历史），并给出「Tab 进入联想」提示 | 相当于 B + 新手引导 | 中高 | 中：改变弹窗既有按键契约，影响键入路径的同一份代码 | ~1.5 天 |

## 6. 推荐修复及理由

**采用方案 A**：`packages/cli/src/ui/editor-reducer.ts` 的 `recall` 分支返回值中增加
`dismissed: true`，并把注释改为记录**新的**语义承诺：

> 历史召回的内容不是用户正在键入的查询，联想弹窗不在召回内容上自动出现；任何缓冲编辑
> （`insert` / `backspace` / `replace` / `input` …）照旧重置 `dismissed`，用户继续打字时
> 联想自然恢复。

配套改动（同一次提交内）：

1. `PromptInput` 无需改动——`popupVisible` 自然因 `dismissed` 为真而关闭，↑/↓ 路由随之回到
   `verticalOrHistory`，第二次 ↑ 直达 `recallUp`，用户报告的场景消失。
2. 回归测试：将 §2.2 的三个用例改写为修复后断言——召回 `/clear` 后弹窗不出现
   （frame 不含命令描述行）、连续 ↑↑ 能走到 `older plain text`、召回后继续键入字符时
   联想恢复。`@file` 路径补一条含 `@` 条目的对称用例。
3. 文档：更新 `editor-reducer.ts` 头部「一次按键一次 dispatch」说明中关于 recall 的例外描述，
   并在输入规范（如有）中记录该语义。

理由：弹窗出现的判定本来就以 `dismissed` 为唯一闸门（事实 1），让「内容来源」参与语义的
最小方式就是在来源切换（召回）时置闸门，一处改动同时修好 `/` 与 `@` 两条联想路径以及按键
路由；B/C 保留「召回即弹窗」这个用户已明确否定的表象，只治标。A 也符合 readline/bash 的
既有心智：历史展开不自动弹补全，继续编辑才触发。

---

## 评审结论

**裁定：根因证据链成立，最终推荐 = 方案 A（`recall` 分支置 `dismissed: true` + K-7 注释改写），并在原方案之上追加一个必改测试文件与一条实现约束。**

### 1. 根因证据审计（通过）

- 三事实全部在 HEAD 逐行复核一致：`PromptInput.tsx:413`（弹窗唯一闸门是 `dismissed`）、
  `:350-357`（`/word` 正则只看 buffer 内容）、`:505`（`popupVisible` 派生）、`:667-693`
  （弹窗可见时 ↑/↓ 归弹窗并 `return`，历史分支 :748-755 排在其后不可达）、
  `editor-reducer.ts:225-239`（`recall` 原样保留 `dismissed`，注释自认是 K-7 保守选择）、
  `:94-101`（初始 `dismissed: false`）与 `composer-input.ts:46`（提交即 `clear` 回初始态，
  故每次新输入的首次历史行走必然从 `dismissed === false` 起步——「第一条 `/xxx` 必弹」成立）。
  因果链闭环，无替代解释：唯一能把 ↑ 变成「高亮上移」的代码就是弹窗分支，而唯一能让弹窗
  在召回后出现的开关就是未复位的 `dismissed`。
- §2.2 复现由评审节点原样重跑：**3/3 通过**（状态级 + 组件级 + Esc 对照）。

### 2. 候选方案审计

- **A（推荐）**：一行状态变更 + 注释改写，语义落点准确——`dismissed` 本来就是「联想是否
  被抑制」的唯一事实位，在「内容来源从键入切换为召回」这一时刻置位，是让来源参与语义的
  最小方式。边界完备：继续编辑即恢复（`DRAFT_FLAGS`）、`@file` 同闸门一并修复、召回后直接
  回车提交结果与现状一致（评审补充证据第 4 条）。评审补充证据第 3 条进一步论证它不拿走
  任何今天可达的能力。
- **B**：否决。`historyIndex !== null` 时 ↑/↓ 改走历史，弹窗仍渲染——「看得见却不响应」的
  矛盾状态比现状更难解释，且 `sel` 与 `historyIndex` 两套状态交织出模糊语义。
- **C**：否决。改写弹窗按键契约会波及键入路径的同一份代码，风险面远大于收益。

### 3. 最终修复方案（给下一节点）

1. `editor-reducer.ts` `recall` 分支（:233-239）返回值中加 `dismissed: true`，同步改写
   :225-232 注释为新语义承诺（召回内容不是正在键入的查询；任何缓冲编辑照旧经 `DRAFT_FLAGS`
   复位 `dismissed`）。
2. **必改测试（原 §6 未点名）**：改写 `editor-reducer.test.ts:137-146` 的 K-7 用例为新契约
   ——「recall 恒置 `dismissed: true`」，含从 `false` 起步的正向断言；否则该用例空洞通过，
   测试名继续宣称已被废除的语义。
3. **实现约束**：只置 `dismissed`，**不要**顺手重置 `sel`——隐藏状态下 `sel` 不可见，下一次
   缓冲变更会经 `DRAFT_FLAGS` 复位；多改一个字段只会扩大与 K-7 重构基线的 diff。
4. 回归测试按 §6.2 落地（召回不弹窗、连续 ↑↑ 走到更早历史、召回后键入恢复联想、`@file`
   对称用例）。

**一句话理由**：症状的三要素（唯一闸门、闸门未被复位、弹窗吞 ↑）每一环都有代码与运行时
双重证据，A 恰好在「闸门未被复位」这一环做最小干预，同时治愈 `/` 与 `@` 两条路径，且与
readline/bash「历史展开不打扰补全」的既有心智一致。
