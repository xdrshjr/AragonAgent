/**
 * 「开始」分组的页面（§2.2）：5 页，阶段 A 全交付。
 *
 * 这一组是读者的第一个接触面，因此两条纪律比别处更硬：
 * - 页面上的每个数字／路径／参数都必须能在源码里点到（`sourceRefs` 兜底）；
 * - 卡片标题不手写，从 `nav.mjs` 取 —— id 与标题的唯一真源在导航里，
 *   手抄一遍就是给自己留一处会漂移的地方（§2.2 的断言只看 nav）。
 *
 * 引用写法约定与 `cli.mjs` 一致：
 * - 站内链接写 `[文字](/guide/tui/)`（站点绝对路径形态），构建时按相对路径重写；
 * - 引用源码写 `packages/cli/src/cli.tsx:2370` 这样的代码片段 + `sourceRefs` 兜底。
 */

import { navGroups } from '../nav.mjs';

/** 本组导航条目（标题与顺序的真源）。 */
const startPages = navGroups.find((group) => group.id === 'start').pages;

/**
 * 页面 id → 站内路径。
 *
 * @param {string} id 页面 id，例如 `start/install`
 * @returns {string} 站内绝对路径，例如 `/start/install/`
 */
function hrefOf(id) {
  return `/${id}/`;
}

/**
 * 用导航条目拼一张卡片，缺描述就直接报错（宁可构建红，也不要一张空卡片）。
 *
 * @param {string} id 页面 id（必须出现在 nav.mjs 里）
 * @param {Record<string, string>} descriptions id → 中文描述
 * @returns {{title: string, href: string, desc: string}} cards block 的一项
 */
function card(id, descriptions) {
  const entry = startPages.find((page) => page.id === id);
  const desc = descriptions[id];
  if (!entry) throw new Error(`start 组没有页面 \`${id}\``);
  if (!desc) throw new Error(`卡片 \`${id}\` 缺描述`);
  return { title: entry.title, href: hrefOf(id), desc };
}

/** 本组四张卡片的中文描述（顺序即 nav 顺序，见下方 `startCards`）。 */
const START_CARD_DESCRIPTIONS = {
  'start/install': 'Node ≥ 18 的前提、全局与零安装两种装法、升级回退，以及引擎 SDK 的安装。',
  'start/first-run': '第一次启动看到什么、数据目录在哪、API key 从哪来、`config.json` 什么时候才落盘。',
  'start/five-minutes': '六个动作走完一轮回路：换模型、让它读文件、看工具卡片、打断、退出。',
  'start/concepts': 'Agent 循环、工具调用、事件流、压缩、会话、权限——每个概念指到源文件。',
};

/** 必需的第一张卡片网格：本组其余 4 页。 */
const startCards = ['start/install', 'start/first-run', 'start/five-minutes', 'start/concepts']
  .map((id) => card(id, START_CARD_DESCRIPTIONS));

/** 分组入口页的中文描述（`start` 已由上面那张网格承担，不重复）。 */
const GROUP_ENTRY_DESCRIPTIONS = {
  guide: '界面、快捷键、斜杠命令、输入队列、计划模式、TODO、团队、技能——日常每天都用到的部分。',
  config: '配置文件位置与优先级、全部配置键、环境变量、日志与诊断、上下文窗口表。',
  cli: '根命令与子命令的每个参数、5 档退出码、config / skills / session 三族命令。',
  exec: '`aragon exec` 的机器契约：参数、输出格式、事件、权限模式、预算与退出码。',
  api: '`@aragon-agent/core` 的公开面：Agent、工具、事件、Provider、压缩端口、沙箱与类型导出。',
  tools: '内置工具总览：19 个工具的用途、参数与源码位置。',
  troubleshoot: '常见问题、doctor 自检、卡住时的逃生路径。',
  appendix: '术语表与版本兼容承诺，随阶段 B 发布。',
};

/**
 * 其余分组的入口卡片：取每组第一个阶段 A 页面；整组都是 B 时退回第一页
 * （渲染层会把它显示成「阶段 B 提供」的占位，这是正确行为，不是缺陷）。
 */
