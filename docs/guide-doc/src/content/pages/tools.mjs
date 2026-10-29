/**
 * 内置工具分组（`tools`）的页面。
 *
 * `tools/index` 是 hub：卡片由 `src/content/data/tools.mjs` 的 19 条记录生成，
 * 因此「卡片数 = 本组页面数」这条断言与数据集天然一致（§8.5）。
 */

import { tools } from '../data/tools.mjs';

/** 分组页面清单（与 nav.mjs 一致，供卡片与「按用途选集」使用）。 */
const GROUP_PAGES = [
  { id: 'tools/files', title: '文件与搜索工具', desc: '读写文件、列目录、glob 与 grep：把仓库当数据库查' },
  { id: 'tools/shell', title: 'Shell 与后台作业工具', desc: 'bash、bash_output、bash_kill、job_wait、job_list 的协作方式' },
  { id: 'tools/plan', title: '计划与提问工具', desc: 'ask_user、submit_plan、todo_write、task：让人与代理对齐' },
  { id: 'tools/skills', title: '技能工具', desc: 'skill、skill_find、skill_install、skill_create 的完整契约' },
];

/**
 * 找一条工具记录。
 *
 * @param {string} name 工具名
 * @returns {object} 记录
 */
function tool(name) {
  const record = tools.find((item) => item.name === name);
  if (!record) throw new Error(`工具数据集里没有 \`${name}\``);
  return record;
}

/**
 * 渲染某几个工具的 `params` 表。
 *
 * @param {string[]} names 工具名列表
 * @param {string} caption 表标题
 * @returns {object[]} block 序列
 */
