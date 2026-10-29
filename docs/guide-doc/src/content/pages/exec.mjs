/**
 * 机器契约分组（`exec`）的页面。
 *
 * `aragon exec` 是本站最"可编程"的一页：参数、事件、退出码都来自数据集，
 * 因此「文档说的事件」与「源码发出的事件」在同一个数组里（§5.3）。
 */

import { execFlags } from '../data/exec-flags.mjs';
import { execEvents } from '../data/exec-events.mjs';
import { exitCodes } from '../data/exit-codes.mjs';

/**
 * 按 `group` 字段把参数记录分桶。
 *
 * @param {object[]} records 参数记录
 * @returns {Map<string, object[]>} 分组
 */
function groupFlags(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.group)) groups.set(record.group, []);
    groups.get(record.group).push(record);
  }
  return groups;
}

/**
 * 参数表 block。
 *
 * @param {string} title 组标题
 * @param {object[]} records 参数记录
 * @returns {object} table block
 */
function flagTable(title, records) {
  return {
    t: 'table',
    caption: `${title}（${records.length} 条）`,
    head: ['参数', '取值', '默认', '说明（源码原文）', '依据'],
    rows: records.map((record) => [
      `\`${record.flag}\``,
      record.arg ? `\`${record.arg}\`` : '—',
      record.default,
      record.desc,
      `\`${record.source.path}:${record.source.lines}\``,
    ]),
  };
}

