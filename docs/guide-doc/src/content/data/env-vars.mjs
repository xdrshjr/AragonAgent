/**
 * 环境变量表数据（中文文档「环境变量」页的唯一数据源）。
 *
 * 真源是仓库源码：绝大多数 `ARAGON_*` 变量在 `packages/cli/src/config/env.ts` 的
 * `readEnvConfig()` 里被读取并映射进配置字段，其余在各自的消费点读取（`config/app-paths.ts`
 * 的 `ARAGON_HOME`、`skills/paths.ts` 的 `ARAGON_SKILLS_PATH`、`update/registry.ts` 的注册表、
 * 日志引导、能力探测等）。每条 `source.snippet` 必须是对应行区间里今天的原文片段。
 * 按变量名字典序排列；`default` 只在源码里能看到兜底值时才写。
 */
export const envVars = [
  {
    name: 'ANTHROPIC_API_KEY', purpose: '提供 Anthropic 服务商密钥',
    effect: 'provider 为 anthropic 时用它认证；同名配置里的密钥仍是兜底，环境变量优先',
    source: { path: 'packages/cli/src/config/env.ts', lines: '64-68', snippet: '\'ANTHROPIC_API_KEY\'' },
  },
  {
    name: 'ARAGON_BASE_URL', purpose: '覆盖服务商 API 基础地址',
    effect: '指向自建代理或兼容端点时改这一条，不需要动配置文件',
    source: { path: 'packages/cli/src/config/env.ts', lines: '98-99', snippet: 'partial.baseUrl = baseUrl' },
  },
  {
    name: 'ARAGON_BASH_AUTO_BACKGROUND', purpose: '自动把不会退出的 bash 命令转成后台服务',
    effect: '开/关自动转后台；对启动 dev server 这类长命令最有感',
    source: { path: 'packages/cli/src/config/env.ts', lines: '291-294', snippet: 'section.autoBackground' },
  },
  {
    name: 'ARAGON_BASH_BACKGROUND', purpose: '开启 bash 后台服务能力',
    effect: '关掉后 bash 工具不再保留服务，命令一律前台执行到退出',
    source: { path: 'packages/cli/src/config/env.ts', lines: '279-290', snippet: 'section.background' },
  },
  {
    name: 'ARAGON_COMPACTION', purpose: '自动上下文压缩总开关',
    effect: '关闭后占用再高也不压缩，长会话会撞到上下文上限而报错',
    source: { path: 'packages/cli/src/config/env.ts', lines: '421-423', snippet: 'positive(compaction)' },
  },
  {
    name: 'ARAGON_COMPACTION_ARCHIVE', purpose: '压缩后是否把被替换的对话归档写盘',
    effect: '容器或不允许写对话内容的机器上关掉它；关掉后压缩仍发生但不可回看',
    source: { path: 'packages/cli/src/config/env.ts', lines: '427-429', snippet: 'section.archive' },
  },
  {
    name: 'ARAGON_COMPACTION_KEEP_TURNS', purpose: '压缩后保留的最近轮数',
    effect: '值越大保留的原始上下文越多、压缩节省越少；非法值留作未设置，交给配置文件',
    source: { path: 'packages/cli/src/config/env.ts', lines: '436-439', snippet: 'section.keepRecentTurns' },
  },
  {
    name: 'ARAGON_COMPACTION_SUBAGENTS', purpose: '子代理是否也参与自动压缩',
    effect: '关掉可以压低并行 dispatch 的成本，代价是子代理可能更早撞上限',
    source: { path: 'packages/cli/src/config/env.ts', lines: '424-426', snippet: 'section.subagents' },
  },
  {
    name: 'ARAGON_COMPACTION_THRESHOLD', purpose: '触发压缩的上下文占用阈值',
    effect: '可写百分比或 token 数；解析失败时不写入，配置文件的值继续生效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '430-435', snippet: 'parseThresholdInput' },
  },
  {
    name: 'ARAGON_CONTEXT_WINDOW', purpose: '覆盖模型的上下文窗口大小',
    effect: '影响占用率估算与压缩阈值；auto 或 0 表示按模型上限推断',
    default: 'auto（按模型上限）',
    source: { path: 'packages/cli/src/config/env.ts', lines: '143-151', snippet: 'clampContextWindow' },
  },
  {
    name: 'ARAGON_DIFF_RENDER', purpose: '是否用增量 diff 渲染帧',
    effect: '关掉后每帧整屏重画，终端兼容性更好但闪屏更明显',
    source: { path: 'packages/cli/src/config/env.ts', lines: '498-502', snippet: 'partial.diffRender' },
  },
  {
    name: 'ARAGON_FAST', purpose: '二级快模型总开关',
    effect: '关闭后任务摘要、快速子任务等不再走便宜模型，全部回到主模型',
    source: { path: 'packages/cli/src/config/env.ts', lines: '390-392', snippet: 'section.enabled = fast ===' },
  },
  {
    name: 'ARAGON_FAST_BASE_URL', purpose: '快模型的 API 基础地址',
    effect: '快模型走另一个中转端点时用它，与主模型的地址互不影响',
    source: { path: 'packages/cli/src/config/env.ts', lines: '395', snippet: 'section.baseUrl = fastBaseUrl' },
  },
  {
    name: 'ARAGON_FAST_MODEL', purpose: '指定快模型使用的模型名',
    effect: '决定摘要与快任务实际调用的模型；留空则沿用配置文件',
    source: { path: 'packages/cli/src/config/env.ts', lines: '394', snippet: 'section.model = fastModel' },
  },
  {
    name: 'ARAGON_FAST_PROVIDER', purpose: '指定快模型的服务商',
    effect: '可在主模型之外单独选服务商，例如主模型 anthropic、快模型 openai',
    source: { path: 'packages/cli/src/config/env.ts', lines: '393', snippet: 'section.provider = fastProvider' },
  },
  {
    name: 'ARAGON_HOME', purpose: '覆盖 aragon 的根目录（配置、会话、日志都落在这里）',
    effect: '首次求值即读取，因此写在 .env 里无效；指向非目录时退回默认根目录并给出警告',
    default: '~/.aragon-agent',
    source: { path: 'packages/cli/src/config/app-paths.ts', lines: '123-136', snippet: 'ARAGON_HOME' },
  },
  {
    name: 'ARAGON_JOBS_ENABLED', purpose: '开启受监督的后台作业通道',
    effect: '关闭后 bash 的 background 作业与其等待/日志工具一并失效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '319', snippet: 'section.enabled = flag(jobsEnabled)' },
  },
  {
    name: 'ARAGON_JOBS_NOTICE_STEER', purpose: '作业状态通知是否以引导消息形式回到会话',
    effect: '关掉后通知只留在面板里，不再打断或注入当前运行',
    source: { path: 'packages/cli/src/config/env.ts', lines: '321', snippet: 'section.noticeSteer' },
  },
  {
    name: 'ARAGON_JOBS_PERSIST_LOG', purpose: '是否把作业输出落盘保存',
    effect: '关掉后作业日志只存在内存里，作业结束即失去历史',
    source: { path: 'packages/cli/src/config/env.ts', lines: '320', snippet: 'section.persistLog' },
  },
  {
    name: 'ARAGON_JOBS_STALL_SECONDS', purpose: '作业多久无输出算卡住（秒）',
    effect: '影响卡住判定与提示时机；非法数值留作未设置',
    source: { path: 'packages/cli/src/config/env.ts', lines: '328-331', snippet: 'section.stallSeconds' },
  },
  {
    name: 'ARAGON_JOBS_WAIT_SECONDS', purpose: 'job_wait 单次等待的默认秒数（5–1200）',
    effect: '调大可以少轮询；等待期间你发消息会立即结束它；非法数值留给默认值兜底',
    source: { path: 'packages/cli/src/config/env.ts', lines: '322-327', snippet: 'section.waitSeconds' },
  },
  {
    name: 'ARAGON_KEYBOARD_ENHANCEMENT', purpose: '是否请求终端键盘增强模式',
    effect: '设为 0 是回到未增强输入处理的一键回退，Shift+Enter 换行随之失效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '187-195', snippet: 'partial.keyboardEnhancement' },
  },
  {
    name: 'ARAGON_LIVE_TOOL_OUTPUT', purpose: '是否在卡片里实时显示工具输出',
    effect: '设为 0 会把默认开启的实时流关掉，工具输出只在结束时一次呈现',
    default: '开启',
    source: { path: 'packages/cli/src/config/env.ts', lines: '117-124', snippet: 'partial.liveToolOutput' },
  },
  {
    name: 'ARAGON_LOG_DIR', purpose: '指定日志文件所在目录',
    effect: '日志写盘开启时决定文件位置；日志引导阶段也会读它，配置加载失败也能生效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '550-551', snippet: 'out.dir = dir' },
  },
  {
    name: 'ARAGON_LOG_FILE', purpose: '是否把日志写入文件',
    effect: '0/false/off/no 视为关闭，其余非空值视为开启；启动早期即生效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '547-548', snippet: 'out.toFile = envBool(toFile)' },
  },
  {
    name: 'ARAGON_LOG_LEVEL', purpose: '设置日志级别',
    effect: '非法值被夹到 info；调成 debug 会显著增加日志量',
    default: 'info',
    source: { path: 'packages/cli/src/config/env.ts', lines: '544-545', snippet: 'clampLogLevel' },
  },
  {
    name: 'ARAGON_MAX_RENDER_INTERVAL_MS', purpose: '限制两帧之间的最小间隔（毫秒）',
    effect: '调大可降低重绘频率，弱终端上更稳但输出更跳',
    source: { path: 'packages/cli/src/config/env.ts', lines: '492-495', snippet: 'partial.maxRenderIntervalMs' },
  },
  {
    name: 'ARAGON_MAX_TOKENS', purpose: '覆盖单次回复的输出 token 上限',
    effect: 'auto 或 0 表示按模型上限；无法识别的值不写入，配置文件的值继续生效',
    default: 'auto（按模型上限）',
    source: { path: 'packages/cli/src/config/env.ts', lines: '130-138', snippet: 'clampMaxTokens' },
  },
  {
    name: 'ARAGON_MODEL', purpose: '覆盖主模型的模型名',
    effect: '一次运行内替代配置文件里的 model，不改文件',
    source: { path: 'packages/cli/src/config/env.ts', lines: '95-96', snippet: 'partial.model = model' },
  },
  {
    name: 'ARAGON_MOUSE', purpose: '开启终端鼠标捕获',
    effect: '关闭后滚轮与拖选交还终端，应用不再接管鼠标事件',
    source: { path: 'packages/cli/src/config/env.ts', lines: '159-162', snippet: 'partial.mouse' },
  },
  {
    name: 'ARAGON_MOUSE_SELECT', purpose: '单独控制拖选，不影响滚轮',
    effect: '设为 0 是鼠标梯子的第三级：保留滚轮，把拖选让给终端',
    source: { path: 'packages/cli/src/config/env.ts', lines: '167-174', snippet: 'partial.mouseSelect' },
  },
  {
    name: 'ARAGON_PASTE', purpose: '粘贴识别开关',
    effect: '设为 0 回到 0.6.3 之前的粘贴处理，长粘贴不再折叠成占位块',
    source: { path: 'packages/cli/src/config/env.ts', lines: '179-182', snippet: 'partial.paste' },
  },
  {
    name: 'ARAGON_PLAN', purpose: '启动时是否默认进入 PLAN 模式',
    effect: '开启后新会话先做只读调查，写操作被拒绝，直到按 Shift+Tab 切回 BUILD',
    source: { path: 'packages/cli/src/config/env.ts', lines: '209-212', snippet: 'partial.planModeDefault' },
  },
  {
    name: 'ARAGON_PROMPTS', purpose: '快捷提示词库的开关',
    effect: '设为 0 后 Ctrl+P 失效，/prompts 仍注册但只报告该功能已关闭',
    source: { path: 'packages/cli/src/config/env.ts', lines: '342-346', snippet: 'partial.prompts' },
  },
  {
    name: 'ARAGON_PROVIDER', purpose: '覆盖主模型的服务商',
    effect: '决定用哪家的适配器与哪份密钥；只影响本次运行',
    source: { path: 'packages/cli/src/config/env.ts', lines: '92-93', snippet: 'partial.provider = provider' },
  },
  {
    name: 'ARAGON_REDUCED_MOTION', purpose: '降低动效，例如关闭动画与闪烁',
    effect: '配置文件或 --no-color 也会打开它；适合低帧率终端与录屏',
    source: {
      path: 'packages/cli/src/config/load.ts',
      lines: '1123',
      snippet: 'envFlagTrue(process.env.ARAGON_REDUCED_MOTION)',
    },
  },
  {
    name: 'ARAGON_RENDER_GOVERNOR', purpose: '是否按帧预算限流重绘',
    effect: '关闭后流式输出每来一段就重绘，CPU 占用更高但延迟更低',
    source: { path: 'packages/cli/src/config/env.ts', lines: '486-490', snippet: 'partial.renderGovernor' },
  },
  {
    name: 'ARAGON_RETRY', purpose: 'LLM 请求自动重试开关',
    effect: '关闭后限流与超时错误直接抛给上层，不再退避重试',
    source: { path: 'packages/cli/src/config/env.ts', lines: '367-369', snippet: 'section.enabled = retry ===' },
  },
  {
    name: 'ARAGON_RETRY_MAX', purpose: '单次请求的最大重试次数',
    effect: '0 等价于不重试；非法数值留作未设置，由配置文件决定',
    source: { path: 'packages/cli/src/config/env.ts', lines: '370-373', snippet: 'section.maxRetries' },
  },
  {
    name: 'ARAGON_SCROLL_MODE', purpose: '选择滚动模式',
    effect: 'native 用终端自身回滚缓冲（默认），app 由应用自绘可滚动视口；其它值被忽略',
    default: 'native',
    source: { path: 'packages/cli/src/config/env.ts', lines: '505-506', snippet: 'partial.scrollMode' },
  },
  {
    name: 'ARAGON_SCROLL_RESUME_MS', purpose: '暂停滚动后自动回到最新行的等待毫秒数',
    effect: '0 表示不再自动回底；这是该设置除配置文件之外唯一的入口，没有命令行开关',
    source: { path: 'packages/cli/src/config/env.ts', lines: '203-207', snippet: 'partial.scrollResumeMs' },
  },
  {
    name: 'ARAGON_SHOW_THINKING', purpose: '启动时是否显示模型思考内容',
    effect: '只接受 1/true/on/yes 为开启，其它非空值一律关闭，效果等同启动后按 Ctrl+T',
    source: { path: 'packages/cli/src/config/env.ts', lines: '105-112', snippet: 'partial.showThinking' },
  },
  {
    name: 'ARAGON_SKILLS', purpose: '技能子系统的总开关',
    effect: '设为 0/false/off/no 后技能不再被发现与激活，但 /skill:* 命令仍可解释状态',
    source: { path: 'packages/cli/src/config/env.ts', lines: '218-224', snippet: 'enabled: !(skills ===' },
  },
  {
    name: 'ARAGON_SKILLS_DISABLED', purpose: '按名字禁用若干技能（逗号分隔）',
    effect: '只在本次运行内屏蔽指定技能，其余技能照常可用',
    source: { path: 'packages/cli/src/config/env.ts', lines: '557-563', snippet: 'ARAGON_SKILLS_DISABLED' },
  },
  {
    name: 'ARAGON_SKILLS_PATH', purpose: '追加额外的技能搜索根目录',
    effect: '按平台路径分隔符拆分成多个只读根，适合把共享技能目录挂进任意项目',
    source: { path: 'packages/cli/src/skills/paths.ts', lines: '72-79', snippet: 'resolveEnvSkillDirs' },
  },
  {
    name: 'ARAGON_SYNC_OUTPUT', purpose: '是否使用同步输出序列刷新帧',
    effect: 'TERM=dumb 时会自动失效；关掉可避免某些终端上的整屏闪动',
    source: { path: 'packages/cli/src/config/env.ts', lines: '508-512', snippet: 'partial.syncOutput' },
  },
  {
    name: 'ARAGON_TASK_SUMMARY', purpose: '标题栏任务摘要的开关',
    effect: '设为 0 后不再发起摘要调用，标题栏退回只显示 provider 与目录',
    source: { path: 'packages/cli/src/config/env.ts', lines: '355-360', snippet: 'partial.taskSummary' },
  },
  {
    name: 'ARAGON_TEAM', purpose: '并行子代理（team）开关',
    effect: '关闭后 agent 无法派发子代理，dispatch 相关工具直接不可用',
    source: { path: 'packages/cli/src/config/env.ts', lines: '230-232', snippet: 'section.enabled = team ===' },
  },
  {
    name: 'ARAGON_TEAM_MAX', purpose: '单次 dispatch 允许的最大子代理数',
    effect: '非法或非正数留作未设置，由配置文件的夹取结果决定',
    source: { path: 'packages/cli/src/config/env.ts', lines: '233-238', snippet: 'section.maxSubagents' },
  },
  {
    name: 'ARAGON_THEME', purpose: '选择界面主题',
    effect: '非法主题名被夹到 auto；只影响之后渲染的界面元素',
    default: 'auto',
    source: { path: 'packages/cli/src/config/env.ts', lines: '153-155', snippet: 'clampTheme' },
  },
  {
    name: 'ARAGON_THINKING', purpose: '设置模型思考等级',
    effect: '非法值被夹到 off；只在服务商支持思考参数时起作用',
    source: { path: 'packages/cli/src/config/env.ts', lines: '101-103', snippet: 'clampThinkingLevel' },
  },
  {
    name: 'ARAGON_TODO', purpose: 'TODO 计划追踪开关',
    effect: '关闭后 agent 不再维护计划列表，相关工具与面板一并失效',
    source: { path: 'packages/cli/src/config/env.ts', lines: '255-257', snippet: 'section.enabled = todo ===' },
  },
  {
    name: 'ARAGON_TODO_ACCEPTANCE', purpose: '是否要求每条 TODO 带验收标准',
    effect: '打开后计划必须写清验收条件，验证阶段据此派生',
    source: { path: 'packages/cli/src/config/env.ts', lines: '267-273', snippet: 'section.acceptance' },
  },
  {
    name: 'ARAGON_TODO_FOLLOW', purpose: '设置 TODO 的跟进强度（followThrough 模式）',
    effect: '未经校验直接写入，由 clampTodoConfig 夹取；无法识别的模式回落到默认值',
    source: { path: 'packages/cli/src/config/env.ts', lines: '261-263', snippet: 'section.followThrough = todoFollow' },
  },
  {
    name: 'ARAGON_TRANSCRIPT_RETAIN', purpose: '保留的历史条目数',
    effect: '值小于可视窗口时会被抬到窗口大小，否则滚动会丢行；非正数忽略',
    source: { path: 'packages/cli/src/config/env.ts', lines: '480-484', snippet: 'partial.transcriptRetain' },
  },
  {
    name: 'ARAGON_UPDATE', purpose: '自动更新策略（三态）',
    effect: '0/false/off/no 关闭，notify 只提示不安装，1/true/on/yes 自动安装；无法识别的值忽略，避免把关闭误读成开启',
    source: { path: 'packages/cli/src/config/env.ts', lines: '465-477', snippet: 'update === \'notify\'' },
  },
  {
    name: 'ARAGON_UPDATE_REGISTRY', purpose: '检查更新时使用的 npm 注册表地址',
    effect: '优先级在配置文件之后、npm_config_registry 之前；非 http(s) 值被跳过',
    source: { path: 'packages/cli/src/update/registry.ts', lines: '45', snippet: 'env.ARAGON_UPDATE_REGISTRY' },
  },
  {
    name: 'CI', purpose: '让程序识别自己跑在 CI 里',
    effect: '设置了任何值就跳过自动更新检查，也用于导入 Ink 时覆盖其 CI 探测',
    source: { path: 'packages/cli/src/cli.tsx', lines: '1436-1440', snippet: '!process.env.CI' },
  },
  {
    name: 'ComSpec', purpose: '决定 Windows 上使用哪个 shell',
    effect: '值里含 powershell/pwsh 就提示模型用 PowerShell 语法，否则按 cmd.exe；bash 工具以 shell:true 继承它',
    default: 'cmd.exe',
    source: { path: 'packages/cli/src/agent/system-prompt.ts', lines: '174', snippet: 'ComSpec' },
  },
  {
    name: 'EDITOR', purpose: '指定编辑配置文件用的编辑器',
    effect: 'VISUAL 未设置时使用；两者都没有时用平台默认编辑器',
    default: 'notepad（Windows）/vi（其它平台）',
    source: { path: 'packages/cli/src/config/cli-commands.ts', lines: '660-663', snippet: 'process.env.EDITOR' },
  },
  {
    name: 'GEMINI_API_KEY', purpose: '提供 Google/Gemini 服务商密钥的备用变量名',
    effect: 'GOOGLE_API_KEY 为空时才读它，两者同时存在时以 GOOGLE_API_KEY 为准',
    source: { path: 'packages/cli/src/config/env.ts', lines: '67', snippet: '\'GEMINI_API_KEY\'' },
  },
  {
    name: 'GOOGLE_API_KEY', purpose: '提供 Google/Gemini 服务商密钥',
    effect: 'google 服务商的首选密钥变量，缺失时才回落到 GEMINI_API_KEY',
    source: { path: 'packages/cli/src/config/env.ts', lines: '67', snippet: '\'GOOGLE_API_KEY\'' },
  },
  {
    name: 'NODE_ENV', purpose: '区分生产与开发运行',
    effect: '非 production 时对被裁剪的历史条目做自检，属内部断言通道，正常使用无需设置',
    default: '未设置（视为非 production）',
    source: { path: 'packages/cli/src/agent/reducer.ts', lines: '1046', snippet: 'process.env.NODE_ENV' },
  },
  {
    name: 'NO_COLOR', purpose: '关闭彩色输出',
    effect: '没有被 `--no-color` 关掉时生效（`flags.color` 为真），同时连带打开 reducedMotion',
    source: { path: 'packages/cli/src/config/load.ts', lines: '1119', snippet: 'process.env.NO_COLOR' },
  },
  {
    name: 'OPENAI_API_KEY', purpose: '提供 OpenAI 服务商密钥',
    effect: 'provider 为 openai 时用它认证，环境变量优先于配置文件里的密钥',
    source: { path: 'packages/cli/src/config/env.ts', lines: '66', snippet: '\'OPENAI_API_KEY\'' },
  },
  {
    name: 'SHELL', purpose: '告诉模型当前使用的 POSIX shell',
    effect: '只用于系统提示里的 shell 描述，影响模型生成哪种语法；命令执行仍走 /bin/sh -c',
    default: '/bin/sh',
    source: { path: 'packages/cli/src/agent/system-prompt.ts', lines: '178', snippet: 'process.env.SHELL' },
  },
  {
    name: 'SSH_CONNECTION', purpose: '识别当前处于 SSH 远程会话',
    effect: '存在时复制改走 OSC 52，因为没有本地剪贴板程序可调用',
    source: { path: 'packages/cli/src/ui/clipboard.ts', lines: '159', snippet: 'SSH_CONNECTION' },
  },
  {
    name: 'SSH_TTY', purpose: '识别当前处于 SSH 远程会话（备用变量）',
    effect: '与 SSH_CONNECTION 任一存在即判定为远程，复制走 OSC 52',
    source: { path: 'packages/cli/src/ui/clipboard.ts', lines: '159', snippet: 'SSH_TTY' },
  },
  {
    name: 'TERM', purpose: '声明终端类型',
    effect: 'TERM=dumb 时关闭同步输出序列，避免在不能识别的终端上写坏屏幕',
    source: { path: 'packages/cli/src/cli.tsx', lines: '1094-1097', snippet: 'process.env.TERM !== \'dumb\'' },
  },
  {
    name: 'VISUAL', purpose: '指定编辑配置文件用的编辑器',
    effect: '优先级高于 EDITOR；两者都没有时用平台默认编辑器',
    source: { path: 'packages/cli/src/config/cli-commands.ts', lines: '661', snippet: 'process.env.VISUAL' },
  },
  {
    name: 'VITEST', purpose: '标记当前跑在 vitest 里',
    effect: '只与测试相关：把会话根目录换成临时目录，避免测试写进真实用户目录',
    source: { path: 'packages/cli/src/config/app-paths.ts', lines: '103-104', snippet: 'process.env.VITEST' },
  },
  {
    name: 'VITEST_POOL_ID', purpose: '标记 vitest 的 worker 编号',
    effect: '只与测试相关：让每个 worker 拿到独立的临时根目录，避免并发互相清理',
    source: { path: 'packages/cli/src/config/app-paths.ts', lines: '116', snippet: 'process.env.VITEST_POOL_ID' },
  },
  {
    name: 'npm_config_registry', purpose: 'npm 自身导出的注册表地址',
    effect: '作为更新检查的最后一级回落，让 aragon 无需配置就能继承企业镜像',
    source: { path: 'packages/cli/src/update/registry.ts', lines: '45', snippet: 'env.npm_config_registry' },
  },
];
