/**
 * 导航真源（§2.2）：9 个分组 × 56 页。
 *
 * 这是**唯一**的页面清单。页集合 = 本文件按 `--phase` 过滤后的结果：
 * `A` → 29 页，`all` → 56 页。页面模块里的 `id`/`group`/`order` 必须与本文件一致
 * （`check.mjs --model` 断言），所以「加一页」只需要动两个地方：这里 + 对应分组文件。
 */

/**
 * @typedef {Object} NavPage
 * @property {string} id 页面 id（同时是 URL 段落）
 * @property {string} title 页面标题
 * @property {number} order 组内排序
 * @property {'A'|'B'} phase 交付阶段
 */

/**
 * @typedef {Object} NavGroup
 * @property {string} id 分组 id
 * @property {string} title 分组中文名
 * @property {NavPage[]} pages 组内页面（按 order 升序）
 */

/** 导航树。 */
export const navGroups = [
  {
    id: 'start',
    title: '开始',
    pages: [
      { id: 'start/index', title: '文档首页', order: 10, phase: 'A' },
      { id: 'start/install', title: '安装与升级', order: 20, phase: 'A' },
      { id: 'start/first-run', title: '第一次运行', order: 30, phase: 'A' },
      { id: 'start/five-minutes', title: '五分钟上手', order: 40, phase: 'A' },
      { id: 'start/concepts', title: '六个核心概念', order: 50, phase: 'A' },
    ],
  },
  {
    id: 'guide',
    title: '日常使用',
    pages: [
      { id: 'guide/tui', title: '界面导览', order: 10, phase: 'A' },
      { id: 'guide/keybindings', title: '键盘快捷键', order: 20, phase: 'A' },
      { id: 'guide/slash-commands', title: '斜杠命令', order: 30, phase: 'A' },
      { id: 'guide/input-queue', title: '输入、队列与中断', order: 40, phase: 'A' },
      { id: 'guide/plan-mode', title: '计划模式', order: 50, phase: 'A' },
      { id: 'guide/todo', title: 'TODO 与验收标准', order: 60, phase: 'A' },
      { id: 'guide/team', title: '团队子代理', order: 70, phase: 'A' },
      { id: 'guide/skills', title: '技能', order: 80, phase: 'A' },
      { id: 'guide/context', title: '上下文与自动压缩', order: 90, phase: 'B' },
      { id: 'guide/background', title: '后台服务与后台作业', order: 100, phase: 'B' },
      { id: 'guide/scroll-themes', title: '滚动、主题与渲染性能', order: 110, phase: 'B' },
      { id: 'guide/sessions', title: '会话、恢复与分支', order: 120, phase: 'B' },
      { id: 'guide/models', title: '模型、fast 档与 kits', order: 130, phase: 'B' },
    ],
  },
  {
    id: 'config',
    title: '配置',
    pages: [
      { id: 'config/overview', title: '配置文件与优先级', order: 10, phase: 'A' },
      { id: 'config/reference', title: '全部配置键', order: 20, phase: 'A' },
      { id: 'config/env', title: '环境变量', order: 30, phase: 'B' },
      { id: 'config/home', title: '本地目录结构', order: 40, phase: 'B' },
      { id: 'config/logs', title: '日志与诊断', order: 50, phase: 'B' },
      { id: 'config/context-window', title: '上下文窗口与模型表', order: 60, phase: 'B' },
    ],
  },
  {
    id: 'cli',
    title: 'CLI 参考',
    pages: [
      { id: 'cli/global-flags', title: '全局参数', order: 10, phase: 'A' },
      { id: 'cli/subcommands', title: '子命令', order: 20, phase: 'A' },
      { id: 'cli/exit-codes', title: '退出码', order: 30, phase: 'A' },
      { id: 'cli/command-families', title: '命令族：config / skills / session', order: 40, phase: 'B' },
    ],
  },
  {
    id: 'exec',
    title: '机器契约',
    pages: [
      { id: 'exec/overview', title: '概览与 60 秒上手', order: 10, phase: 'A' },
      { id: 'exec/flags', title: '参数参考', order: 20, phase: 'A' },
      { id: 'exec/output', title: '输出格式', order: 30, phase: 'A' },
      { id: 'exec/events', title: '事件参考', order: 40, phase: 'A' },
      { id: 'exec/permissions', title: '权限模式与工具白名单', order: 50, phase: 'A' },
      { id: 'exec/budgets', title: '预算与退出码', order: 60, phase: 'A' },
      { id: 'exec/sessions', title: '会话续接与并发', order: 70, phase: 'B' },
      { id: 'exec/host', title: '宿主桥：bridge / threads / hooks', order: 80, phase: 'B' },
    ],
  },
  {
    id: 'api',
    title: '引擎 API',
    pages: [
      { id: 'api/install', title: '安装与最小示例', order: 10, phase: 'A' },
      { id: 'api/agent', title: 'Agent 与 AgentConfig', order: 20, phase: 'A' },
      { id: 'api/tools', title: '工具定义与执行', order: 30, phase: 'A' },
      { id: 'api/events', title: '事件与订阅', order: 40, phase: 'B' },
      { id: 'api/providers', title: 'Provider 与模型', order: 50, phase: 'B' },
      { id: 'api/limits', title: '输出上限与重试', order: 60, phase: 'B' },
      { id: 'api/compaction', title: '上下文压缩端口', order: 70, phase: 'B' },
      { id: 'api/skills', title: 'SkillRegistry 与技能格式', order: 80, phase: 'B' },
      { id: 'api/sandbox', title: 'isolated-vm 沙箱', order: 90, phase: 'B' },
      { id: 'api/types', title: '类型导出与子路径导出', order: 100, phase: 'B' },
    ],
  },
  {
    id: 'tools',
    title: '内置工具',
    pages: [
      { id: 'tools/index', title: '工具总览', order: 10, phase: 'A' },
      { id: 'tools/files', title: '文件与搜索工具', order: 20, phase: 'B' },
      { id: 'tools/shell', title: 'Shell 与后台作业工具', order: 30, phase: 'B' },
      { id: 'tools/plan', title: '计划与提问工具', order: 40, phase: 'B' },
      { id: 'tools/skills', title: '技能工具', order: 50, phase: 'B' },
    ],
  },
  {
    id: 'troubleshoot',
    title: '排错',
    pages: [
      { id: 'troubleshoot/faq', title: '常见问题', order: 10, phase: 'A' },
      { id: 'troubleshoot/doctor', title: 'doctor 与自检', order: 20, phase: 'B' },
      { id: 'troubleshoot/escape', title: '卡住时的逃生路径', order: 30, phase: 'B' },
    ],
  },
  {
    id: 'appendix',
    title: '附录',
    pages: [
      { id: 'appendix/glossary', title: '术语表', order: 10, phase: 'B' },
      { id: 'appendix/compat', title: '版本与兼容承诺', order: 20, phase: 'B' },
    ],
  },
];

