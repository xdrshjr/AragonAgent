/**
 * 「日常使用」分组的 13 个页面（§2.2）。
 *
 * 这一组是**行为文档**：它不重复参数表，而是回答「我该做什么」和「我怎么知道它生效了」。
 * 三条约定与 `cli.mjs` 相同：
 *
 * - 数据驱动：键位、斜杠命令、参数、工具、配置键全部来自 `src/content/data/**`，
 *   页面只负责分组、措辞和交叉引用（§5.3）。条数一律由 `length` 现算，不手抄。
 * - 引用写法：站内链接写 `[计划模式](/guide/plan-mode/)`（站点绝对路径形态）；
 *   源码引用写 `packages/cli/README.md:1246` 这样的片段，并有 `sourceRefs` 兜底。
 * - 源码优先：README 与源码不一致时，正文按源码写，并在需要时点明这一处差异。
 */

import { keybindings } from '../data/keybindings.mjs';
import { slashCommands } from '../data/slash-commands.mjs';
import { cliFlags } from '../data/cli-flags.mjs';
import { tools } from '../data/tools.mjs';
import { configKeys } from '../data/config-keys.mjs';

/**
 * 按某个字段把记录分桶（保持数据集顺序）。
 *
 * @param {object[]} records 记录
 * @param {string} field 分桶字段
 * @returns {Map<string, object[]>} 分组
 */
function groupBy(records, field) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record[field])) groups.set(record[field], []);
    groups.get(record[field]).push(record);
  }
  return groups;
}

/**
 * 键位表：一列键位（渲染成 `{kbd:...}` 键帽）、一列作用。
 *
 * @param {string} scope 作用域（写进 caption）
 * @param {object[]} records 键位记录
 * @returns {object} table block
 */
function keyTable(scope, records) {
  return {
    t: 'table',
    caption: `${scope}（${records.length} 条）`,
    head: ['键位', '作用'],
    rows: records.map((record) => [
      record.keys.map((key) => `{kbd:${key}}`).join(' / '),
      record.action,
    ]),
  };
}

/**
 * 斜杠命令表：命令、别名、源码原文说明、来源类别。
 *
 * @param {string} topic 主题（写进 caption）
 * @param {object[]} records 命令记录
 * @returns {object} table block
 */
function commandTable(topic, records) {
  return {
    t: 'table',
    caption: `${topic}（${records.length} 条）`,
    head: ['命令', '别名', '说明（源码原文）', '来源'],
    rows: records.map((record) => [
      `\`/${record.name}\``,
      record.aliases.length > 0 ? record.aliases.map((alias) => `\`/${alias}\``).join(' / ') : '—',
      record.desc || '—',
      record.kind === 'builtin' ? '内置' : '命令族',
    ]),
  };
}

/**
 * 从 `cliFlags` 里挑出若干个参数渲成一张表。
 *
 * @param {string} title 组标题（写进 caption）
 * @param {string[]} names 参数长名
 * @returns {object} table block
 */
function flagTable(title, names) {
  const records = names
    .map((name) => cliFlags.find((flag) => flag.flag === name))
    .filter((record) => record !== undefined);
  return {
    t: 'table',
    caption: `${title}（${records.length} 条）`,
    head: ['参数', '取值', '默认', '说明（源码原文）'],
    rows: records.map((record) => [
      `\`${record.flag}\``,
      record.arg ? `\`${record.arg}\`` : '—',
      record.default,
      record.desc,
    ]),
  };
}

/**
 * 从 `configKeys` 里挑出若干个顶层键渲成一张表。
 *
 * @param {string} title 组标题（写进 caption）
 * @param {string[]} names 键名
 * @returns {object} table block
 */
function configTable(title, names) {
  const records = names
    .map((name) => configKeys.find((record) => record.key === name))
    .filter((record) => record !== undefined);
  return {
    t: 'table',
    caption: `${title}（${records.length} 个键；默认值是源码里的常量名）`,
    head: ['键', '类型', '默认', '归属'],
    rows: records.map((record) => [
      `\`${record.key}\``,
      `\`${record.type}\``,
      `\`${record.default}\``,
      record.area,
    ]),
  };
}

/**
 * 从 `tools` 里取一个工具的参数，直接当作 `params` block。
 *
 * @param {string} name 工具名
 * @returns {object} params block
 */
function toolParams(name) {
  const record = tools.find((tool) => tool.name === name);
  const items = (record ? record.params : []).map((param) => ({
    name: param.name,
    type: param.type,
    required: param.required === true,
    desc: param.desc,
  }));
  return { t: 'params', caption: `\`${name}\` 的参数（共 ${items.length} 个）`, items };
}

/** 数据集里的现算条数：页面正文引用它们，不手抄数字。 */
const counts = {
  keys: keybindings.length,
  keysScopes: groupBy(keybindings, 'scope').size,
  commands: slashCommands.length,
  commandsBuiltin: slashCommands.filter((record) => record.kind === 'builtin').length,
  commandsFamily: slashCommands.filter((record) => record.kind === 'family').length,
  commandsTopics: groupBy(slashCommands, 'topic').size,
  commandsNoDesc: slashCommands.filter((record) => !record.desc).length,
  tools: tools.length,
  configKeys: configKeys.length,
  flags: cliFlags.length,
};

/** 键位表（按数据集里第一次出现的顺序分 5 组，每组不超过 18 行）。 */
const keyScopeTables = [...groupBy(keybindings, 'scope')].map(([scope, records]) => keyTable(scope, records));