const groupCards = navGroups
  .filter((group) => group.id !== 'start')
  .map((group) => {
    const entry = group.pages.find((page) => page.phase === 'A') || group.pages[0];
    const desc = GROUP_ENTRY_DESCRIPTIONS[group.id];
    if (!desc) throw new Error(`分组 \`${group.id}\` 缺入口描述`);
    return { title: entry.title, href: hrefOf(entry.id), desc };
  });

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'start/index',
    title: '文档首页',
    group: 'start',
    order: 10,
    phase: 'A',
    template: 'hub',
    summary:
      'AragonAgent 的中文文档入口：使用者从 TUI 与 `aragon exec` 读起，集成者从引擎 API 读起；全站 9 个分组、56 页，关键数字由门禁对齐源码。',
    keywords: ['文档首页', 'AragonAgent', 'aragon', '入门', '导航', '@aragon-agent/core'],
    seeAlso: ['start/install', 'start/five-minutes', 'cli/global-flags', 'exec/overview'],
    sourceRefs: [
      { path: 'README.md', lines: '39-43', snippet: '@aragon-agent/core' },
      { path: 'docs/guide-doc/src/content/data/tools.mjs', lines: '1-15', snippet: 'truth set S-4' },
      { path: 'docs/guide-doc/src/extract/sources.mjs', lines: '1-9', snippet: '9 个 truth set' },
      { path: 'docs/guide-doc/check.mjs', lines: '61-73', snippet: '--model' },
      { path: 'docs/guide-doc/src/site.config.mjs', lines: '34-42', snippet: 'export function withVersions' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          'AragonAgent 是一套装在终端里的编码 agent，同时是一个可以嵌入的引擎。`@aragon-agent/cli` 提供 `aragon` 命令' +
          '（交互式 TUI 与 `aragon exec` 机器契约），`@aragon-agent/core` 提供不碰持久化与界面的 Agent 引擎。' +
          '本站是这两个包的中文权威参考：每个参数、路径与退出码都能点到源码的那一行。',
      },
      {
        t: 'h2',
        text: '三条用法，三种读法',
      },
      {
        t: 'p',
        md: '同一套源码，三种用法。先确定你是哪一种，再决定从哪一行读起。',
      },
      {
        t: 'table',
        caption: '三条使用路径（分工与仓库 README 一致）',
        head: ['你想做的事', '用哪个', '从这里读'],
        rows: [
          [
            '在终端里和 agent 对话、看它干活',
            '`aragon` —— 交互式 TUI',
            '[安装与升级](/start/install/) 然后 [五分钟上手](/start/five-minutes/)',
          ],
          [
            '把 agent 循环嵌进自己的应用，用自己的工具',
            '`@aragon-agent/core` —— 引擎',
            '[安装与最小示例](/api/install/)',
          ],
          [
            '从脚本、CI 或另一个 agent 驱动它',
            '`aragon exec` —— JSON 契约',
            '[概览与 60 秒上手](/exec/overview/)',
          ],
        ],
      },
      {
        t: 'h2',
        text: '本组：四页上手',
      },
      {
        t: 'p',
        md:
          '「开始」组按导航顺序读四页就够上手：装、跑、走一遍完整回路、再理解它为什么这样跑。' +
          '每页开头的摘要是这一页的结论，赶时间只读摘要也不会漏掉前提。',
      },
      { t: 'cards', items: startCards },
      {
        t: 'h2',
        text: '全站地图',
      },
      {
        t: 'p',
        md:
          '其余八个分组各有一张入口卡片。除「附录」外，每张卡片都指向阶段 A 已交付的页面；' +
          '组内后续页面用侧栏或页尾的上一页／下一页抵达。',
      },
      { t: 'cards', items: groupCards },
      {
        t: 'h2',
        text: '本站如何保证准确',
      },
      {
        t: 'p',
        md:
          '参数、工具名、事件、退出码与配置键都不是手抄的：仓库里有 9 组真值（truth set），' +
          '全部由纯函数从源码提取，再用门禁把「写进正文的每一项」和这些集合逐条对照。' +
          '源码里没有的项，页面里也不允许出现 —— 这一条是用 ERROR 拦的，不是靠自觉。',
      },
      {
        t: 'ul',
        items: [
          '`S-1` / `S-2`：`cli.tsx` 与 `exec/cli-commands.ts` 里每一条 `.option(` 声明，含默认值与源码描述原文。',
          '`S-3` / `S-4`：斜杠命令（内置 30 条 + 命令族 7 条）与内置工具名（含 `HOST_TOOL_NAMES` 第二来源）。',
          '`S-5` / `S-6`：`exec/events.ts` 的事件联合与 `exec/runner.ts` 的退出码。',
          '`S-7` / `S-8` / `S-9`：`DEFAULT_CONFIG` 的配置键、Core 的导出面、两个包的版本号。',
        ],
      },
      {
        t: 'code',
        lang: 'bash',
        title: '在仓库里跑一遍门禁',
        code: ['node docs/guide-doc/check.mjs --model', 'node docs/guide-doc/check.mjs --dist'].join('\n'),
      },
      {
        t: 'p',
        md:
          '`--model` 读 `src/content` 下的页面模块，`--dist` 读产物目录；退出码 `0` 全绿、`1` 用法错误、`3` 存在 ERROR。' +
          '版本号不在正文里写死：`build.mjs` 解析两个 `package.json` 后注入页头。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '引用是按行号钉住的',
        md:
          '每条「本页依据」都被校验「这一段行区间今天还能不能找到这段原文」。代码前移时页面跟着报错，' +
          '而不是静默失效 —— 所以那些行号值得直接点开看。',
      },
    ],
  },

  {
    id: 'start/install',
    title: '安装与升级',
    group: 'start',
    order: 20,
    phase: 'A',
    template: 'steps',
    summary:
      'Node ≥ 18 上安装 `@aragon-agent/cli`：全局装或 `npx` 零安装，用 `aragon --version` 与 `aragon doctor` 验收，并含升级、回退与 SDK 安装。',
    keywords: ['安装', 'npm', 'npx', '@aragon-agent/cli', 'upgrade', 'aragon update', 'Node 版本'],
    seeAlso: ['start/first-run', 'cli/subcommands', 'api/install', 'troubleshoot/doctor'],
    sourceRefs: [
      { path: 'packages/cli/README.md', lines: '13-15', snippet: 'Node **≥ 18**, any platform.' },
      { path: 'packages/cli/README.md', lines: '49-58', snippet: 'npm i -g @aragon-agent/cli' },
      { path: 'packages/cli/package.json', lines: '34-36', snippet: '"aragon": "./dist/launcher.js"' },
      { path: 'packages/cli/src/cli.tsx', lines: '2386', snippet: '-v, --version' },
      { path: 'packages/cli/README.md', lines: '3324', snippet: 'aragon update --check' },
      { path: 'packages/cli/README.md', lines: '3332', snippet: 'execute **zero** lines' },
      { path: 'README.md', lines: '99-103', snippet: 'npm install @aragon-agent/core' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '安装本身只有一条命令，麻烦的是装完之后的确认：`aragon` 一个命令里装着 TUI、`exec` 契约和自更新机制，' +
          '装错版本或 Node 太旧都表现为「打开之后行为怪」，而不是一条干净的报错。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '前置条件只有一个',
        md:
          '两个包声明的引擎都是 `>=18`，没有别的系统依赖，Windows / macOS / Linux 共用同一份安装说明。' +
          'Windows 上更老 Node 的差异只影响 `Shift+Tab` 与可选的全屏滚动模式，不影响 agent 循环、工具与 `aragon -p`。',
      },
      {
        t: 'h2',
        text: '安装 CLI',
      },
      {
        t: 'steps',
        items: [
          {
            title: '确认 Node 版本',
            md: '低于 18 时 `npx` 与全局安装都会在启动阶段失败。验收：`node -v` 打印 `v18` 或更高。',
            code: { lang: 'bash', code: 'node -v' },
          },
          {
            title: '全局安装',
            md:
              '`aragon` 这个可执行名由包的 `bin` 字段提供，指向 `dist/launcher.js`。' +
              '验收：`aragon --version` 打印版本号 —— 这个参数在根命令上声明为 `-v, --version`。',
            code: { lang: 'bash', code: 'npm i -g @aragon-agent/cli' },
          },
          {
            title: '或者先用 npx 零安装试一次',
            md:
              '不想往全局目录写东西时用 `npx`，它从 npm 仓库解析包。验收：同样进入 TUI，' +
              '在输入框里敲 `/exit` 能退出（别名 `/quit`）。',
            code: { lang: 'bash', code: 'npx @aragon-agent/cli' },
          },
          {
            title: '自检这台机器',
            md:
              '`doctor` 回答的是「这台机器是否配置成能跑我」，`info --json` 打印版本、schema 版本、工具、输出格式与特性列表。' +
              '验收：`doctor` 退出码为 `0`；非 `0` 时先修它指出的那一项，再回到下一步。',
            code: {
              lang: 'bash',
              code: ['aragon doctor', 'aragon info --json'].join('\n'),
            },
          },
        ],
      },
      {
        t: 'h2',
        text: '升级、回退与关闭自动更新',
      },
      {
        t: 'p',
        md:
          '交互式会话会自动检查更新，符合条件时直接装。想自己掌握时机，用 `aragon update`；' +
          '想把自动检查关掉，用配置文件键或环境变量，两者等价。',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '手动更新',
        code: [
          'aragon update --check                    # 只问有没有新版本，不安装',
          'aragon update                            # 立刻检查，符合条件就安装',
          'aragon update --to 0.5.8                 # 装回某个具体版本',
          'aragon update --rollback                 # 撤销上一次自动更新',
        ].join('\n'),
      },
      {
        t: 'table',
        caption: '四种关法，效果不同',
        head: ['做法', '效果'],
        rows: [
          ['`aragon config set update.mode notify`', '检查并提示，但不自动安装'],
          ['`aragon config set update.mode off`', '完全不检查'],
          ['`ARAGON_UPDATE=0 aragon`', '本次运行关闭'],
          ['`aragon --no-update`', '同上，用参数写法'],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '非交互运行根本不执行更新代码',
        md:
          '后台更新器只为交互式会话构造：`aragon -p "…"`、`aragon config set`、CI（任何真值的 `CI`）与非 TTY 执行' +
          ' **零行** 更新代码。脚本与流水线里不需要额外的开关。',
      },
      {
        t: 'h2',
        text: '安装引擎 SDK',
      },
      {
        t: 'p',
        md:
          '要在自己的项目里嵌 agent 循环，装的是另一个包。它 ESM-only、同样要求 Node ≥ 18，' +
          '导出根入口加六个子路径：`./llm/types`、`./llm/providers`、`./tools/types`、`./tools/helpers`、`./skills`、`./sandbox/*`。',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '项目内安装',
        code: 'npm install @aragon-agent/core',
      },
      {
        t: 'p',
        md:
          '最小可运行示例（自定义工具 + `AragonAgent` + Provider 注册表）见 [安装与最小示例](/api/install/)；' +
          '冻结的公开面见 [类型导出与子路径导出](/api/types/)。',
      },
    ],
  },

  {
    id: 'start/first-run',
    title: '第一次运行',
    group: 'start',
    order: 30,
    phase: 'A',
    template: 'steps',
    summary:
      '第一次运行 `aragon`：开场块显示什么、数据目录 `~/.aragon-agent` 与 `ARAGON_HOME` 的关系、`config.json` 何时落盘、API key 的四个来源与优先级。',
    keywords: ['首次运行', 'ARAGON_HOME', 'config.json', 'API key', 'ANTHROPIC_API_KEY', '/settings'],
    seeAlso: ['config/overview', 'config/home', 'config/env', 'guide/tui'],
    sourceRefs: [
      {
        path: 'packages/cli/src/ui/SessionOpener.tsx',
        lines: '52-77',
        snippet: 'Run /settings (or set ANTHROPIC_API_KEY) to get started.',
      },
      { path: 'packages/cli/src/config/app-paths.ts', lines: '10-24', snippet: 'persisted config (0600 on POSIX)' },
      { path: 'packages/cli/src/config/app-paths.ts', lines: '31-34', snippet: 'ARAGON_HOME=$XDG_CONFIG_HOME/aragon-agent' },
      { path: 'packages/cli/src/config/env.ts', lines: '34-38', snippet: 'NOT here: `ARAGON_HOME`' },
      { path: 'packages/cli/src/config/load.ts', lines: '1082', snippet: 'config-file key wins over the provider env var' },
      { path: 'packages/cli/src/config/store.ts', lines: '117-143', snippet: 'Atomically write the persisted config' },
      { path: 'packages/cli/src/config/cli-commands.ts', lines: '718-726', snippet: 'overridden by ARAGON_HOME' },
      { path: 'packages/cli/src/commands/builtins.ts', lines: '1456', snippet: "name: 'exit'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '第一次运行没有向导：它直接进入 TUI，把该说的一句话放在开场块里。下面按你实际会看到的顺序走一遍，' +
          '每一步都说明「怎么算成功」。',
      },
      {
        t: 'h2',
        text: '先看数据落在哪',
      },
      {
        t: 'p',
        md:
          '运行时的东西全在一个目录里：默认 `~/.aragon-agent/`，`ARAGON_HOME` 可以把整个根搬走，' +
          '三个平台用同一个路径（想走 XDG 就自己指 `ARAGON_HOME`）。目录里是 `config.json`、' +
          '`model-windows.json`、`prompt-history.jsonl`、`state.json`、`logs/`、`sessions/`、`skills/`。',
      },
      {
        t: 'steps',
        items: [
          {
            title: '问一下根目录在哪',
            md:
              '`config home` 打印实际生效的根目录，接着两行是提示历史与 UI 状态文件的位置。' +
              '验收：第二行出现 `(overridden by ARAGON_HOME)`，说明环境变量真的生效了；没有这一行就是默认的 `~/.aragon-agent`。',
            code: { lang: 'bash', code: 'aragon config home' },
          },
          {
            title: '知道 config.json 什么时候才出现',
            md:
              '启动不会凭空创建 `config.json`：文件缺失时它保持缺失，直到你第一次改动需要持久化的设置' +
              '（`/theme`、`/thinking`、`/model` 选择、`/settings` 保存、`aragon config set`）。写盘是原子的，' +
              'POSIX 上权限为 `0600`。验收：先 `aragon config home`，改一次 `/theme` 之后再 `ls` 那个目录。',
          },
          {
            title: '给一个 API key',
            md:
              '三选一：在 shell 里导出环境变量；在 TUI 里用 `/settings` 粘贴（会落进 `config.json`）；' +
              '或用 `--api-key` 做一次性覆盖（不持久化）。验收：重开 TUI 后开场块里不再出现 ' +
              '“Run /settings (or set ANTHROPIC_API_KEY) to get started.” 这一行。',
            code: {
              lang: 'bash',
              code: [
                'export ANTHROPIC_API_KEY=sk-ant-...',
                'export OPENAI_API_KEY=...',
                'export GOOGLE_API_KEY=...',
              ].join('\n'),
            },
          },
          {
            title: '发第一句',
            md:
              '直接 `aragon` 进入 TUI 再输入，或者把提示词当参数传进去（会自动提交）。' +
              '验收：出现一条回答，并且它读文件时会出现一张工具卡片。',
            code: { lang: 'bash', code: 'aragon "summarize README.md"' },
          },
          {
            title: '退出',
            md:
              '`/exit`（别名 `/quit`）直接退出。`Ctrl+C` 不是退出键：它先处理选区与后台服务，' +
              '之后才进入「再按两次退出」的阶梯 —— 想一次走掉就用斜杠命令。验收：会话结束时没有残留的后台服务。',
            code: { lang: 'bash', code: '/exit' },
          },
        ],
      },
      {
        t: 'h2',
        text: '开场块里的那两行',
      },
      {
        t: 'table',
        caption: '开场块（SessionOpener）会说的话',
        head: ['显示内容', '含义'],
        rows: [
          ['`v<版本>` 与工作目录', '这一进程的版本号与工具的工作目录（`--cwd` 可改）'],
          ['Full permission, no sandbox …', '`bash` 直接执行、文件直接写盘，默认没有逐动作确认'],
          ['Run /settings (or set ANTHROPIC_API_KEY) …', '只在没有解析到 key 时出现'],
          ['一条示例提示词', '有 key 且终端不太矮时出现，只是示例，不会自动提交'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: 'key 的优先级可能与你的直觉相反',
        md:
          '配置文件里的 key **优先于** 环境变量：`config.json` 的 `apiKeys` 有值时，同名的 `ANTHROPIC_API_KEY` 会被忽略。' +
          '排查「明明导出了新 key 却不生效」时，先看 `config.json`。',
      },
      {
        t: 'h2',
        text: '关于 ARAGON_HOME 的两个坑',
      },
      {
        t: 'ul',
        items: [
          '它**不能**写在项目 `.env` 里：`.env` 的加载发生在路径解析之后，一个 `.env` 永远供不上它。',
          '指向一个不是目录的路径会被忽略并在日志里说明原因，然后退回默认根目录 —— 不会报错退出。',
          '换目录等于换掉全部状态：会话、技能、日志与 key 都在根目录下，`ARAGON_HOME` 一改就是另一个「用户」。',
        ],
      },
    ],
  },

  {
    id: 'start/five-minutes',
    title: '五分钟上手',
    group: 'start',
    order: 40,
    phase: 'A',
    template: 'steps',
    summary:
      '六个动作走完一轮完整回路：确认版本、用 `/model` 换模型、让它读一个文件、看一张工具卡片、连按两次 Esc 打断、`/exit` 退出。',
    keywords: ['五分钟', '快速上手', '/model', 'read_file', 'Ctrl+C', 'Esc', '/exit'],
    seeAlso: ['guide/tui', 'guide/keybindings', 'guide/slash-commands', 'tools/index', 'cli/global-flags'],
    sourceRefs: [
      { path: 'packages/cli/src/commands/builtins.ts', lines: '296', snippet: "name: 'model'" },
      { path: 'packages/cli/src/ui/overlays/ModelPicker.tsx', lines: '1-9', snippet: 'Model picker overlay' },
      { path: 'packages/cli/src/ui/App.tsx', lines: '2482', snippet: 'saveModelSettingsPatch' },
      { path: 'packages/cli/src/tools/fs-tools.ts', lines: '83-89', snippet: "name: 'read_file'" },
      { path: 'packages/cli/src/input/interrupt-gesture.ts', lines: '1-27', snippet: 'INTERRUPT_CONFIRM_MS = 1500' },
      { path: 'packages/cli/src/ui/App.tsx', lines: '3077', snippet: 'advanceInterruptGesture' },
      { path: 'packages/cli/src/ui/App.tsx', lines: '2707', snippet: 'liveServiceCount' },
      { path: 'packages/cli/README.md', lines: '723-740', snippet: 'Headless: stream the answer to stdout, then exit' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '这一页只做一件事：让完整回路（提问 → 模型 → 工具 → 结果 → 收工）在你眼前跑一遍。' +
          '参数与表格不在这里重复，需要时点 [全局参数](/cli/global-flags/) 与 [内置工具](/tools/index/)。',
      },
      {
        t: 'h2',
        text: '六个动作',
      },
      {
        t: 'steps',
        items: [
          {
            title: '确认装好了',
            md: '验收：`aragon --version` 打印版本号。装不上先回 [安装与升级](/start/install/)。',
            code: { lang: 'bash', code: 'aragon --version' },
          },
          {
            title: '换一个模型',
            md:
              '`/model` 打开模型选择器，列表来自真正接得上的 provider，不会出现「选了才知道跑不起来」的项。' +
              '选择是落盘的（先在磁盘上做一次原子提交，再让本会话生效）。' +
              '验收：再打开 `/model`，当前项就是刚选的那一行。',
            code: { lang: 'bash', code: '/model' },
          },
          {
            title: '让它读一个文件',
            md:
              '提一个必须读文件才能回答的问题。它会调用 `read_file`，卡片上写着路径，回答里应该是文件里的真内容。' +
              '验收：卡片里的路径与你指定的路径一致。',
            code: { lang: 'bash', code: 'aragon "读 package.json，告诉我 name 和 engines.node"' },
          },
          {
            title: '看一张工具卡片的细节',
            md:
              '`{kbd:Ctrl+O}` 展开最近一张工具卡片（或末条回答）。验收：展开后能看到工具的入参与输出，' +
              '再按一次收起。全部键位见 [键盘快捷键](/guide/keybindings/)。',
          },
          {
            title: '打断一次',
            md:
              '运行过程中连按两次 `{kbd:Esc}`（1.5 秒内）中断当前回合，再按一次是强制停止。' +
              '验收：状态行回到空闲，输入框可以继续输入。',
          },
          {
            title: '退出，并用无头方式再跑一次',
            md:
              '`/exit` 退出交互式会话；同样的活可以用 `-p` 一次性跑完并把回答打到 stdout。' +
              '验收：`-p` 的命令退出后，终端里留下的是纯文本回答，可以直接管道给下一个命令。',
            code: { lang: 'bash', code: ['/exit', 'aragon -p "读 package.json，告诉我 name 和 engines.node"'].join('\n') },
          },
        ],
      },
      {
        t: 'h2',
        text: '同一个动作的三种入口',
      },
      {
        t: 'table',
        caption: '交互式、一次性、机器契约（参数细节在各自的页面）',
        head: ['入口', '适合', '输出'],
        rows: [
          ['`aragon`', '人看着它干活，需要中途引导', 'TUI'],
          ['`aragon -p "…"`', '脚本里要一段文本结果', 'stdout 上的纯文本'],
          ['`aragon exec "…"`', '另一个程序要结构化事件与会话', '`text` / `json` / `stream-json`'],
        ],
      },
      {
        t: 'h2',
        text: '接下来读什么',
      },
      {
        t: 'ul',
        items: [
          '[界面导览](/guide/tui/)：状态行、面板带、滚动与浮层分别在哪。',
          '[斜杠命令](/guide/slash-commands/)：`/model` 之外的命令与别名。',
          '[输入、队列与中断](/guide/input-queue/)：运行中继续输入会发生什么。',
          '[配置文件与优先级](/config/overview/)：刚才 `/model` 改的是哪个键。',
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '默认全权限，没有沙箱',
        md:
          '`bash` 直接执行、文件直接写盘，默认没有逐动作确认 —— 只在信任的工作区里跑。' +
          '需要逐个批准时用 `--confirm`（每个变更类工具调用前确认）；机器契约侧用 `--permission-mode strict`。',
      },
    ],
  },

  {
    id: 'start/concepts',
    title: '六个核心概念',
    group: 'start',
    order: 50,
    phase: 'A',
    template: 'prose',
    summary:
      '六个核心概念——Agent 循环、工具调用、事件流、上下文与压缩、会话、权限与确认；每个概念都指到真正的源文件，读完能把界面上的每一块对上实现。',
    keywords: ['概念', 'Agent 循环', '工具调用', '事件流', '上下文压缩', '会话', '权限'],
    seeAlso: ['api/agent', 'api/tools', 'api/events', 'guide/context', 'exec/permissions'],
    sourceRefs: [
      { path: 'packages/core/src/engine/agent-loop.ts', lines: '1-8', snippet: 'stream consumption -> tool execution -> loop' },
      { path: 'packages/core/src/tools/executor.ts', lines: '1-12', snippet: 'Tool lookup from registry' },
      { path: 'packages/core/src/types.ts', lines: '134-147', snippet: 'export type AgentEvent =' },
      { path: 'packages/core/src/engine/compaction.ts', lines: '1-20', snippet: 'Pure compaction mechanics' },
      {
        path: 'packages/cli/src/compaction/compactor.ts',
        lines: '1',
        snippet: 'Threshold-authorized compaction with host-owned, append-only task memory.',
      },
      { path: 'packages/cli/src/session/store.ts', lines: '1-16', snippet: 'The id-keyed session store behind' },
      { path: 'packages/cli/src/cli.tsx', lines: '2394', snippet: '--resume' },
      { path: 'packages/cli/src/tools/index.ts', lines: '467-478', snippet: "'write_file'," },
      { path: 'packages/cli/src/exec/permission.ts', lines: '10-16', snippet: 'REMOVES, and wins over allow' },
      { path: 'packages/cli/src/ui/overlays/ConfirmDialog.tsx', lines: '48-59', snippet: 'state.resolve(true)' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '界面上的四块东西 —— 流式回答、工具卡片、上下文占用条、状态行 —— 各自对应引擎里的一个概念。' +
          '下面六个概念按「一次提问从发出到结束」的顺序排列，每个都给出源文件，读代码时可以原地接上。',
      },
      {
        t: 'h2',
        text: '一张表看完',
      },
      {
        t: 'table',
        caption: '六个概念与它们的源码入口',
        head: ['概念', '一句话', '源码入口'],
        rows: [
          ['Agent 循环', '调用模型 → 消费流 → 执行工具 → 回到循环', '`packages/core/src/engine/agent-loop.ts`'],
          ['工具调用', '查表、校验、超时、执行、截断、错误落成结果', '`packages/core/src/tools/executor.ts`'],
          ['事件流', '一次运行的全部状态变化，订阅即可渲染', '`packages/core/src/types.ts` 的 `AgentEvent`'],
          ['上下文与压缩', '哪里能切、切完还能不能发、什么时候切', '`packages/core/src/engine/compaction.ts`'],
          ['会话', '给一段对话一个 id，让它跨进程活下去', '`packages/cli/src/session/store.ts`'],
          ['权限与确认', '哪些调用要人点头，哪些直接跑', '`packages/cli/src/tools/index.ts`、`exec/permission.ts`'],
        ],
      },
      {
        t: 'h2',
        text: '一、Agent 循环',
      },
      {
        t: 'p',
        md:
          '引擎的全部工作是同一个循环：调模型、把流消费成消息、若模型要工具就执行、把结果塞回历史、再来一轮。' +
          '循环内部有 steering / follow-up 的检查点 —— 这就是「运行中继续输入」不会丢字的原因，' +
          '排队的文本会在下一个安全点整批进入历史并发出一张回执。',
      },
      {
        t: 'quote',
        md:
          'Implements the LLM call -> stream consumption -> tool execution -> loop cycle, ' +
          'with steering/follow-up checkpoints',
        cite: 'packages/core/src/engine/agent-loop.ts:4',
      },
      {
        t: 'p',
        md: '引擎侧细节见 [Agent 与 AgentConfig](/api/agent/)；你在界面上看到的「思考中／运行中」来自这个循环的回合边界。',
      },
      {
        t: 'h2',
        text: '二、工具调用',
      },
      {
        t: 'p',
        md:
          '一次工具调用是一条固定流水线：注册表查表、按 JSON Schema 校验入参、用 `AbortController` 包超时、执行、' +
          '截断过长输出、把任何错误收成 `ToolResult` 而不是抛出。这条流水线意味着两件事：' +
          '模型给的参数不合法时拿到的是可读的校验错误；单个工具卡住不会拖垮整个回合。',
      },
      {
        t: 'quote',
        md:
          'Orchestrates the full lifecycle of a tool invocation: lookup, JSON Schema validation, ' +
          'timeout, execution, truncation, error capture',
        cite: 'packages/core/src/tools/executor.ts:3',
      },
      {
        t: 'p',
        md:
          '工具清单、参数与源码位置在 [工具总览](/tools/index/)；`read_file` 一类文件工具见 [文件与搜索工具](/tools/files/)。',
      },
      {
        t: 'h2',
        text: '三、事件流',
      },
      {
        t: 'p',
        md:
          '引擎不回调界面，它发事件。`AgentEvent` 是一个 12 个成员的联合：回合开始／结束、消息增量、' +
          '工具执行开始／结束、代码执行、压缩开始／结束，以及 steering 回执。' +
          'TUI 订阅它把卡片画出来；`aragon exec` 把同一批事件序列化成 NDJSON —— 同一份事实，两种消费方式。',
      },
      {
        t: 'quote',
        md: 'export type AgentEvent = AgentStartEvent | AgentEndEvent | TurnStartEvent | SteeringAcceptedEvent | …',
        cite: 'packages/core/src/types.ts:134-147',
      },
      {
        t: 'p',
        md:
          '事件字段见 [事件与订阅](/api/events/)；`exec` 侧的 `type` / `subtype` 对照见 [事件参考](/exec/events/)。' +
          '`exec` 的事件是**另一组**类型，故意不进 Core 的联合，避免引擎学习宿主形态。',
      },
      {
        t: 'h2',
        text: '四、上下文与压缩',
      },
      {
        t: 'p',
        md:
          '上下文会满，于是要压缩。分层很干净：引擎只回答两个问题 —— 这段历史在哪里可以安全切开，' +
          '以及切完之后还能不能发出去（一个没有配对的 `tool_result` 会让请求直接 400）；' +
          'CLI 负责阈值判断、摘要调用与归档，所以「模型什么时候开始忘事」是策略，不是机制。',
      },
      {
        t: 'quote',
        md: 'Pure compaction mechanics. NO I/O, NO CLOCK, NO PROVIDER KNOWLEDGE, NO `node:*` IMPORT.',
        cite: 'packages/core/src/engine/compaction.ts:2',
      },
      {
        t: 'p',
        md:
          'CLI 侧的实现读作「阈值授权的压缩，加上宿主拥有的、只追加的任务记忆」；' +
          '用户可见的占用条、`/compact` 与 `/context` 见 [上下文与自动压缩](/guide/context/)，' +
          '端口定义见 [上下文压缩端口](/api/compaction/)。',
      },
      {
        t: 'h2',
        text: '五、会话',
      },
      {
        t: 'h3',
        text: '会话 id 的两种用法',
      },
      {
        t: 'p',
        md:
          '会话是「一段对话 + 一个 id + 一份落盘状态」，目录里的 `sessions/` 与 `aragon exec` 共用同一种文件格式。' +
          '两个参数把语义分开：`--resume` 读已有会话并以**新 id** 继续（原会话不会被这一进程再写一次），' +
          '`--save` 给本次运行命名 id 并把它固定在清理之外。',
      },
      {
        t: 'quote',
        md:
          'The id-keyed session store behind `aragon exec`. Identity, listing, retention and ' +
          'mutual exclusion live here; the file format is shared with the TUI',
        cite: 'packages/cli/src/session/store.ts:2',
      },
      {
        t: 'p',
        md: '交互式侧的 `/save`、`/resume`、`/branch` 与跨终端续接见 [会话、恢复与分支](/guide/sessions/)。',
      },
      {
        t: 'h2',
        text: '六、权限与确认',
      },
      {
        t: 'p',
        md:
          '默认是**全权限**：`bash` 直接执行、文件直接写盘，没有逐动作闸门。可选的收紧手段有四层，' +
          '它们作用在不同位置，所以可以叠用。',
      },
      {
        t: 'table',
        caption: '四层收紧手段（互不替代）',
        head: ['手段', '在哪', '作用'],
        rows: [
          ['`--confirm`', 'TUI 根参数', '每个变更类工具调用前弹确认框，`{kbd:Y}` 批准、`{kbd:N}` 拒绝'],
          ['`Shift+Tab` 或 `/plan`', 'TUI', '计划模式：写入与进程类工具在调用时被拒绝（共 6 个）'],
          ['`--permission-mode`', '`aragon exec`', '基线：`auto`、`plan`、`strict`、`ask`'],
          ['`--allow-tool` / `--deny-tool`', '`aragon exec`', '在基线上加减，`--deny-tool` 赢过 `--allow-tool`'],
        ],
      },
      {
        t: 'p',
        md:
          '计划模式不注销工具，而是在调用时返回拒绝文本 —— 模型仍然「知道」写操作存在、只是被推迟，' +
          '这正是它能转去 `submit_plan` 的原因。被拦的六个名字是 `write_file`、`edit_file`、`bash`、' +
          '`skill_install`、`skill_create`、`bash_kill`。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '确认闸门是一个包装器，不是引擎钩子',
        md:
          '工具在注册时被包成 `{...tool, execute}`：先是策略与计划门的拒绝（不需要 I/O），然后才是人。' +
          '所以「策略本来就会拒」的调用永远不会打扰人 —— 顺序本身就是设计的一部分。',
      },
      {
        t: 'p',
        md:
          '机器契约侧的完整语义见 [权限模式与工具白名单](/exec/permissions/)；计划模式的交互流程见 [计划模式](/guide/plan-mode/)。',
      },
    ],
  },
];
