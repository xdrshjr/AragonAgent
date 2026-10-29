/**
 * 排错分组（`troubleshoot`）的页面。
 *
 * 这一组的 sourceRefs 不是"照抄文档"，而是指向**错误串真正产生的位置**：
 * 读者看到的老是某句话，我们指的就是那句话的源头。
 */

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'troubleshoot/faq',
    title: '常见问题',
    group: 'troubleshoot',
    order: 10,
    phase: 'A',
    template: 'prose',
    summary:
      '按现象索引的常见问题：装不上、跑不起来、模型连不通、工具被拒、输出解析失败、退出码看不懂。每条都给「先查哪一句」。',
    keywords: ['FAQ', '常见问题', '排错', '报错', '401', 'EADDRINUSE', 'exit code'],
    seeAlso: ['troubleshoot/doctor', 'troubleshoot/escape', 'cli/exit-codes'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/options.ts', lines: '1-40', snippet: 'export' },
      { path: 'packages/cli/src/config/load.ts', lines: '1083', snippet: 'apiKeys' },
      { path: 'packages/cli/src/update/registry.ts', lines: '40-60', snippet: 'ARAGON_UPDATE_REGISTRY' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '排错的顺序永远是：**先看退出码，再看 stdout，最后才看日志**。前两者是契约，日志只是线索。',
      },
      {
        t: 'h2',
        text: '装不上 / 跑不起来',
      },
      {
        t: 'table',
        caption: '启动阶段的问题',
        head: ['现象', '最可能的原因', '先做什么'],
        rows: [
          ['`aragon: command not found`', '全局 bin 目录不在 `PATH` 里', '看 `npm bin -g` 的输出，或改用 `npx @aragon-agent/cli`'],
          ['启动即报 Node 版本错误', 'Node < 18', '`node --version`；两个包都要求 `>=18`'],
          ['`EACCES` 写不进数据目录', '`ARAGON_HOME` 指到了只读位置', '`aragon config home` 确认路径，换一个可写目录'],
          ['配置文件解析失败', '手工编辑时留下语法错误', '`aragon config edit` 修回；JSON 不允许注释'],
        ],
      },
      {
        t: 'h2',
        text: '连不上模型',
      },
      {
        t: 'steps',
        items: [
          {
            title: '确认用的是哪把 key',
            md:
              '优先级是 `--api-key` > 配置文件 `apiKeys.<provider>` > 环境变量。配置文件里的旧 key 会静默盖住你刚设的环境变量。',
            code: { lang: 'bash', code: 'aragon config get apiKeys' },
          },
          {
            title: '确认 provider 与 base URL 是成套的',
            md: '换 provider 时 `--base-url` 也要跟着换；混用会得到 404 而不是优雅的报错。',
            code: { lang: 'bash', code: 'aragon --provider anthropic --model claude-sonnet-4-5 -p "在吗"' },
          },
          {
            title: '401/403 不等于额度问题',
            md: '401 是身份，403 是权限，429 才是限流。三者重试策略完全不同。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '`401` 先怀疑 key 的来源，而不是 key 本身',
        md: '在 CI 里最常见的原因是配置文件里残留了一个本地开发用的 key。它优先级更高，且不会报"我用的是哪把 key"。',
      },
      {
        t: 'h2',
        text: '工具被拒绝',
      },
      {
        t: 'ul',
        items: [
          '确认当前权限档位：计划模式会封锁 `write_file`、`edit_file`、`bash`、`bash_kill` 与技能安装/创建。',
          '确认 `--deny-tool` 没有把要用的工具禁掉 —— **deny 永远优先于 allow**。',
          '团队模式下子代理拿到的工具集与主代理不同（`team_send` / `team_wait` 只在子代理侧）。',
        ],
      },
      {
        t: 'h2',
        text: '输出解析失败',
      },
      {
        t: 'p',
        md:
          '如果你在解析 stdout，请确认用的是 `--output-format stream-json`（每行一个 JSON 对象）。' +
          '默认的 `text` 格式**不是**机器可读的，它只是给人看的流式文本；诊断信息还会混进 stderr。',
      },
      {
        t: 'h2',
        text: '看不懂退出码',
      },
      {
        t: 'table',
        caption: '五档退出码的排查方向',
        head: ['码', '含义', '下一步'],
        rows: [
          ['`0`', '成功', '不需要排查'],
          ['`1`', '代理错误', '读 `result` 事件的 `error`；查日志'],
          ['`2`', '用法或会话错误（stdout 为空）', '看 stderr 的参数提示；确认会话 id 存在'],
          ['`3`', '预算命中', '加大 `--max-turns` / `--max-duration`，或拆任务'],
          ['`>= 128`', '被信号中断', '`130` 是 Ctrl+C；容器里被 KILL 通常是 `137`'],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '端口占用',
        md:
          '`EADDRINUSE` 时不要换端口了事：先 `bash_kill`（或 `job_list`）确认是不是自己上一次没停的服务。' +
          '换端口会把"忘记清理"变成"两个服务都活着"。',
      },
    ],
  },

  {
    id: 'troubleshoot/doctor',
    title: 'doctor 与自检',
    group: 'troubleshoot',
    order: 20,
    phase: 'B',
    template: 'prose',
    summary:
      '`aragon skills doctor` 与内置自检到底检查什么：技能声明的可执行性、脚本平台匹配、配置与目录一致性，以及怎么读它的输出。',
    keywords: ['doctor', '自检', '诊断', 'skills doctor', '健康检查'],
    seeAlso: ['guide/skills', 'config/logs', 'troubleshoot/faq'],
    sourceRefs: [
      { path: 'packages/cli/src/skills/cli-commands.ts', lines: '353-420', snippet: 'checkDeclaredTools' },
      { path: 'packages/cli/src/tools/index.ts', lines: '500-530', snippet: 'HOST_TOOL_NAMES' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '自检的价值不是"跑一遍看看有没有红"，而是**回答那些平时没人问的问题**：这个技能声明的工具真的能注册吗？' +
          '它带的脚本在我的平台上能跑吗？我的配置里有没有互相矛盾的键？',
      },
      {
        t: 'h2',
        text: '`skills doctor` 查什么',
      },
      {
        t: 'table',
        caption: '`checkDeclaredTools` 与 `checkScriptPlatform` 覆盖的范围',
        head: ['检查项', '判定依据', '输出'],
        rows: [
          ['声明的工具是否可注册', '`HOST_TOOL_NAMES`（宿主能力全集，20 条）', '列出无法生效的工具名'],
          ['脚本平台是否匹配', '技能里脚本声明的平台与当前 `process.platform`', '列出不匹配的脚本'],
          ['技能来源是否可达', '安装来源（目录 / git / https）', '不可达时给出原因'],
          ['字节预算是否超限', '`SKILL_*_MAX_BYTES` 系列常量', '超出时指名是哪一项'],
        ],
      },
      {
        t: 'h2',
        text: '怎么读输出',
      },
      {
        t: 'steps',
        items: [
          {
            title: '先看"不可执行"那一栏',
            md:
              '如果技能声明了 `team_send`，那不是错误 —— 它只在子代理侧注册，`HOST_TOOL_NAMES` 故意不包含它。' +
              '真正需要修的是"声明了但宿主永远不会注册"的工具。',
          },
          {
            title: '再看平台不匹配',
            md: 'Windows 上没有 `sh` 的技能会在执行时失败，自检在这里提前告诉你。',
          },
          {
            title: '最后看预算',
            md: '技能正文太大不会被静默截断，而是被拒绝加载 —— 这比"加载了一半"更容易发现。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '自检不联网',
        md: '它只读本机状态：已安装技能、配置、常量。因此可以在离线环境与 CI 里跑，也不会把仓库信息发到外面。',
      },
    ],
  },

  {
    id: 'troubleshoot/escape',
    title: '卡住时的逃生路径',
    group: 'troubleshoot',
    order: 30,
    phase: 'B',
    template: 'prose',
    summary:
      '当代理看起来不动、工具调用不返回、或者界面完全不响应时的逐级逃生路径：从一次按键到清空数据目录，每一步都说清代价。',
    keywords: ['卡住', '无响应', 'Esc', 'Ctrl+C', 'interrupt', '逃生', '强杀'],
    seeAlso: ['troubleshoot/faq', 'guide/input-queue', 'config/logs'],
    sourceRefs: [
      { path: 'packages/cli/src/exec/runner.ts', lines: '879-891', snippet: "return this.errored ? 1 : 0" },
      { path: 'packages/cli/src/tools/bash-tool.ts', lines: '265-300', snippet: "name: 'bash'" },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '"卡住"有四种完全不同的原因：模型在思考、工具在跑、界面在等按键、进程已死。它们对应的退出方式不同，' +
          '所以不要一上来就 `Ctrl+C`。',
      },
      {
        t: 'h2',
        text: '逐级升级',
      },
      {
        t: 'steps',
        items: [
          {
            title: '先分清是哪一种卡',
            md:
              '状态栏还在走动 = 模型在工作；显示某个工具在跑 = 命令没退出；两者都不动 = 界面或进程的问题。',
          },
          {
            title: '中断当前回合：`Esc`',
            md: '取消正在进行的模型调用，保留已经产生的对话。这是最轻的一步，随时可用。',
          },
          {
            title: '强制结束：`Ctrl+C` 一次',
            md: '连按两次会在第二次直接退出进程，不给保存机会。',
          },
          {
            title: '停掉后台作业',
            md: '工具卡住通常是它起的子进程没退出。先列出来，再逐个停。',
            code: { lang: 'bash', code: 'job_list({})\nbash_kill({ service: "all" })' },
          },
          {
            title: '最后手段：新开会话',
            md:
              '会话文件是纯 JSON，可以直接读出来定位卡在哪一步。新开会话不会丢文件系统上的工作 —— ' +
              '只丢"对话历史"。',
          },
        ],
      },
      {
        t: 'h2',
        text: '每一步的代价',
      },
      {
        t: 'table',
        caption: '升级顺序与代价（越往下越不可逆）',
        head: ['动作', '丢什么', '什么时候值得'],
        rows: [
          ['`Esc`', '当前回合的回答', '几乎总是'],
          ['`Ctrl+C` 一次', '当前回合 + 未提交的输入', '`Esc` 没反应'],
          ['`bash_kill all`', '后台进程的所有进展', '进程确实卡死'],
          ['杀掉整个进程', '未落盘的会话片段', '界面完全不响应'],
          ['新开会话', '对话历史（会话文件仍在）', '上下文已被污染'],
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '不要删数据目录来"重置"',
        md:
          '`~/.aragon-agent/` 里有你的会话、日志和技能。先 `aragon config home` 看清路径，' +
          '再按 [本地目录结构](/config/home/) 里的表格只删需要删的那一层。',
      },
    ],
  },
];
