/**
 * CLI 参考分组的页面（§2.2）。
 *
 * 这一组是「数据驱动页」的样板：正文不手抄参数，而是从 `src/content/data/**` 里的记录数组
 * 生成表格。改一条参数的说明只需要改数据集，全站同步生效（§5.3）。
 *
 * 引用写法约定（全站一致）：
 * - 站内链接写 `[文字](/guide/tui/)`（站点绝对路径形态），构建时按相对路径重写；
 * - 引用源码写 `packages/cli/src/cli.tsx:2372` 这样的代码片段 + `sourceRefs` 兜底。
 */

import { cliFlags, subcommandFlags } from '../data/cli-flags.mjs';
import { exitCodes } from '../data/exit-codes.mjs';

/**
 * 把参数记录渲染成一张表（每组 ≤ 18 行，§8.5）。
 *
 * @param {string} title 组标题（写进 caption）
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

/**
 * 按 `group` 字段把记录分桶（保持源码顺序）。
 *
 * @param {object[]} records 记录
 * @returns {Map<string, object[]>} 分组
 */
function groupBy(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.group)) groups.set(record.group, []);
    groups.get(record.group).push(record);
  }
  return groups;
}

/** 全局参数页：按 9 个语义分组渲染 root 作用域的全部参数。 */
const globalFlagGroups = groupBy(cliFlags);

/** 子命令参数页：6 个子命令作用域。 */
const subcommandGroups = groupBy(subcommandFlagRows());

/**
 * 作用域 → 读者看得懂的命令写法。
 *
 * `list` 是 `config list` 的选项作用域（`cli.tsx:2591`），truth set 按源码里的作用域名
 * 记账；页面上把它写成裸 `list` 会让读者以为存在一个顶层的 `aragon list`。
 */
const SCOPE_LABELS = { list: 'config list' };

/**
 * 子命令参数记录（`--json` 等在不同子命令下语义不同，因此按作用域分表）。
 *
 * @returns {object[]} 记录
 */