function toolSections(names, caption) {
  const blocks = [];
  for (const name of names) {
    const record = tool(name);
    blocks.push({ t: 'h3', text: `\`${record.name}\`` });
    blocks.push({ t: 'p', md: record.summary });
    if (record.params.length > 0) {
      blocks.push({
        t: 'params',
        caption: `${caption} —— \`${record.name}\``,
        items: record.params.map((param) => ({
          name: param.name,
          type: param.type,
          required: Boolean(param.required),
          default: param.default,
          desc: param.desc,
        })),
      });
    }
    blocks.push({
      t: 'p',
      md: `${record.mutating ? '**会改变状态**' : '只读'} · 依据 \`${record.source.path}:${record.source.lines}\``,
    });
  }
  return blocks;
}

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'tools/index',
    title: '工具总览',
    group: 'tools',
    order: 10,
    phase: 'A',
    template: 'hub',
    summary:
      '19 个内置工具的全景：每个工具做什么、是否改变状态、在哪些源文件里定义。按「读、跑、对齐、技能」四类分组进入详细页。',
    keywords: ['工具', 'tools', '内置工具', 'read_file', 'bash', 'skill', '19 个'],
    seeAlso: ['tools/files', 'tools/shell', 'tools/plan', 'tools/skills'],
    sourceRefs: [
      { path: 'packages/cli/src/tools/index.ts', lines: '500-530', snippet: 'HOST_TOOL_NAMES' },
      { path: 'packages/cli/src/tools/fs-tools.ts', lines: '85-90', snippet: "name: 'read_file'" },
      { path: 'packages/core/src/skills/skill-tool.ts', lines: '54-60', snippet: "name: 'skill'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '工具是代理"能做的事"的全部边界。19 个工具来自 6 个源位置：`tools/` 下 13 个、' +
          '`todo_write`、`task`、以及技能族 4 个（其中 `skill` 与 `skill_find` 定义在 Core 里）。',
      },
      {
        t: 'cards',
        items: GROUP_PAGES.map((page) => ({
          title: page.title,
          href: `/${page.id}/`,
          desc: page.desc,
          badge: 'B 阶段',
        })),
      },
      {
        t: 'h2',
        text: '全部 19 个工具',
      },
      {
        t: 'table',
        caption: '工具名、是否改变状态与定义位置（顺序与源文件扫描一致）',
        head: ['工具', '作用', '改变状态', '定义于'],
        rows: tools.map((record) => [
          `\`${record.name}\``,
          record.summary,
          record.mutating ? '是' : '否',
          `\`${record.source.path}:${record.source.lines}\``,
        ]),
      },
      {
        t: 'h2',
        text: '两条容易混淆的边界',
      },
      {
        t: 'ul',
        items: [
          '**「会改变状态」不等于「被允许」**：`--permission-mode` 与 `--deny-tool` 决定放行，' +
            '「改变状态」只说明它可能写东西。',
          '**`HOST_TOOL_NAMES` 有 20 条**：多出来的 `submit_result` 是宿主专属工具，' +
            '只有带 `--result-schema` 的会话才注册它，所以不计入「内置工具 19 个」。',
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '为什么这里只有 19 个',
        md:
          '「内置」指随 CLI/Core 一起发布、无需安装就能用的工具。团队模式下子代理还会拿到 `team_send` / `team_wait`，' +
          '它们不在这个口径里。',
      },
    ],
  },

  {
    id: 'tools/files',
    title: '文件与搜索工具',
    group: 'tools',
    order: 20,
    phase: 'B',
    template: 'api',
    summary:
      '`read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep` 六个工具的参数、返回与典型组合，含读写边界与编码约定。',
    keywords: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', '文件工具'],
    seeAlso: ['tools/index', 'tools/shell', 'config/overview'],
    importLine: "// 这些工具随 CLI 一起提供，直接对话即可用，无需导入",
    signature: `read_file({ path, offset?, limit? }) -> { lines: string[] }
write_file({ path, content }) -> { bytes }
edit_file({ path, old_string, new_string, replace_all? }) -> { diff }
list_dir({ path? }) -> { entries: { name, type, size }[] }
glob({ pattern, cwd? }) -> string[]
grep({ pattern, path?, glob?, ignoreCase? }) -> { matches: { path, line, text }[] }`,
    sourceRefs: [
      { path: 'packages/cli/src/tools/fs-tools.ts', lines: '85-240', snippet: "name: 'read_file'" },
      { path: 'packages/cli/src/tools/search-tools.ts', lines: '30-90', snippet: "name: 'glob'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '六个文件工具的分工很明确：**读**（`read_file`、`list_dir`）、**找**（`glob`、`grep`）、' +
          '**写**（`write_file`、`edit_file`）。写类工具默认要求精确匹配，避免"大概在这个位置"的破坏性修改。',
      },
      {
        t: 'h2',
        text: '参数',
      },
      ...toolSections(['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep'], '参数'),
      {
        t: 'h2',
        text: '组合方式',
      },
      {
        t: 'steps',
        items: [
          {
            title: '先定位再读',
            md: '用 `glob` 找文件、`grep` 找行，最后只 `read_file` 那一小段。整仓读取是最常见的浪费。',
            code: { lang: 'bash', code: 'grep(pattern: "registerBuiltinCommands", glob: "*.ts")' },
          },
          {
            title: '改一处用 edit_file',
            md: '`old_string` 必须唯一；不唯一就带上上下文，或者用 `replace_all` 明确表示"全都要改"。',
          },
          {
            title: '建新文件用 write_file',
            md: '它会创建父目录并整文件覆盖 —— 对已存在的文件要格外小心。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '`write_file` 是覆盖，不是追加',
        md: '想在一份大文件里加几行，用 `edit_file`。用 `write_file` 前先 `read_file`，否则会静默丢掉没读到的部分。',
      },
    ],
  },

  {
    id: 'tools/shell',
    title: 'Shell 与后台作业工具',
    group: 'tools',
    order: 30,
    phase: 'B',
    template: 'api',
    summary:
      '`bash` 的前台与后台两种模式，以及 `bash_output`、`bash_kill`、`job_wait`、`job_list` 如何观察和停止一个不自己退出的进程。',
    keywords: ['bash', 'bash_output', 'bash_kill', 'job_wait', 'job_list', '后台', '作业'],
    seeAlso: ['tools/index', 'tools/files', 'guide/background'],
    importLine: '// bash 与四个作业工具都是内置工具，无需导入',
    signature: `bash({ command, timeout?, background?, cwd? }) -> output | { jobId, status }
bash_output({ service, since? }) -> { status, progress, output }
bash_kill({ service }) -> { stopped: boolean }
job_wait({ job, timeoutSeconds?, since? }) -> { status, progress, output }
job_list({}) -> { jobs: { id, kind, status, elapsed, progress }[] }`,
    sourceRefs: [
      { path: 'packages/cli/src/tools/bash-tool.ts', lines: '265-300', snippet: "name: 'bash'" },
      { path: 'packages/cli/src/tools/proc-tools.ts', lines: '59-120', snippet: "name: 'bash_output'" },
      { path: 'packages/cli/src/tools/job-tools.ts', lines: '238-380', snippet: "name: 'job_wait'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '一条命令要么**会自己结束**（前台跑完返回输出），要么**不会**（服务、watcher、训练任务）。' +
          '后者必须交给运行时监管：`background: true` 立刻返回作业 id，再用四个作业工具观察它。',
      },
      {
        t: 'h2',
        text: '参数',
      },
      ...toolSections(['bash', 'bash_output', 'bash_kill', 'job_wait', 'job_list'], '参数'),
      {
        t: 'h2',
        text: '什么时候必须用后台',
      },
      {
        t: 'ul',
        items: [
          '命令自己不会退出：dev server、`docker compose up`、`tail -f`、文件 watcher。',
          '命令要跑很久：超过一次工具调用的时间上限（训练、全量构建、模型下载）。',
          '需要边跑边看日志：`bash_output` 可以按游标只读增量。',
        ],
      },
      {
        t: 'h2',
        text: '一个完整的后台循环',
      },
      {
        t: 'steps',
        items: [
          {
            title: '起在后台',
            md: '拿到作业 id（`s1` 表示服务，`t1` 表示会结束的任务）。',
            code: { lang: 'bash', code: 'bash(command: "npm run dev", background: true)' },
          },
          {
            title: '确认真的起来了',
            md: '后台结果只是"进程在跑"，不是"服务可用"。读日志并真的发一次请求。',
            code: { lang: 'bash', code: 'bash_output(service: "s1")' },
          },
          {
            title: '用完就停',
            md: '不停会占端口、占内存，还会让下一次启动失败。',
            code: { lang: 'bash', code: 'bash_kill(service: "s1")' },
          },
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '不要自己 detach',
        md:
          '用 `&`、`nohup`、`Start-Process` 自己把进程扔到后台，运行时就读不到它的日志、也停不掉它。' +
          '这不是风格问题：失去监管的进程在会话结束后仍然占着端口。',
      },
    ],
  },

  {
    id: 'tools/plan',
    title: '计划与提问工具',
    group: 'tools',
    order: 40,
    phase: 'B',
    template: 'api',
    summary:
      '`ask_user`、`submit_plan`、`todo_write`、`task` 四个"对齐类"工具：什么时候该问、计划为什么要批准、清单与验收标准怎么用、并行子代理怎么派。',
    keywords: ['ask_user', 'submit_plan', 'todo_write', 'task', '计划', '验收标准', '子代理'],
    seeAlso: ['tools/index', 'guide/plan-mode', 'guide/todo', 'guide/team'],
    importLine: '// 四个对齐类工具都是内置工具',
    signature: `ask_user({ questions: { id, header, question, options }[] }) -> answers
submit_plan({ title, summary, steps, risks?, openQuestions? }) -> approval
todo_write({ todos, acceptance? }) -> { ok }
task({ subagents: { description, prompt, readOnly? }[] }) -> report`,
    sourceRefs: [
      { path: 'packages/cli/src/tools/plan-tools.ts', lines: '95-210', snippet: "name: 'ask_user'" },
      { path: 'packages/cli/src/todo/todo-tool.ts', lines: '131-160', snippet: "name: 'todo_write'" },
      { path: 'packages/cli/src/team/task-tool.ts', lines: '115-150', snippet: "name: 'task'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '这四个工具的共同点：它们不改变仓库，而是**改变共识**。用错它们的方式只有两种 —— 该问的时候猜，或者把一次能问清的事问成三轮。',
      },
      {
        t: 'h2',
        text: '参数',
      },
      ...toolSections(['ask_user', 'submit_plan', 'todo_write', 'task'], '参数'),
      {
        t: 'h2',
        text: '选择规则',
      },
      {
        t: 'table',
        caption: '什么时候用哪个',
        head: ['情形', '用哪个', '为什么'],
        rows: [
          ['有多种合理做法且代价不同', '`ask_user`', '猜错的成本高于问一句'],
          ['改动跨多个文件、需要先对齐步骤', '`submit_plan`', '批准之后才动文件'],
          ['任务有 3 步以上、要能被别人检查', '`todo_write`', '进度要可见，验收标准要可核对'],
          ['几块工作互不依赖', '`task`', '并行省时间；串行会互相等待'],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '`todo_write` 是整体替换',
        md: '每次都要发送**完整清单**，不是增量。因此清单要短（最多 20 项），状态只有 pending / in_progress / completed。',
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '`submit_plan` 一次运行只能调一次',
        md: '计划是"开工前的对齐"，不是"随时可刷新的状态"；需要更新进度用 `todo_write`。',
      },
    ],
  },

  {
    id: 'tools/skills',
    title: '技能工具',
    group: 'tools',
    order: 50,
    phase: 'B',
    template: 'api',
    summary:
      '`skill`、`skill_find`、`skill_install`、`skill_create` 的契约：技能如何被加载、为什么搜索不联网、安装来源有哪些、以及 `allowed-tools` 的可执行性。',
    keywords: ['skill', 'skill_find', 'skill_install', 'skill_create', '技能工具', 'allowed-tools'],
    seeAlso: ['guide/skills', 'api/skills', 'tools/index'],
    importLine: '// skill 与 skill_find 定义在 Core，skill_install / skill_create 在 CLI',
    signature: `skill({ name, arguments? }) -> { body, files }
skill_find({ query, limit? }) -> { matches }
skill_install({ source, scope? }) -> { name, path }
skill_create({ name, description, body, files? }) -> { name, path }`,
    sourceRefs: [
      { path: 'packages/cli/src/skills/tools.ts', lines: '52-110', snippet: "name: 'skill_install'" },
      { path: 'packages/core/src/skills/skill-tool.ts', lines: '54-90', snippet: "name: 'skill'" },
      { path: 'packages/core/src/skills/skill-find-tool.ts', lines: '93-130', snippet: "name: 'skill_find'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '技能的加载是**渐进**的：系统提示词里只有名字与描述，真正需要时才用 `skill` 读全文。' +
          '因此装了 50 个技能也不会撑爆上下文。',
      },
      {
        t: 'h2',
        text: '参数',
      },
      ...toolSections(['skill', 'skill_find', 'skill_install', 'skill_create'], '参数'),
      {
        t: 'h2',
        text: '为什么 `skill_find` 不联网',
        md:
          '它只搜索**本机已安装**的技能。想装新技能必须由人给出一个明确的来源（目录、git 仓库、https 地址），' +
          '这条约束让"代理自己去找一个技能来执行"这种不可审计的行为不可能发生。',
      },
      {
        t: 'h2',
        text: '`allowed-tools` 真的会被执行吗',
      },
      {
        t: 'p',
        md:
          '会，但只在宿主**能够注册**的工具范围内。`HOST_TOOL_NAMES` 是这个范围的全集；技能声明了一个不在其中的工具，' +
          '`aragon skills doctor` 会指出它不可执行 —— 这比"看起来生效了、其实没有"安全得多。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '两个工具在 Core 里',
        md:
          '`skill` 与 `skill_find` 定义在 `packages/core/src/skills/`，不在 CLI 的 `tools/` 目录。' +
          '只扫描 CLI 会把工具总数数成 17 —— 本站的工具数据集显式把这两个源文件包含进来。',
      },
    ],
  },
];
