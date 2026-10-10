# 诊断报告：Main profile 选择器无法二次编辑已配置的模型 profile（`e` 键缺失）

- **症状（用户原话）**：「Main profile中，当选中某个已经配置的模型了以后，可以点击e键，二次编辑已经配置好的模型profile」——目前按 `e` 无任何反应。
- **结论（一句话）**：`ModelProfilePicker` 的输入处理器只认 Esc/↑/↓/Tab/Enter/`/`，不存在任何字母快捷键；且在「Main profile」这类**角色选择页**（`manager === false`）里，动作行只有 `Create profile`，`Edit` 动作行根本不渲染。编辑器与状态机本身已就绪（`onEdit` 已接线、编辑后能返回 picker 页），缺的只是 picker 页一条进入编辑器的按键通路。
- **bug 代号**：`profile-picker-edit-key`
- **严重级**：P2（功能可达性缺陷——已配置 profile 的二次编辑入口藏在 `Manage profiles` 二级页内，主路径不可达）
- **证据来源**：源码逐行核对 + 真实 Ink 按键级运行时复现（下文可复制粘贴）。

---

## 1. 问题描述

用户在 `/settings` 里选中某条已配置的模型 profile（例如名为 `Shared` 的条目）后，期望按 `e`
直接进入该 profile 的编辑表单（`ModelProfileEditor`），二次修改名称 / provider / model /
Base URL / 凭据。

实际行为：

1. 在 **Main profile / Fast profile 选择页**（root 屏第 0/1 行按 Enter 进入），无论光标停在哪条
   profile 上，按 `e` 都没有任何反应；
2. 想编辑只能 `Esc` 退回 root → ↓↓ 到 `Manage profiles` → Enter 进入管理页 → 光标落在条目上 →
   Enter（光标跳到 `Edit` 动作行）→ 再 Enter 才打开编辑器。共 6 步，且主选择页完全没有提示这条
   路径的存在。

## 2. 复现步骤

### 2.1 真实环境复现（手动，~1 分钟）

1. 启动 TUI：`aragon`（需要至少一个已保存的 profile；没有就先在 `/settings` 里建一个）。
2. 输入 `/settings` 回车，进入设置屏。
3. root 屏第一行是 `Main profile`，按 **Enter** 进入「Main profile」选择页（标题 `Main profile`，
   列出 `Current custom`、已保存条目、`Create profile`）。
4. 按 **↓** 把光标移到任意一条已配置的 profile 上（如 `Shared  openai:custom`）。
5. 按 **e**。
   - **预期（用户期望）**：打开 `Edit profile` 编辑表单。
   - **实际（bug）**：界面纹丝不动，仍停留在选择页。
6. 对照（当前唯一可达路径）：`Esc` → ↓↓ → Enter（`Manage profiles`）→ 光标停在条目上按 Enter
   （光标跳到 `Edit` 行）→ 再按 Enter → 编辑器打开，标题 `Edit profile | Used by ...`。

### 2.2 离线确定性复现（最小 repro，复制即跑）

将下面文件复制为 `packages/cli/src/__tests__/repro-picker-edit.test.tsx` 后运行：

```
cd packages/cli
npx vitest run src/__tests__/repro-picker-edit.test.tsx
```

**当前代码下两个用例都通过（即都复现了 bug 行为 / 证明了对照路径）**：

```tsx
import React from 'react';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import { createStdinFilter } from '../input/stdin-filter.js';
import { SettingsScreen, type SettingsValues } from '../ui/overlays/SettingsScreen.js';
import type { ModelSettingsDraft } from '../config/model-profile-store.js';
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

const profile = { id: 'profile-a', name: 'Shared', provider: 'openai', model: 'custom',
  baseUrl: null, apiKey: 'disk-secret' };
const draft = () => ({ diskRevision: 'disk', liveRevision: 0, baseline: {}, liveBaseline: {},
  patch: {}, activateRoles: [], profiles: { version: 1, entries: [profile], mainId: 'profile-a',
    fastId: 'profile-a' } }) as unknown as ModelSettingsDraft;
const initial: SettingsValues = { provider: 'openai', model: 'custom', baseUrl: '',
  thinkingLevel: 'off', showThinking: 'off', liveToolOutput: 'off', maxTokens: '', apiKey: '',
  logLevel: 'info', fastEnabled: 'off', fastModel: '', fastProvider: '', fastReview: '5',
  fastReviewBudget: '40', compactionEnabled: 'off', compactionThreshold: '90',
  compactionKeepTurns: '3', compactionSubagents: 'off', compactionArchive: 'off' };

async function mountSettings() {
  return mount(<SettingsScreen initial={initial} apiKeys={{}} cols={80} maxRows={24}
    scrollOffset={0} theme={getTheme('cool', caps)} caps={caps} draft={draft()}
    onProfileSave={vi.fn(() => ({ ok: false, persisted: false, status: 'rejected' as const,
      code: 'write_failed' as const }))} />);
}

describe('DIAG-2 Main-profile picker ignores e', () => {
  it('e on a configured profile in the Main profile picker does nothing', async () => {
    const view = await mountSettings();
    await view.send('\r');            // root 第 0 行 Enter -> Main profile 选择页
    await view.send('\x1b[B');        // 光标移到第一条已配置 profile
    await view.send('e');
    expect(view.frame()).toContain('Current custom');        // 仍停留在选择页
    expect(view.frame()).not.toContain('Credential mode');   // 编辑器没有打开
  });

  it('contrast: the editor is reachable only via Manage profiles + Enter Enter', async () => {
    const view = await mountSettings();
    await view.send('\x1b[B');
    await view.send('\x1b[B');
    await view.send('\r');            // Manage profiles
    await view.send('\r');            // 条目上 Enter -> 光标跳到 Edit 动作行
    await view.send('\r');            // Edit 动作行 Enter -> 编辑器
    expect(view.frame()).toContain('Edit profile');
  });
});
```