function subcommandFlagRows() {
  return subcommandFlags;
}

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'cli/global-flags',
    title: '全局参数',
    group: 'cli',
    order: 10,
    phase: 'A',
    template: 'flags',
    summary:
      '`aragon` 根命令的全部参数，按用途分组：模型与推理、输出、会话、工具与权限、界面渲染、计划与团队、技能与上下文、fast 档、日志。',
    keywords: ['flag', 'option', '参数', 'CLI flags', '--model', '--theme', '全局参数'],
    seeAlso: ['cli/subcommands', 'cli/exit-codes', 'config/reference'],
    sourceRefs: [
      { path: 'packages/cli/src/cli.tsx', lines: '2370-2470', snippet: ".option('--model <id>'" },
      { path: 'packages/cli/src/cli.tsx', lines: '2567-2690', snippet: '.command(' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '根命令（不带子命令）的参数分为 9 组。第 4 列是**源码里的描述原文** —— 站点不翻译它，' +
          '因为「准确」优先于「顺口」；第 5 列可以直接点开看那一行。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '三个数字的区别',
        md:
          '`--no-x` 与同作用域的 `--x` 是同一个开关的两种默认值，本页把**它们合并成一行**（默认值列写 `开/关`）。' +
          '所以「声明数」「不同长名数」「合并后的行数」是三个不同的数：声明 101 处、不同长名 92 个、合并后 80 条' +
          '（其中本页的 root 作用域 55 条）。',
      },
      ...renderGroupSections(globalFlagGroups),
      {
        t: 'h2',
        text: '组合示例',
      },
      {
        t: 'p',
        md: '常见的几组搭配，可以直接复制：',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '日常与脚本',
        code: [
          '# 换模型与推理强度',
          'aragon --model claude-sonnet-4-5 --thinking high',
          '',
          '# 无人值守跑一次性任务（-p 走 headless）',
          'aragon -p "把 README 的示例改成新 API" --confirm',
          '',
          '# 只看不改：关掉变更类工具（`--deny-tool` 在 `exec` 上，根命令没有这个参数）',
          'aragon exec --deny-tool write_file --deny-tool edit_file "梳理目录结构"',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '子命令参数不在本页',
        md: '`logs`、`history`、`skills`、`update`、`models`、`list` 各自的参数见 [子命令](/cli/subcommands/)。',
      },
    ],
  },

  {
    id: 'cli/subcommands',
    title: '子命令',
    group: 'cli',
    order: 20,
    phase: 'A',
    template: 'flags',
    summary:
      '10 个子命令的用途与各自的参数：`config`、`logs`、`history`、`skills`、`update`、`models`、`exec`、`sessions`、`info`、`doctor`，含 `--json` 的机器可读用法。',
    keywords: ['subcommand', '子命令', 'aragon logs', 'aragon skills', 'aragon update', '--json'],
    seeAlso: ['cli/global-flags', 'cli/command-families', 'guide/slash-commands'],
    sourceRefs: [
      { path: 'packages/cli/src/cli.tsx', lines: '2567-2690', snippet: '.command(' },
      { path: 'packages/cli/src/commands/builtins.ts', lines: '1466', snippet: 'registerBuiltinCommands' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '子命令在 `aragon <子命令>` 位置使用。除了下面这些参数，每个子命令**同样接受根命令的全局参数**' +
          '（例如 `aragon logs --theme light`）。',
      },
      {
        t: 'h2',
        text: '子命令一览',
      },
      {
        t: 'table',
        caption: '10 个子命令，顺序与 `cli.tsx` 的注册顺序一致',
        head: ['子命令', '用途'],
        rows: [
          ['`config`', '打开设置界面；另有 6 个子动作：`set` / `get` / `list` / `path` / `edit` / `home`'],
          ['`logs`', '查看日志：`path` / `list` / `tail` / `clear` / `open`'],
          ['`history`', '查看提示词历史：`path` / `list` / `clear`'],
          [
            '`skills`',
            '技能管理：`list` / `info` / `install` / `update` / `remove` / `create` / `path` / `doctor` / `usage` / `trust` / `untrust`',
          ],
          ['`update`', '自更新：检查、指定版本、回滚'],
          ['`models`', '列出内置与已发现的模型（可指定 provider）'],
          ['`exec`', '机器面的一次性运行：JSON 事件、会话、工具权限、预算'],
          ['`sessions`', '管理 `exec` 会话：`list` / `show` / `rm` / `prune` / `path`'],
          ['`info`', '打印这套安装支持什么（给包装脚本与 CI 用）'],
          ['`doctor`', '检查本机是否已配好；`exit 0` 表示全部通过'],
        ],
      },
      {
        t: 'h2',
        text: '子命令参数',
      },
      ...renderGroupSections(subcommandGroups, (title) => `子命令 ${SCOPE_LABELS[title] || title}`),
      {
        t: 'callout',
        kind: 'tip',
        title: '脚本里请加 --json',
        md:
          '`logs`、`history`、`skills`、`update`、`sessions`、`config list` 都支持 `--json`：输出一行 JSON，失败时退出码非 0。' +
          '解析文本输出在版本升级时会坏，解析 JSON 不会。',
      },
    ],
  },

  {
    id: 'cli/exit-codes',
    title: '退出码',
    group: 'cli',
    order: 30,
    phase: 'A',
    template: 'flags',
    summary:
      'TUI 与 headless 共用的 5 档退出码：0 成功、1 代理错误、2 用法或会话错误（stdout 为空）、3 预算命中、128+signo 被信号中断。',
    keywords: ['exit code', '退出码', 'exitCode', '130', 'SIGINT', '预算命中'],
    seeAlso: ['exec/budgets', 'exec/output', 'cli/global-flags'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/runner.ts', lines: '879-891', snippet: 'exitCode(): number {' },
      { path: 'packages/cli/src/exec/index.ts', lines: '1050-1060', snippet: 'exitCode: 2' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '退出码是脚本与 `aragon` 之间最小的契约：不需要解析任何输出，只看 `$?` 就能分支。' +
          '下面 5 档覆盖全部情况，`--output-format json` 时同样成立。',
      },
      {
        t: 'h2',
        text: '五档退出码',
      },
      {
        t: 'table',
        caption: '退出码速查（`stdout` 列说明是否可能已有输出）',
        head: ['码', '含义', '何时出现', 'stdout', '依据'],
        rows: exitCodes.map((record) => [
          `\`${record.code}\``,
          record.meaning,
          record.when,
          record.stdout,
          `\`${record.source.path}:${record.source.lines}\``,
        ]),
      },
      {
        t: 'h2',
        text: '脚本里的判断顺序',
      },
      {
        t: 'steps',
        items: [
          {
            title: '先看是不是 `2`',
            md: '`2` 表示**命令根本没跑起来**（参数错、会话不存在）。此时 stdout 为空，重试没有意义，先修参数。',
          },
          {
            title: '再看是不是 `3`',
            md: '`3` 表示预算命中：`--max-turns` / `--max-duration` 用完了。加大预算或拆任务，而不是重试。',
          },
          {
            title: '`1` 才是「跑过但出错」',
            md: '此时 stdout 可能已经有半份结果；读 `result` 事件的 `isError` 与 `error` 字段，不要只看退出码。',
          },
          {
            title: '`>= 128` 是信号',
            md: '`130` = `SIGINT`（Ctrl+C），`143` = `SIGTERM`。容器里被 KILL 通常是 `137`。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '不要用 `1` 判断「什么都没发生」',
        md:
          '`1` 只说明代理出错，不说明没有副作用：工具可能已经写过文件。需要「要么全做要么不做」时，' +
          '用 `aragon exec --deny-tool` 关掉变更类工具，或在版本控制里回滚。',
      },
    ],
  },

  {
    id: 'cli/command-families',
    title: '命令族：config / skills / session',
    group: 'cli',
    order: 40,
    phase: 'B',
    template: 'flags',
    summary:
      '三组命令族的完整用法：`aragon config` 的六个动作、`aragon skills` 的安装与诊断、以及会话相关的子命令与它们的退出码。',
    keywords: ['config 命令', 'skills 命令', 'session', 'aragon config set', 'aragon skills doctor'],
    seeAlso: ['cli/subcommands', 'config/overview', 'guide/skills'],
    sourceRefs: [
      { path: 'packages/cli/src/config/cli-commands.ts', lines: '1-40', snippet: 'config' },
      { path: 'packages/cli/src/skills/cli-commands.ts', lines: '118-160', snippet: 'export async function runSkillsCommand' },
    ],
    blocks: [
      {
        t: 'p',
        md: '命令族是「一组同前缀子命令」的实现方式。它们与斜杠命令共享语义，但跑在 shell 里，因此更适合脚本与 CI。',
      },
      {
        t: 'h2',
        text: 'config 族',
      },
      {
        t: 'table',
        caption: '`aragon config` 的六个动作',
        head: ['动作', '作用'],
        rows: [
          ['`config path`', '打印配置文件路径（不受 `ARAGON_HOME` 影响的真实位置）'],
          ['`config get <key>`', '读取一个键（`a.b` 记法）'],
          ['`config set <key> <value>`', '写入一个键，保留其余键与注释顺序'],
          ['`config list`', '列出全部键与当前值'],
          ['`config edit`', '用 `$EDITOR` 打开配置文件'],
          ['`config home`', '打印数据目录（会话、日志、技能都在里面）'],
        ],
      },
      {
        t: 'h2',
        text: 'skills 族',
      },
      {
        t: 'p',
        md:
          '`aragon skills` 负责安装与诊断。`doctor` 会逐条回答「这个技能的 `allowed-tools` 能不能真的生效」，' +
          '答案来自 `HOST_TOOL_NAMES` 这个宿主能力全集。',
      },
      {
        t: 'table',
        caption: '`aragon skills` 的常用动作',
        head: ['动作', '作用'],
        rows: [
          ['`skills list`', '列出已安装技能与来源'],
          ['`skills install <source>`', '从目录、git 仓库或 https 地址安装'],
          ['`skills doctor`', '检查技能声明与本机能力是否匹配'],
          ['`skills remove <name>`', '卸载一个技能'],
        ],
      },
      {
        t: 'h2',
        text: 'session 族',
      },
      {
        t: 'p',
        md:
          '会话相关的子命令见 [会话、恢复与分支](/guide/sessions/)；`aragon history` 负责列出历史会话，' +
          '`--json` 输出可直接喂给 `jq`。',
      },
    ],
  },
];

/**
 * 把分组渲染成「H2 + 表格」序列。
 *
 * @param {Map<string, object[]>} groups 分组
 * @param {(title: string) => string} [titlePrefix] 标题前缀（子命令用）
 * @returns {object[]} block 序列
 */
function renderGroupSections(groups, titlePrefix) {
  const blocks = [];
  for (const [title, records] of groups) {
    blocks.push({ t: 'h2', text: titlePrefix ? titlePrefix(title) : title });
    if (records.length <= 18) {
      blocks.push(flagTable(title, records));
    } else {
      // 超过 18 行就拆，避免一张表长到需要滚动
      for (let index = 0; index < records.length; index += 18) {
        blocks.push(flagTable(`${title}（续 ${index / 18 + 1}）`, records.slice(index, index + 18)));
      }
    }
  }
  return blocks;
}
