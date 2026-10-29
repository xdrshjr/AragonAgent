/**
 * 附录分组的页面（§2.2）。
 *
 * 两页都是 `prose` 模板：一页把全站反复用到的名词一次性定义清楚（术语表），
 * 一页把「升级会不会让我改代码」这件事说成可核对的承诺（版本与兼容）。
 *
 * 定义的口径是**这个项目的真实含义**，不是通用教科书含义：例如 `event` 指引擎的
 * `AgentEvent`，`ExecEvent` 指 `aragon exec` 写到 stdout 的 JSON 行，两者不能混用。
 */

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'appendix/glossary',
    title: '术语表',
    group: 'appendix',
    order: 10,
    phase: 'B',
    template: 'prose',
    summary:
      '十六个在别处被反复使用、在这里一次性定义清楚的名词：从 agent 循环、工具调用、事件，到 truth set、kit 与会话分支。',
    keywords: ['术语', 'glossary', 'agent loop', 'ExecEvent', 'truth set', 'kit', 'steering'],
    seeAlso: ['start/concepts', 'appendix/compat', 'api/events'],
    sourceRefs: [
      { path: 'packages/core/src/types.ts', lines: '134-147', snippet: 'export type AgentEvent =' },
      {
        path: 'packages/core/src/engine/steering.ts',
        lines: '12-16',
        snippet: 'export interface SteeringMessage {',
      },
      { path: 'packages/cli/src/exec/events.ts', lines: '832-861', snippet: 'export type ExecEvent =' },
      {
        path: 'packages/core/src/engine/agent-loop.ts',
        lines: '410-420',
        snippet: "ctx.emit({ type: 'turn_start' });",
      },
      {
        path: 'packages/core/src/engine/watchdog.ts',
        lines: '1-10',
        snippet: 'IdleWatchdog — fires a callback if no activity occurs within a',
      },
      { path: 'docs/guide-doc/src/extract/sources.mjs', lines: '1-10', snippet: '9 个 truth set 的提取器' },
      { path: 'packages/cli/src/fast/types.ts', lines: '17-30', snippet: 'export type FastTier =' },
      {
        path: 'packages/cli/src/config/model-kits.ts',
        lines: '1-13',
        snippet: 'Agent model kits: a named preset that pins the THREE model roles',
      },
      {
        path: 'packages/core/src/engine/compaction.ts',
        lines: '147',
        snippet: 'export function planCompaction(',
      },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '这份表只有一个目的：把“我们说的是同一个东西”变成可以引用的定义。每一条都对应真实代码里的一个字形，' +
          '括号里的链接指向讲得最细的那一页。如果一个词在这里没有条目，说明它在本项目里**不是术语**，' +
          '不要给它编一个定义。',
      },
      {
        t: 'h2',
        text: '十六个术语',
      },
      {
        t: 'table',
        caption: '按“引擎 → 宿主 → 工程流程”的顺序排列',
        head: ['术语', '一句话定义', '详见'],
        rows: [
          [
            'agent 循环（agent loop）',
            '一次 `prompt()` 内部的循环：发请求 → 消费流 → 执行工具 → 再发请求，直到 `end_turn` 或预算耗尽。工具调用严格串行。',
            '[Agent 与 AgentConfig](/api/agent/)',
          ],
          [
            '回合（turn）',
            '循环里的一次 LLM 请求。`turn_start` 在请求之前、`turn_end` 携带这一回合的 `usage`；回合边界也是压缩检查点所在。',
            '[事件与订阅](/api/events/)',
          ],
          [
            '工具调用（tool call）',
            '模型请求执行某个 `AgentTool` 的一次记录：`toolCallId` + `toolName` + `args`。它的结果必须以 `toolCallId` 配对的 `tool_result` 回填。',
            '[工具定义与执行](/api/tools/)',
          ],
          [
            '工具结果（tool result）',
            '工具返回的 `{ content, isError? }`。**孤儿 `tool_result`**（找不到对应的 `tool_call`）在 Anthropic 上是不可恢复的 400。',
            '[上下文压缩端口](/api/compaction/)',
          ],
          [
            '事件（event）',
            '引擎通过 `Agent.subscribe` 发出的 `AgentEvent`：进程内的类型化回调，12 个成员。',
            '[事件与订阅](/api/events/)',
          ],
          [
            'ExecEvent',
            '`aragon exec` 写到 stdout 的 JSON 行，29 个成员，带 `seq` 与 `schemaVersion`。**永远不是** `AgentEvent` 的成员。',
            '[事件参考](/exec/events/)',
          ],
          [
            'steering',
            '运行中插队的文本：在回合顶部或工具之间被接收并写进历史。接收成功会发 `steering_accepted` 回执（携带宿主的**不透明 ID**）。',
            '[输入、队列与中断](/guide/input-queue/)',
          ],
          [
            'follow-up',
            '低优先级的追加消息：只在 `end_turn` 之后被消费。与 steering 共用一套队列管理器，但优先级不同。',
            '[输入、队列与中断](/guide/input-queue/)',
          ],
          [
            '回执（receipt）',
            '`steering_accepted` 事件携带的那组 ID。它只证明**文本已进入历史**，不证明模型请求成功或回答完成。',
            '[Agent 与 AgentConfig](/api/agent/)',
          ],
          [
            '空闲看门狗（idle watchdog）',
            '`idleTimeout` 内没有任何事件就中止运行的定时器。重试退避、压缩、等人这三类“正当等待”都需要显式暂停它。',
            '[Agent 与 AgentConfig](/api/agent/)',
          ],
          [
            '压缩（compaction）',
            '在回合边界替换历史以腾出上下文：宿主决定阈值与摘要，引擎只负责校验与采纳（无效的替换会被拒绝）。',
            '[上下文与自动压缩](/guide/context/)',
          ],
          [
            '技能（skill）',
            '一份带 frontmatter 的 `SKILL.md` 加可选附带文件。三级渐进加载：目录进系统提示词，正文进 `skill` 工具结果，文件按需读。',
            '[技能](/guide/skills/)',
          ],
          [
            '计划（plan）',
            '只读阶段：可以随便探索，但五个变更类工具在调用时拒绝。它是一个**模式**，不是工具白名单。',
            '[计划模式](/guide/plan-mode/)',
          ],
          [
            'todo',
            '一份带验收标准的待办清单，落盘可恢复；完成前会派生一个“验证”阶段。与 plan 模式无关，两者可以同时开着。',
            '[TODO 与验收标准](/guide/todo/)',
          ],
          [
            '会话分支（session branch）',
            '从一个已有会话的历史继续，但写到一个新的会话 id。原会话不被改写：`--resume` 本身就是「接着往下写，但写进新 id」。要在新终端里同时开着用 `/branch`（`Ctrl+L`）。',
            '[会话、恢复与分支](/guide/sessions/)',
          ],
          [
            '宿主桥（host bridge）',
            '`aragon exec --input-format bridge` 的双向通道：stdout 出事件，stdin 进请求 —— 它是 `stream-json` 加一个请求/响应层。',
            '[宿主桥](/exec/host/)',
          ],
        ],
      },
      {
        t: 'h2',
        text: '三对最容易混的名词',
      },
      {
        t: 'p',
        md:
          '这六个别名式说法在本仓库里都有**唯一定义**，混用会直接导致读错代码或写错文档：',
      },
      {
        t: 'table',
        caption: '左边与右边不是同一层的东西',
        head: ['别混用', '差别'],
        rows: [
          [
            '`AgentEvent` vs `ExecEvent`',
            '前者是进程内回调（12 个成员、无版本号），后者是跨进程 JSON 行（29 个成员、`schemaVersion` 为 1）。一个只能在宿主里用，一个只能被别的进程解析。',
          ],
          [
            'plan vs todo',
            'plan 是“现在只能读”的**权限模式**；todo 是“要做什么、怎样算做完”的**清单**。plan 模式下当然也可以写 todo。',
          ],
          [
            'steering vs follow-up',
            '都是入队，差别是消费时机与优先级：steering 会打断当前推理去接收，follow-up 一定等回合结束。',
          ],
        ],
      },
      {
        t: 'h2',
        text: '三个只在这个项目里有意义的词',
      },
      {
        t: 'p',
        md:
          '下面三个词在别处也能看到，但含义完全不同。在外部分享或写文档时，值得顺手解释一句：',
      },
      {
        t: 'kv',
        items: [
          {
            k: 'truth set',
            v:
              '文档门禁的 9 组“真源”：参数、斜杠命令、工具名、事件、退出码、配置键、导出、版本、数据集。' +
              '每一项都必须能在源码里指出位置 —— 猜出来的项不算，因为无法被指出。',
          },
          {
            k: 'fast tier',
            v:
              '第二个更便宜的模型档（`main` / `fast` 两档，刻意的两档而不是三档）。它跑评审、摘要这类活；解析结果是判别联合而不是可空引用，' +
              '因为界面上必须能说清“为什么这一档没开”。',
          },
          {
            k: 'kit',
            v:
              '一套命名的模型预设，把三个角色（main / fast / subagent）钉到已有的 profile 上。**只存引用、不存副本** —— ' +
              '改 profile 会改变所有引用它的 kit，这正是“预设”应有的语义。',
          },
        ],
      },
      {
        t: 'h2',
        text: '怎么用这张表',
      },
      {
        t: 'ul',
        items: [
          '**写文档时**：一个词在表里，就用表里的定义；不在表里，先确认它是不是真的属于这个项目。',
          '**读代码时**：`AgentEvent` 与 `ExecEvent` 的分界是理解“哪一层在说话”的分界线；`steering` 与 `follow-up` 的分界决定了时序。',
          '**报障时**：说清是引擎侧（`AgentEvent`）还是机器契约侧（`ExecEvent`），能省掉一轮来回 —— 两者的日志位置完全不同。',
        ],
      },
    ],
  },

  {
    id: 'appendix/compat',
    title: '版本与兼容承诺',
    group: 'appendix',
    order: 20,
    phase: 'B',
    template: 'prose',
    summary:
      '两个包的版本各自独立，机器契约只有一个 `schemaVersion`：什么算破坏性变更、哪些升级不用改代码，以及 Node 与 ESM 的硬前提。',
    keywords: ['兼容', '版本', 'schemaVersion', 'EXEC_SCHEMA_VERSION', '破坏性变更', 'Node 18'],
    seeAlso: ['exec/output', 'api/types', 'cli/subcommands'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/events.ts', lines: '33-42', snippet: 'EXEC_SCHEMA_VERSION' },
      {
        path: 'packages/cli/src/exec/stdin-stream.ts',
        lines: '88-94',
        snippet: 'An unknown type is IGNORED, not reported',
      },
      {
        path: 'packages/cli/README.md',
        lines: '139-143',
        snippet: 'Ignore event types you do not know',
      },
      { path: 'packages/core/package.json', lines: '90-95', snippet: '"node": ">=18"' },
      { path: 'packages/core/package.json', lines: '36-40', snippet: '"exports": {' },
      { path: 'packages/core/API.md', lines: '3-11', snippet: 'Three-sync discipline:' },
      { path: 'packages/core/CHANGELOG.md', lines: '29-33', snippet: 'runtime exports' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '兼容承诺可以拆成三件互相独立的事：**包的版本号**（能不能装）、**机器的 `schemaVersion`**（能不能解析）、' +
          '**运行时前提**（装得上跑不跑得起来）。混在一起谈，就会出现“我明明没升级却坏了”这种无解的结论。',
      },
      {
        t: 'h2',
        text: '三个版本，各管一段',
      },
      {
        t: 'table',
        caption: '看版本号之前，先看它是哪一个',
        head: ['版本', '在哪', '变了意味着什么'],
        rows: [
          ['`@aragon-agent/core` 的包版本', '`package.json`', '引擎的公开表面可能变了；冻结清单见 `API.md`'],
          ['`@aragon-agent/cli` 的包版本', '`package.json`', 'TUI 与命令行的行为、配置键、快捷键可能变了'],
          ['`schemaVersion`', '`system` 与 `result` 事件里', '**机器契约**的形状变了 —— 只有改名或删除才会动它'],
        ],
      },
      {
        t: 'p',
        md:
          '两个包独立升版本：`0.x` 阶段不承诺“两边永远同号”，也不承诺它们能任意交叉组合。' +
          '要确认当前装的是什么，用 `aragon --version` 或 `aragon info --json`（后者还会报 `schemaVersion` 与能力列表）。',
      },
      {
        t: 'h2',
        text: '`EXEC_SCHEMA_VERSION`：只出现在两个地方',
      },
      {
        t: 'p',
        md:
          '它出现在 `system` 和 `result` 上，**别处没有**。规则很短：**新增字段或新增事件类型永远不升它；改名或删除才升。**' +
          '这条规则只有在消费者也守约时才有意义，所以 README 用同样的措辞写了一遍：' +
          '**忽略你不认识的事件类型，忽略你不认识的字段。**',
      },
      {
        t: 'table',
        caption: '什么动版本，什么不动',
        head: ['变更', '破坏消费者？', '`schemaVersion`'],
        rows: [
          ['新增一种事件类型', '否（守约的消费者会跳过它）', '不动'],
          ['给已有事件新增可选字段', '否（缺席则该键不存在，不序列化）', '不动'],
          ['给已有事件新增**必填**字段', '是（语义上等于改形状）', '应当升'],
          ['重命名或删除事件 / 字段', '是', '升'],
          ['改变某个字段的**类型**或单位', '是', '升'],
          ['新增命令行参数', '否', '无关'],
          ['删除命令行参数或改默认值', '是（脚本会坏）', '无关'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '双向都要“忽略未知”',
        md:
          '不只 stdout 出的事件要忽略未知类型：stdin 进的指令也一样。一个类型不认识就不要报错 —— 报错会让每一次**加法**' +
          '都变成老版本 CLI 的噪音。例外只有一处：bridge 模式下不认识的 `respondsTo` 必须回一个 `bridge_unknown_request` 错误，' +
          '否则调用方会永远等下去。',
      },
      {
        t: 'h2',
        text: '什么算破坏性变更',
      },
      {
        t: 'p',
        md:
          '按“会不会让一段**正确写的**调用代码突然失败或静默做错事”来判断，而不是按“我改了多少行”：',
      },
      {
        t: 'ul',
        items: [
          '**删除或改名一个运行时值导出。** Core 的运行时表面由 `public-api.test.ts` 冻结，加一个要在三处同步（源码 barrel、测试里的 `EXPECTED`、`API.md`），删一个必须当破坏性变更处理。',
          '**删除或改名一个稳定错误码。** 例如 `SkillValidationIssue.code` 里的 `SKILL_NAME_MISSING` —— 代码是可编程接口，字符串改名等同于改签名。',
          '**让一个工具变成变更类，或改它的参数 schema 的必填项。** 前者会静默改掉权限语义，后者会让已有调用方在运行时被拒。',
          '**删除一个配置键、环境变量或命令行参数。** 脚本与 `config.json` 都会坏；新键可以加，旧键不能无声消失。',
          '**改变 `AgentConfig` 里某个字段的必填性。** 把一个必填字段变可选是兼容的，反过来不是。',
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '哪些“看起来吓人”的变更其实不破坏',
        md:
          '新增事件类型、新增可选字段、新增运行时导出、新增子路径、新增配置键、把某个上限调大 —— 全部是加法。' +
          '前提是消费者守住“忽略未知”的约定；守不住的那一方，会在某次升级里第一次遇到不认识的东西就崩。',
      },
      {
        t: 'h2',
        text: '运行时前提',
      },
      {
        t: 'table',
        caption: '装得上 ≠ 跑得起来',
        head: ['前提', '要求', '不满足时'],
        rows: [
          ['Node', '**>= 18**（两个包的 `engines` 都这么写）', '核心依赖全局 `fetch` / `AbortController`，更低版本直接不可用'],
          ['模块系统', 'Core 是 ESM only（`"type": "module"`）', '`require()` 解析失败；CJS 宿主只能用 `await import()`'],
          ['可选原生依赖', '`ajv`、`isolated-vm`', '缺席时校验退化为内置子集、沙箱子路径 import 即失败'],
          ['解析方式', '`package.json#exports`（七个入口）', '不读 `exports` 的旧 `moduleResolution` 走 `typesVersions`'],
        ],
      },
      {
        t: 'p',
        md:
          '`exports` 里有七个键：根加六个子路径，其中 `./sandbox/*` 是唯一的通配项。删掉任何一个都是破坏性变更 —— ' +
          '哪怕根导出没动，某个消费者的 `import` 也会立刻解析失败。',
      },
      {
        t: 'h2',
        text: '升级前的三个一分钟检查',
      },
      {
        t: 'ol',
        items: [
          '`aragon info --json`：看 `schemaVersion` 与 `features`。**用能力列表判断，不要用版本号比较** —— 能力是声明，版本号只是标签。',
          '读 `CHANGELOG.md` 的 **Breaking** 段（如果有）。没有这一段，通常意味着只有加法。',
          '如果你的消费者自己实现了事件分发：确认它对未知 `type` 有 `default` 分支。没有的话，先加这一条再升级。',
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '别把 `schemaVersion` 当成“功能开关”',
        md:
          '它是**形状**的版本，不是能力的版本。同一个 `schemaVersion: 1` 的两次发布之间可以差着七八种新事件。' +
          '想知道某个能力在不在，看 `system` 事件里的能力字段或 `aragon info --json` 的 `features`，' +
          '然后写好“不支持时怎么办”的分支。',
      },
    ],
  },
];
