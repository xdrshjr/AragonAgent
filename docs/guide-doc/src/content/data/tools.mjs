/**
 * 内置工具数据集（truth set S-4）。
 *
 * **19 个**：`tools/*.ts` 13 个 + `todo_write` + `task` + 技能族 4 个
 * （CLI 2 个 `skill_install`/`skill_create`，**Core 2 个** `skill`/`skill_find`）。
 * 注意：Core 的两个工具在 `packages/core/src/skills/` 里 —— 只扫 CLI 会数到 17 个并
 * 静默报绿，这正是本数据集把「源文件清单」写死在提取器里、再用 `HOST_TOOL_NAMES`
 * 做第二来源的原因。
 *
 * `summary` 是面向读者的中文概括；`source` 指向 `name:` 字面量所在行。
 */

/** @typedef {{name: string, summary: string, mutating: boolean,
 *   params: {name: string, type: string, required?: boolean, desc: string}[],
 *   source: {path: string, lines: string, snippet: string}}} ToolRecord */

/**
 * @type {ToolRecord[]}
 */
export const tools = [
  {
    name: 'bash',
    summary: '在受控 shell 里执行命令；可前台（阻塞到结束）或后台（服务/作业）运行',
    mutating: true,
    params: [
      { name: 'command', type: 'string', required: true, desc: '要执行的命令（按当前平台的 shell 语法）' },
      { name: 'timeout', type: 'number', desc: '前台命令的超时（毫秒）' },
      { name: 'background', type: 'boolean', desc: '交给运行时监管的后台作业，返回作业 id' },
      { name: 'cwd', type: 'string', desc: '工作目录，默认继承会话' },
    ],
    source: { path: 'packages/cli/src/tools/bash-tool.ts', lines: '265', snippet: "name: 'bash'" },
  },
  {
    name: 'read_file',
    summary: '读取 UTF-8 文本文件并返回带行号的内容，可窗口化读取',
    mutating: false,
    params: [
      { name: 'path', type: 'string', required: true, desc: '文件路径（相对工作目录或绝对路径）' },
      { name: 'offset', type: 'number', desc: '起始行（1-based）' },
      { name: 'limit', type: 'number', desc: '最多返回多少行' },
    ],
    source: { path: 'packages/cli/src/tools/fs-tools.ts', lines: '85', snippet: "name: 'read_file'" },
  },
  {
    name: 'write_file',
    summary: '写入（覆盖）文件，自动创建父目录',
    mutating: true,
    params: [
      { name: 'path', type: 'string', required: true, desc: '目标文件路径' },
      { name: 'content', type: 'string', required: true, desc: '完整文件内容' },
    ],
    source: { path: 'packages/cli/src/tools/fs-tools.ts', lines: '131', snippet: "name: 'write_file'" },
  },
  {
    name: 'edit_file',
    summary: '把文件中的一段原文替换为新内容（默认要求原串唯一），返回 diff 预览',
    mutating: true,
    params: [
      { name: 'path', type: 'string', required: true, desc: '目标文件路径' },
      { name: 'old_string', type: 'string', required: true, desc: '要被替换的原文' },
      { name: 'new_string', type: 'string', required: true, desc: '替换后的文本' },
      { name: 'replace_all', type: 'boolean', desc: '替换全部出现，而不是要求唯一' },
    ],
    source: { path: 'packages/cli/src/tools/fs-tools.ts', lines: '171', snippet: "name: 'edit_file'" },
  },
  {
    name: 'list_dir',
    summary: '列目录内容，带类型（目录/文件）与字节大小',
    mutating: false,
    params: [{ name: 'path', type: 'string', desc: '目录路径，默认工作目录' }],
    source: { path: 'packages/cli/src/tools/fs-tools.ts', lines: '238', snippet: "name: 'list_dir'" },
  },
  {
    name: 'glob',
    summary: '按 glob 模式查找文件，按修改时间倒序返回相对路径',
    mutating: false,
    params: [
      { name: 'pattern', type: 'string', required: true, desc: 'glob 模式，如 `src/**/*.ts`' },
      { name: 'cwd', type: 'string', desc: '搜索起点目录' },
    ],
    source: { path: 'packages/cli/src/tools/search-tools.ts', lines: '30', snippet: "name: 'glob'" },
  },
  {
    name: 'grep',
    summary: '按正则搜索文件内容，返回 `path:line:text`',
    mutating: false,
    params: [
      { name: 'pattern', type: 'string', required: true, desc: '正则表达式' },
      { name: 'path', type: 'string', desc: '限定搜索的文件或目录' },
      { name: 'glob', type: 'string', desc: '只搜索匹配该 glob 的文件' },
      { name: 'ignoreCase', type: 'boolean', desc: '忽略大小写' },
    ],
    source: { path: 'packages/cli/src/tools/search-tools.ts', lines: '83', snippet: "name: 'grep'" },
  },
  {
    name: 'bash_output',
    summary: '读取后台作业日志的尾部与当前状态，可用游标只取增量',
    mutating: false,
    params: [
      { name: 'service', type: 'string', required: true, desc: '作业 id，如 `s1` 或 `t3`' },
      { name: 'since', type: 'number', desc: '上一 次返回的游标，只读新内容' },
    ],
    source: { path: 'packages/cli/src/tools/proc-tools.ts', lines: '59', snippet: "name: 'bash_output'" },
  },
  {
    name: 'bash_kill',
    summary: '停止一个后台作业，或用 `all` 停止全部',
    mutating: true,
    params: [{ name: 'service', type: 'string', required: true, desc: '作业 id 或 `all`' }],
    source: { path: 'packages/cli/src/tools/proc-tools.ts', lines: '112', snippet: "name: 'bash_kill'" },
  },
  {
    name: 'job_wait',
    summary: '有界地等待后台作业，返回状态、一行进度与游标之后的新输出',
    mutating: false,
    params: [
      { name: 'job', type: 'string', required: true, desc: '作业 id、`all`（等到全部结束）或 `any`（等到第一个结束）' },
      { name: 'timeoutSeconds', type: 'number', desc: '等待上限（5–1200 秒，最长 20 分钟）；你发消息会提前结束等待' },
      { name: 'since', type: 'number', desc: '游标，只要更新的输出' },
    ],
    source: { path: 'packages/cli/src/tools/job-tools.ts', lines: '238', snippet: "name: 'job_wait'" },
  },
  {
    name: 'job_list',
    summary: '列出全部后台作业：id、类型、状态、耗时、进度一行一个',
    mutating: false,
    params: [],
    source: { path: 'packages/cli/src/tools/job-tools.ts', lines: '369', snippet: "name: 'job_list'" },
  },
  {
    name: 'ask_user',
    summary: '向用户提 1–5 道多选题；每个问题有稳定 id、≤12 字符表头、2–4 个选项',
    mutating: false,
    params: [{ name: 'questions', type: 'object[]', required: true, desc: '问题数组（id/header/question/options）' }],
    source: { path: 'packages/cli/src/tools/plan-tools.ts', lines: '109', snippet: "name: 'ask_user'" },
  },
  {
    name: 'submit_plan',
    summary: '提交实施计划等待批准；整个任务只能调用一次',
    mutating: false,
    params: [
      { name: 'title', type: 'string', required: true, desc: '计划标题（≤80 字符）' },
      { name: 'summary', type: 'string', required: true, desc: '摘要（≤600 字符）' },
      { name: 'steps', type: 'object[]', required: true, desc: '有序步骤（可独立验证）' },
    ],
    source: { path: 'packages/cli/src/tools/plan-tools.ts', lines: '207', snippet: "name: 'submit_plan'" },
  },
  {
    name: 'todo_write',
    summary: '记录并更新任务清单与验收标准；每次发送完整列表（整体替换）',
    mutating: false,
    params: [
      { name: 'todos', type: 'object[]', required: true, desc: '完整清单（content/status，最多 20 项）' },
      { name: 'acceptance', type: 'object[]', desc: '验收标准（可核对、可给证据）' },
    ],
    source: { path: 'packages/cli/src/todo/todo-tool.ts', lines: '131', snippet: "name: 'todo_write'" },
  },
  {
    name: 'task',
    // `mutating: false` 是源码的口径，不是排版选择：`task` 在 `SKILL_TOOL_FLOOR` 里，
    // 因为子代理的每一次写入都要经过同一条工具包装链（`tools/index.ts:427-432`）。
    // 把它算成变更类工具，会让「计划模式封锁六个工具」这句话变成七个。
    summary: '并行派发 2–5 个独立子代理，返回一份合并报告（仅团队模式）',
    mutating: false,
    params: [
      { name: 'subagents', type: 'object[]', required: true, desc: '子代理数组（description/prompt/readOnly）' },
    ],
    source: { path: 'packages/cli/src/team/task-tool.ts', lines: '115', snippet: "name: 'task'" },
  },
  {
    name: 'skill_install',
    summary: '从本地目录、git 仓库或 https 地址安装技能',
    mutating: true,
    params: [
      { name: 'source', type: 'string', required: true, desc: '安装来源' },
      { name: 'scope', type: 'string', desc: '`user` 或 `project`' },
    ],
    source: { path: 'packages/cli/src/skills/tools.ts', lines: '52', snippet: "name: 'skill_install'" },
  },
  {
    name: 'skill_create',
    summary: '从零编写一个新技能并保存到磁盘',
    mutating: true,
    params: [
      { name: 'name', type: 'string', required: true, desc: 'kebab-case 技能名' },
      { name: 'description', type: 'string', required: true, desc: '做什么 + 何时使用' },
      { name: 'body', type: 'string', required: true, desc: 'SKILL.md 正文' },
    ],
    source: { path: 'packages/cli/src/skills/tools.ts', lines: '94', snippet: "name: 'skill_create'" },
  },
  {
    name: 'skill',
    summary: '加载一个已安装技能的完整说明，并列出它附带的文件',
    mutating: false,
    params: [
      { name: 'name', type: 'string', required: true, desc: '技能名' },
      { name: 'arguments', type: 'string', desc: '传给技能的自由文本参数' },
    ],
    source: { path: 'packages/core/src/skills/skill-tool.ts', lines: '54', snippet: "name: 'skill'" },
  },
  {
    name: 'skill_find',
    summary: '按名称、描述或关键词搜索本机已安装的技能（不联网）',
    mutating: false,
    params: [
      { name: 'query', type: 'string', required: true, desc: '能力描述，如 `pdf form`' },
      { name: 'limit', type: 'number', desc: '最多返回几条（默认 10）' },
    ],
    source: { path: 'packages/core/src/skills/skill-find-tool.ts', lines: '93', snippet: "name: 'skill_find'" },
  },
];

/** 工具名集合（顺序与数组一致）。 */
export const toolNames = tools.map((tool) => tool.name);
