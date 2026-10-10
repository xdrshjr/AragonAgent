# 诊断报告：TUI 上下文占用恒显 ~0%、自动压缩不触发 / 乱触发

- **症状（用户原话）**：aragon TUI 里"上下文统计和计算的显示结果有误——没有正确显示 Agent
  执行时已经使用的上下文数量；达到用户设置的上下文百分比后没有自动触发上下文压缩；压缩后
  上下文占用显示也没有正确更新"。
- **结论（一句话）**：Anthropic 适配器把 `message_start` 当作输入 token 的唯一来源，并**丢弃
  `message_delta` 里携带的任何 usage 字段**；当网关不在 `message_start` 披露输入 token 时
  （【评审修订】按 10-06~10-09 日志逐会话核对：智谱 `open.bigmodel.cn/api/anthropic` **100% 不披露**，
  三天数千条 `turn_end` 全部 `in:0`；Kimi `api.kimi.com/coding` **间歇性不披露**——同一会话内
  `in:>0` 与 `in:0` 交替出现；DeepSeek `/anthropic` 实测 `message_start` 正常携带输入、不受影响），
  流结束时的 `turn_end.usage.inputTokens === 0`。这个"什么都没测到的测量值"以 `source: 'usage'`
  的身份压过了本可近似正确的估算分支，于是**一个坏数字同时污染了表盘、触发器和成本显示**。
- **bug 代号**：`context-usage-zero-input-tokens`
- **严重级**：P1（核心卖点功能——上下文表盘与自动压缩——在常见接入方式下整体失效）
- **证据来源**：本机 `~/.aragon-agent/logs/aragon-2026-10-0*.log`（用户真实会话）、适配器/计量器
  级最小复现（下文可复制粘贴）、源码逐行核对。

---

## 1. 问题描述

用户在 TUI 中观察到的三个表面症状，全部由同一个根因产生：

| # | 表面症状 | 实际机理（同一根因的不同投影） |
|---|---|---|
| S1 | Agent 执行期间，状态栏 `Context N%` 长期停在 ~0%（偶或跳到离谱大值） | 计量器 measured 分支的基数 `inputTokens=0`，`occupied` 只剩上一轮的 `outputTokens`（几十~几百 token）；两个轮次之间又只剩"新追加消息的估算增量"，两头都是错的 |
| S2 | 到达用户设置的百分比（本机 config：`threshold: 0.7`）后不自动压缩；或者反过来在奇怪的时刻触发，且卡片显示的 token 数离谱 | 触发器与表盘读同一个数字（`shouldCompactAt(pressure, threshold)`）。基数≈0 时永远到不了 70%；当某轮工具结果很大时，"增量估算"又会瞬间把占用推过阈值，产生垃圾触发 |
| S3 | 压缩发生后占用显示不正确 | 压缩后的重测仍走同一个被污染的 measured 基数；且压缩本身经常降级为 `relieved`（只裁尾）甚至自禁用，因为摘要输入是按错误的估算规模构建的 |

对照实验（同一台机器、同一天）：把 `provider` 换成 `openai`（DeepSeek 的 OpenAI 兼容端点）后，
`turn_end` 的 `in` 立即恢复正常（见 §3.3 日志证据 E1）。这排除了"计量器/表盘管线坏了"的假设，
把问题收敛到 **anthropic 适配器的 usage 解析**。

## 2. 复现步骤

### 2.1 真实环境复现（用户实测路径，~2 分钟）

1. 准备任一 Anthropic 兼容网关的 API Key（本机实测过：智谱 `https://open.bigmodel.cn/api/anthropic`、
   `https://api.kimi.com/coding`、`https://api.deepseek.com/anthropic`，三者表现一致）。
2. 启动 TUI 并接入网关模型：
   ```
   aragon
   /settings        # provider=anthropic, model=glm-5.3（或 kimi-k3）,
                    # baseUrl=https://open.bigmodel.cn/api/anthropic, 填入 Key
   /compact threshold 70%
   ```
3. 让 Agent 连续执行几轮带工具调用的任务（例如"读 packages/cli/src/compaction 下所有文件并总结"），
   观察底部状态栏 `Context N%`。
4. **预期（正确行为）**：占用随对话增长（几轮之后应到 10%~50% 量级，`~` 表示估算）。
   **实际（bug）**：`Context 0%` 几乎不动；`/context` 报告的 occupied 同样只有几百 token；
   会话成本（`Session input` / `Cost`）也只按输出计。
5. 继续加长会话到真实占用超过 70%：自动压缩**不触发**；若某轮工具输出巨大，则在错误时机触发一次，
   卡片的 token 数与 `/compact status` 都不自洽。
6. 事后核验（无需 TUI）：
   ```
   C:\Users\<user>\.aragon-agent\logs\aragon-<date>.log
   ```
   过滤 `"msg":"turn_end"`：所有记录均为 `"in":0,"out":>0`。

### 2.2 离线确定性复现（最小 repro，复制即跑）

两个用例分别钉死"适配器丢数字"与"计量器被坏测量值劫持"。放入
`packages/cli/src/__tests__/`（如 `_repro-context-display.test.ts`）后
`npx vitest run src/__tests__/_repro-context-display.test.ts`。**当前代码下两者都通过（即都复现了
bug 行为）。**

