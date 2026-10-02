# 手工验收 —— context-usage-gauge-accuracy

配套 `spec.md` **v2**（含 §0 评审记录与文末「实施过程发现的方案缺陷」）。
★ 标记的 **9** 条是**发布门禁**，其余为回归覆盖。
除非另行说明，都在一个 ≥ 100 列的终端里跑 `npm run dev:cli`。

> **本轮尚未执行任何一条。** 第 15 条是评审放行条件 4 的兑现处，也是实施节点
> 明确未做的那一项（见 spec.md 文末「放行条件的兑现情况」）。

准备：

```bash
cd aragon-agent-core
npm install
npm run build
npm run dev:cli
```

---

## ★ 1 — 压缩之后进度条真的掉下去（P0-1）

1. `/compact threshold 0.5`（把阈值压到 50%，便于触发）。
2. 让 Agent 读几个大文件，直到状态栏百分比越过 50%。
3. 观察压缩发生的那一瞬间。

**期望**：进度条**下落一次并停在低位**，直到下一轮才重新爬升。
**改动前的症状**：先掉再立刻弹回压缩前的数值（往往只在一帧内可见，随后整轮都停在高位）。
4. 紧接着执行 `/compact status`，`Occupancy` 行必须与状态栏百分比**完全相同**。

---

## ★ 2 — `/resume` 之后立刻显示真实占用（P0-2）

1. 跑一段较长的会话（状态栏 ≥ 40%），`/save ./big.json`。
2. `Ctrl+C` 退出，重新 `npm run dev:cli`（此时状态栏应是 `0%` 或 `~2%`）。
3. `/resume ./big.json`。

**期望**：**不发送任何消息**，状态栏立刻跳到接近 40% 的值，带 `~` 前缀；`/context` 的
`Occupancy` 行同样非零，`Since measured` 行说明这是估计值。
**改动前的症状**：状态栏停在 `0%`，`/compact status` 也报 `~0%`。

---

## ★ 3 — 关掉压缩，进度条依然会动（P1-4）

1. `aragon config set compaction.enabled false`，重启 CLI（该键在构造期读取一次）。
2. `/compact status` 应显示 `not registered for this session`。
3. 让 Agent 连续读 5 个大文件。

**期望**：每个工具跑完后一秒内，百分比与 `86.0k/200.0k` 都在往上走。
**改动前的症状**：整个回合内纹丝不动，只在每次模型回复结束时跳一格。

---

## ★ 4 — 回合内的工具输出被计入（I-3 的现场验证）

1. 让 Agent 一次性读一个 ≥ 200 KB 的文件。
2. 盯住状态栏。

**期望**：工具卡片settle 之后**大约半秒内**，占用明显跳升（200 KB ≈ 50k token）。
**如果它一直等到模型下一次开口才跳**，说明测量被写在了 `tool_execution_end` 的同步路径
上——那条路径量到的历史里还没有这条结果（spec I-3）。

---

## ★ 5 — 分子与分母的两个标记（P1-5 / P2-7）

1. `aragon config set model <一个不在模型表里的 id>`，或指向一个自定义 `baseUrl`。
2. 启动，随便问一句。

**期望**：绝对值对显示 `.../128k?`（`?` 贴在分母上），百分比按情况带 `~`。
3. `aragon config set contextWindow 1000000`，重启。
**期望**：分母变成 `1.0M`，`?` **消失**；`/context` 的 `Window` 行写明它来自配置覆盖。
4. `aragon config set contextWindow auto`，重启 → 回到 `128k?`。

---

## ★ 6 — 累计读数与成本同口径（P1-3）

1. 在一个会被网关缓存的后端上（或用 Anthropic 直连 + prompt caching 的代理）跑几轮。
2. `/context`。

**期望**：`Session spend` 行的 `1.24M in (incl. 940k cache read, 12k cache write)` 与状态栏
`total` 后的 `↑` 数值一致；且该行明确写着 `includes subagent, fast-tier and compaction
spend, not just this conversation`。
**改动前的症状**：`↑` 明显小于成本所依据的量，且没有任何地方说它混了别的模型。

---

## 7 — 宽度阶梯

依次把终端缩到 110 / 96 / 84 / 72 / 66 / 58 列：

| 列宽 | 期望右簇 |
|---|---|
| ≥ 96 | `[gauge] 43% 86.0k/200.0k total 1.2M↑ 48.0k↓ $3.21` |
| 72–95 | `[gauge] 43% 86.0k/200.0k $3.21` |
| 60–71 | `[gauge] 43% $3.21` |
| < 60 | `43% $3.21` |

左簇 `flexShrink={0}` 的既有保证仍在，但**掉字符本身是既有的降级行为、不是本轮的
回归**：右簇在 `provider:model` 很长（`anthropic:claude-sonnet-4-5`）且列宽恰好卡在
72 时会被 yoga 削掉尾字符，改动前的 `1.2M↑ 48k↓` 占的是同样的列。判据因此是
**「同一模型名下，与改动前的截图相比不更差」**，而不是「任何一档都不掉字符」。