/** 全部页面 id（按导航顺序）。 */
export const allPageIds = navGroups.flatMap((group) => group.pages.map((page) => page.id));

/**
 * 按阶段过滤导航：`A` 只保留阶段 A 的页面，`all` 返回全部。
 *
 * @param {'A'|'all'} phase 交付阶段
 * @returns {NavGroup[]} 过滤后的分组（保持原顺序）
 */
export function navForPhase(phase) {
  if (phase === 'all') return navGroups.map((group) => ({ ...group, pages: [...group.pages] }));
  return navGroups
    .map((group) => ({ ...group, pages: group.pages.filter((page) => page.phase === 'A') }))
    .filter((group) => group.pages.length > 0);
}

/**
 * 阶段页面数（`A` → 29，`all` → 56）。
 *
 * @param {'A'|'all'} phase 交付阶段
 * @returns {number} 页面数
 */
export function pageCountForPhase(phase) {
  return navForPhase(phase).reduce((sum, group) => sum + group.pages.length, 0);
}

/**
 * 两个阶段的页数，供 `_meta.json.phaseCounts` 使用。
 *
 * @returns {{A: number, B: number}} 阶段 A 与 B 的页数
 */
export function phaseCounts() {
  const countA = navGroups.reduce(
    (sum, group) => sum + group.pages.filter((page) => page.phase === 'A').length,
    0,
  );
  const countB = navGroups.reduce(
    (sum, group) => sum + group.pages.filter((page) => page.phase === 'B').length,
    0,
  );
  return { A: countA, B: countB };
}

/**
 * 查一个页面在导航里的条目。
 *
 * @param {string} id 页面 id
 * @returns {NavPage|null} 导航条目
 */
export function navEntry(id) {
  for (const group of navGroups) {
    const found = group.pages.find((page) => page.id === id);
    if (found) return found;
  }
  return null;
}