## 3. 根因分析（证据）

按键通路只有一条：`usePickerInput`（`packages/cli/src/ui/overlays/ModelProfilePicker.tsx:97-130`）。
它处理且只处理以下键：

```ts
// ModelProfilePicker.tsx:113-129
useInput((input, key) => {
  if (props.isActive === false) return;
  if (key.escape) { ... }
  if (searching) { ... }                       // 搜索态吞掉所有可打印字符
  if (key.upArrow || (key.tab && key.shift)) ...
  else if (key.downArrow || key.tab) ...
  else if (key.return) activate();
  else if (input === '/' && searchable) setSearching(true);
});
```

没有任何 `input === 'e'` 分支——`e` 落入无匹配分支，被静默丢弃。

其次，`Edit` 动作行在选择页根本不存在：

```ts
// ModelProfilePicker.tsx:83
const actions = props.manager ? ['New', 'Edit', 'Duplicate', 'Delete'] : ['Create profile'];
```

`manager === false`（即 root 屏 `Main profile` / `Fast profile` 行进入的页面，见
`packages/cli/src/ui/overlays/SettingsScreen.tsx:795`：`dispatch({ type: 'page', page: 'picker',
role: index === 0 ? 'main' : 'fast' })`）时动作行只有 `Create profile`。

`activate()`（`ModelProfilePicker.tsx:100-112`）里与编辑相关的通路有两条，都到不了选择页用户
手上：

```ts
// ModelProfilePicker.tsx:102-111
if (focused) {
  if (props.manager) setIndex(prefix + entries.length + 1);  // 管理页：Enter 只跳光标
  else props.onSelect(focused.id);                            // 选择页：Enter 直接绑定并返回
  return;
}
const action = actions[cursor - prefix - entries.length];
...
if (action === 'Edit' && selected) props.onEdit(selected);    // 只有管理页存在 Edit 行
```

底部提示同样没有暴露编辑入口：

```ts
// ModelProfilePicker.tsx:179-180
hint={state.searching ? 'Type search | Enter done | Esc back'
  : 'Enter select/action | Esc back'}
```

而下游一切就绪，说明这纯粹是**入口缺失**而非能力缺失：

- `SettingsScreen.tsx:873`：选择页已经把 `onEdit={(profile) => dispatch({ type: 'edit', profile })}`
  传给了 picker——只是 picker 从不在选择页触发它；
- `packages/cli/src/ui/overlays/model-profile-state.ts:131-133`：`edit` 动作记录
  `returnPage: state.page === 'picker' ? 'picker' : 'manager'`——从选择页进编辑器、保存/取消后
  返回选择页的状态机支持**已经存在**；
- `model-profile-state.ts:104-119`：`mergeEditor` 对已存在条目走「替换合并进草稿」路径，编辑已
  绑定 profile 不会产生重复条目。

### 运行时证据（§2.2 输出，节选）

```
✓ e on a configured profile in the Main profile picker does nothing
✓ contrast: the editor is reachable only via Manage profiles + Enter Enter
```

第一个用例证明 `e` 无效；第二个对照用例证明「编辑器 + onEdit + returnPage」链路完好，
只有入口键位缺失。

### 评审补充证据（复核新增，行号已在 HEAD 逐一核对）

1. **`onEdit` 对两页无条件接线**：`SettingsScreen.tsx:866-876`（`renderProfileSubpage`）在
   `state.page === 'picker' || state.page === 'manager'` 同一分支里渲染 `ModelProfilePicker`，
   :873 的 `onEdit={(profile) => dispatch({ type: 'edit', profile })}` 不区分
   `manager`——picker 层加 `e` 键**零 SettingsScreen 改动**，与 §3 判断一致。