---

## 8 — 颜色阈值与触发阈值一致（P2-6）

1. `/compact threshold 0.6`，`/compact status` 确认 `Triggers at: 60% (amber at 45%)`。
2. 把上下文推到 50% 左右 → 进度条应已变琥珀色（≥ 45%）。
3. 制造一个 summarizer 解析不出来的状态（例如 `fast` 开着但配了一个不存在的模型，
   `/compact status` 显示 `on, but no summarizer model resolves`）。
**期望**：颜色阈值**仍然**是 45 / 60，不回落到 60 / 85。

---

## 9 — `/reset` 与 `/clear` 的区别

1. 跑到 40%。
2. `/clear` → 屏幕清空，**百分比不变**（历史还在）。
3. `/reset` → 百分比掉到接近 0（只剩系统提示词），`total` 累计归零，成本归零。

---

## 10 — 换模型时分母跟着变

1. 在一个 200k 窗口的模型上跑到 `86k/200k`。
2. `/model` 切到一个 128k 窗口的模型。
**期望**：分子基本不变、分母立刻变成 `128k`、百分比相应升高。**不需要**再发一条消息。

---

## 11 — 中断与重试不破坏读数

1. 跑一个长任务，中途 `Esc` 打断。
**期望**：进度条停在最后一次测量值，不清零、不跳变。
2. 再发一条消息续跑 → 读数从那里继续。

---

## 12 — 子 Agent / fast tier 不污染占用

1. `aragon config set team.enabled true`，重启，派一个多子 Agent 的任务。
**期望**：状态栏百分比反映的仍是**主** Agent 的占用（不会因为 5 个子 Agent 而冲到 180%）；
`total` 累计与 `$` **会**包含子 Agent 的花费；`/context` 的那句 `includes subagent...`
解释了这一点。

---

## 13 — 退出摘要与状态栏同口径

1. `aragon config set exitTranscript true`，跑几轮后退出。
**期望**：退出后打印的摘要里的 token 行与退出前状态栏 `total` 的数字一致。

---

## 14 — 未注册压缩的会话形状不变（AC-9 回归护栏）

1. `aragon config set compaction.enabled false`，重启。
2. 与改动前的截图逐字比对状态栏右簇。
**期望**：除新增的 `86k/200k` 与累计读数的门槛/前缀之外，其余**逐字节相同**；
颜色仍走 60/85 默认档。

---

## ★ 15 — `/context` 的五种压缩形态各看一遍（放行条件 4）

**这一条是本轮唯一「新命令有可能直接说假话」的地方**，五个分支逐个跑，只看
`Compaction` 那一行：

| 怎么进入 | 期望文案 |
|---|---|
| `aragon --no-compaction` | `off - not registered for this session (started with --no-compaction)`，**不得**出现 `on` 或 `triggers at` |
| 正常启动 → `/compact off` | `off for this session - /compact on re-enables it` |
| `/compact keep 40` 之类逼出 guard 4 自禁用（`/compact status` 显示 `self-disabled`） | `self-disabled (<reason>) - no compaction will run until /compact on` |
| `fast` 开着但配一个不存在的模型，`/compact status` 显示 `on, but no summarizer model resolves` | `on, but no summarizer model resolves - triggers at 90% (amber at 75%)` |
| 正常会话 | `on - triggers at 90% (amber at 75%), N this session, XXk reclaimed` |

**同时**：第一行的 `aragon --no-compaction` 会话里，喂几个大文件之后
`/context` 的 `Occupancy` 行必须**非零**——它取自 `getContextUsage()`，不是
`offCompactionSnapshot()` 里那份硬编码的零压力。

---

## ★ 16 — `/compact off` 之后颜色回落 60/85（AC-8 后半句）

1. `/compact threshold 0.6`，把上下文推到 50 % 左右 → 进度条应为**琥珀色**
   （45 % 是 `warnThreshold`）。
2. `/compact off`。

**期望**：同一个百分比下颜色**回落到绿色**（默认档 60/85 里 50 % 属低档），
`compact` chip 同时消失。
**为什么两个方向都要看**：只看前半句（阈值跟随配置）时，把谓词错写成
`isCompactionRegistered()` 也全绿——而那个错误谓词会在 `/compact off` 之后
**继续用颜色承诺一次不会来的救援**，比原来的缺陷更坏。

---

## ★ 17 — 一次成功压缩后 `/compact status` 的累计 `reclaimed` 严格增长（I-10）

1. `/compact threshold 0.5`，跑到触发。
2. 压缩发生后立刻 `/compact status`。

**期望**：`This session: 1 compaction ... , XXk tokens reclaimed`，其中 `XXk`
**严格大于 0**；再触发一次后该数字**继续增长**。
**改动前后都可能为真**，所以配合看卡片上的 `NNNk -> MMk tokens` 一行：两者必须
描述同一次压缩，且 `NNN` 是压缩**前**的占用。
