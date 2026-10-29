/**
 * 按键表数据（中文文档「快捷键」页的唯一数据源）。
 *
 * 真源是仓库源码本身：行编辑键位见 `packages/cli/src/input/keymap.ts` 与
 * `packages/cli/src/ui/PromptInput.tsx`，应用级键位见 `packages/cli/src/ui/App.tsx`，
 * 确认浮层键位见 `packages/cli/src/ui/overlays/ConfirmDialog.tsx`。每条记录的
 * `source.snippet` 必须是对应行区间里今天的原文片段——站点有漂移校验，改代码就要同步改这里。
 * 数组顺序即页面渲染顺序：先行编辑，再全局，然后是浮层与会话。
 */
export const keybindings = [
  {
    keys: ['Ctrl+A'],
    action: '跳到行首',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '41-43', snippet: 'case \'a\':' },
  },
  {
    keys: ['Ctrl+E'],
    action: '跳到行尾',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '44-45', snippet: 'case \'e\':' },
  },
  {
    keys: ['Ctrl+W'],
    action: '删除光标前的整个单词',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '46-47', snippet: 'case \'w\':' },
  },
  {
    keys: ['Ctrl+U'],
    action: '删除光标到行首的内容',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '48-49', snippet: 'case \'u\':' },
  },
  {
    keys: ['Alt+B', 'Alt+F'],
    action: '按单词左右移动光标',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '56-58', snippet: 'input === \'b\'' },
  },
  {
    keys: ['Alt+K'],
    action: '删除光标到行尾的内容（原 Ctrl+K）',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '62', snippet: 'killToEnd' },
  },
  {
    keys: ['Alt+Backspace'],
    action: '删除光标前的整个单词',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '63', snippet: 'deleteWordBack' },
  },
  {
    keys: ['Ctrl+Left', 'Ctrl+Right'],
    action: '按单词左右跳转光标',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '39-40', snippet: 'key.leftArrow' },
  },
  {
    keys: ['Home'],
    action: '跳到行首，不删除任何字符',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '69-74', snippet: 'return \'home\';' },
  },
  {
    keys: ['End'],
    action: '跳到行尾',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/input/keymap.ts', lines: '75-79', snippet: 'return \'end\';' },
  },
  {
    keys: ['Enter'],
    action: '空闲时发送，运行时排队为引导消息',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/ui/PromptInput.tsx', lines: '817-824', snippet: 'kind: \'submit\'' },
  },
  {
    keys: ['Alt+Enter', 'Shift+Enter'],
    action: '插入换行而不发送',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/ui/PromptInput.tsx', lines: '745-750', snippet: 'insert(\'\\n\');' },
  },
  {
    keys: ['Ctrl+J'],
    action: '不依赖键盘增强的换行兜底',
    scope: '输入编辑',
    source: { path: 'packages/cli/README.md', lines: '986', snippet: 'Ctrl+J' },
  },
  {
    keys: ['Up', 'Down'],
    action: '在空草稿时召回历史输入',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/ui/PromptInput.tsx', lines: '850-857', snippet: 'verticalOrHistory(\'up\')' },
  },
  {
    keys: ['Tab'],
    action: '接受补全弹层里高亮的候选',
    scope: '输入编辑',
    source: { path: 'packages/cli/src/ui/PromptInput.tsx', lines: '781-783', snippet: 'completeSelection()' },
  },
  {
    keys: ['Ctrl+C'],
    action: '复制选区；否则停后台服务，再按两次退出',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2671', snippet: 'input === \'c\'' },
  },
  {
    keys: ['Ctrl+R'],
    action: '整屏重绘，修复终端乱码',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2946', snippet: 'input === \'r\'' },
  },
  {
    keys: ['Ctrl+T'],
    action: '显示或隐藏模型思考内容',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2974', snippet: 'thinkingVisible' },
  },
  {
    keys: ['Ctrl+O'],
    action: '展开最近的工具/团队/压缩卡片或末条回答',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2983', snippet: 'input === \'o\'' },
  },
  {
    keys: ['Shift+Tab'],
    action: '切换 BUILD 与 PLAN 模式（Ctrl+N 同效）',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2929', snippet: 'key.tab && key.shift' },
  },
  {
    keys: ['PgUp', 'PgDn'],
    action: '按页滚动记录或当前浮层',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2960', snippet: 'scrollBy(\'pageDown\')' },
  },
  {
    keys: ['Shift+Up', 'Shift+Down'],
    action: '按行滚动记录（仅全屏模式）',
    scope: '全局',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2963', snippet: 'key.shift && key.upArrow' },
  },
  {
    keys: ['Ctrl+G'],
    action: '打开或关闭快捷键抽屉',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2789', snippet: 'input.toLowerCase() === \'g\'' },
  },
  {
    keys: ['Ctrl+B'],
    action: '打开只读的子代理看板',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2805', snippet: 'const isCtrlB' },
  },
  {
    keys: ['Ctrl+K'],
    action: '打开 agent kit 选择器，切换本会话模型组合',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2850', snippet: 'const isCtrlK' },
  },
  {
    keys: ['Ctrl+P'],
    action: '打开快捷提示词库',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2831', snippet: 'input === \'p\'' },
  },
  {
    keys: ['Esc'],
    action: '关闭当前浮层或取消等待中的确认',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '3041', snippet: 'if (key.escape)' },
  },
  {
    keys: ['?'],
    action: '在空输入时打开帮助浮层',
    scope: '面板与浮层',
    source: { path: 'packages/cli/src/ui/PromptInput.tsx', lines: '859-863', snippet: 'input === \'?\'' },
  },
  {
    keys: ['Ctrl+L'],
    action: '把当前会话分支到新终端窗口',
    scope: '会话与历史',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2878', snippet: 'executeSlashInput(\'/branch\')' },
  },
  {
    keys: ['Ctrl+I'],
    action: '确认后建立项目索引（project-indexer）',
    scope: '会话与历史',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '2860', snippet: 'input.includes(INDEX_KEY_FRAME)' },
  },
  {
    keys: ['Esc', 'Esc'],
    action: '1.5 秒内两次中断当前运行，再按强制停止',
    scope: '会话与历史',
    source: { path: 'packages/cli/src/ui/App.tsx', lines: '3077', snippet: 'advanceInterruptGesture' },
  },
  {
    keys: ['Y'],
    action: '批准工具调用',
    scope: '权限与确认',
    source: { path: 'packages/cli/src/ui/overlays/ConfirmDialog.tsx', lines: '52-54', snippet: 'input === \'y\'' },
  },
  {
    keys: ['N'],
    action: '拒绝工具调用（Enter 与 Esc 效果相同）',
    scope: '权限与确认',
    source: { path: 'packages/cli/src/ui/overlays/ConfirmDialog.tsx', lines: '55-57', snippet: 'input === \'n\'' },
  },
  {
    keys: ['A'],
    action: '批准计划评审结果',
    scope: '权限与确认',
    source: {
      path: 'packages/cli/src/ui/overlays/PlanReviewOverlay.tsx',
      lines: '106',
      snippet: 'input === \'a\'',
    },
  },
];