2. **`e` 与 App 全局按键无冲突**：App 的全局 `useInput`（`App.tsx:1902-2134`）没有任何
   纯字母分支（Ctrl+P 模式切换带 `key.ctrl` 守卫且 overlay 打开时早退，`App.tsx:2034-2038`）。
   设置屏打开时 `e` 直达 picker，不会被 App 抢走。
3. **管理页副作用是增益而非回归**：`ModelProfilePicker.tsx:90`
   （`useEffect(() => { if (focused) setSelectedId(focused.id); }, [focused?.id])`）保证管理页
   `selected === focused`，因此同一 `e` 分支在管理页打开的正是 Edit 动作行会打开的同一条
   profile——只是省去「Enter 跳到动作行」一步。
4. **编辑不产生重复条目（复核）**：`model-profile-state.ts:108-114`，`mergeEditor` 对已存在
   id 走原地替换（`entries.map(...)`），仅新 id 才 append（200 条上限在 :110-111 拦截）。
5. **复现重跑**：评审节点将 §2.2 原样落盘为临时测试重跑，2/2 通过后已删除临时文件。

## 4. 影响面

| 维度 | 影响 |
|---|---|
| 受影响功能 | 模型 profile 的二次编辑（改名、换 provider/model/Base URL、换凭据模式） |
| 受影响页面 | `/settings` → `Main profile`、`Fast profile` 两个角色选择页（`manager: false`） |
| 受影响用户 | 所有配置了多个 profile / 使用网关中转并需要改 Base URL 或 Key 的用户（这正是 profile 功能的核心场景：网关换地址、换 Key、改模型名） |
| 不受影响 | `Manage profiles` 管理页（Edit 动作行可用）；新建 profile（`Create profile` → 编辑器） |
| 连带文档 | `docs/specs/model-config-profiles/manual-test.md` 的验证矩阵未覆盖「选择页直接编辑」路径，属于规格盲区而非回归 |

## 5. 候选修复（对比表）

| 方案 | 做法 | 侵入性 | 风险 | 工作量 |
|---|---|---|---|---|
| **A：picker 内加 `e` 快捷键**（推荐） | `usePickerInput` 非搜索态增加分支：`input === 'e'`（建议 `toLowerCase()` 兼容大写）且 `focused` 存在 → `props.onEdit(focused)`；hint 改为 `Enter select · e edit · Esc back` 一类 | 极低：一个分支 + 一句文案，零布局变化 | 低：搜索分支在前（`searching` 优先），`e` 不会误触搜索框；`/` 搜索键不冲突；`onEdit`/`returnPage` 已就绪 | ~0.5 天（含测试） |
| B：选择页也渲染 `Edit`/`Duplicate`/`Delete` 动作行 | 改 `actions` 数组与 `activate()` 语义 | 中：`activate()` 在非管理页对条目 Enter 的语义是「绑定」，与动作行导航纠缠；列表行数 +3，挤压小终端下的可视窗口 | 中：选择页的核心语义是「选一个绑到角色」，塞进管理动作会稀释语义；键盘导航距离并未明显缩短 | ~1-2 天 |
| C：改用鼠标/双击或全局命令 `/profile edit <name>` | 新增命令解析与补全 | 中：跨 `commands/builtins.ts`、补全、帮助 | 中：与现有 `/settings` 屏功能重叠，两条真相源 | ~2 天 |

## 6. 推荐修复及理由

**采用方案 A**，具体落点：

1. `packages/cli/src/ui/overlays/ModelProfilePicker.tsx` `usePickerInput` 内、`key.return` 分支
   旁增加：

   ```ts
   else if (!key.ctrl && !key.meta && input.toLowerCase() === 'e' && focused) {
     props.onEdit(focused);
   }
   ```

   放在 `searching` 分支之后即可（搜索态已提前 return，`e` 作为查询字符不会被劫持）。
2. hint 文案（`ModelProfilePicker.tsx:179-180`）同步暴露快捷键，保持可发现性：
   `'Enter select · e edit · Esc back'`（管理页可用 `'Enter action · e edit · Esc back'`）。
3. 边界约定：
   - 光标在 `Current custom` 行（`focused` 为 `undefined`）时按 `e` 无操作——只编辑「已配置的
     profile」，与用户需求原文一致；如产品后续想支持编辑 custom 快照，应显式另立需求。
   - 编辑已绑定 Main/Fast 的 profile 会照常走 `mergeEditor` 草稿合并 + Save 事务，无额外风险。