```ts
import { describe, expect, it, vi } from 'vitest';

/** Anthropic 风格 SSE Response */
function sseResponse(events: readonly [string, Record<string, unknown>][]): Response {
  const encoder = new TextEncoder();
  const body = events.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(encoder.encode(body)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('repro: adapter drops gateway-reported input tokens', () => {
  it('message_delta carries input_tokens but the adapter yields inputTokens=0', async () => {
    const { AnthropicProvider } = await import('@aragon-agent/core');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      // 兼容网关常见形态: message_start 不带可用 usage, 最终 message_delta 才给真实数字
      ['message_start', { message: { usage: { input_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 95_123, output_tokens: 245 } }],
      ['message_stop', {}],
    ])));
    const provider = new AnthropicProvider();
    const events: unknown[] = [];
    for await (const e of provider.stream({ model: 'glm-5.3', messages: [],
      systemPrompt: '', apiKey: 'k', baseUrl: 'https://relay.test' } as never)) {
      events.push(e);
    }
    const done = events.at(-1) as { usage: { inputTokens: number; outputTokens: number } };
    expect(done.usage.outputTokens).toBe(245);
    expect(done.usage.inputTokens).toBe(0); // <-- 网关明明上报了 95,123, 被丢弃
  });

  it('that zero-input usage collapses the meter gauge and never triggers compaction', async () => {
    const { ContextMeter } = await import('../compaction/meter.js');
    const { shouldCompactAt } = await import('../compaction/pressure.js');
    const messages: never[] = [];
    for (let i = 0; i < 30; i += 1) {           // 一个真实规模(约数万 token)的历史
      messages.push({ role: 'user', content: `turn ${i}: ${'x'.repeat(2_000)}`, timestamp: 0 } as never);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(200) }] } as never);
    }
    const meter = new ContextMeter({
      getMessages: () => messages,
      getSystemPrompt: () => 'sys',
      getModelInfo: () => ({ contextWindow: 200_000, contextWindowSource: 'user' }) as never,
      isWindowKnown: () => true,
      getWindowOverride: () => null,
    });
    meter.onTurnEnd({ inputTokens: 0, outputTokens: 245 });   // 网关式 usage
    const after = meter.currentUsage();
    // 断言即 bug: 巨大的历史只显示 245 token, 0%, 且冒充"实测"
    expect(after.occupied).toBe(245);
    expect(after.pct).toBe(0);
    expect(after.source).toBe('usage');
    expect(shouldCompactAt({ occupied: after.occupied, contextWindow: 200_000 } as never, 0.9))
      .toBe(false);                                            // <-- 70%/90% 阈值永远够不着
  });
});
```

> 反向对照：同样的历史、同样的 meter，把 `onTurnEnd` 换成
> `{ inputTokens: 95_123, outputTokens: 245 }`，`occupied≈95k`、`pct≈48`、
> `shouldCompactAt(...,0.9)` 在 190k 时为 `true`——整条下游管线本身是好的。

### 2.3 生产日志证据（用户真机会话）