/** 命令表（按主题分组）。 */
const commandTopics = [...groupBy(slashCommands, 'topic')];

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'guide/tui',
    title: '界面导览',
    group: 'guide',
    order: 10,
    phase: 'A',
    template: 'prose',
    summary:
      '屏幕由四块区域组成：头部身份条、会话区、输入框与状态行。本页说明每块显示什么、浮层怎么接管、Ctrl+C 的三级含义，以及 /clear 与 /compact 各自清掉什么。',
    keywords: ['界面', 'TUI', '状态行', '头部', '屏幕分区', 'overlay', '清屏'],
    seeAlso: ['guide/keybindings', 'guide/context', 'guide/scroll-themes'],
    sourceRefs: [
      {
        path: 'packages/cli/README.md',
        lines: '1246-1264',
        snippet: 'The input and status stay fixed while output streams.',
      },
      {
        path: 'packages/cli/README.md',
        lines: '1335-1341',
        snippet: "The conversation lives in **your terminal's own scrollback**",
      },
      { path: 'packages/cli/README.md', lines: '1187-1194', snippet: '/clear screen' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '默认的 `scrollMode: native` 下，`aragon` 不占用备用屏，也不打开鼠标上报：会话直接印在你终端自己的回滚缓冲里，' +
          '屏幕上只保留一块**实时区**。所以「界面」在这里的准确含义是**四块区域 + 若干浮层**，而不是一个自绘的全屏应用。',
      },
      {
        t: 'code',
        lang: 'text',
        title: '一块 30 行终端的实时区',
        code: [
          ' aragon  anthropic:claude-sonnet-4-5  ~/proj  a4k2m9        ^G more   <- 头部身份条',
          ' ------------------------------------------------------------------',
          ' > 把 README 的示例改成新 API                                        <- 你发的那句',
          '   * thought for 12s - ctrl+t to show                                  <- 一行占位',
          '   bash npm test   running                                            <- 工具卡片',
          '   |  OK src/__tests__/patch.test.ts (49 tests)',
          '                                                                       ',
          ' +-----------------------------------------------------------------+',
          ' | > _                                                             |   <- 输入区',
          ' +-----------------------------------------------------------------+',
          ' BUILD | Thinking | Context ~35% | Think high | 12 tok/s | 1m04s      <- 状态行',
        ].join('\n'),
      },
      {
        t: 'h2',
        text: '四块区域各管什么',
      },
      {
        t: 'table',
        caption: '区域、内容与变化时机',
        head: ['区域', '显示什么', '什么时候变'],
        rows: [
          [
            '头部（第一行）',
            '工作目录、`provider:model`、**任务摘要**（用 fast 档把第一条提示词压成几个词）、`^G more`、`kit <name>` 等入口提示',
            '一次任务只生成一次摘要；`/task refresh` 或抽屉里的 `r` 才重算',
          ],
          [
            '会话区（中间）',
            '实时区里最多十项最新条目：你发的、模型答的、工具/团队/压缩卡片；离开这块窗口的条目**印进终端回滚缓冲**，不再重绘',
            '新条目进来时；`Ctrl+O` 在有卡片时可展开，否则重印最后一条完整回答',
          ],
          [
            '输入区（底部上方）',
            '草稿、`/` 命令调色板、`@` 文件补全、粘贴折叠标记、选区高亮',
            '打字、粘贴、补全打开；`Paste` 超过 6 行 400 字折叠成 `[Pasted text #1 +15 lines]`',
          ],
          [
            '状态行（最后一行）',
            '运行状态 + 五个字段：模式（`BUILD` / `PLAN`）、上下文百分比、思考档（O/N/L/M/H/X）、tok/s、耗时',
            '每次工具结果都会推动上下文百分比；`Ctrl+G` 打开第二行细节',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '「看不见」有时是设计',
        md:
          '状态行只在终端**够高**时才画；那一行不存在时，右侧的会话 id 也就不画。' +
          '这不是截断——半个 id 是一条无法使用的 `--resume` 命令——读 id 请用 `/session`，它在任何宽度都给全量。',
      },
      {
        t: 'h2',
        text: '浮层：谁接管键盘',
      },
      {
        t: 'p',
        md:
          '浮层画在实时区里并占满它的上半部分，面板带（计划栏、团队名册）会让位。打开期间**草稿不动、转录不动**，' +
          '所有按键先给浮层。规则只有一条例外：等你决策的浮层（`confirm` / `question` / `plan`）只能由 {kbd:Esc} 收尾，' +
          '此时按 {kbd:Ctrl+G} 不会把键盘抢走，头部显示的正是 `Esc close`。',
      },
      {
        t: 'table',
        caption: '常用浮层与开关方式',
        head: ['浮层', '打开', '关闭 / 说明'],
        rows: [
          ['快捷键抽屉', '{kbd:Ctrl+G} 或 `/keys [query]`', '再按一次 {kbd:Ctrl+G}；`d` 切状态详情行，`r` 重算任务摘要'],
          ['子代理看板（只读）', '{kbd:Ctrl+B} 或 `/agents`', '{kbd:Esc}；dispatch 结束后仍可打开，冻结最后一次快照'],
          ['agent kit 选择器', '{kbd:Ctrl+K} 或 `/kit`', '{kbd:Esc}；**不写配置文件**'],
          ['快捷提示词库', '{kbd:Ctrl+P} 或 `/prompts`', '{kbd:Esc}；`Enter` 只填充草稿，`Ctrl+Enter` 填充并发送'],
          ['计划评审卡', '代理调用 `submit_plan`', '`a` 批准，`r` 反馈，{kbd:Esc} 要求重做'],
          ['工具确认', '`--confirm` 或权限门', '`Y` 批准，`N` 拒绝（`Enter` / {kbd:Esc} 同效）'],
        ],
      },
      {
        t: 'h2',
        text: 'Ctrl+C 的三级含义',
      },
      {
        t: 'p',
        md:
          '{kbd:Ctrl+C} 先做终端用户预期的那件事，再谈退出。源码把这三步叫 rung（阶梯），每一步都只前进一格，' +
          '而且**停服务不会给退出上膛**：为杀一个 dev server 按的键，不该让你离丢会话只差一次按键。',
      },
      {
        t: 'steps',
        items: [
          {
            title: '有拖选高亮在等你 → 复制',
            md:
              '复制走 OSC 52（SSH 下也能用）。这一次按键既不退出也不停服务；' +
              '`Copy sent` 只说明请求已发出，`Copied` 才是终端确认写入。',
          },
          {
            title: '没有选区但有活着的后台服务 → 停服务',
            md: '优雅阶梯（SIGTERM → SIGKILL），因为这时还有事件循环能跑完它，dev server 能干净地放掉端口。',
          },
          {
            title: '什么都没有 → 进入退出阶梯',
            md: '第一次按只警告（`Ctrl+C again to exit`）；第二次才真退出。空草稿与非空草稿的提示文案不同。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '停运行是 Esc，不是 Ctrl+C',
        md:
          '中断一次运行用 {kbd:Esc} 两次（1.5 秒内）；{kbd:Ctrl+C} 两次是退出会话。' +
          '两者混用会让你以为「只是停了任务」，实际连会话一起关掉。详见 [输入、队列与中断](/guide/input-queue/)。',
      },
      {
        t: 'h2',
        text: '/clear 与 /compact 各清掉什么',
      },
      {
        t: 'table',
        caption: '两个「看着像清理」的命令，行为完全不同',
        head: ['命令', '打断运行', '清掉什么', '保留什么'],
        rows: [
          [
            '`/clear`（`/reset` 同实现）',
            '是',
            '上下文历史、待接收队列、转录、TODO 面板；旧会话归档到 `~/.aragon-agent/sessions/cleared/`',
            '归档文件本身（最近 20 份），提示里给出路径，可用 `/resume <路径>` 拿回',
          ],
          [
            '`/clear screen`',
            '否',
            '只清屏（并印一条 `---- conversation cleared ----` 分隔）',
            '上下文、队列、TODO、任务摘要全在；模型仍知道刚才在做什么',
          ],
          [
            '`/compact`',
            '排队',
            '把较老的历史换成结构化摘要（任务与最近几轮保持原文）',
            '摘要后的任务记忆、最近 `keepRecentTurns` 轮、被丢消息的归档文件',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '怎么确认清掉了',
        md:
          '`/context` 看占用是否归零（或压缩后是否立刻下降），状态行的 TODO 计数是否消失，`/session` 是否换了 id。' +
          '清屏不影响占用，所以「屏上干净了但百分比没变」是正确表现，不是 bug。',
      },
      {
        t: 'p',
        md:
          '细节分别在 [上下文与自动压缩](/guide/context/)、[会话、恢复与分支](/guide/sessions/) 和 ' +
          '[滚动、主题与渲染性能](/guide/scroll-themes/) 三页；键位全表见 [键盘快捷键](/guide/keybindings/)。',
      },
    ],
  },

  {
    id: 'guide/keybindings',
    title: '键盘快捷键',
    group: 'guide',
    order: 20,
    phase: 'A',
    template: 'flags',
    summary:
      `${counts.keys} 条键位按作用域分组：输入编辑、全局、面板与浮层、会话与历史、权限与确认，附平台差异，以及用 Ctrl+G 打开快捷键抽屉的办法。`,
    keywords: ['快捷键', 'keybinding', 'Ctrl+G', '抽屉', '输入编辑', 'Esc'],
    seeAlso: ['guide/tui', 'guide/input-queue', 'guide/slash-commands'],
    sourceRefs: [
      { path: 'packages/cli/src/ui/shortcuts.ts', lines: '63', snippet: 'export const SHORTCUTS' },
      { path: 'packages/cli/README.md', lines: '981-1012', snippet: '| Key | Action |' },
      { path: 'packages/cli/README.md', lines: '980', snippet: '打开同一份清单' },
      { path: 'packages/cli/src/input/keymap.ts', lines: '41-45', snippet: "case 'a':" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          `本页的 ${counts.keys} 条键位来自键位数据集，按数据集的 \`scope\` 分 ${counts.keysScopes} 组渲染；` +
          '键位与动作都来自源码真源（`input/keymap.ts`、`ui/PromptInput.tsx`、`ui/App.tsx`、`ui/overlays/ConfirmDialog.tsx`），' +
          '所以这里的一行就是终端里的一行。',
      },
      {
        t: 'h2',
        text: '怎么一次看到全部键位',
      },
      {
        t: 'p',
        md:
          '头部右上角只有一件事：`^G more`。按 {kbd:Ctrl+G} 右侧滑出**只读抽屉**，把所有键位自上而下列出：' +
          '每行是「键 + 作用关键词」，选中行下面再用一句话解释它到底做什么。',
      },
      {
        t: 'ul',
        items: [
          '分组固定为 `COMPOSE / RUN / PANELS / SESSION / VIEW`；窗口够高时组头单独成行，80×24 下组头让位，把行数留给键。',
          '翻页 = 移动光标一页，视窗永远覆盖选中行，所以「这个键做什么」那句不会滑出屏幕。',
          '抽屉里只有两个动作键：`d` 切状态详情行，`r` 重新生成任务摘要。**回车不会启动任何东西。**',
          '`/keys [query]` 是同一入口的命令面（脚本、粘贴、读屏软件都得有路可走），`query` 按 id / 键位 / 关键词预过滤。',
        ],
      },
      ...keyScopeTables,
      {
        t: 'h2',
        text: '平台与终端差异',
      },
      {
        t: 'p',
        md:
          '键位本身跨平台一致，但**终端能不能把它送进来**不是同一件事。下表只列会在真机上遇到的四处，' +
          '每一处都有一个不需要终端配合的兜底。',
      },
      {
        t: 'table',
        caption: '四处平台差异与兜底',
        head: ['场景', '症状', '兜底'],
        rows: [
          [
            'Windows 下 {kbd:Shift+Tab}',
            '控制台把修饰键吞掉，到达进程的只是普通 `Tab`（`09`）。Node < 22.17 上可以预期',
            '{kbd:Ctrl+N}：同一个开关，走控制台吃不掉的通道；`/plan` 是命令面等价物',
          ],
          [
            '不支持键盘增强的终端里的 {kbd:Shift+Enter}',
            '与 `Enter` 同为 CR，一按就发送',
            '{kbd:Ctrl+J} 换行；或按 `/terminal-setup` 给终端加一条「Shift+Enter 发送 CSI 13;2u」的绑定',
          ],
          [
            '{kbd:Ctrl+I}（建项目索引）',
            '旧编码下它就是 `Tab` 字节，于是变成补全输入',
            '`/skill:project-indexer` 或 `/project-indexer` 直接跑',
          ],
          [
            '{kbd:Ctrl+K}（kit 选择器）',
            '窄于 79 列时头部让位成 `^L` / `^I` 提示',
            '`/kit`；原来的「删到行尾」搬到了 {kbd:Alt+K}',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '哪些键只在某种滚动模式下有效',
        md:
          '{kbd:PgUp} / {kbd:PgDn} 翻浮层在任何模式都有效，但**滚动转录**只在 `--scroll-mode app` 下有效；' +
          '{kbd:Shift+Up} / {kbd:Shift+Down} 更是全屏模式专属。默认原生模式下滚轮、滚动条、选中与搜索都是终端自己的，' +
          '`aragon` 连鼠标上报都不打开。见 [滚动、主题与渲染性能](/guide/scroll-themes/)。',
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '`Esc` 的三种含义要分清',
        md:
          '关浮层 / 取消等待中的确认（空闲时还取消自动续跑）、1.5 秒内两次中断运行、运行还没停时再按一次强制停止。' +
          '三级阶梯的完整说明在 [输入、队列与中断](/guide/input-queue/)。',
      },
    ],
  },

  {
    id: 'guide/slash-commands',
    title: '斜杠命令',
    group: 'guide',
    order: 30,
    phase: 'A',
    template: 'flags',
    summary:
      `${counts.commands} 条斜杠命令按主题分组：${counts.commandsBuiltin} 条内置命令加 ${counts.commandsFamily} 条命令族，逐条给出别名与源码原文说明，并说明斜杠输入、参数与转义规则。`,
    keywords: ['斜杠命令', 'slash command', '/help', '/clear', '/compact', '别名', '命令族'],
    seeAlso: ['guide/keybindings', 'guide/skills', 'cli/subcommands'],
    sourceRefs: [
      { path: 'packages/cli/src/commands/builtins.ts', lines: '289', snippet: 'const COMMANDS: SlashCommand[] = [' },
      {
        path: 'packages/cli/README.md',
        lines: '973-975',
        snippet: 'A leading `/` meant literally can be escaped as `//`.',
      },
      { path: 'packages/cli/src/commands/queue-command.ts', lines: '1-8', snippet: "name: 'queue'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          `本页渲染斜杠命令数据集的全部 ${counts.commands} 条记录，按数据集里的 ${counts.commandsTopics} 个主题分组；` +
          '第 3 列是**源码里的 `description` 原文**，站点不翻译它——因为「准确」优先于「顺口」。',
      },
      {
        t: 'h2',
        text: '输入规则',
      },
      {
        t: 'ul',
        items: [
          '行首打 `/` 打开命令调色板；`Tab` / `→` 接受高亮候选，{kbd:Up} / {kbd:Down} 移动，{kbd:Esc} 关闭。',
          '`@` 打开文件路径补全，与 `/` 是两套弹层，互不干扰。',
          '想**字面**打一个开头的斜杠，写 `//`。',
          '命令后面可以带参数：`/model claude-sonnet-4-5`、`/theme light`、`/todo follow auto`、`/compact 只保留接口签名`。',
          '装好的技能本身就是斜杠命令（`/pdf-forms invoice.pdf --flatten`）。名字与内置命令撞车时**内置命令优先**，技能退到 `/skill:<name>`。',
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '别名是同一份实现，不是两份',
        md:
          '数据集里只有 `/reset → /clear` 与 `/quit → /exit` 两组别名，源码的做法是**共用同一个 run 函数**，' +
          '所以两条命令不可能漂移。别名在本页表里与主命令列在同一行。',
      },
      {
        t: 'h2',
        text: '两个来源：内置命令与命令族',
      },
      {
        t: 'table',
        caption: '命令集的口径（数字由数据集现算）',
        head: ['来源', '条数', '定义位置', '增删一条要动哪里'],
        rows: [
          [
            '内置命令（`kind: builtin`）',
            `${counts.commandsBuiltin}`,
            '`commands/builtins.ts` 的 `COMMANDS` 数组，别名写在同一条记录的 `aliases`',
            '数组里加一条；`/help`、`/keys` 与命令调色板自动跟上',
          ],
          [
            '命令族（`kind: family`）',
            `${counts.commandsFamily}`,
            '各自模块里唯一的 `name: \'<命令>\'` 字面量，经 `CommandRegistry` 注册',
            '新模块 + 一次注册调用；族内子动作各自解析参数',
          ],
          ['合计', `${counts.commands}`, '—', '—'],
        ],
      },
      {
        t: 'p',
        md:
          `源码里有 ${counts.commandsNoDesc} 条命令没有 \`description\`（\`team\`、\`fast\`、\`todo\`、\`compact\` 这类开关型命令），` +
          '本页把它们显示为 `—`，而不是替它们编一句说明。要看真实子动作，用命令本身：`/team`、`/fast`、`/todo`、`/compact` 都自带 status。',
      },
      {
        t: 'h2',
        text: '按主题的命令清单',
      },
      ...commandTopics.flatMap(([topic, records]) => [{ t: 'h3', text: topic }, commandTable(topic, records)]),
      {
        t: 'h2',
        text: '命令族：一个入口，多个子动作',
      },
      {
        t: 'p',
        md:
          '命令族与内置命令的区别不在于「能不能带参数」，而在于**子动作由模块自己分派**。它们的参数表更长，' +
          '而且多数支持不带参数时报告当前状态——这是最安全的一次试探。',
      },
      {
        t: 'table',
        caption: `${counts.commandsFamily} 条命令族的子动作（取自 README 的命令表）`,
        head: ['命令族', '子动作'],
        rows: [
          ['`/queue`', '无参数：分页查看所有待处理消息的完整原文'],
          ['`/kit`', '`list`、`use <name|current>`；不带参数报告当前生效的 kit 与来源'],
          ['`/prompts`', '`manage`、`list`、`show`、`add`、`edit`、`rm`、`move`、`favorite`、`sort`'],
          ['`/agents`', '无参数：打开只读子代理看板（与 {kbd:Ctrl+B} 同一块）'],
          ['`/keys`', '`[query]`：打开快捷键抽屉，`query` 预过滤'],
          ['`/task`', '`refresh`：用最后一条用户消息重新生成头部任务摘要'],
          ['`/skills`', '`list`、`info`、`install`、`update`、`remove`、`create`、`path`、`doctor`、`usage`、`trust`、`policy`、`unload`'],
        ],
      },
      {
        t: 'h2',
        text: '常用组合',
      },
      {
        t: 'code',
        lang: 'text',
        title: '三次按键回答三个问题',
        code: [
          '/context            # 我现在占了多少上下文，窗口数字哪来的',
          '/compact status     # 压缩到底开着没有、阈值多少、这次会话压过几次',
          '/todo status        # 计划面板是没数据还是被窗口挤掉了',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '`/clear` 不是清屏',
        md:
          '`/clear` 会打断正在跑的运行、归档旧会话、清掉上下文/队列/转录/TODO；只想清屏用 `/clear screen`。' +
          '两者的完整差异见 [界面导览](/guide/tui/)。',
      },
      {
        t: 'p',
        md:
          '命令与 shell 子命令不是一回事：`aragon config set` / `aragon skills install` 跑在 shell 里，适合脚本与 CI，' +
          '见 [子命令](/cli/subcommands/)。',
      },
    ],
  },

  {
    id: 'guide/input-queue',
    title: '输入、队列与中断',
    group: 'guide',
    order: 40,
    phase: 'A',
    template: 'prose',
    summary:
      '运行中发送的消息进队列，只有 Core 发出接收凭据后才算进入历史。本页说明队列语义、Esc 的 1.5 秒中断阶梯、引导与后续消息的区别。',
    keywords: ['队列', 'queue', 'steering', 'Esc', '中断', 'followUp', '接收凭据'],
    seeAlso: ['guide/tui', 'guide/keybindings', 'exec/budgets'],
    sourceRefs: [
      { path: 'packages/cli/README.md', lines: '1171-1185', snippet: 'Queue: also check the tests' },
      { path: 'packages/core/src/engine/accept-steering.ts', lines: '1-15', snippet: 'steering_accepted' },
      { path: 'packages/cli/src/input/interrupt-gesture.ts', lines: '1-28', snippet: 'INTERRUPT_CONFIRM_MS = 1500' },
      { path: 'packages/cli/src/ui/App.tsx', lines: '2693', snippet: 'RUNG ONE' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '一个正在跑的任务不该让你闭嘴，也不该让你打断它。所以 {kbd:Enter} 在运行时的含义是**入队**：' +
          '输入框照常编辑和发送，消息排到 `Queue` 面板里，等引擎在它自己的检查点接住。',
      },
      {
        t: 'h2',
        text: '运行时打字会发生什么',
      },
      {
        t: 'table',
        caption: '发送时机与后果',
        head: ['时机', '行为', '你看到什么'],
        rows: [
          [
            '空闲时 {kbd:Enter}',
            '开一轮新运行，历史立即追加',
            '你那条消息出现在转录里，状态行进入运行态',
          ],
          [
            '运行中 {kbd:Enter}',
            '进队列，等引擎写入历史',
            '`Queue` 面板出现一行 `◷ Queue: ...`，固定状态栏显示真实待处理总数',
          ],
          [
            '引擎接住之后',
            '整批写入对话历史并发出 `steering_accepted` 回执',
            '**此时** Queue 那一行才移除；`turn_start`、动画、提示超时都不能代替回执',
          ],
          [
            '中断或失败后',
            '未被接收的消息**保留**并标记暂停',
            '`/queue` 仍能看到全文；`/save` 会把这些未发送正文补回',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么回执值得单独说',
        md:
          '「消息从我屏幕上消失」和「消息进了模型的历史」是两件事。只有后者才能保证下一轮真的看到了你的修补。' +
          'Core 用带 id 的回执把两件事绑在一起：`SteeringAcceptedEvent` 里的 id 就是两条消息的对应关系。',
      },
      {
        t: 'ul',
        items: [
          '相同正文的两次发送**仍是两条消息**，不会去重。',
          '`/queue` 分页查看所有待处理消息的完整原文；它们不会在普通转录里重复显示。',
          '窄屏下优先保留运行状态、待处理数量和上下文，其余字段整项隐藏，但**关键数值不会被截断成残数**。',
          '`/clear` 清空队列；`/clear screen` 只清屏，队列不动。',
        ],
      },
      {
        t: 'h2',
        text: '引导（steer）与后续（follow-up）',
      },
      {
        t: 'p',
        md:
          '队列里其实有两种意图，引擎用两个方法区分。**引导**是「趁现在改方向」，**后续**是「等这轮完了再做」。' +
          '引导只有一个安全检查点：循环顶部、下一次 LLM 调用之前；在那里整批入历史，并先发回执再让任何监听器有机会中止或再入队。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '那个检查点就是全部',
        code: [
          '// engine/accept-steering.ts',
          'const items = ctx.messageQueueManager.drainSteeringItems();',
          'for (const item of items) {',
          '  ctx.messageManager.push({ role: \'user\', content: item.text, timestamp: Date.now() });',
          '  if (item.id !== undefined) ids.push(item.id);',
          '}',
          '// 整批必须已在历史里，监听器才可能中止或再入队',
          'if (ids.length > 0) ctx.emit({ type: \'steering_accepted\', ids });',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '实用判断',
        md:
          '想改变**正在做的这一轮**，用引导（运行中直接发）。想加一件**下一件要做的事**，等这轮结束再发，' +
          '或者用 `/todo` 把它写进计划——排队中的后续消息不会自己变成一轮。',
      },
      {
        t: 'h2',
        text: 'Esc 的三级阶梯',
      },
      {
        t: 'p',
        md:
          '中断用 {kbd:Esc} 而不是 {kbd:Ctrl+C}：后者是退出。三次按键对应三种意图，代码里的确认窗口是一个常量 `INTERRUPT_CONFIRM_MS = 1500`。',
      },
      {
        t: 'table',
        caption: '三级阶梯（第 2 级与第 3 级不可越过）',
        head: ['手势', '动作', '边界条件'],
        rows: [
          [
            '{kbd:Esc} 一次',
            '关浮层 / 取消等待中的确认；空闲时取消自动续跑',
            '有浮层时不会升级成中断',
          ],
          [
            '{kbd:Esc} 两次（1.5 秒内）',
            '中断当前运行（`abort`）',
            '中间按了别的键、或关掉菜单，第一次按键作废；关计划卡不算第一次',
          ],
          [
            '中断后再按 {kbd:Esc}',
            '强制停止（`force-stop`）：杀掉前台 shell 命令并回到 `idle`',
            '后台**服务**继续运行，不会被这一下带走',
          ],
          [
            '{kbd:Ctrl+C} 两次',
            '退出会话',
            '第一次只警告；有服务在跑时第一次先停服务，不给退出上膛',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '关掉计划卡不等于停止',
        md:
          '在计划评审卡上按 {kbd:Esc} 的意思是「这个计划还不够好，改一版再提交」，所以模型会继续提交。' +
          '真要停这条运行：先 {kbd:Esc} 关卡片，再在 1.5 秒内按两次 {kbd:Esc}。见 [计划模式](/guide/plan-mode/)。',
      },
      {
        t: 'h2',
        text: '怎么知道它真的停了',
      },
      {
        t: 'ul',
        items: [
          '状态行回到 `idle`，tok/s 变回 `--`，耗时冻结在停下的那一刻。',
          '被中断的那一轮在转录里留下一条通知；你用两次 {kbd:Esc} 主动中断的那种，现在不再复述「你刚打断了什么」。',
          '`/bg list` 还会列出活着的后台作业——中断一轮不等于杀掉你之前起的 dev server。',
          '队列里没被接收的消息还在，标记为暂停，`/queue` 可读全文。',
        ],
      },
    ],
  },

  {
    id: 'guide/plan-mode',
    title: '计划模式',
    group: 'guide',
    order: 50,
    phase: 'A',
    template: 'prose',
    summary:
      '计划模式把会话切到只读：六个变更类工具在工具边界被拒，代理先提问、再提交计划，批准后立刻回到 BUILD 并继续同一轮实现。',
    keywords: ['plan mode', '计划模式', 'submit_plan', 'ask_user', 'Shift+Tab', '批准'],
    seeAlso: ['guide/todo', 'guide/team', 'tools/plan'],
    sourceRefs: [
      { path: 'packages/cli/src/tools/plan-tools.ts', lines: '182-198', snippet: 'Present the implementation plan for approval.' },
      { path: 'packages/cli/src/tools/plan-tools.ts', lines: '199', snippet: 'Plan approved. You are now in Build mode' },
      { path: 'packages/cli/README.md', lines: '1557-1560', snippet: 'five tools are refused at the tool boundary' },
      { path: 'packages/cli/README.md', lines: '1621', snippet: 'Tightening applies at once; loosening waits.' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '`BUILD` 适合「把这个符号改个名」。`PLAN` 适合「加多租户支持」——任何你想在**一个字节变化之前**先看到并调整方案的任务。',
      },
      {
        t: 'h2',
        text: '两种姿态',
      },
      {
        t: 'table',
        caption: 'BUILD 与 PLAN',
        head: ['模式', '含义', '适合'],
        rows: [
          ['`BUILD`', '默认。你问，它做', '局部重命名、修一个明确的 bug、跑一条命令'],
          ['`PLAN`', '只研究与设计：读、问你读不出来的决定、提交计划等批准', '跨模块改造、迁移、方案未定的大任务'],
        ],
      },
      {
        t: 'h2',
        text: '它到底挡住了什么',
      },
      {
        t: 'p',
        md:
          '挡在**工具边界**，不是写在提示词里的承诺：调用发生之前就被拒，所以状态行的徽标说的是一件结构上成立的事。' +
          '被拒的是六个变更类工具（其中 `bash_kill` 也拦，因为它会结束一个进程），其余照常。',
      },
      {
        t: 'table',
        caption: 'PLAN 下的工具可见性（拒绝发生在执行前）',
        head: ['工具', 'PLAN 下', '说明'],
        rows: [
          ['`write_file`', '拒绝', '没有例外'],
          ['`edit_file`', '拒绝', '没有例外'],
          ['`bash`', '**整体拒绝**，`git status` 也一样', '没有可靠办法把一条 shell 串分类成只读'],
          ['`skill_install`', '拒绝', '安装会写磁盘'],
          ['`skill_create`', '拒绝', '同上'],
          ['`bash_kill`', '拒绝', '会终止一个进程，属于「改变世界」；用户仍可用 `Ctrl+C` / `/bg stop`'],
          ['`read_file` / `list_dir` / `glob` / `grep`', '允许', '拒绝消息里会点名这四个，让代理有路可走'],
          ['`task`（团队）', '允许，但子代理继承同一道门', '并行研究是计划模式最好的用法'],
          ['`ask_user` / `submit_plan`', '仅交互式', '`-p` 下不注册：没有人可问'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么不给 `bash` 开白名单',
        md:
          '一个 95% 正确的门禁比一个永远正确的门禁更糟：你会停止相信徽标。所以这里没有基于子串匹配的允许列表，将来也不会有。' +
          '只读需求用 `read_file` / `glob` / `grep`，它们本来就在。',
      },
      {
        t: 'h2',
        text: '两个工具：ask_user 与 submit_plan',
      },
      {
        t: 'p',
        md:
          '`ask_user` 渲染一个键盘驱动的向导：1–5 个问题、每题 2–4 个选项，恰好一个标 `RECOMMENDED`，外加一个 `Other…` 自由文本项。' +
          `{kbd:Up} / {kbd:Down} 选择，{kbd:Enter} 确认并前进，{kbd:←} 返回，{kbd:Esc} 取消；{kbd:Space} 标记但不前进。` +
          '一路 {kbd:Enter} 按到底 = 接受全部推荐，这是刻意的「你看着办」路径。',
      },
      {
        t: 'p',
        md: '`submit_plan` 的契约由参数定义，必填三项；其余为可选的结构化信息：',
      },
      toolParams('submit_plan'),
      {
        t: 'table',
        caption: '可选字段与上限（由截断而非拒绝执行）',
        head: ['字段', '上限', '用途'],
        rows: [
          ['`filesTouched`', '30 项', '预判会动的文件，批准后实现要守住这份清单'],
          ['`risks`', '10 项', '风险点，评审时最先看这里'],
          ['`openQuestions`', '10 项', '还没定的问题；也可以在提交前用 `ask_user` 先问掉'],
          ['`title` / `summary` / `steps`', '80 / 600 / 20 步（每步 title 100、detail 400）', '超限是截断不是报错，所以别指望超长内容被保留'],
        ],
      },
      {
        t: 'h2',
        text: '批准、反馈与离开',
      },
      {
        t: 'steps',
        items: [
          {
            title: '`a` 批准 → 立刻回到 `BUILD`，同一轮继续实现',
            code: { lang: 'text', code: 'Plan approved. You are now in Build mode - implement the plan step by step, in order.' },
            md: '不需要你再发一次「开始做」。这是唯一一处「不按阶梯等待」的模式切换，因为批准是一个有意识的行为。',
          },
          {
            title: '`r` 写一行反馈 → 模型改稿再提交',
            md: '{kbd:Enter} 发送反馈，{kbd:←} 回到卡片。反馈会原样进入工具结果（`Plan rejected. The user\'s feedback: ...`）。',
          },
          {
            title: '{kbd:Esc} 关闭卡片 → 要求更好的计划',
            md: '模型被告知「细化后再次提交」。这不等于停止运行；要停运行请接着按两次 {kbd:Esc}。',
          },
          {
            title: '取消不是错误',
            md: '取消 `ask_user` 或 `submit_plan` 之后，模型被要求按已陈述的假设继续推进，而不是重试同一个调用。',
          },
        ],
      },
      {
        t: 'h2',
        text: '在哪些地方切换',
      },
      {
        t: 'table',
        caption: '五种等价入口与它们各自的适用面',
        head: ['入口', '适用', '备注'],
        rows: [
          ['{kbd:Shift+Tab}', '日常切换', 'Windows 上需要控制台标志；Node < 22.17 可能被吞'],
          ['{kbd:Ctrl+N}', '上面那行失效时', '走控制台吃不掉的通道'],
          ['`/plan [on|off|status]`', '任何终端、任何平台', '命令面等价物，也是脚本里能写的那条'],
          ['`--plan` / `ARAGON_PLAN=1` / `planModeDefault`', '启动即只读', '适合「这次只给我方案」的一次性运行'],
          ['`aragon -p --plan "..."`', '无头批处理', '只读门仍生效；没有问答工具，最终消息就是计划正文'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '收紧立即生效，放松要等这一轮结束',
        md:
          '运行中朝 `PLAN` 切换立刻生效——你按它正是因为代理马上要做点什么。朝 `BUILD` 切换会**推迟到本轮结束**，' +
          '否则一个只读保障中的会话会因为你误触一个键开始写文件。等待期间状态行显示 `PLAN>BUILD`；' +
          '批准计划是唯一例外。',
      },
      {
        t: 'h2',
        text: '怎么确认自己在哪一边',
      },
      {
        t: 'ul',
        items: [
          '状态行第一行永远写出模式：`BUILD` 或 `PLAN`（窄屏为 `B` / `P`），`PLAN>BUILD` 表示切换待生效。',
          '输入框边框在计划模式下染色；{kbd:Ctrl+G} 的细节行重复一遍模式。',
          '`/plan status` 是任何宽度、任何模式下都能问的那条路。',
          '`aragon doctor` 报告本机的 `vt-input`，那是 `Shift+Tab` 能不能用的机器答案。',
        ],
      },
    ],
  },

  {
    id: 'guide/todo',
    title: 'TODO 与验收标准',
    group: 'guide',
    order: 60,
    phase: 'A',
    template: 'prose',
    summary:
      'todo_write 一次写完整清单：最多 20 项，可附验收标准，全部完成后进入 VERIFY 阶段。本页说明面板渲染、验收证据与 follow 策略。',
    keywords: ['TODO', 'todo_write', '验收标准', 'VERIFY', '计划栏', 'acceptance'],
    seeAlso: ['guide/plan-mode', 'guide/team', 'tools/plan'],
    sourceRefs: [
      { path: 'packages/cli/src/todo/todo-tool.ts', lines: '126-135', snippet: "name: 'todo_write'" },
      { path: 'packages/cli/src/todo/limits.ts', lines: '18-30', snippet: 'maxItems: 20,' },
      { path: 'packages/cli/README.md', lines: '1773', snippet: 'They arrive in the **same** `todo_write` call' },
      { path: 'packages/cli/README.md', lines: '1756', snippet: '/todo panel off' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '三步以上的活，代理会维护一份**看得见的计划**：用 `todo_write` 写清单，恰好一项标为进行中，做完一项打勾再开下一项。' +
          '要一件一分钟的事，面板不会出现——系统提示明确要求它别为一步两步的活、一个问题、一次没带改动的搜索去调这个工具。',
      },
      {
        t: 'h2',
        text: 'todo_write 的契约',
      },
      {
        t: 'p',
        md:
          '一个工具、一个写者、一次**完整替换**。每次调用都重写整份清单，所以「把某项从列表里悄悄去掉」不会生效于验收判定——' +
          '这是它和「在别处追加一行」最重要的区别。',
      },
      toolParams('todo_write'),
      {
        t: 'table',
        caption: '两条结构性上限（不是配置项）',
        head: ['上限', '值', '越界行为'],
        rows: [
          ['一份计划的步骤数', '20（`TODO_LIMITS.maxItems`）', '多余项被丢弃，不是报错'],
          ['单项的标题长度', 'schema 只声明形状，不声明 `enum` / `maxItems`', '由工具侧归一化，不靠 JSON Schema 拦'],
        ],
      },
      {
        t: 'h2',
        text: '验收标准与 VERIFY',
      },
      {
        t: 'p',
        md:
          '计划是承诺，验收标准是证据。同一次 `todo_write` 里还带第二组数组：每一行写「怎么知道这块真做完了」，' +
          '并给出打算跑的检查。因为它们同一次调用到达，就不可能和步骤漂移。',
      },
      {
        t: 'code',
        lang: 'json',
        title: '一次调用同时写两份',
        code: [
          '{',
          '  "todos": [ /* content + status，最多 20 项 */ ],',
          '  "acceptance": [',
          '    { "content": "80x24 终端上计划栏显示 3 项", "check": "改窗口大小看一眼" },',
          '    { "content": "npm test 全绿", "check": "npm test" }',
          '  ]',
          '}',
        ].join('\n'),
      },
      {
        t: 'ul',
        items: [
          '全部步骤完成后计划进入 **VERIFY**：逐条核对，结论必须带上**看到的东西**（`evidence`）。',
          '没有 evidence 的结论会掉回「未核对」；想把已通过的条目重新打开，用 `reopen: true` 或 `/todo acceptance reset`。',
          '把某条从下一次清单里省略**不会**撤销结论——这正是验收表独立存在的原因。',
          '失败条目才是重点：转录卡片逐条列出失败项与其证据，`/todo status` 随时重印那张表。',
        ],
      },
      {
        t: 'h2',
        text: '面板怎么渲染',
      },
      {
        t: 'code',
        lang: 'text',
        title: '右栏（全屏模式，目标占终端宽度 15%）',
        code: [
          ' transcript ...                     | TODO             7/7',
          '                                    | ####------',
          '                                    |',
          '                                    |    all steps complete',
          '                                    | VERIFY           2/5 !1',
          '                                    | x npm test 全绿',
          '                                    | ! 启动没有控制台报错',
          '                                    | > README 已记录',
        ].join('\n'),
      },
      {
        t: 'table',
        caption: '三种显示形态与它们的取舍',
        head: ['形态', '出现条件', '内容'],
        rows: [
          ['右栏（rail）', '≥ 76 列、共享区 ≥ 3 行、未开浮层', '标记 + 序号 + 进行中条目的 `activeForm` + 进度条，下方再挂验收段'],
          ['单行任务条（inline）', '`--scroll-mode` 之外的 inline 模式', '`todo 3/7  >  正在做的事   +2 done`，永不换行、永不超过一行'],
          ['状态行计数', '右栏放不下时', '`Accept 2/5` 或 `todo` 计数；`/todo status` 里的 `Panel: on` 只说明配置开着'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '看不见不等于没有',
        md:
          '右栏在低于 76 列、共享区不足 3 行、打开浮层、显式关面板、没有任务、或 inline 模式下都不显示。' +
          '区分「没生成计划」与「暂时隐藏」的办法只有一个：`/todo status`。',
      },
      {
        t: 'h2',
        text: '一轮结束但还有步骤没做完',
      },
      {
        t: 'table',
        caption: '`/todo follow` 的三种模式',
        head: ['模式', '行为', '适合'],
        rows: [
          ['`notify`（默认）', '给你一条提示和 `/todo continue`，**不自动续跑**', '想自己决定何时继续'],
          ['`auto`', '宣布 `Continuing with N remaining steps in 3s - Esc to stop.`，等一会儿自己续跑', '长时间无人值守的批量改造'],
          ['`off`', '没有提示，没有续跑', '只要清单，不要追进度'],
        ],
      },
      {
        t: 'ul',
        items: [
          '`/todo continue` 发的是**还开着的步骤编号列表**，所以几轮前滚出上下文窗口的计划仍被精确执行。',
          '`auto` 有两道结构性上限，都不是设置项：一次没完成任何步骤的续跑只再给一次机会；一份计划最多续跑 25 次。',
          '以**错误**结束的一轮在任何模式下都不自动续跑，只会给一条警告；你用两次 {kbd:Esc} 主动中断的那种什么都不说。',
          '`-p` 下没有宽限窗口，只有两个计数器；`[todo] 3 steps unfinished` 打到 stderr，且**不改变退出码**。',
        ],
      },
      {
        t: 'h2',
        text: '关掉它',
      },
      {
        t: 'table',
        caption: '四个开关，覆盖面不同',
        head: ['开关', '作用范围', '副作用'],
        rows: [
          ['`/todo off`', '本次会话', '工具不再工作、系统提示里的指导被摘掉；工具列表本身不变（启动时固定）'],
          ['`/todo panel off`', '本次会话的显示', '保留计划纪律，只藏那根栏；读屏软件场景就是它'],
          ['`--no-todo-panel`', '整个会话', '连 inline 的单行条一起藏'],
          ['`--no-todo` / `todo.enabled: false`', '整场运行', '不注册 `todo_write`，提示块按字节消失'],
        ],
      },
      {
        t: 'p',
        md:
          '`/clear` 会连计划一起清掉（会话没了）；`/clear screen` 与 `/todo clear` 只把计划从屏幕上拿走，' +
          '模型仍知道自己做到哪，下一次更新会把面板带回来。计划会写进 `/save`，也会被 `/resume` 恢复。',
      },
    ],
  },

  {
    id: 'guide/team',
    title: '团队子代理',
    group: 'guide',
    order: 70,
    phase: 'A',
    template: 'prose',
    summary:
      'task 工具把独立的任务分给 2–5 个子代理并行执行，默认 3 个并发、上限 10，最后合并成一份文本报告，失败的部分不影响整体。',
    keywords: ['team', '子代理', 'subagent', 'task', '并行', 'dispatch', 'supervisor'],
    seeAlso: ['guide/plan-mode', 'guide/models', 'guide/context'],
    sourceRefs: [
      { path: 'packages/cli/src/team/task-tool.ts', lines: '113-120', snippet: 'export function createTaskTool' },
      { path: 'packages/cli/src/team/task-tool.ts', lines: '96-111', snippet: 'Do NOT use it when one part needs another part' },
      { path: 'packages/cli/src/config/schema.ts', lines: '962', snippet: 'maxConcurrent: 3,' },
      { path: 'packages/cli/src/team/limits.ts', lines: '47', snippet: 'hardMaxSubagents: HARD_MAX_SUBAGENTS,' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '派活由代理自己决定：一次只跑一个子代理、或者从不调用 `task` 的会话，就是没有这个功能时的样子。' +
          '你看到的不是一个新面板，而是**同一份转录里的并行卡片**和一份合并后的报告。',
      },
      {
        t: 'h2',
        text: 'task 工具',
      },
      toolParams('task'),
      {
        t: 'p',
        md:
          '`prompt` 必须是**自足的完整简报**：子代理有自己独立的消息历史，看不到你的对话。' +
          '它拿同一套工具、同一个工作目录，不能再次派活（深度按构造固定为一层），也不能向你提问。',
      },
      {
        t: 'h2',
        text: '规模：默认 5 个、3 个并发、硬上限 10',
      },
      {
        t: 'table',
        caption: '宽度的四个数（配置来自 `DEFAULT_TEAM_CONFIG`，上限来自 `TEAM_LIMITS`）',
        head: ['设置', '默认', '范围 / 上限', '为什么要分开'],
        rows: [
          ['`team.maxSubagents`', '5', '1–10（硬上限 10，任何配置文件都抬不上去）', '一次派活的宽度'],
          ['`team.maxConcurrent`', '3', '1–10', '同时在建的流；5 条并行最容易集体撞限流，而每一条都会在报告里变成一个失败'],
          ['`team.subagentTimeoutMs`', '0（不限）', '0–1800000', '与主代理对齐：子代理跑到自己结束'],
          ['`team.maxTurnsPerSubagent`', '0（不限）', '0–100', '同样对齐主代理'],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '常见规模是 2–4',
        md:
          '工具描述的写法是 `2-5 independent subagents to run in parallel`。少于 2 个不值得一次派活，' +
          '多于 5 个要显式放宽 `maxSubagents`，而收益通常不如把任务拆成两批。',
      },
      {
        t: 'h2',
        text: '什么时候不要用',
      },
      {
        t: 'ul',
        items: [
          '**一段依赖另一段的结果**：自己做，按顺序做。并行代理之间没有因果链。',
          '**两个部分要改同一个文件**：报告会警告「两个子代理写了同一个文件」，而它只能看见 `write_file` / `edit_file` 的写入，走 `bash` 的写入它看不见。',
          '**改动小到自己一分钟能做完**：派活的固定开销比改动大。',
          '**需要向你确认某个决定**：子代理问不了你，它只会卡住或猜。',
        ],
      },
      {
        t: 'h2',
        text: '结果怎么合并',
      },
      {
        t: 'p',
        md:
          '一次派活返回**一个文本结果**：先是带 ok / failed 计数、汇总 token 与成本的标题，然后每个子代理一节——状态、耗时、' +
          '它写过的文件、它自己的最终总结。失败的子代理**不会**让整次派活失败：部分结果是这种并行派活的正常结局。',
      },
      {
        t: 'ul',
        items: [
          '转录里留下一条团队卡片，`{kbd:Ctrl+O}` 展开成各家的总结；派活结束名册消失，卡片保留。',
          '`{kbd:Ctrl+B}` 或 `/agents` 打开只读看板：每个子代理的状态、轮次、工具、token、文件、邮件、supervisor 动作、最近 24 条事件。',
          `子代理之间可以用 \`team_send\` / \`team_wait\` 互相说话（这两个只发给子代理，不在工具数据集的 ${counts.tools} 条里）。`,
          '`-p` 下同样的过程写成 stderr 的 `[team] a1 ok 22.1s 7 tools`，子代理的 token 折进 `[usage]`。',
        ],
      },
      {
        t: 'h2',
        text: 'supervisor：超时是检查信号，不是死刑',
      },
      {
        t: 'p',
        md:
          '每次派活都有一个跑在 fast 档上的 supervisor。它按几何级数加密检查（基准 5 分钟、×1.6、封顶 15 分钟），' +
          '一次批量调用带上全部活跃子代理，给每个孩子一个决定：继续等、注入一句指点、带上修正简报重建、或记录理由放弃。',
      },
      {
        t: 'table',
        caption: '结构预算（不是设置项）',
        head: ['预算', '每孩子每次派活', '用完之后'],
        rows: [
          ['检查（looks）', '12', '说一次 `quiet`，不再叫醒这个孩子；失败的检查也算一次 look'],
          ['指点（nudges）', '3', '不再注入建议'],
          ['重建（replacement）', '1', '重建后仍卡住就让它自己的看门狗收尾'],
          ['放弃（abandon）', '1', '在报告里留下理由'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: 'fast 档没配时会怎样',
        md:
          '缺 key 或 `/fast off` 时，到点的检查降级为「无协助等待」：孩子继续跑，报告写明有几次检查是降级的，**没有东西被杀**。' +
          '设置屏 `Team` 页的 `Supervisor` 行（或 `aragon config set team.overseer false`）是回到老规矩的逃生门——那时 `team.subagentTimeoutMs` 又变成硬中止。',
      },
      {
        t: 'h2',
        text: '中断与其它子系统的交互',
      },
      {
        t: 'ul',
        items: [
          '两次 {kbd:Esc}（1.5 秒内）中止整次派活：所有子代理在两秒内停下，报告标 `ABORTED` 并带上已完成的部分。',
          '计划模式往下传一层：`PLAN` 里每个子代理都带同一道只读门。单个子代理还能用 `readOnly: true` 再收紧（只能收紧）。',
          '技能的 `allowed-tools` 上限也往下传一层，所以派活不是绕过它的办法；子代理有 `skill_find` 但没有 `skill`。',
          '`--confirm` 会把子代理的确认排队、逐条弹出，并标注是谁在问（`[a2] Write: src/routes.ts`）。',
        ],
      },
    ],
  },

  {
    id: 'guide/skills',
    title: '技能',
    group: 'guide',
    order: 80,
    phase: 'A',
    template: 'prose',
    summary:
      '技能是写在磁盘上的专家流程：SKILL.md 加 frontmatter，三级渐进加载，allowed-tools 在当轮形成工具上限。含安装、创建与 doctor 自检。',
    keywords: ['技能', 'skill', 'SKILL.md', 'frontmatter', 'allowed-tools', 'skills doctor'],
    seeAlso: ['api/skills', 'tools/skills', 'cli/command-families'],
    sourceRefs: [
      { path: 'packages/core/src/skills/constants.ts', lines: '18-22', snippet: 'SKILL_CATALOG_MAX_BYTES = 6000' },
      { path: 'packages/core/src/skills/types.ts', lines: '14-22', snippet: 'allowedTools: string[];' },
      { path: 'packages/cli/README.md', lines: '2975', snippet: 'allowed-tools: [read_file, bash]' },
      { path: 'packages/cli/README.md', lines: '3043', snippet: 'Scope is one turn.' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '一个技能就是磁盘上的一个目录：一份 `SKILL.md`（YAML frontmatter + Markdown 正文），可选 `reference/`、`scripts/`、`assets/`。' +
          '格式与 Claude Code 一致，现成的社区技能目录可以直接用。',
      },
      {
        t: 'tree',
        root: '~/.aragon-agent/skills/pdf-forms/',
        lines: [
          'SKILL.md          # frontmatter + 正文，唯一会进上下文的文件',
          'reference/        # 大段参考材料，模型按需 read_file',
          'scripts/          # 可执行脚本，只在模型调用 bash 时运行',
          'assets/           # 模板、字体等静态文件',
        ],
      },
      {
        t: 'h2',
        text: 'frontmatter：哪些键真的有用',
      },
      {
        t: 'code',
        lang: 'text',
        title: '一份最小可用的 frontmatter',
        code: [
          '---',
          'name: pdf-forms          # 必填，kebab-case，<= 64 字符',
          'description: 填写、压平并校验 AcroForm PDF。当任务提到 PDF 表单、',
          '  字段填写或压平可填表单时使用。',
          'version: 1.2.0',
          'allowed-tools: [read_file, bash]   # 作为本轮的工具上限被强制执行',
          'activation: auto                   # auto | always | manual',
          '---',
        ].join('\n'),
      },
      {
        t: 'table',
        caption: 'frontmatter 字段与它们的真实作用',
        head: ['键', '必填', '作用'],
        rows: [
          ['`name`', '是', 'kebab-case、≤ 64 字符；也是斜杠命令的名字'],
          ['`description`', '是', '**模型在决定加载前唯一能看到的文字**，必须同时说清「做什么」和「何时用」'],
          ['`allowed-tools`', '否', '本轮的变更类工具上限（见下）'],
          ['`activation`', '否', '`auto`（默认）、`always`（正文注入每次会话，全体合计 12000 字节）、`manual`（不进目录，只能显式调用）'],
          ['`version` / `license` / `author` / `homepage` / `keywords`', '否', '元数据；未知键会被保留，更新的 Claude Code 字段不会让解析失败'],
        ],
      },
      {
        t: 'h2',
        text: '三级渐进加载',
      },
      {
        t: 'table',
        caption: '为什么装很多技能也不贵',
        head: ['层级', '模型拿到什么', '什么时候'],
        rows: [
          ['1', '名字、作用域、一行「做什么 + 何时用」', '一直在系统提示里；整个目录封顶 6000 字节'],
          ['2', '完整 `SKILL.md` 正文 + 附带文件清单', '只有模型调用 `skill(name=…)` 时'],
          ['3', '附带文件本身', '只有它用 `read_file` / `bash` 去读时'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '目录被截断不是死路',
        md:
          '6000 字节按 UTF-8 算：一行精炼英文描述约 180 字节（约 30 个技能），一条 220 字符中文描述可到 660 字节（约 10 个）。' +
          '截断前会排序（作用域 `env` > `project` > `user` > `bundled`，然后按最近使用），掉出去的仍能用 `skill_find` 按名字/描述/关键词搜到——' +
          '它只搜本机已安装的东西，不联网、不推荐安装。',
      },
      {
        t: 'h2',
        text: '安装、创建与自检',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '常用动作（shell 与 /skills 是同一套实现）',
        code: [
          'aragon skills list --sort=recent        # 装了什么',
          'aragon skills info <name>               # 版本、路径、来源、文件清单',
          'aragon skills install <source> --yes    # 目录 | git 仓库 | https .md / .zip',
          'aragon skills create <name> --description "做什么 + 何时用"',
          'aragon skills doctor                    # 校验声明并检测篡改',
          'aragon skills usage --json              # 本地使用计数',
        ].join('\n'),
      },
      {
        t: 'ul',
        items: [
          '四个作用域后者按名字覆盖前者：`bundled`（包内只读）、`user`（`aragon skills path`）、`project`（`<cwd>/.aragon/skills/`）、`env`（`ARAGON_SKILLS_PATH`）。被覆盖的仍可见，标成 `~shadowed by <scope>`。',
          '装好的技能就是斜杠命令；与内置命令撞名时内置优先，技能退到 `/skill:<name>`。',
          '正文可用 `$ARGUMENTS` 与 `$1..$9`，`$$` 是字面 `$`；没有占位符时参数追加到 `## Arguments` 段。',
          '`aragon skills update` 会先检查本地改动：改过就拒绝并列出文件，`--force` 丢弃你的编辑（先复制出去）。模型**不能**调用 update。',
        ],
      },
      {
        t: 'h2',
        text: 'allowed-tools：工具上限，不是安全边界',
      },
      {
        t: 'p',
        md:
          '声明了 `allowed-tools` 的技能会约束模型**本轮剩余部分**能用哪些工具。范围是**一轮**：下一条消息发出去，上限就消失。' +
          '真正被约束的是五个会改东西的工具，其余本来就允许。',
      },
      {
        t: 'table',
        caption: `工具数据集 ${counts.tools} 条；\`allowed-tools\` 只能收紧下面这一列`,
        head: ['受限的五个', '永远允许（声明与否都一样）'],
        rows: [
          ['`write_file`', '`read_file`、`list_dir`、`glob`、`grep`、`skill`、`skill_find`'],
          ['`edit_file`', '（同上）'],
          ['`bash`', '（同上）'],
          ['`skill_install`', '（同上）'],
          ['`skill_create`', '（同上）'],
        ],
      },
      {
        t: 'table',
        caption: '三种策略（`skills.toolPolicy`，默认 `enforce`）',
        head: ['模式', '行为', '切换方式'],
        rows: [
          ['`enforce`', '调用被拒，并告诉模型它可以用什么代替', '默认'],
          ['`warn`', '调用照跑，每工具每轮给一条提示', '`--skill-tool-policy warn`'],
          ['`off`', '没有上限，`allowed-tools` 完全不进提示', '`/skills policy off`（本会话立即生效）'],
        ],
      },
      {
        t: 'ul',
        items: [
          'Claude Code 的工具名能映射：`[Read, Bash, MultiEdit]` → `read_file` / `bash` / `edit_file`；这边没有的（`WebFetch`、`Task`）被忽略而不是报错。',
          '**一个解析不了的名字会让整条声明失效**，并明确说出来——不会给你一个你没写过的更窄上限。`aragon skills doctor` 会提前报出这些。',
          '上限是**并集**：本轮加载的每个技能各贡献一份，而 `skill` 永远可用，所以技能可以指示模型再加载一个更宽松的技能。每一次放宽都会印在转录上：`Tool ceiling widened by skill "skill-creator": +write_file, +skill_create`。',
          '`activation: always` 的技能从不强加上限——它们是环境参考，不是你选择运行的过程。',
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '没有沙箱',
        md:
          '批准只挡住**静默安装**，不会让被批准的技能变安全：它可以含对抗性指令，它的脚本以你的完整用户权限运行。' +
          '`/skills info` 记录来源与每文件 sha256，回答的是「这还是我批准的那份文件吗」，**不是**「这份文件来自我信任的人吗」——没有签名，没有密钥分发。',
      },
      {
        t: 'p',
        md:
          '核心 API（`SkillRegistry`、目录排序、披露预算）见 [SkillRegistry 与技能格式](/api/skills/)，工具侧参数见 [技能工具](/tools/skills/)。',
      },
    ],
  },

  {
    id: 'guide/context',
    title: '上下文与自动压缩',
    group: 'guide',
    order: 90,
    phase: 'B',
    template: 'prose',
    summary:
      '上下文量规读什么、自动压缩在 90% 触发、压缩后哪些内容按原文保留，以及用 /context 与 /compact status 核对真实状态。',
    keywords: ['上下文', 'context', 'compaction', '压缩', '阈值', 'archive'],
    seeAlso: ['api/compaction', 'config/context-window', 'guide/sessions'],
    sourceRefs: [
      { path: 'packages/cli/README.md', lines: '2405', snippet: 'Occupancy      43%' },
      { path: 'packages/cli/src/config/schema.ts', lines: '1595', snippet: 'threshold: 0.9,' },
      { path: 'packages/cli/README.md', lines: '2560', snippet: 'never two compactions on consecutive turns' },
      { path: 'packages/cli/src/compaction/limits.ts', lines: '50', snippet: 'archiveMaxFiles: 20,' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '一个长跑任务填满上下文窗口，本来只有一种结局：HTTP 400 加一条「重开吧」的横幅，把这一轮做过的事全扔掉。' +
          '现在默认走的是**压缩**：占用到达阈值时，在轮次边界把较老的历史交给摘要器，换成结构化记录，同一个循环继续跑。',
      },
      {
        t: 'h2',
        text: '量规上两个不同的怀疑标记',
      },
      {
        t: 'table',
        caption: '状态行与 `/context` 的字段怎么读',
        head: ['看到', '含义', '为什么会这样'],
        rows: [
          ['`C35%`', '占用比例，来自上一轮 provider 报告的用量', '正常状态'],
          ['`C~35%`', '**百分比**是猜的：还没有完成的轮次报过用量，或之后又追加了工具结果', '`/resume` 后、压缩后、或本轮追加过大结果'],
          ['`C?`', '**窗口**未知：API 与模型表都给不出上限', '此时不显示百分比；128000 只作压缩预算，不是容量声明'],
          ['`C>999%`', '超过 999% 仍保留近似标记', '通常意味着窗口被设得太小'],
        ],
      },
      {
        t: 'p',
        md:
          '百分比在**一轮之内也会动**：每个工具结果都会推它一下，跟压缩开不开没有关系——`--no-compaction` 的会话读数一样是活的。',
      },
      {
        t: 'h2',
        text: '阈值与其它默认值',
      },
      configTable('压缩相关的配置分组', ['compaction', 'contextWindow']),
      {
        t: 'table',
        caption: '`compaction.*` 的默认值与范围（源码注释原文的范围）',
        head: ['键', '默认', '范围', '作用'],
        rows: [
          ['`enabled`', '`true`', '布尔', '为 `false` 时不构造管理器、不订阅事件，窗口满了就和以前一样结束这一轮'],
          ['`threshold`', '`0.9`', '`[0.5, 0.95]`', '触发线；比较用未取整的 occupied / window 比值'],
          ['`warnThreshold`', '`0.75`', '`[0.4, threshold - 0.05]`', '量规转琥珀色的位置；与 threshold 联合钳制，顺序固定'],
          ['`keepRecentTurns`', '`4`', '`[1, 20]`', '按原文保留的完整轮数'],
          ['`useFastTier`', '`true`', '布尔', '**偏好**：只有你配了 fast 档才真的用它摘要'],
          ['`onFailure`', '`stop`', '`stop` / 旧值 `truncate`', '两者都保留历史；旧值仍能加载，`/compact status` 会解释'],
          ['`subagents`', '`true`', '布尔', '让 `task` 子代理各自压缩自己的历史（同一套策略）'],
          ['`archive`', '`true`', '布尔', '把被丢掉的消息原文写进 `~/.aragon-agent/compaction/`'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '默认模型摘要，这是笔真钱',
        md:
          '开箱时 fast 档是关的，所以第一次压缩是一次约 30k token 的调用，跑在**会话自己的模型**上。' +
          '代价被三重约束住：一轮最多 5 次、不压缩就要丢掉整轮、花费计入会话总额并标注 `pricing unknown` 而不是 `$0.00`。' +
          '想便宜就配 fast 档（`/fast on` 加一个便宜模型），转录卡片会写出用的是哪个模型。',
      },
      {
        t: 'h2',
        text: '压缩之后什么还在',
      },
      {
        t: 'ul',
        items: [
          '**你的原始任务按原文保留**；之后的用户要求、此前的记忆条目、最近几轮完整轮次也按原文保留。',
          '新增的事实、决定、任务、证据、坑与下一步带着来源引用写入；新条目会取代旧条目，但不会静默抹掉它。',
          '图片仍是真实的消息内容，不是描述。',
          '放不下的受保护内容会让这次压缩**被拒绝**，而不是被截断。',
          '子代理压缩自己的历史：同一 `keepRecentTurns`、同一 `onFailure`、同一归档设置——但**没有转录卡片**，转录描述的是主代理的上下文。',
        ],
      },
      {
        t: 'h2',
        text: '怎么检查：三块屏各答一个问题',
      },
      {
        t: 'code',
        lang: 'text',
        title: '`/context` 的完整答案（任何宽度、任何模式）',
        code: [
          'Context',
          '  Occupancy      43%   86.2k of 200.0k   [measured 85.1k + 1.1k estimated]',
          '  Window         200000   from the model table',
          '  Since measured 1.1k estimated tokens appended since the last provider-reported usage',
          '  Compaction     on - triggers at 90% (amber at 75%), 2 this session, 118.0k reclaimed',
          '  Session spend  1.2M in (incl. 940.0k cache read, 12.0k cache write) / 48.2k out, $3.21',
        ].join('\n'),
      },
      {
        t: 'table',
        caption: '三个表面，各自答一件别人答不了的事',
        head: ['表面', '回答', '什么时候失效'],
        rows: [
          ['`/context`', '占用拆分（实测 + 估算）、窗口**从哪来**、测量有多旧、压缩的真实状态', '不会失效；从不注册过压缩的会话也能问'],
          ['`/compact status`', '精确 token 数、阈值对应的 token 数、两位小数百分比、这次会话压过几次', '不会失效；这是保证路径'],
          ['转录卡片', '压缩前后的消息与 token 数、摘要模型、耗时、这次是自动/手动/溢出触发', '会随转录滚走；子代理没有卡片'],
          ['状态栏 chip', '`compacting`、及其后的量规回落', '窄屏会掉；`Ctrl+O` 展开卡片可看细节'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '红条只有一种含义',
        md:
          '触发条件是 `>= threshold`，红带是 `> threshold`，所以会被染红的占用**都已经触发了压缩**，同一帧里条就回落了。' +
          '因此红条只在你看到它没跑（关了、自我禁用、阶梯用尽）时才出现。若一直是红的，先看 `/compact status` 的 `off - not registered for this session`。',
      },
      {
        t: 'h2',
        text: '四道闸：它不会在你的钱上打转',
      },
      {
        t: 'ol',
        items: [
          '永不连续两轮都压缩。',
          '一轮运行里最多 5 次。',
          '一次拼接如果不能投影出真实回收，就不算进步。',
          '连续两次无进步的压缩会**为本次会话关掉主动触发**，并给出一条点名原因与修复办法的提示。',
        ],
      },
      {
        t: 'p',
        md:
          '溢出可以绕过「连续轮次」冷却，但仍受阈值、每轮上限与自我禁用约束，而且从不缩短保留的尾部。' +
          '手动请求绕过自动阈值与自我禁用，排队请求受每轮上限约束并在该轮结束时过期。',
      },
      {
        t: 'h2',
        text: '压缩是不可逆的吗',
      },
      {
        t: 'p',
        md:
          '不是。拼接被采纳之后，被丢掉的消息会按原文写进 `~/.aragon-agent/compaction/`：元数据、摘要、消息本身。' +
          '`/compact history` 列出**本轮运行**的归档（最新在前，带路径），`/compact show <n>` 打印某一份的元数据与摘要——从不打印消息正文，' +
          '因为一份归档可能有好几兆。',
      },
      {
        t: 'table',
        caption: '归档的保留策略（两层，都有界）',
        head: ['维度', '上限', '实现'],
        rows: [
          ['本轮运行的文件数', '20', '`COMPACTION_LIMITS.archiveMaxFiles`'],
          ['跨运行的时间窗', '7 天（604800000 ms）', '`archiveMaxAgeMs`，扫描全部运行'],
          ['单文件尺寸', '8 MB', '`archiveMaxBytes`；写入是尽力而为，失败只记日志'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '这不是 undo',
        md:
          '把一份过满的历史恢复回去，就是恢复那个触发压缩的条件，下一次请求照样失败。它的价值是**磁盘上的保真**：' +
          '「摘要有错、代理照着假记录做了」从此是可以检查的事，而不是只能接受的事。',
      },
    ],
  },

  {
    id: 'guide/background',
    title: '后台服务与后台作业',
    group: 'guide',
    order: 100,
    phase: 'B',
    template: 'prose',
    summary:
      '永不退出的命令进后台服务，长任务进后台作业：bash_output、bash_kill、job_wait、job_list 各管一段，端口被占用时会明说。',
    keywords: ['背景', 'background', 'dev server', 'job_wait', 'bash_output', '端口', 'stalled'],
    seeAlso: ['tools/shell', 'guide/tui', 'config/reference'],
    sourceRefs: [
      { path: 'packages/cli/README.md', lines: '1922', snippet: 'already answering before the launch' },
      { path: 'packages/cli/README.md', lines: '2003', snippet: 'job_wait({ job, timeoutSeconds?, since? })' },
      { path: 'packages/cli/src/tools/job-tools.ts', lines: '234-242', snippet: "name: 'job_wait'" },
      { path: 'packages/cli/src/tools/proc-tools.ts', lines: '55-62', snippet: "name: 'bash_output'" },
      { path: 'packages/cli/README.md', lines: '2050', snippet: 'jobs.waitSeconds' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '`bash` 默认前台阻塞到进程退出，工具天花板是 180 秒。这条规则对两类命令不成立：**永不自己退出的**（dev server、watch、`docker compose up`）' +
          '和**要很久才退出的**（训练、下载、`cargo build --release`）。前者前台跑会卡住整轮，后者会被超时杀掉。',
      },
      {
        t: 'h2',
        text: '服务（service）与作业（job）的区别',
      },
      {
        t: 'p',
        md:
          '区别只有一个字：**会不会自己结束**。传 `background: true` 时由运行时判断：命令落在关闭的分类白名单里（`npm|pnpm|yarn|bun run dev|start|serve|watch|preview`、`vite`、`next dev`、`uvicorn`、`docker compose up` 不带 `-d`、`tail -f` …）就是服务，否则是作业。',
      },
      {
        t: 'table',
        caption: '两种后台对象',
        head: ['', '服务 `s1`', '作业 `t1`'],
        rows: [
          ['会不会自己结束', '不会', '会，只是慢'],
          ['初始状态', '`starting`，等到就绪或退出或 4 秒', '`running`（没有就绪可等）'],
          ['就绪判定', '日志里印出一个 URL，或对命令点名的端口做一次 TCP 连接', '不适用'],
          ['典型命令', '`npm run dev`、`tsc --watch`、`docker compose up`', '`python train.py`、`npx playwright install`'],
          ['谁会读它', '`bash_output` / `bash_kill`', '`bash_output` / `bash_kill` / `job_wait` / `job_list`'],
        ],
      },
      {
        t: 'h2',
        text: '四个工具',
      },
      {
        t: 'p',
        md:
          '一次受监管的启动**只要有一件确定的事可报就返回**：就绪、已退出、或满 4 秒。所以启动即崩的服务在 400 毫秒内带回堆栈，而不是让你干等三分钟。',
      },
      toolParams('job_wait'),
      {
        t: 'table',
        caption: '四个工具的读法',
        head: ['工具', '返回', '什么时候用'],
        rows: [
          ['`bash_output({ service, since? })`', '200 行环形缓冲的日志尾 + 当前状态', '想看细节；`since` 是上次返回的游标，可增量读'],
          ['`bash_kill({ service })`', '停止一个，或传 `"all"`', '收工；确认不了是否退干净时会说 `may have left a detached child`'],
          ['`job_wait({ job, timeoutSeconds?, since? })`', '一行状态 + 一行进度 + 最多 6 行新输出 + 游标', '等长任务：一次调用约 150 token，替代六次 `bash_output`'],
          ['`job_list()`', '一行一个作业：id、kind、状态、耗时、进度', '接手一个别人起的会话时先看这里'],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '等待是有界的，而这是设计',
        md:
          '`job_wait` 默认等 30 秒、最多 20 分钟（`timeoutSeconds` 取 5–1200）；等待期间你发一条消息就会立刻结束它，作业照常运行。' +
          '等待时转录里是一张固定五行的卡片：进度条、两个时钟、作业最新输出和操作提示。' +
          '结果里的 `[next]` 会建议下一次该等多久，让模型倾向于“一次长等”而不是“多次短等”。' +
          '等待期间空闲看门狗被有意暂停，由等待自身的上限、执行器的兜底和你的 Esc 负责收尾。',
      },
      {
        t: 'h2',
        text: '端口冲突：它不会把别人的服务器当成你的',
      },
      {
        t: 'p',
        md:
          '就绪探测是「日志里的 URL」或「对命令点名的端口做一次 TCP 连接」。如果那个端口**在启动之前就已经有应答**，探测会被关掉，卡片会明说，' +
          '而不是把别人的服务写成你的。一个起来了但什么都没监听的进程（`tsc --watch`）会被如实报告为 `running`——诚实的第三个答案。',
      },
      {
        t: 'ul',
        items: [
          '端口已被占用时，先 `bash_kill({ service: "all" })` 或换端口；不要相信一条「ready」就算完了。',
          '`/bg list` 与状态行的 `svc N` chip 是当前活着的服务数；`/bg logs s1` 直接打日志尾，不经过模型。',
          '一次前台超时**不会**自动转后台：你拿到错误、已捕获的输出，以及重新运行该用的确切 `background: true` 命令。',
        ],
      },
      {
        t: 'h2',
        text: '四个细节层级，按 token 从 0 到你的选择',
      },
      {
        t: 'table',
        caption: '想知道多少，就付多少',
        head: ['层级', '拿到什么', '大概'],
        rows: [
          ['运行中', '卡片、活动行、`/bg list`', '0 token'],
          ['`job_wait`', '状态 + 进度 + ≤6 行 + 游标', '60–200 token'],
          ['`bash_output`', '200 行环，用 `since` 分页', '1k–8k token'],
          ['日志文件', '`<home>/jobs/<session>/<id>.log`，用 `grep` / `read_file` 读', '你自己决定'],
        ],
      },
      {
        t: 'p',
        md:
          '最后一个层级是逃生口：超过 200 行环就忘了，`bash_output` 的截断说明会点出文件名。' +
          '进度是**被提取**的而不是被传输的：从最后几行里读一行（`47%`、`epoch 3/10`、`812/1000`），没变化就不重复。' +
          '`[stalled]` 表示命令已经 `jobs.stallSeconds` 没有输出，它是一个带三个选项的报告，从不自动 kill。',
      },
      {
        t: 'h2',
        text: '配置与关闭',
      },
      configTable('后台相关的配置分组', ['bash', 'jobs']),
      {
        t: 'table',
        caption: '`jobs.*` 的默认值',
        head: ['键', '默认', '作用'],
        rows: [
          ['`jobs.enabled`', '`true`', '注册 `job_wait` / `job_list` 并拼接提示块；`false` 逐字节恢复旧行为'],
          ['`jobs.waitSeconds`', '`30`', '一次等待的默认秒数（5–1200）；不再受 `toolTimeoutMs` 约束'],
          ['`jobs.stallSeconds`', '`300`', '多久没输出算 `[stalled]`（30–3600）'],
          ['`jobs.persistLog`', '`true`', '把输出镜像到磁盘；`false` 连目录都不建'],
          ['`jobs.noticeSteer`', '`true`', '完成通知能否打断运行中的一轮；`false` 只是延后，**不是关通知**'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '服务与作业都不活过 CLI',
        md:
          '退出、{kbd:Ctrl+C}、SIGTERM、崩溃都会尽力收掉整棵树：没有守护进程、没有 PID 文件、不能跨启动重新挂接。' +
          '唯一例外是 {kbd:Ctrl+L} 开出来的分支窗口——它是**另一个会话**，不是服务，主窗口退出后它继续活着。' +
          '`aragon exec` 在运行结束时也会收掉作业，机器消费者应读 `job` 事件而不是假设它还在。',
      },
    ],
  },

  {
    id: 'guide/scroll-themes',
    title: '滚动、主题与渲染性能',
    group: 'guide',
    order: 110,
    phase: 'B',
    template: 'prose',
    summary:
      '两种滚动模式、四套主题、渲染治理的三道闸与减少动态：本页说明默认原生滚动的行为、主题迁移规则，以及 /perf 每一行怎么读。',
    keywords: ['滚动', 'scrollMode', '主题', 'theme', 'render governor', 'eco', '/perf'],
    seeAlso: ['guide/tui', 'config/reference', 'troubleshoot/escape'],
    sourceRefs: [
      { path: 'packages/cli/src/config/schema.ts', lines: '97-106', snippet: "'native', 'app'" },
      { path: 'packages/cli/src/ui/render-governor.ts', lines: '20-26', snippet: 'GOVERNOR_LADDER' },
      { path: 'packages/cli/src/ui/palettes.ts', lines: '160-170', snippet: 'export function resolvePalette' },
      { path: 'packages/cli/README.md', lines: '1205-1209', snippet: 'Terracotta + amber over warm neutrals' },
      { path: 'packages/cli/README.md', lines: '1499-1504', snippet: 'Ink has no' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '`scrollMode` 决定会话画在哪里，`theme` 决定颜色，渲染治理决定每秒重画多少次。三件事互相独立，' +
          '优先级都是 **flags > 环境变量 > 配置文件 > 默认**。',
      },
      {
        t: 'h2',
        text: '两种滚动模式',
      },
      flagTable('滚动与渲染相关的参数', [
        '--scroll-mode',
        '--render-governor',
        '--theme',
        '--compact',
        '--mouse',
        '--mouse-select',
      ]),
      {
        t: 'table',
        caption: '`native`（默认）与 `app`',
        head: ['', '`native`', '`app`（`--scroll-mode app`）'],
        rows: [
          ['会话在哪', '你终端自己的回滚缓冲里', '备用屏幕缓冲区（`vim`、`htop` 用的那套）'],
          ['滚轮 / 选中 / 搜索', '终端自己的：`Shift+PgUp`、右键菜单、终端搜索、`tmux` copy mode', '应用自己的滚动条与 `PgUp` / `Shift+↑`；鼠标上报由应用接管'],
          ['退出之后', '会话仍在回滚缓冲里，另印一段简短摘要（含 `aragon --resume <id>`）', '把会话当纯文本重放回普通缓冲（`--no-exit-transcript` 关掉；`/save` 仍导出完整 JSON）'],
          ['长回答', '超出实时区的行**印进回滚缓冲**，`scrollback + screen` 恰好覆盖整段回答一次且有序', '只有消息区滚动，帧高固定为 `rows - 1`'],
          ['已印的行', '离开屏幕即定稿，永不重写；改宽度会以新宽度重印并标记 `[-- reflowed to N columns ... --]`', '整帧差分重绘'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '删掉的老开关不会回来',
        md:
          '`--fullscreen`、`--no-fullscreen`、`ARAGON_FULLSCREEN` 与 `fullscreen` 配置项都已移除：旧的命令行标志是**报错**，' +
          '旧的配置字段与环境变量被忽略。统一用 `--scroll-mode` / `scrollMode`。',
      },
      {
        t: 'h2',
        text: '主题：三套调色板加 `auto`',
      },
      {
        t: 'table',
        caption: '四套外观',
        head: ['名字', '外观', '备注'],
        rows: [
          ['`warm`', '陶土 + 琥珀压在中性暖色上', '默认；`auto` 解析到这里'],
          ['`cool`', '蓝紫色调，0.3.x 时代以 `dark` 之名发布', '旧名字在每个入口都还能用'],
          ['`light`', '为浅色终端背景', '需要自己选'],
          ['`auto`', '从不猜成 `light`', '终端无法可靠报告背景色，猜错不是难看而是不可读'],
        ],
      },
      {
        t: 'ul',
        items: [
          '`dark` → `cool` 的迁移覆盖 `--theme dark`、`aragon config set theme dark`、`/theme dark` 与配置文件里的 `"theme": "dark"`；下次保存配置时值被写成 `cool`。',
          '密度与提示同样三路可设：`--compact` / `--no-hints` 单次生效，`aragon config set density compact` / `hints false` 持久化。',
          '输入框那行提示在若干次会话后自己缩短成 `? help`，但**运行期间永远完整写出** `esc ×2 interrupt`。',
          '原生滚动模式下 {kbd:Ctrl+T} 与 `/theme` 只影响**新**消息：已印出的行不重写。',
        ],
      },
      {
        t: 'h2',
        text: '渲染治理：为什么长会话不再变慢',
      },
      {
        t: 'p',
        md:
          'Ink 没有输出缓存，每帧都会重走整棵已挂载的树、重新测量每个文本节点、重新序列化整帧——代价正比于**这轮会话产生过的字符数**（不是屏幕上的字符数）。' +
          '四件事把它改掉了：',
      },
      {
        t: 'table',
        caption: '四道闸与各自的关闭方式',
        head: ['机制', '效果', '关闭 / 观察'],
        rows: [
          ['屏幕外条目不再挂载', '只渲染看得见的带加上下各几条，其余用两个等高空位替代', '滚动与 `↑N` 读数不变'],
          ['昂贵的纯计算被缓存', '语法高亮与 markdown 解析每个不同块只做一次', '主题仍在渲染时套用，所以 `/theme` 立刻生效'],
          ['转录有界', '单条回答视图内不超 256 KiB，`transcriptRetain` 限制保留条目数', '两处都会**报告**删掉了什么，不静默丢弃'],
          ['帧间隔自适应', '代价高时把更新合并进更宽的窗口：33ms 起，最高 320ms', '生效时状态栏出现 `eco` chip；`--no-render-governor` 关闭'],
        ],
      },
      {
        t: 'code',
        lang: 'text',
        title: '/perf 的输出，每行都有对应的事实（原生模式的实际形态）',
        code: [
          'render     rung 2  -  interval 80ms  -  last commit 61ms  -  eco',
          'transcript 4213 entries  -  1000 retained  -  3213 dropped  -  38 mounted',
          'heights    412 cached  -  6 estimated  -  cols 132',
          'caches     md 178 (1.9MB)  -  hl 96 (1.4MB)  -  lines 340',
          'mode       native  -  live region 44 rows  -  top 3',
          'scrollbar  n/a (native scroll)',
        ].join('\n'),
      },
      {
        t: 'p',
        md:
          '治理阶梯是一个常量数组 `GOVERNOR_LADDER = [33, 50, 80, 125, 200, 320]`（毫秒）：代价超过阈值就上一档，连续安静若干帧才下一档。' +
          '`/perf reset` 清掉渲染缓存并把治理器退回最快那一档。',
      },
      {
        t: 'h2',
        text: '减少动态与无鼠标环境',
      },
      {
        t: 'ul',
        items: [
          '减少动态（reduced motion）时状态行用静态字形代替旋转符：不再是每帧变化的一个字符。',
          '`--no-mouse`、`ARAGON_MOUSE=0` 或 `aragon config set mouse false` 关掉鼠标：全屏模式下滚轮**什么都不做**，不会掉回去编辑你的草稿。',
          '`--no-mouse-select` 关掉文本选择但保留滚动条拖拽；`Shift`+拖拽在支持的宿主上用终端原生选区。',
          '`tmux` 里 `mouse on` 会把滚轮留给自己，应用永远看不到它：`set -g mouse off` 交回来。',
          'Windows 控制台的滚轮需要 Node ≥ 22.17；不足时 `PgUp` / `Shift+↑` 从键盘滚。',
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '怀疑画面不对时先看两条线',
        md:
          '`/perf` 的 `scrollback` 行给出 `guardHits` / `clippedRows` / `fallbacks` 与几何（`region` / `canvas` / `content` / `gap`、`anchor bottom via probe|fill|none`）；' +
          '`band:` 行是**唯一**说明某个面板为什么不在屏幕上的地方（`reason=<visible|empty|disabled|narrow|short|overlay>`）。' +
          '整屏乱码时先 {kbd:Ctrl+R} 重绘一次，再去看这两行。',
      },
    ],
  },

  {
    id: 'guide/sessions',
    title: '会话、恢复与分支',
    group: 'guide',
    order: 120,
    phase: 'B',
    template: 'prose',
    summary:
      '会话 id 六个字符、写在 ~/.aragon-agent/sessions/，--resume 读旧写新、/branch（Ctrl+L）另开窗口、sessions prune 有作用域限制。',
    keywords: ['会话', 'session', 'resume', 'branch', 'sessions prune', 'checkpoint'],
    seeAlso: ['exec/sessions', 'guide/models', 'config/home'],
    sourceRefs: [
      { path: 'packages/cli/src/session/limits.ts', lines: '15-26', snippet: 'idLength: 6,' },
      { path: 'packages/cli/README.md', lines: '805-809', snippet: 'six characters from an alphabet that omits' },
      { path: 'packages/cli/README.md', lines: '843-847', snippet: 'the session you name' },
      { path: 'packages/cli/src/session/cli-commands.ts', lines: '70-76', snippet: '--older-than <days>' },
      { path: 'packages/cli/src/session/clear-archive.ts', lines: '48-49', snippet: 'maxArchives: 20' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '默认就有会话身份：不需要先开一个「保存」开关。每轮结束写一次检查点，于是第二个终端能接着同一个对话，' +
          '而第一个窗口不必知道这件事。',
      },
      {
        t: 'h2',
        text: 'id 的形状',
      },
      {
        t: 'table',
        caption: '一个 id 的三个部分',
        head: ['部分', '长度', '说明'],
        rows: [
          ['根 id', '6 个字符', '字母表剔除了 `0 o 1 l i`，可以从屏幕上读出来而不抄错；31^6 ≈ 8.9e8 个 id'],
          ['分支后缀', '`-` + 4 个字符', '`a4k2m9` 派生出 `a4k2m9-x7f2`'],
          ['总上限', '64 个字符', '`SESSION_ID_LIMITS.maxIdLength`；根最长 59'],
        ],
      },
      {
        t: 'p',
        md:
          'id 显示在状态行右端（≥ 72 列时为 `id a4k2m9`，更窄只留 `a4k2m9`，再窄就不画）。**id 从不截断**：' +
          '半个 id 是一条无法使用的 `--resume` 命令，比没有更糟。读不到就用 `/session`，它在任何宽度给全量。',
      },
      {
        t: 'h2',
        text: '三个入口，三种行为',
      },
      {
        t: 'table',
        caption: '读谁、写谁（原文里的三行表）',
        head: ['入口', '读', '写'],
        rows: [
          ['`aragon --resume <id|path>`', '你点名的那份', '一个**新的**分支会话；父会话永不被碰'],
          ['`/resume [file]`（TUI 内）', '你点名的那份文件', '本进程移到新 id，花费计数器重置'],
          ['`aragon exec --resume <id>`', '你点名的那份（包括 TUI 写的）', '它自己的一exec 会话；`--continue` 随后指向这个新的'],
        ],
      },
      {
        t: 'ul',
        items: [
          '分支窗口（{kbd:Ctrl+L} 或 `/branch`）先把会话**落盘**，再在 `/cwd` 开一个新终端跑 `aragon --resume <id>`，子进程打印 `Resumed <id> as a new branch: session <new-id>`。',
          '两个窗口从此互不影响：关掉任一个都不碰另一个，主窗口的 {kbd:Ctrl+C} 不会停分支。',
          '重复按键被节流为每两秒一次；**失败的那次不消耗冷却**，所以重试是立即的。',
          '`aragon --save <id>` 给本次运行命名并钉住（`sessions prune` 永不删它）。只接受 id，不接受路径——`--save ./notes.json` 退出码 2 并说明原因。',
        ],
      },
      {
        t: 'h2',
        text: '会话落在哪里，怎么清',
      },
      {
        t: 'code',
        lang: 'text',
        title: '磁盘上的位置',
        code: [
          '~/.aragon-agent/sessions/',
          '  <id>.json            # 检查点：对话、todo、模型、transcript、meta',
          '  cleared/             # /clear 归档，保留最近 20 份',
          '    cleared-20261022-0931-4128.json',
        ].join('\n'),
      },
      {
        t: 'table',
        caption: '`aragon sessions` 的五个子命令与 prune 的两个作用域开关',
        head: ['命令', '作用'],
        rows: [
          ['`sessions list`', '列出**这个子命令作用域内**的会话（默认只看 `exec` 管理的那些）'],
          ['`sessions show <id>`', '打印一份会话的元数据'],
          ['`sessions rm <id> --yes`', '删除一份；没有 `--yes` 会被拒'],
          ['`sessions prune --dry-run`', '只打印将要删什么，什么都不删'],
          ['`sessions prune --yes`', '真删；拒绝在缺 `--yes` 时动手'],
          ['`--origin <exec|tui|all>`', '`prune` 允许碰哪一种写者的文件，默认 `exec`'],
          ['`--older-than <days>`', '只删超过这么多天没被碰过的'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: 'prune 默认不会碰你的 TUI 会话',
        md:
          '因为 `--origin` 默认是 `exec`。想连 TUI 会话一起清，必须显式写 `--origin all`——' +
          '而且**被钉住**的（`--save <id>` 或 `/session pin`）永远是例外。没有任何东西会被自动删除。',
      },
      {
        t: 'h2',
        text: '一份检查点里有什么',
      },
      {
        t: 'ul',
        items: [
          '完整对话、todo 清单、模型与转录，外加一个指明写者的 `meta` 块。',
          '在工具中途被打断的一轮会**在副本上**修复：悬空的 `tool_call` 补一个 `isError` 的 `tool_result`，' +
            '仍在跑的卡片被结算，于是恢复的会话里没有东西还在转。活着的对话从不为这个被改写。',
          '写入是原子的（`renameSync` 重试 3 次，间隔 20ms），因为这是本 CLI 第一个可能被读着的同时被重写的文件。',
          '写入时机：第一帧之后、每个稳定轮次之后（750ms 去抖、250ms 最小间隔）、`/session pin`、以及退出时一次。`aragon -p` 没有屏幕也没有轮次事件，只在退出写一次。',
          '无头会话的检查点**只有上下文，没有回滚记录**：`--resume` 这样的文件会继承完整上下文，屏幕空到下一轮为止。',
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么没有「显示 id 但不保存」的开关',
        md:
          '那会造出唯一一种不该存在的状态：一个你能复制、却用不了的 id。删除只有一条明确的路——`sessions rm <id> --yes`。',
      },
    ],
  },

  {
    id: 'guide/models',
    title: '模型、fast 档与 kits',
    group: 'guide',
    order: 130,
    phase: 'B',
    template: 'prose',
    summary:
      '主模型、fast 档与 agent kit 三层配置：fast 默认关闭、每 5 轮复核一次、会话预算 40 次；kit 只在会话内生效，不写配置文件。',
    keywords: ['模型', 'model', 'fast 档', 'kit', 'provider', 'thinking', 'subagent model'],
    seeAlso: ['api/providers', 'config/reference', 'guide/team'],
    sourceRefs: [
      { path: 'packages/cli/src/config/schema.ts', lines: '1338', snippet: 'reviewMaxPerSession: 40,' },
      { path: 'packages/cli/README.md', lines: '2309', snippet: '| `fast.enabled` | `false` |' },
      { path: 'packages/cli/README.md', lines: '875-887', snippet: 'A **kit** is a named preset that pins the three model roles at once' },
      { path: 'packages/cli/README.md', lines: '2345', snippet: 'fast*' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '一个会话里有**三个模型角色**：主模型（干活的）、fast 档（做复核与摘要的便宜模型）、子代理模型。' +
          '三者可以各自配置，而 kit 是「一次把三者钉住」的预设。',
      },
      {
        t: 'h2',
        text: '主模型：怎么选、怎么改',
      },
      flagTable('模型相关的参数', ['--model', '--thinking']),
      configTable('模型分组（默认值是源码里的常量名）', ['provider', 'model', 'baseUrl', 'thinkingLevel']),
      {
        t: 'ul',
        items: [
          '一次运行：`aragon --model claude-sonnet-4-5 --thinking high`。',
          '在会话里：`/model` 打开选择器，`/thinking <level>` 改推理档（代码里的码位是 O/N/L/M/H/X）。',
          '`/max-tokens [<n>|auto|default]` 管输出上限；不带参数时同时报设置值与**当前模型的有效上限**。',
          '`/model` 之后状态行的 `kit <name>` chip 会带上 `~`：说明活着的连接已经不再匹配那个预设。',
        ],
      },
      {
        t: 'h2',
        text: 'fast 档：默认关闭的第二档',
      },
      {
        t: 'p',
        md:
          '`fast.enabled: false` 时，系统提示、转录与请求载荷逐字节等于没有这个功能的样子。打开之后它买两样东西：' +
          '**周期性复核**（每 N 个完成的轮次把一段有界摘要发给便宜模型，问一句「还在正轨上吗」，答案不是 on track 就作为 `<fast_review>` 注入回来）' +
          '和**便宜的子代理 supervisor**。',
      },
      {
        t: 'table',
        caption: '`fast.*` 的默认值（README 的键表原文）',
        head: ['键', '默认', '含义'],
        rows: [
          ['`fast.enabled`', '`false`', '是否解析这一档'],
          ['`fast.provider`', '`\'\'`', '空 = 继承主 provider'],
          ['`fast.model`', '`\'\'`', '空表示**未配置**，从不回落到主模型，好让「与主模型相同」和拼错区分开'],
          ['`fast.baseUrl`', '`\'\'`', '空时仅在 provider 相同的情况下继承会话 base URL'],
          ['`fast.thinkingLevel`', '`\'off\'`', '用于复核（主与子代理）和 fast 档的压缩摘要'],
          ['`fast.review`', '`true`', '跑周期性复核，主代理与每个 `task` 子代理各一份'],
          ['`fast.reviewEveryTurns`', '`5`', '每隔几个轮次复核（1–50）'],
          ['`fast.reviewContextTurns`', '`3`', '一次摘要带几轮（1–10）'],
          ['`fast.reviewMaxChars`', '`280`', '注入批评的长度上限（80–600）'],
          ['`fast.reviewMaxPerSession`', '`40`', '一次会话可**开始**的复核次数（1–500），没有 unlimited 哨兵值'],
        ],
      },
      {
        t: 'code',
        lang: 'bash',
        title: '打开它',
        code: [
          'aragon config set fast.model claude-haiku-4-5',
          'aragon config set fast.enabled true',
          '# 或者会话里：/fast model claude-haiku-4-5 然后 /fast on',
        ].join('\n'),
      },
      {
        t: 'ul',
        items: [
          '`/fast` 报状态、解析到的模型、节奏与会话总计；`/fast status` 是保证可问的那条。',
          '`/fast budget [n]`：不带参数是**读**，所以在 `task` 派活期间也能问；带参数是写，和别的 `/fast` 设置一样在派活中被拒。',
          '节奏只在配置里：**故意没有**环境变量，因为要容器里调它的情况并不存在。',
          '复核自己只**重试一次**（不是主代理默认的十次），也不观察 `retry.*` / `/retry`；它自己的墙钟上限是 20 秒。',
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '档位解析不了时会被计数',
        md:
          '切模型或清空 key 都可能让这一档中途不可用。此时会被降级到主模型、**这次降级被计数并写进派活报告**，' +
          '并有一条说明原因的通知。静默降级会让代理以为自己还在按便宜的价格花钱，实际在付全价。' +
          '三次连续的**配置类**失败（错的模型 id、死掉的网关、无权限的 key）会关掉本次会话的复核并只警告一次；被限流属于瞬时故障，不计数。',
      },
      {
        t: 'h2',
        text: 'agent kit：一次钉住三个角色',
      },
      {
        t: 'p',
        md:
          'kit 是**指向**你已有 profile 的一组引用，所以改一个 profile 会改变所有点名它的 kit——这才是「预设」该有的意思。' +
          '它有三层，其中只有一层会写文件：',
      },
      {
        t: 'table',
        caption: 'kit 的三层',
        head: ['层', '在哪', '活到什么时候'],
        rows: [
          ['**保存的**', '`/settings` → `Kit pack` → `New kit` / `e`', '你删掉它为止'],
          ['**默认的**', '`Kit pack` → `s`（Set default），然后 `Ctrl+S`', '你改它为止'],
          ['**会话的**', '{kbd:Ctrl+K} 或 `/kit use <name>`', '本进程退出'],
        ],
      },
      {
        t: 'ul',
        items: [
          '{kbd:Ctrl+K} 的第一行**永远是 `Current setup`**——配置文件里的绑定——选它就释放会话 kit，所以这个功能有出口也有入口。',
          '{kbd:Ctrl+K} **从不写配置文件**：会话路径跑同一套 prepare 链，只跳过 commit，所以失败的切换让文件与会话都保持原样，成功的切换在磁盘上产生零字节。',
          '一次保存决定的是**槽位**而不是整个 kit：改子代理模型只会让子代理槽离开 kit，主模型与 fast 仍用 kit 的选择。',
          '状态行用 `kit <name>` chip 说明在跑什么；没有 kit 生效时这个 chip 根本不渲染。',
          '删掉一个 profile 会连带删掉点名它的 kit（同一个确认里），因为一个指向已删 profile 的预设哪个屏幕都修不好。',
        ],
      },
      configTable('kit 与 profile 相关的配置分组', ['modelProfiles']),
      {
        t: 'h2',
        text: '子代理跑哪个模型',
      },
      {
        t: 'p',
        md:
          '这是**你的设置**，不是模型的自由：`team.model: \'main\'`（默认）保持与主代理一致，每个孩子用主代理自己的连接。' +
          '把它设成 fast 档或某个已保存的 profile（设置屏的 *Subagent model* 行；`/team` 已不再写配置），' +
          '对「一群只读侦察兵」很有用。每次派活重新解析；解析不出来（档关着、profile 被删、key 缺失）就回落到主模型，' +
          '并在派活报告里写明一行，而不是让这次派活失败。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '模型不能给自己降级',
        md:
          '`task` 调用里一个过期的 `model` 键会被忽略。降级只能是你的决定——同一条规则也让「每次派活都用 fast」这种旧行为彻底消失。',
      },
      {
        t: 'p',
        md:
          'provider 层的能力与模型发现见 [Provider 与模型](/api/providers/)；窗口数字与 `model-windows.json` 见 ' +
          '[上下文窗口与模型表](/config/context-window/)。',
      },
    ],
  },
];