4. 回归测试：把 §2.2 的两个用例改写为断言 `e` 打开编辑器（`frame` 含 `Edit profile`）、
   搜索态下 `e` 仍进查询框；顺带在 `docs/specs/model-config-profiles/manual-test.md` 矩阵中
   补「选择页 e 编辑」一行。

理由：这是最小、无语义冲突、且与既有状态机（`onEdit` 接线 + `returnPage: 'picker'`）完全
对齐的改法；`B` 改变选择页语义且导航收益低，`C` 制造平行入口。方案 A 同时符合列表型界面的
人机交互惯例（单键操作聚焦项，如 Claude Code / lazygit 一类 TUI 的通用模式）。

---

## 评审结论

**裁定：根因证据链成立，最终推荐 = 方案 A（`usePickerInput` 增加 `e` 编辑快捷键 + hint 文案同步），按 §6 落点执行，另加两条实现约束（见下）。**

### 1. 根因证据审计（通过）

- §3 全部代码引用在 HEAD 逐行复核一致：`ModelProfilePicker.tsx:83`（非管理页动作行仅
  `Create profile`）、`:97-130`（`useInput` 无任何字母分支，`e` 落入无匹配被静默丢弃）、
  `:100-112`（`activate()` 在非管理页对条目 Enter 是「绑定」语义，不含编辑入口）、
  `:179-180`（hint 未暴露编辑）；`SettingsScreen.tsx:795/:873`、`model-profile-state.ts:131-133/:104-119`
  亦属实。「编辑器与状态机就绪、仅缺入口键」的判断成立，无替代解释：不存在其他能拦下 `e`
  的处理器（评审补充证据第 2 条），也没有被遗漏的既有快捷键通路。
- §2.2 复现由评审节点原样重跑：**2/2 通过**，症状与机制均被钉死。

### 2. 候选方案审计

- **A（推荐）**：是最小改动——一个按键分支 + 一句 hint，不改 `activate()` 语义、不改
  `SettingsScreen`、不改状态机。边界覆盖完备：`searching` 分支在前（搜索态 `e` 进查询框）、
  `focused` 为 `undefined` 时（`Current custom` 行与动作行）自然 no-op、`!key.ctrl && !key.meta`
  排除 Ctrl+E/Alt+E 之类组合键。无回归面：选择页 Enter 仍为绑定，Esc 仍为返回。
- **B**：否决。给选择页塞 `Edit/Duplicate/Delete` 动作行改变该页「选一个绑到角色」的核心
  语义，与 `activate()` 的管理页导航逻辑纠缠，且列表 +3 行挤压小终端视口。
- **C**：否决。新增 `/profile edit` 命令与设置屏形成两条真相源，工作量最大。

### 3. 最终修复方案（给下一节点）

1. `ModelProfilePicker.tsx` `usePickerInput` 内、`searching` 早退之后、与既有 `else if` 并列：

   ```ts
   else if (!key.ctrl && !key.meta && input.toLowerCase() === 'e' && focused) {
     props.onEdit(focused);
   }
   ```

2. hint（:179-180）同步暴露快捷键：非管理页 `'Enter select · e edit · Esc back'`，
   管理页 `'Enter action · e edit · Esc back'`。
3. **实现约束一**：分支不区分 `manager`——同一分支让管理页获得「`e` 直达编辑」的增益
   （`selected === focused`，见评审补充证据第 3 条），这是有意的对称行为，不要加
   `!props.manager` 守卫把它掐掉。
4. **实现约束二**：测试除 §6.4 所列（`e` 打开编辑器、搜索态 `e` 不被劫持）外，补一条
   「光标在 `Current custom` 行按 `e` 无操作」的用例，把「只编辑已配置 profile」的边界
   钉进回归网。

**一句话理由**：症状是「入口缺失」而非「能力缺失」，A 恰好只补入口——一处分支、零语义
变更、复用已就绪并已接线的 `onEdit`/`returnPage` 状态机，是三个方案中唯一改动面与缺陷面
严格等比例的方案。


## 实施过程发现的方案缺陷

1. **§6.2 建议的 hint 分隔符 `·` 不可用（已替换为 `|`）**：`src/ui/**` 受
   `glyphs.test.ts` ASCII-only 静态扫描约束，任何非 ASCII 字面量（含 U+00B7 `·`）都会
   使构建失败；非 ASCII 字形必须经 `pickGlyphs(caps)` 提供，而 picker 的 hint 属纯文案、
   无字形语义。实施采用与既有 hint（`Type search | Enter done | Esc back`）一致的
   `|` 分隔：`Enter select | e edit | Esc back` / `Enter action | e edit | Esc back`。
   语义与可发现性目标不受影响，方案 A 的按键分支本体照 §6.1/评审 §3.1 原样落地。