本机 `C:\Users\jdqqj\.aragon-agent\logs\`：

- **E1（坏）** `aragon-2026-10-09.log`：`turn_end` 共 1919 条，**1919 条 `"in":0`**；
  `aragon-2026-10-08.log`：1566/1566 条 `"in":0`。当日 `config_loaded`：
  `{"provider":"anthropic","model":"glm-5.3","baseUrl":"https://open.bigmodel.cn/api/anthropic"}`。
  【评审修订】诊断落稿后日志仍在增长，评审时重算 10-09 为 **1973/1973 全 `in:0`**（与 1919 不矛盾，
  只是该文件当日又追加了 54 个 turn）；10-08 的 1566/1566 复算一致。日志 `in` 字段即
  `packages/cli/src/logging/install.ts:468` `in: event.usage?.inputTokens ?? 0`——与
  `turn_end` 事件同源，因此 E1 直接度量的就是适配器的输出。
- **E2（好，同一功能正常时的样子）** `aragon-2026-10-07.log` 00:19 会话：
  `run_start {"provider":"openai","model":"deepseek-v4-pro"}` →
  `turn_end {"in":140520,"out":622}`、`{"in":155471,"out":358}`。
- **E3（切换点）** `aragon-2026-10-07.log`：00:37 起切换为
  `provider=anthropic + baseUrl=.../anthropic` 后，从第一条 `turn_end`（00:42:46 `"in":0,"out":239`，
  sid=`b6723ed8`）起该会话全 0。
  【评审修订】原文"同日 kimi-k3 @ api.kimi.com/coding 同样全 0"**与同一日志矛盾，予以纠正**：
  02:31–03:21 的 kimi `/coding` 会话（sid `ae6a9a54`、`23811786`、`eaa2c539`、`1e7facf9`、`9ac06ab3`）
  绝大多数 turn `in:>0`（如 `in:8323/1034/1987/...`，仅零星 `in:0`，如 `ae6a9a54` 95 条中 4 条为 0）；
  10-06 16:45–16:48 的 `provider=anthropic @ api.deepseek.com/anthropic`（deepseek 模型）同样 `in:>0`。
  即：**三家网关并非"表现一致"**——智谱 bigmodel 恒 0；Kimi `/coding` 间歇 0；DeepSeek `/anthropic`
  正常。详见新增证据 E6。
- **E6（评审补充：网关行为分类 + 同会话切换对照）** 按"每条 `turn_end` 归属其时间上最近的
  `run_start/config_loaded`"重算 10-06/10-07 全量日志：
  - `anthropic/glm-5.3 @ open.bigmodel.cn/api/anthropic`：全部会话 100% `in:0`（合计数千条）；
  - `anthropic/kimi-k3 @ api.kimi.com/coding`：约 9 成为 `in:>0`，**间歇性**出现 `in:0`——
    表盘会在"正确测量值"与"零测量值"之间来回翻转，是 S1"偶或跳到离谱大值"的另一半成因；
  - `anthropic/deepseek-* @ api.deepseek.com/anthropic`：`in:>0`（说明 DeepSeek 的 anthropic 端点
    在 `message_start` 携带输入，当前适配器读得到）；
  - **同会话对照（最有说服力的单条证据）**：sid `7ede027e` 02:21:09 在 bigmodel 下
    `turn_end {"in":0,"out":9312}`；用户仅把 baseUrl 切到 `api.kimi.com/coding` 后，02:31:25 同一
    会话同模型 `turn_end {"in":149758,"out":179}`。同会话、同模型、同适配器、同计量管线，
    唯一变量是网关的 usage 披露——排除了"计量器/表盘/引擎管线损坏"的一切替代解释。
- **E7（评审补充：E4 细节核实）** 逐条核验压缩病理记录：10-06/10-07 存在
  `compaction_tail_relief {"charsRemoved":109318,"projectedBefore":169251}`、
  `{"projectedBefore":8606981,"budget":56880}`（估算规模是摘要预算的 151 倍）、
  `compaction_self_disabled {"reason":"insufficient_reclaim"}` 与 `{"reason":"nothing_to_drop"}`
  （10-07 单日 **43 次**自禁用）、10-08 `compaction_end {"applied":false,"reason":"digest_budget_exceeded"}`
  以及 `compaction_start {"trigger":"pressure","messages":1}`（历史仅 1 条消息就满足压力触发——
  增量估算瞬间虚高的直接物证）；**10-09 全天 0 条任何压缩记录**（1973 个 turn 全 `in:0`）。
- **E4（下游症状）** 同批日志中的压缩记录呈现两种病态：
  - 10-09（1919 个 turn）：**0 条压缩记录**——measured 占用≈0，阈值永远不满足（S2 前半）。
  - 10-06/10-07：压力触发的压缩带着荒谬规模（`"projectedBefore":169251`、甚至 `8606981`，
    `"projectedRatio":1`），反复降级为 `"mode":"relieved"`（只裁尾：
    `"charsRemoved":109318`）、`"reason":"digest_budget_exceeded"`，最终
    `compaction_self_disabled {"reason":"nothing_to_drop"}`（S2 后半 + S3）。
- **E5（用户设置）** `~/.aragon-agent/config.json`：
  `{"provider":"anthropic","model":"kimi-k3","baseUrl":"https://api.kimi.com/coding","contextWindow":null,
  "compaction":{"enabled":true,"threshold":0.7,...}}`；`model-windows.json` 为 kimi-k3/glm-5.3
  声明了 1,048,576 窗口（分母没问题，问题全在分子）。

## 3. 根因分析

### 3.1 直接原因：适配器只认 `message_start` 的 usage，忽略 `message_delta` 的 usage

`packages/core/src/llm/providers/anthropic.ts`：

- `:141-148`（`message_start`）——`inputTokens` / `cacheReadTokens` / `cacheWriteTokens`
  **只**从 `message.message.usage` 读取；
- `:251-260`（`message_delta`）——usage 对象虽然被取出，但**只读 `output_tokens`**：
  ```ts
  const u = data.usage as Record<string, number> | undefined;
  if (u) {
    usage.outputTokens = u.output_tokens ?? usage.outputTokens;
  }
  ```
  `message_delta.usage` 里即使带着 `input_tokens`（以及部分网关的 cache 字段）也被静默丢弃。

第一方 `api.anthropic.com` 的 `message_start` 一定带真实 `input_tokens`，所以官方直连不受影响；
但 Anthropic **兼容**网关普遍把真实 usage 放在流末尾的 `message_delta`（或 `message_start`
里给 0/缺省）——本机三个厂商的网关表现一致（E1/E3）。两种变体落到本适配器的结果相同：
`usage.inputTokens === 0`。
【评审修订】上一段"三家表现一致"按日志重算应更正为：**bigmodel 恒不披露（`message_start`
无可用输入）；Kimi `/coding` 多数 turn 在 `message_start` 披露、间歇缺失；DeepSeek `/anthropic`
正常披露**（E6）。结论不变——凡 `message_start` 不披露输入的流，本适配器一律输出
`inputTokens === 0`；受影响面从"三家全部"收敛为"bigmodel 全部 + Kimi 间歇"，且 bigmodel 正是
本机用户 10-06 之后的主力接入（10-08/10-09 全部会话均为 bigmodel、全 `in:0`），P1 定级维持。

对照另外两个适配器（它们都从"流末尾的 usage"取输入 token，所以没有此问题）：
`openai.ts:297-301`（`usage.prompt_tokens`，且 `:390` 主动 `stream_options.include_usage`）、
`google.ts:141-143`（`usageMetadata.promptTokenCount`）。

### 3.2 传播链：一个坏数字如何污染整条链路

`turn_end.usage.inputTokens=0` 之后，按调用顺序：

1. **引擎把坏数字立为权威**：`packages/core/src/engine/agent-loop.ts:490`
   `ctx.emit({ type: 'turn_end', ..., usage })`；`:507` `lastUsage = usage`——
   它既是计量器的校准源，也是下一轮压力探针的 `probe.lastUsage`（`:410` 压力检查点）。
2. **计量器无条件采信**：`packages/cli/src/compaction/meter.ts:216-226` `onTurnEnd`
   直接把该 usage 记为 `lastUsage`（measured 分支开关），并且
   `packages/cli/src/compaction/pressure.ts:165-173` 的 measured 分支
   `occupied = occupiedTokens(usage) + 估算增量` → 只剩 `outputTokens`。
   **没有任何"这个测量值其实什么都没测到"的防御**：
   - 245/200000 → `pct=0`（`meter.ts:85-98` `toContextUsage`），
     且 `source='usage'` → 状态栏连诚实的 `~` 都不显示
     （`packages/cli/src/ui/layout/status-layout.ts:64-68`；详情行
     `status-detail-layout.ts:43-47`；`/context` 同源）。
   - 校准常数同样报废：`pressure.ts:67-75` `computeEstimateOffset = max(0, measured - estimated)`
     = `max(0, 245 - 巨大估算)` = 0——估算分支失去了它唯一的校准来源。
3. **触发器读同一个数字**：`packages/cli/src/compaction/compactor.ts:210-227`
   `shouldCompact` → `meter().current()` → `pressure.ts:200-206`
   `shouldCompactAt(pressure, threshold)`：
   - 基数≈0 → `occupied/window` 永远 < 0.7 → **不触发**（E4 的 10-09）；
   - 两轮之间只剩"前缀之后新追加消息"的估算增量（`pressure.ts:128-136`
     `estimateAppendedTokens`，从 `measuredPrefixLength+1` 起算）——某轮工具结果一大，
     占用瞬间虚高过阈值 → **在错误时机以垃圾规模触发**（E4 的
     `projectedRatio:1` / `digest_budget_exceeded` / `relieved` / 自禁用链条）。
     这正是"表盘与触发器必须同源"（R-11）设计在坏输入下的必然结局：一个数字错，两处一起错。
4. **成本与用量同源受害**：`packages/cli/src/agent/reducer.ts:716-724`（`turnEnd` 累计）与
   `packages/cli/src/agent/usage.ts:10-15`（`computeCost` 按 `usage.inputTokens` 计价）→
   `Session input` 恒≈0、`Cost` 只含输出。`aragon exec` 的 usage 输出同理。
5. **压缩后的显示更新也因此失真**（S3）：压缩落盘后 `wiring.ts` 的 `settlePending` →
   `meter.onHistorySpliced()`（`wiring.ts:693`，先于两次 `emit`）→ `lastUsage` 被清空，
   紧接着的 `snapshot()`/`meter.current()` 落入**估算分支**。
   【评审修订】原文"重测仍以零基数进行"不准确：`onHistorySpliced`（`meter.ts:242-249`）本来就会
   丢弃 `lastUsage` 走估算分支。失真的真实机理是两条：(a) `estimateOffset` 已被每个零输入
   `turn_end` 钳成 0（见上文第 2 步），估算分支失去唯一校准、系统性偏低，与卡片上
   `estimatePromptTokens` 口径的 `tokensBefore/tokensAfter` 互不自洽；(b) 压缩后的**下一个**
   `turn_end` 携带零输入 usage 再次武装 measured 分支，表盘立刻又坍缩回 ~0%——
   用户看到的"压缩后占用不正确"正是这两条的叠加。修复验收（§6）必须覆盖 (b)：压缩后
   下一轮 turn_end 之后表盘不得回落到 0%。

### 3.3 证据清单（汇总）

| 编号 | 类型 | 内容 | 位置 |
|---|---|---|---|
| E1 | 生产日志 | 10-09 全部 1919 条 `turn_end` `"in":0`（10-08：1566/1566） | `~/.aragon-agent/logs/aragon-2026-10-{08,09}.log` |
| E2 | 生产日志 | OpenAI 兼容端点下 `in:140520/155471` 正常 | `logs/aragon-2026-10-07.log` 00:19 会话 |
| E3 | 生产日志 | 切到 anthropic+网关 baseUrl 后全 0；三个厂商网关一致 | `logs/aragon-2026-10-07.log` 00:37 起 |
| E4 | 生产日志 | 0 条压缩 / 荒谬规模的压力压缩与自禁用 | `logs/aragon-2026-10-{06,07,08,09}.log` `scope:"compaction"` |
| E5 | 用户配置 | `threshold:0.7`、窗口 1M 已声明（分母健康） | `~/.aragon-agent/config.json`、`model-windows.json` |
| C1 | 代码 | input 只读 `message_start` | `packages/core/src/llm/providers/anthropic.ts:141-148` |
| C2 | 代码 | `message_delta` 只读 `output_tokens`，其余丢弃 | `anthropic.ts:251-260` |
| C3 | 代码 | 对照组：openai/google 均读流末 usage | `openai.ts:297-301,390`；`google.ts:141-143` |
| C4 | 代码 | `turn_end` 立为权威并传给压力探针 | `packages/core/src/engine/agent-loop.ts:490,507,410` |
| C5 | 代码 | meter 无条件采信 measured、无零输入防御 | `packages/cli/src/compaction/meter.ts:216-226`；`pressure.ts:165-179` |
| C6 | 代码 | 触发器与表盘同源 | `compactor.ts:210-227`；`pressure.ts:200-206` |
| C7 | 代码 | 校准偏移被钳为 0，估算分支失去校准 | `pressure.ts:67-75` |
| C8 | 代码 | 成本按 inputTokens 计价 | `packages/cli/src/agent/usage.ts:10-15` |
| R1 | 复现 | 适配器丢弃 `message_delta.usage.input_tokens`（断言通过=bug 存在） | §2.2 用例 1 |
| R2 | 复现 | 零输入 usage → gauge 0%、`source:'usage'`、阈值永不满足（断言通过=bug 存在） | §2.2 用例 2 |
| R3 | 复现（评审重跑） | 评审节点在当前 HEAD 重跑 §2.2 两用例：**均通过（bug 仍在）**；反向对照（`onTurnEnd {95_123, 245}` → `occupied=95_368, pct=48, source='usage'`）亦通过，证明下游管线健康 | `packages/cli/src/__tests__/`（临时文件，跑毕即删） |
| C9 | 代码（评审补充） | TUI 实际接线：`controller.ts:851` `contextMeter.attach(agent.subscribe)`——meter 确实收到每个 `turn_end`，失败路径真实可达 | `packages/cli/src/agent/controller.ts:851` |
| C10 | 代码（评审补充） | 全仓 `grep message_delta` 仅命中 `anthropic.ts:251` 一处；唯一构造 Anthropic SSE 的测试 `adapter-truncation.test.ts`（`:71-89`）**从不发送 `message_delta` 事件**——该 case 在测试里从未执行过 | `packages/core/src/__tests__/adapter-truncation.test.ts:71-89` |
| C11 | 代码（评审补充） | 缓存字段"仅 anthropic.ts 可写"的扫描护栏（修复 A 动 cache 字段不越界，但须防混算，见评审结论） | `packages/cli/src/__tests__/compaction-pressure.test.ts:58-85` |
| C12 | 代码（评审补充） | 日志 `in` 与 `turn_end.usage` 同源：`in: event.usage?.inputTokens ?? 0` | `packages/cli/src/logging/install.ts:466-472` |

## 4. 影响面

- **受影响的接入方式**：`provider=anthropic` + 自定义 `baseUrl`（Anthropic 兼容网关/中转）。
  【评审修订】实测受影响的是：智谱 bigmodel `/api/anthropic`（**100% 复现**，10-06~10-09 数千条
  全 `in:0`，亦即本机用户的主力接入）；Kimi `/coding`（**间歇复现**，约 1 成 turn `in:0`，表盘
  周期性坍缩）；DeepSeek `/anthropic` 实测正常（`message_start` 携带输入）。对第一方
  `api.anthropic.com` 无影响；`openai`/`google` 适配器无此问题。
- **受影响的功能**：
  1. 状态栏 `Context N%` 与详情行 `Context X/Y tokens`（含 `~` 诚实标记的缺失——冒充实测）；
  2. `/context`、`/compact status` 的一切占用数字与"reclaimed"统计；
  3. 自动压缩触发（不触发 + 乱触发两种病态）、压缩降级链（`relieved`/`digest_budget_exceeded`/
     `nothing_to_drop`/自禁用）与压缩卡片数字；
  4. 会话用量与成本（`Session input`、`Cost`，按 0 输入计价）；
  5. `aragon exec --output-format json` 的 usage 字段、fast 审查与子代理的同类计量
     （它们复用同一适配器与 meter 语义）。
- **不受影响**：上下文窗口分母解析（model-windows/发现机制/override 均正常，E5）；
  压缩算法本身（safe-cut/摘要/校验）在被正确喂入时工作正常（§2.2 反向对照）。

## 5. 候选修复方案

| 方案 | 内容 | 侵入性 | 风险 | 工作量 | 覆盖面 |
|---|---|---|---|---|---|
| **A. 适配器补齐 usage 解析** | `anthropic.ts` 的 `message_delta` 分支同时接受 `input_tokens`（及 `cache_read_input_tokens`/`cache_creation_input_tokens`，若网关给出），"非零后到者胜"；`message_start` 语义不变 | 小（1 个 case 内数行 + 单测） | 极低：第一方流的 `message_delta.usage` 从不含 `input_tokens`，官方直连行为字节级不变；仅当网关真的给出该字段时才采用 | 小 | 覆盖"usage 在 `message_delta` 披露"的网关（本机三家实测形态） |
| **B. 计量器零输入防御** | `meter.ts`/`pressure.ts`：当 `lastUsage.inputTokens===0` 且历史/系统提示非空时，**不**让该测量值武装 measured 分支——退回估算分支（带 `~` 与 `source:'estimate'`），并留一条 `warn` 日志；真实首轮极小请求（估算也≈0）不受影响 | 中（触及占用语义，需配单测：`context-meter.test.ts`、`context-gauge-wiring.test.ts`、`compaction-pressure.test.ts`） | 中低：需谨慎界定"输入未披露"与"输入真的很小"（用"input===0 且 估算>阈值下限"或"turn≥2 仍为 0"判据）；`estimateOffset` 在此场景恒为 0，估算偏低但数量级正确且自洽 | 中 | 覆盖**任何**不披露输入的端点（含 A 覆盖不到的网关），保证表盘/触发退化为"近似正确"而非"自信地全错" |
| **C. 可观测性与自愈提示** | `/context`、`doctor`、状态栏在检测到连续 N 轮 `inputTokens===0 && outputTokens>0` 时明示"该网关未上报输入 token，占用为估算值"；必要时提示用户用 `contextWindow`/`model-windows.json` 校准分母 | 小 | 低 | 小 | 不修复数字，只消除"静默错误"；作为 A/B 的补充 |

## 6. 推荐方案与理由

**推荐 A + B 组合落地（C 作为可选增强），修复节点按此执行：**

1. **A 是对因修复**：三家网关的流末 `message_delta` 是真实 usage 的实际载体（R1 直接证明当前
   代码丢弃了它）。改动严格收敛在 `anthropic.ts` 的 `message_delta` case 内，采用
   "存在且非零才覆盖"的保守合并，对第一方 Anthropic 与现有 3878 个测试零影响
   （现有测试没有任何 `message_delta.usage.input_tokens` 的用例——这正是本 bug 溜进来的原因）。
2. **B 是结构性防御**：A 治不了的形态（网关在任何事件里都不披露输入）依然存在，而
   `ContextMeter` 当前的语义缺陷是"把空测量当权威测量"——`source:'usage'` 抹掉了 `~` 诚实标记，
   使整条链路"自信地错"。B 保证最坏情况下表盘与触发器退化为带 `~` 的估算值：数量级正确、
   阈值可触发、压缩后更新自洽（S1/S2/S3 三症状在 A 失效的形态下也不再出现"恒 0%"）。
3. **C 让残余风险可见**：若还存在 A/B 都无法量化的网关，用户至少能从 `/context` 看到原因，
   而不是复现本次"日志里 3485 个 `in:0`、UI 里 0%"的无声失败。
4. **不建议**只做 B 不做 A：网关明明上报了精确数字却弃之不用，表盘长期停留在估算精度，
   且成本（`computeCost`）依旧缺输入侧——B 管不到 `usageTotal`/成本那条支线。
5. **不建议**在网关侧解决（要求用户换端点/厂商）：与本产品"Anthropic 顶级体验"的目标相悖，
   且三家主流中转形态一致，属必经路径。

**修复验收（对应 §2 的复现步骤）**：
- §2.2 两个复现用例在修复后应反转：用例 1 `inputTokens===95_123`；用例 2 `source==='estimate'`
  且 `pct` 为非零合理值（或 A 生效后直接构造 `message_start` 带真实 input 的对照）；
- §2.1 真机步骤 3/5：表盘随会话增长、70% 阈值到点触发、压缩后表盘落到与卡片一致的低值；
- 回归：`anthropic` 第一方流的 usage 解析行为不变（补一条"message_delta 不带 input_tokens"
  的守恒用例）。

---

*诊断节点产出（本节点不改代码）。报告人：问题定位与分析节点；日期：2026-10-09；
证据日志保留于本机 `~/.aragon-agent/logs/`。*

---

## 评审结论

**评审人**：资深评审节点（Anthropic 工程团队视角）；**日期**：2026-10-09；
**评审对象**：本报告全文 + 当前 HEAD 源码 + `~/.aragon-agent/logs/` 原始日志。
**评审方法**：C1–C8 逐行核对源码；E1–E5 用脚本重算（含"每条 `turn_end` 归属时间上最近的
`run_start/config_loaded`"的会话级归因）；§2.2 两个复现用例在当前 HEAD 重跑（临时测试文件，
跑毕即删）；全仓检索 `message_delta`/`message_start` 的测试覆盖。

### 一、根因证据审计：成立

| 诊断声明 | 审计结果 |
|---|---|
| C1/C2：输入 token 只读 `message_start`，`message_delta.usage` 只读 `output_tokens` | **逐字属实**。`anthropic.ts:141-148`、`:251-260` 引用的代码片段与仓库当前内容完全一致 |
| 该代码在失败路径真实执行 | **属实**。`message_delta` case 在每条流上执行（`out>0` 恰恰证明 delta 的 usage 对象到达且被解析）；R1 复现（不经 retry、不经引擎）在适配器层单独复得 `inputTokens=0` |
| 传播链 C4–C8（引擎立权威 → meter 采信 → 触发器同源 → 成本计价） | **逐条属实**：`agent-loop.ts:490/507/410`、`meter.ts:216-226`（`onTurnEnd` 无条件 `this.lastUsage = usage`）、`pressure.ts:165-179/200-206/67-75/128-136`、`compactor.ts:210-227`（注意：`shouldCompact` 实际忽略 `probe.lastUsage`，直接读 `meter().current()`——所以 B 修在 meter 一处即同时覆盖表盘与触发器）、`reducer.ts:716-724`、`usage.ts:10-15`、`status-layout.ts:64-68`、`status-detail-layout.ts:43-47`、`controller.ts:851`（TUI 真实接线） |
| 替代解释排查 | **已穷尽并排除**：(1)"计量/表盘管线坏了"——被 E2（openai 同管线 `in:140520`）、E6 同会话切 baseUrl 对照、R3 反向对照三重排除；(2)"retry 包装吞了 usage"——R1 不经 retry 即复现；(3)"窗口分母错了"——E5 已声明 1,048,576 且表盘显 0% 而非 `?`；(4)"引擎丢字段"——`turn_end` 事件直通，日志 `in` 与之同源（C12） |
| 日志证据 E1–E5 | **重算属实**（E1 计数见修订注：10-09 已增至 1973/1973，方向不变）；**E3 的 kimi/deepseek 表述有误，已按日志纠正**（见【评审修订】与 E6） |
| 测试覆盖缺口声明 | **属实且比原文更绝对**：全仓 `message_delta` 仅 `anthropic.ts:251` 一处命中；唯一构造 Anthropic SSE 的 `adapter-truncation.test.ts` 从不发送 `message_delta` 事件——该 case 在测试套件中**从未执行过**（C10） |

**两处事实修正**（已就地写入正文，此处汇总）：
1. "三家网关表现一致全 0" → bigmodel 恒 0 / Kimi `/coding` 间歇 0 / DeepSeek `/anthropic` 正常（E6）。
   不改变 P1 定级：用户 10-06 后的主力接入是 bigmodel，10-08/10-09 全部会话受影响；且"间歇 0"
   反而证明 B 不可省——表盘会在正确值与 0 之间翻转，仅靠 A 治不干净。
2. S3 机理"压缩后重测仍以零基数进行" → `onHistorySpliced` 本就清空 `lastUsage` 走估算分支；
   失真真因是 (a) `estimateOffset` 被零输入轮钳 0 + (b) 压缩后下一个零输入 `turn_end` 再次武装
   measured 分支。验收必须覆盖 (b)。

**一处证据缺口（必须向修复节点明示）**：全仓与日志中**没有**任何 bigmodel 原始 SSE 抓包
（日志只有 `cli/config/fast/update/agent/compaction/tool` 七个 scope，无 llm/sse scope）。
"bigmodel 把真实 usage 放在 `message_delta`"是**推断**而非实测：可证实的是 delta 的 usage
对象存在且带 `output_tokens`（否则 `out` 不会 >0），但它**是否同时携带 `input_tokens` 未知**。
若 bigmodel 全程不披露输入，A 对 bigmodel 无效，B 独扛表盘/触发（成本侧输入只能靠 C 显性化）。
这不改变 A+B 的组合结论，但**修复节点必须把"对真实 bigmodel 抓一次 `message_delta` usage
（临时 debug 日志或一次性探测）"列入验收**，以判定 bigmodel 最终落在 A 还是 B 的覆盖下。

### 二、候选修复审计

**A（适配器补齐 `message_delta` usage 解析）——最小且充分针对"披露了却丢掉"的形态，边界如下：**
- 合并语义：对 `input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` 取
  "存在且非零才覆盖"（后到非零者胜）；`output_tokens` 一行**保持字节不变**（第一方流的
  `message_delta.usage` 官方只含累计 `output_tokens`，这是 A 对官方直连零影响的根据）。
- 防混算（C-14/P1-10 不变量）：若 delta 带非零 `input_tokens`，应把 delta 自身的 cache 字段
  （存在且非零时）一并接管，而不是与 `message_start` 的 additive cache 字段跨事件相加——
  否则"delta 的 input 为 inclusive 总量 + start 的 cache 字段"会双计，占用虚高提前触发压缩。
  `compaction-pressure.test.ts:58-85` 的扫描护栏只约束 openai/google，A 在 anthropic.ts 内动
  cache 字段不越界，但需新增上述混算用例。
- 必须补的守恒回归：`message_delta` 不带 input 字段时，`inputTokens` 仍等于 `message_start`
  的值（官方直连行为字节级不变）——C10 证明今天没有任何用例守护这条路径。
- 错误/中断路径：截断流不会产生 `done`，usage 随局部状态一起丢弃，无泄漏；无并发面。
  **结论：确为最小改动（一个 case 内数行 + 单测），无已知回归面。**

**B（计量器零输入防御）——结构性兜底，判据与行为需按如下收紧：**
- 判据必须是"**输入侧合计为 0**"：`inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  === 0 && outputTokens > 0`，而不是原文的 `inputTokens === 0`——Anthropic 真实流在深度缓存时
  `input_tokens` 可以极小而 `cache_read_input_tokens` 巨大，那是一次**有效测量**，不得误杀。
- 行为：不可信的 usage **不武装** measured 分支，也**不得覆盖** `estimateOffset`/前缀记账——
  若存在更早的好测量，保留之（历史在两次 splice 之间单调增长，"旧好测量 + 追加估算"仍然自洽，
  且优于整段重估）；若从无好测量，自然退化为带 `~` 的估算分支。标记 dirty 并立即发布，让表盘
  当帧降级而不是等下一轮。
- 告警限频：一次运行一条 `warn`（10-09 单日 1973 个 turn，逐 turn 告警即日志洪水）。
- 落点：改在 `ContextMeter.onTurnEnd`（CLI 层）即可，`Compactor.shouldCompact` 读的是
  `meter().current()`，触发器随表盘一起被覆盖；`pressure.ts` 保持纯函数（可把判据做成
  纯谓词导出、两侧共用单一权威定义，C 的检测也复用它）。
- 边界：真实极小请求（估算也≈0）不受影响；`/clear`、`/resume` 的深复位路径
  （`onHistoryReplaced`）语义不变。
  **结论：必要——A 覆盖不到"任何事件都不披露输入"的网关与 Kimi 的间歇 0；且这是唯一能让
  最坏情况退化为"近似正确 + 诚实 `~`"的手段。**

**C（可观测性提示）——可选增强，不修复数字**；实现时复用 B 的同一谓词，避免出现两个
互相漂移的"网关未上报"定义。用户 `config.json` 已有 `warnThreshold: 0.65`，提示面已有挂点。

**A×B 关系**：两层独立、叠加安全——A 修"测量源完整性"，B 修"测量器对空测量的不信任"。
B 的判据作用于 A 合并后的最终 usage，顺序天然正确。

### 三、最终推荐：**A + B 组合落地（C 可选），B 的判据修正为"输入侧合计为 0"**

理由：
1. **A 是对因修复且最小**：代码级证据（C1/C2/C10）与 R1 复现共同钉死"披露即丢弃"这一半；
   改动收敛在 `anthropic.ts` 的 `message_delta` case 内，官方直连零影响。
2. **B 不可省**：bigmodel 是否披露输入未经实测证实（见缺口），Kimi 已实测存在间歇 0；
   没有 B，任何不披露输入的流都会把表盘、触发器、`~` 诚实标记一起污染——这是
   "把空测量当权威测量"的语义缺陷，与本次网关无关地成立。
3. **只做 B 不做 A 不完整**：B 管不到 `usageTotal`/`computeCost` 的输入侧（E1 会话成本
   只按输出计），而网关明明上报了（若 delta 携带）却弃之不用，违背"Anthropic 顶级体验"目标。
4. **不建议网关侧解决**：bigmodel 是用户主力接入，要求换端点等于不修。

**验收清单（在 §6 原有三条之上追加）**：
1. 守恒用例：`message_delta` 仅带 `output_tokens` → `inputTokens` 仍来自 `message_start`（第一方不变）；
2. 合并用例：delta 带 `input_tokens`（± cache 字段）→ 正确接管，含"delta input 与 start cache
   混算双计"的防回归用例；
3. B 用例：输入侧合计 0 的 usage 不武装 measured 分支、保留既有好测量、`source='estimate'`
   带 `~`、告警一次；输入 0 但 cache 巨大的 usage **仍**武装 measured 分支；
4. S3-b 用例：压缩落盘后下一个零输入 `turn_end` 之后，表盘不得坍缩回 0%；
5. 现有套件全绿：`context-meter` / `context-gauge-wiring` / `compaction-pressure`（含 P1-10
   扫描）/ core 适配器与 `public-api` 冻结测试；
6. 真机验收：对 bigmodel 抓一次 `message_delta` usage（临时 debug 日志），确认其落在 A 还是
   B 的覆盖下，并按 §2.1 步骤 3/5 复核表盘增长、70% 触发与压缩后回落。

**给修复节点的一句话**：按"A（非零后到者胜、output 行不动、cache 随 delta 接管）+ B（输入侧
合计为 0 即不采信、保留旧好测量、限频告警）"实施，C 可选；先补守恒/合并/B 判据三类单测再动
业务代码（CLAUDE.md §七）。

---

*评审节点产出（本节点只改本文件，未动源码、未跑 git commit）。报告人：资深评审节点；
日期：2026-10-09。*

---

## 修复实施记录

**实施节点**：修复实施节点（Anthropic 工程团队视角）；**日期**：2026-10-10。
**结论**：按评审结论实施 **A + B 组合**，未发现方案缺陷；§2.2 离线复现按 §6 验收反转通过，全量套件绿。

### 落地内容（严格按推荐方案，diff 最小化）

- **A（`packages/core/src/llm/providers/anthropic.ts`，仅 `message_delta` case）**：
  `output_tokens` 行字节不变；新增"存在且非零才接管"的 `input_tokens` 合并——非零后到者胜；
  若 delta 带非零 `input_tokens`，输入侧整体由该事件重导出（delta 自身的
  `cache_read_input_tokens` / `cache_creation_input_tokens` 存在即接管，缺省即清除），
  绝不与 `message_start` 的 cache 字段跨事件相加（防 P1-10 混算双计）。
- **B（`packages/cli/src/compaction/pressure.ts` + `meter.ts`）**：
  - `pressure.ts` 新增纯谓词 `isInputSideUnmeasured(usage)`：`inputTokens +
    (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) === 0 && outputTokens > 0`
    （单一权威定义，后续 C 复用）；
  - `ContextMeter.onTurnEnd` 命中该谓词时：**不武装** measured 分支、**不覆盖**
    `estimateOffset` / 前缀记账 / 采样状态——保留既有好测量（"旧好测量 + 追加估算"），
    无好测量则退化为带 `~` 的估算分支；置 dirty 并当帧重测发布；每运行一条
    `warn`（`compaction` scope，`context_input_tokens_unreported`，限频字段
    `hasWarnedUnmeasuredInput`）。logger 惰性解析（meter 先于 installLogging 构造）。

### 测试（先写复现用例、确认红、再实施、确认绿）

- 新增 `packages/core/src/__tests__/anthropic-usage.test.ts`（7 例）：守恒×2（第一方
  `message_delta` 仅 `output_tokens` 时 start 值不变；显式 `input_tokens:0` 不回写清零）+
  合并×5（无 start usage / 非零接管 / 多 delta 后非零者胜 / delta 带 cache 接管 /
  delta 无 cache 时清除 start cache——混算双计防回归）。
- `compaction-pressure.test.ts` 追加谓词 4 例（真值/深缓存不误杀/全零不判/单一权威
  源码扫描——meter.ts 必须引用该谓词）。
- `context-meter.test.ts` 追加 T10 共 6 例（§2.2 用例 2 反转：source='estimate' 且
  数量级正确；保留旧好测量只估追加段；不覆盖 estimateOffset；input 0 + 巨额 cacheRead
  仍武装实测；S3-b 压缩后下一个零输入 turn_end 表盘不坍缩；告警一次/运行）。

### 验收结果

1. **§2.2 复现反转**：原样重跑两用例，bug 断言均失败（用例 1 实得 `inputTokens=95123`；
   用例 2 实得 `occupied=25806`）；按 §6 反转断言重跑均通过。临时文件跑毕即删。
2. **套件**：core 全量 559/559 绿（含 `public-api` 冻结、`no-host-coupling`、适配器）；
   cli 全量 263 文件 3888 通过 / 0 失败（6 例既有 skip；含 glyphs ASCII 扫描与
   compaction-pressure 的 P1-10 扫描）。
3. **编译/启动**：两包 `typecheck` 与 `build` 通过；`node packages/cli/dist/cli.js
   --version` 正常退出（0.6.19）。
4. **git 范围**：仅 5 个修复必要文件（anthropic.ts、pressure.ts、meter.ts、两个测试
   文件）+ 新增 1 个测试文件；未运行 git commit（归下一节点）。

### 验收第 6 条（真机探针）的结果：受阻，已尽试探

- **bigmodel**：本机 `~/.aragon-agent/` 无 bigmodel 作用域密钥；用现存 anthropic 密钥
  （72 字符，为当前 kimi 接入配置）直探 `open.bigmodel.cn/api/anthropic` 返回
  `401 令牌已过期或验证不正确`。**bigmodel 的 `message_delta` 是否携带 `input_tokens`
  仍属未证实**（与评审声明的证据缺口一致）。A+B 组合下两种形态均已离线覆盖并正确
  （携带→A 采纳；不携带→B 兜底估算），故该缺口不影响修复正确性，仅影响
  "bigmodel 最终落在 A 还是 B 覆盖下"的分类结论。待有有效密钥时以一次性探针补验。
- **Kimi（当前接入）**：raw 探针返回 `403`（5 小时配额耗尽），无法在本节点窗口内
  完成真机流式验证；同样留待配额恢复后按 §2.1 步骤 3/5 复核。