/** exec 参数按语义分 9 组。 */
const flagGroups = groupFlags(execFlags);

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'exec/overview',
    title: '概览与 60 秒上手',
    group: 'exec',
    order: 10,
    phase: 'A',
    template: 'steps',
    summary:
      '`aragon exec` 把一次代理运行变成可解析的数据流：一条命令、一个 stdin 请求、一串事件、一个退出码，没有任何交互界面。',
    keywords: ['exec', 'headless', '机器契约', 'stream-json', 'stdin', '自动化'],
    seeAlso: ['exec/flags', 'exec/output', 'exec/events', 'exec/budgets'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/index.ts', lines: '1040-1060', snippet: 'exitCode: 2' },
      { path: 'packages/cli/src/exec/options.ts', lines: '229-231', snippet: 'stream-json' },
      { path: 'packages/cli/README.md', lines: '148-200', snippet: 'exec' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '`aragon exec` 与 TUI 共用同一个引擎，但**没有界面**：它读一个请求、往外写事件、用一个退出码收尾。' +
          '所有"用户在界面上看到的东西"在这里都变成了数据，所以它适合被脚本、CI 和别的程序调用。',
      },
      {
        t: 'h2',
        text: '三件事就够了',
      },
      {
        t: 'steps',
        items: [
          {
            title: '跑一次最简调用',
            md: '不指定任何格式时输出人类可读文本；退出码 0 表示成功。验证方式：看 `echo $?`。',
            code: { lang: 'bash', code: 'aragon exec "用一句话解释这个仓库做了什么"' },
          },
          {
            title: '换成机器可读',
            md:
              '`--output-format stream-json` 逐行输出事件（每行一个 JSON 对象）；`--output-format json` ' +
              '只在结束时输出一个 `result`。验证方式：把输出喂给 `node -e "..."` 或 `jq`。',
            code: {
              lang: 'bash',
              code: 'aragon exec --output-format stream-json "列出 src 下的入口文件" > events.jsonl',
            },
          },
          {
            title: '按退出码分支',
            md:
              '`0` 成功、`1` 代理错误、`2` 用法/会话错误（stdout 为空）、`3` 预算命中。验证方式：' +
              '把 `--max-turns 1` 加到长任务上，应当看到 `3`。',
            code: { lang: 'bash', code: 'aragon exec --max-turns 1 "重构整个项目" ; echo "exit=$?"' },
          },
        ],
      },
      {
        t: 'h2',
        text: '请求从哪来',
      },
      {
        t: 'p',
        md:
          '最常用的是把提示词当**位置参数**。需要结构化输入时（多轮、带工具结果、带附件）改用 `--input-format stream-json`，' +
          '从 stdin 逐行读请求 —— 这也是宿主桥（bridge）的入口。',
      },
      {
        t: 'kv',
        items: [
          { k: '位置参数', v: '一个字符串，就是这一轮的用户输入' },
          { k: '`--prompt-file <path>`', v: '从文件读提示词，避免 shell 转义问题' },
          { k: '`--input-format stream-json`', v: '从 stdin 读结构化请求（多轮/续接/工具结果）' },
          { k: '`--append-system-prompt <text>`', v: '在系统提示词末尾追加一段约束' },
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么它和 TUI 不一样',
        md:
          'TUI 的渲染、按键、抽屉在这里都不存在；反过来 `exec` 有 `--output-format`、`--input-format`、' +
          '`--result-schema` 这类只有机器才关心的参数。两边能力同源（同一个 Agent 引擎），只是出口不同。',
      },
    ],
  },

  {
    id: 'exec/flags',
    title: '参数参考',
    group: 'exec',
    order: 20,
    phase: 'A',
    template: 'flags',
    summary:
      '`aragon exec` 的全部 29 条参数，按 9 组排列：输出与输入格式、提示词、会话、预算与停止条件、权限、超时、结果契约、线程、Hooks。',
    keywords: ['exec flags', 'exec 参数', '--output-format', '--max-turns', '--result-schema', '--allow-tool'],
    seeAlso: ['exec/overview', 'exec/output', 'cli/global-flags'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/cli-commands.ts', lines: '1-80', snippet: '.option(' },
      { path: 'packages/cli/README.md', lines: '148-350', snippet: 'exec' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '下表的 29 条参数由 `exec/cli-commands.ts` 的声明逐条提取，第 4 列是源码原文。' +
          '`--no-*` 已与同作用域的正名合并（默认值列写 `开/关`）。',
      },
      ...renderFlagSections(flagGroups),
      {
        t: 'h2',
        text: '三组最常用的组合',
      },
      {
        t: 'steps',
        items: [
          {
            title: 'CI 里跑一次只读分析',
            md: '`--allow-tool` 限定能力、`--max-turns` 兜住预算、`--output-format json` 拿一个可解析结果。',
            code: {
              lang: 'bash',
              code:
                'aragon exec --output-format json \\\n' +
                '  --allow-tool read_file --allow-tool grep \\\n' +
                '  --max-turns 12 "找出未使用的导出"',
            },
          },
          {
            title: '带结构化结果的调用',
            md: '`--result-schema` 会让会话注册 `submit_result` 工具，模型必须调用它才结束。',
            code: {
              lang: 'bash',
              code: 'aragon exec --result-schema .aragon/result.schema.json "评估这次改动"',
            },
          },
          {
            title: '长任务放进线程',
            md: '`--threads` 与 `--max-open-threads` 让多个 exec 运行共享一个会话空间，`--thread-concurrency` 控制并发。',
            code: { lang: 'bash', code: 'aragon exec --threads --max-open-threads 4 "并行处理这 4 个文件"' },
          },
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '`--budget` 不存在',
        md:
          '预算只有两个维度：`--max-turns`（回合数）与 `--max-duration`（时长）。' +
          '两者任一触发都返回退出码 `3`，见 [预算与退出码](/exec/budgets/)。',
      },
    ],
  },

  {
    id: 'exec/output',
    title: '输出格式',
    group: 'exec',
    order: 30,
    phase: 'A',
    template: 'prose',
    summary:
      '三种输出格式的取舍：`text` 给人看、`json` 只要一个最终结果、`stream-json` 逐行事件——以及每种格式下日志该往哪走。',
    keywords: ['output-format', 'stream-json', 'json', 'text', 'stdout', 'stderr', '流式'],
    seeAlso: ['exec/events', 'exec/overview', 'exec/budgets'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/options.ts', lines: '225-235', snippet: 'stream-json' },
      { path: 'packages/cli/src/exec/events.ts', lines: '40-50', snippet: 'EXEC_SCHEMA_VERSION' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '三种格式的区别不是"详细程度"，而是**谁在消费**：人在终端里读、脚本读一个最终值、还是宿主程序逐条处理。',
      },
      {
        t: 'h2',
        text: '三种格式对照',
      },
      {
        t: 'table',
        caption: '`--output-format` 的三个取值',
        head: ['取值', '输出', '适合', '不适合'],
        rows: [
          ['`text`（默认）', '人类可读的流式文本', '手动排查、粘贴到工单', '任何自动化解析'],
          ['`json`', '结束时一个 `result` 对象', '只要最终答案的脚本', '需要过程（工具调用、进度）'],
          ['`stream-json`', '每行一个事件对象（JSONL）', '宿主程序、进度条、审计', '只想看最后一句话'],
        ],
      },
      {
        t: 'h2',
        text: 'stream-json 的形状',
      },
      {
        t: 'p',
        md:
          '每行是一个完整的 JSON 对象，`type` 字段决定它是什么事件。事件之间有顺序关系，' +
          '但不保证"每种事件都出现"—— 只消费你需要的 `type`，其余忽略。',
      },
      {
        t: 'code',
        lang: 'json',
        title: '一行一个事件',
        code: [
          '{"type":"system","subtype":"init","sessionId":"s-1a2b"}',
          '{"type":"text_delta","text":"先看一下"}',
          '{"type":"tool_call","name":"read_file","input":{"path":"README.md"}}',
          '{"type":"tool_result","name":"read_file","isError":false}',
          '{"type":"result","isError":false,"usage":{"outputTokens":512}}',
        ].join('\n'),
      },
      {
        t: 'h2',
        text: 'stdout 与 stderr 的分工',
      },
      {
        t: 'ul',
        items: [
          '**stdout 只放结果**（文本或事件流）。这是可解析的那一半。',
          '**stderr 放诊断**（警告、重试、工具进度提示）。它可能乱序、可能为空，不要解析它。',
          '用法错误（退出码 `2`）时 **stdout 为空**，错误在 stderr —— 这让"没有输出"成为一个可靠信号。',
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '兼容性承诺',
        md:
          '事件流带 `EXEC_SCHEMA_VERSION`；解析方应当**忽略未知事件**而不是报错（`stdin-stream` 也是这个规则），' +
          '这样新增事件不会打断既有宿主。升级策略见 [版本与兼容承诺](/appendix/compat/)。',
      },
    ],
  },

  {
    id: 'exec/events',
    title: '事件参考',
    group: 'exec',
    order: 40,
    phase: 'A',
    template: 'events',
    summary:
      '`stream-json` 下的 29 种事件：每种事件的触发时机、字段表与一行示例，按源码联合类型的顺序排列。',
    keywords: ['ExecEvent', '事件', 'stream-json', 'tool_call', 'result', 'text_delta', 'hook'],
    seeAlso: ['exec/output', 'api/events', 'exec/host'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/events.ts', lines: '832-861', snippet: 'export type ExecEvent' },
      { path: 'packages/cli/src/exec/events.ts', lines: '40-50', snippet: 'EXEC_SCHEMA_VERSION' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '事件是 `exec` 与宿主之间唯一的通道。下面的 29 种事件与 `ExecEvent` 联合类型一一对应，' +
          '`fields` 是该接口真实声明的字段（含可选标记）。',
      },
      {
        t: 'h2',
        text: '事件索引',
      },
      {
        t: 'table',
        caption: '29 种事件速查（`streamOnly` 表示只在 stream-json 下出现）',
        head: ['`type`', '名称', '形态'],
        rows: execEvents.map((event) => [
          `\`${event.type}\``,
          event.when.length > 60 ? `${event.when.slice(0, 58)}…` : event.when,
          event.streamOnly ? '仅 stream-json' : '两种格式都有',
        ]),
      },
      {
        t: 'h2',
        text: '逐事件说明',
      },
      {
        t: 'events',
        items: execEvents,
      },
      {
        t: 'callout',
        kind: 'note',
        title: '字段为空是正常的',
        md:
          '少数事件（如 `pong`、`ack`、`request_end`）几乎没有负载，它们的价值是**时序信号**：' +
          '出现即代表某个阶段结束。不要把"没有字段"当成"没有发生"。',
      },
    ],
  },

  {
    id: 'exec/permissions',
    title: '权限模式与工具白名单',
    group: 'exec',
    order: 50,
    phase: 'A',
    template: 'flags',
    summary:
      '怎样限定一次 headless 运行能做什么：`--permission-mode` 的四个基线（`auto` / `plan` / `strict` / `ask`）、`--allow-tool` / `--deny-tool` 的优先级，以及计划模式的工具封锁。',
    keywords: ['permission-mode', 'allow-tool', 'deny-tool', '权限', '白名单', '确认'],
    seeAlso: ['exec/flags', 'guide/plan-mode', 'tools/index'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/permission.ts', lines: '31-78', snippet: 'PermissionMode' },
      { path: 'packages/cli/src/tools/index.ts', lines: '460-480', snippet: 'PLAN_MODE_BLOCKED_TOOLS' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '权限分两层判定，顺序固定：**基线**（`--permission-mode`）先给出「默认注册哪些工具」，**白名单**（`--allow-tool` / `--deny-tool`）再做加减，而 `--deny-tool` 永远优先于 `--allow-tool`。',
      },
      {
        t: 'h2',
        text: '判定顺序',
      },
      {
        t: 'table',
        caption: '三层判定（后面的层覆盖前面的层，`--deny-tool` 永远赢）',
        head: ['层', '来源', '作用'],
        rows: [
          ['1', '`--permission-mode`', '决定默认注册哪些工具；`strict` 只注册白名单里的'],
          ['2', '`--allow-tool <name>`', '额外放行指定工具（可重复）'],
          ['3', '`--deny-tool <name>`', '明确禁止；**优先级最高**，与 allow 冲突时 deny 赢'],
        ],
      },
      {
        t: 'h2',
        text: '四个基线',
      },
      {
        t: 'table',
        caption: '`--permission-mode` 的四个取值（默认 `auto`）',
        head: ['取值', '注册哪些工具', '一句话'],
        rows: [
          ['`auto`', '全部', '默认。要不要真的动手由确认规则决定'],
          ['`plan`', '去掉六个变更类工具', '只研究、只设计；见下一节'],
          ['`strict`', '只有 `--allow-tool` 点名的', '白名单模式，没点名的一律不注册'],
          ['`ask`', '与 `auto` 相同', '不过滤，但每个变更类工具等调用方放行；需要 `--input-format bridge`'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么 `ask` 不筛工具',
        md:
          '`ask` 改变的是**调用**而不是**注册**：`--permission-mode ask --deny-tool bash` 的含义是' +
          '「bash 不注册、也不问」，而不是「问了再过滤」。两条路混在一起，调用方就无法从事件流里分清哪一种发生了。',
      },
      {
        t: 'h2',
        text: '计划模式的封锁表',
      },
      {
        t: 'p',
        md:
          '计划模式只允许"看"，不允许"改"。这套封锁表同时被 TUI 与 headless 使用，因此两边的行为一致：',
      },
      {
        t: 'ul',
        items: [
          '`write_file`、`edit_file` —— 直接改文件',
          '`bash` —— 能改任何东西',
          '`bash_kill` —— 能打断用户的进程',
          '`skill_install`、`skill_create` —— 会写进技能目录',
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '白名单不是沙箱',
        md:
          '`--allow-tool bash` 意味着模型可以执行任意命令。需要真正的隔离时用容器/虚拟机，' +
          '或者把 `--deny-tool bash` 与只读工具组合起来。',
      },
      {
        t: 'h2',
        text: '典型配置',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '只读审计',
        code:
          'aragon exec \\\n' +
          '  --permission-mode plan \\\n' +
          '  --deny-tool bash \\\n' +
          '  --allow-tool read_file --allow-tool grep --allow-tool list_dir \\\n' +
          '  "这份代码有没有明显的密钥泄漏"',
      },
    ],
  },

  {
    id: 'exec/budgets',
    title: '预算与退出码',
    group: 'exec',
    order: 60,
    phase: 'A',
    template: 'prose',
    summary:
      '`--max-turns` 与 `--max-duration` 是两道闸门：触发时退出码为 3（不是 0 也不是 1），并保留已经产生的输出。',
    keywords: ['预算', 'budget', 'max-turns', 'max-duration', '退出码', '3'],
    seeAlso: ['cli/exit-codes', 'exec/flags', 'exec/output'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/options.ts', lines: '565-600', snippet: 'max-turns' },
      { path: 'packages/cli/src/exec/runner.ts', lines: '879-891', snippet: "return 3" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '预算是给"可能会跑很久"的操作设定的上限。它的语义很具体：**到达上限就停，但已经产生的内容要留住** —— ' +
          '`0` 会假装任务完成了，`1` 会假装出错了，两者都不对，所以有了独立的 `3`。',
      },
      {
        t: 'h2',
        text: '两个维度',
      },
      {
        t: 'table',
        caption: '预算参数（值来自 `exec/options.ts` 的声明）',
        head: ['参数', '计量', '触发后'],
        rows: [
          ['`--max-turns <n>`', '代理循环的回合数', '停止、输出已产生的事件、退出码 3'],
          ['`--max-duration <ms>`', '墙钟时长', '同上；超时也会让 `stopReason` 记成 `timeout`'],
        ],
      },
      {
        t: 'h2',
        text: '退出码与预算的关系',
      },
      {
        t: 'table',
        caption: '五档退出码（完整说明见 [退出码](/cli/exit-codes/)）',
        head: ['码', '含义', '与预算的关系'],
        rows: exitCodes.map((record) => [
          `\`${record.code}\``,
          record.meaning,
          record.code === '3' ? '**就是预算命中**' : '与预算无关',
        ]),
      },
      {
        t: 'h2',
        text: '脚本里怎么用',
      },
      {
        t: 'steps',
        items: [
          {
            title: '给每个任务一个上界',
            md: '没有上界的自动化调用会在某一天跑满你的额度。用 `--max-turns` 起步，再按实际需要放宽。',
            code: { lang: 'bash', code: 'aragon exec --max-turns 20 --max-duration 300000 "整理 CHANGELOG"' },
          },
          {
            title: '把 3 当作"未完成"，而不是"失败"',
            md: '`3` 时 stdout 里的事件是可信的、可继续的部分结果。把它存下来，下次带着上下文继续。',
          },
          {
            title: '不要为了"通过"去掉预算',
            md: '去掉预算是把问题推给下一次更贵的运行。更好的做法是拆任务，或者换更快的模型。',
          },
        ],
      },
    ],
  },

  {
    id: 'exec/sessions',
    title: '会话续接与并发',
    group: 'exec',
    order: 70,
    phase: 'B',
    template: 'prose',
    summary:
      '`--session-id`、`--resume`、`--continue` 的区别，会话文件落在哪里，以及多个 exec 同时跑同一个会话时会发生什么。',
    keywords: ['session', 'resume', 'continue', 'session-id', '并发', '续接'],
    seeAlso: ['guide/sessions', 'exec/flags', 'exec/host'],
    sourceRefs: [
      { path: 'packages/cli/src/session/store.ts', lines: '50-68', snippet: 'SESSION_LOCK_TTL_MS' },
      { path: 'packages/cli/src/exec/options.ts', lines: '970-990', snippet: 'session' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          'headless 跑一次就是一次会话。会话会被持久化，所以"下一次"可以接着"上一次"说 —— ' +
          '前提是你知道自己在续接**哪一个**。',
      },
      {
        t: 'h2',
        text: '三个入口的区别',
      },
      {
        t: 'kv',
        items: [
          { k: '`--session-id <id>`', v: '用指定 id 新建（或指定）会话；便于调用方自己记账' },
          { k: '`--resume <id|path>`', v: '续接已有会话；历史会一并载入' },
          { k: '`--continue`', v: '续接**最近一次**会话，不用记 id' },
          { k: '`--no-save-session`', v: '不落盘：适合一次性的敏感任务' },
        ],
      },
      {
        t: 'h2',
        text: '并发时的语义',
      },
      {
        t: 'ul',
        items: [
          '同一个会话 id 上的两个 exec 会各自写自己的历史片段，**不保证**合并顺序符合直觉。',
          '需要并行时用 `--threads`：每个 thread 是同一会话下的独立分支。',
          '长任务用后台作业 + `job_wait` 观察，而不是两个前台进程抢一个会话。',
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '续接会带上历史成本',
        md: '续接越老的会话，读入的上下文越多。长期任务应当定期开新会话，并把结论写进文件。',
      },
    ],
  },

  {
    id: 'exec/host',
    title: '宿主桥：bridge / threads / hooks',
    group: 'exec',
    order: 80,
    phase: 'B',
    template: 'prose',
    summary:
      '把 `aragon exec` 当成一个被托管的进程：bridge 双向通道、threads 多分支、hooks 生命周期回调、`--result-schema` 的类型化结果。',
    keywords: ['bridge', 'threads', 'hooks', '宿主桥', 'result-schema', 'submit_result'],
    seeAlso: ['exec/sessions', 'api/events', 'appendix/compat'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/options.ts', lines: '225-235', snippet: 'stream-json' },
      { path: 'packages/cli/src/exec/events.ts', lines: '832-861', snippet: 'export type ExecEvent' },
      { path: 'packages/cli/src/tools/index.ts', lines: '505-530', snippet: 'submit_result' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '宿主桥解决一个问题：**运行中途要能双向说话**。只放一个提示词、等结果，用 `aragon exec` 就够；' +
          '要在工具调用前后插手、要并发多个分支、要结构化结果时，才需要这一层。',
      },
      {
        t: 'h2',
        text: '四块能力',
      },
      {
        t: 'table',
        caption: '宿主桥的四个开关（都以 `--` 参数开启）',
        head: ['能力', '开关', '做什么'],
        rows: [
          ['双向通道', '`--input-format stream-json`', '运行中继续从 stdin 送消息与工具结果'],
          ['生命周期回调', '`--hook-timeout` / `--on-hook-timeout`', '在工具调用前后执行宿主逻辑，超时可配置'],
          ['多分支', '`--threads` / `--max-open-threads` / `--thread-concurrency`', '同一会话下的并行分支'],
          ['结构化结果', '`--result-schema <path>`', '注册 `submit_result`，模型必须按 schema 提交'],
        ],
      },
      {
        t: 'h2',
        text: '`submit_result` 是宿主专属工具',
      },
      {
        t: 'p',
        md:
          '它不在"内置工具 19 个"里：只有带 `--result-schema` 的会话才注册它。因此本站的工具数据集不算它，' +
          '而 `HOST_TOOL_NAMES`（宿主能力全集，20 条）包含它 —— 这个差集是刻意记录在案的。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: 'hook 超时的默认值',
        md:
          'hook 超时与工具超时是两套独立设置：`--hook-timeout` 管宿主回调，`--caller-tool-timeout` 管调用方工具。' +
          '两者都不会自动放宽，需要按任务设。',
      },
    ],
  },
];

/**
 * 把参数分组渲染成「H2 + 表格」序列。
 *
 * @param {Map<string, object[]>} groups 分组
 * @returns {object[]} block 序列
 */
function renderFlagSections(groups) {
  const blocks = [];
  for (const [title, records] of groups) {
    blocks.push({ t: 'h2', text: title });
    if (records.length <= 18) {
      blocks.push(flagTable(title, records));
      continue;
    }
    for (let index = 0; index < records.length; index += 18) {
      blocks.push(flagTable(`${title}（续 ${Math.floor(index / 18) + 1}）`, records.slice(index, index + 18)));
    }
  }
  return blocks;
}
