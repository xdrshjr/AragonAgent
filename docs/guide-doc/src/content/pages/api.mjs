/**
 * 引擎 API 分组的页面（§2.2）。
 *
 * 这一组讲的是**库**而不是 CLI：`Agent`、工具契约、事件、provider、输出上限与重试、
 * 压缩端口、技能、沙箱，以及最终导出清单。
 *
 * 三条写作约定：
 * - 清单与计数从 `src/content/data/**` 派生（`apiExports`、`apiSubpaths`、`tools`），
 *   正文里的数字不是抄的 —— 改数据集即全站同步。
 * - 每个 `api` 模板页面都设置 `importLine` 与 `signature`：模板把它们固定在正文之前，
 *   读者不必在示例里猜「这个符号从哪来」。
 * - 示例都是对着真实签名写的 TypeScript；示例之外用到的宿主函数用 `declare` 显式声明。
 */

import { apiExports, apiSubpaths } from '../data/api-exports.mjs';
import { tools } from '../data/tools.mjs';

/**
 * 值导出总数（派生）。真源是 `packages/core/src/index.ts`；`API.md` 的标题写 85、
 * 表里只有 84 行，见 `/api/types/`。
 */
const EXPORT_COUNT = apiExports.length;

/** `API.md` 运行时表里缺行的记录（有名字、无 `summary`）。 */
const apiDocGaps = apiExports.filter((record) => !record.summary);

/** kind → 中文标签；表顺序：先类型，再函数，最后常量。 */
const KIND_LABELS = { class: '类', 'class (alias)': '类别名', fn: '函数', const: '常量' };
const KIND_ORDER = ['class', 'class (alias)', 'fn', 'const'];

/** 子路径 → `exports` 里的目标文件（译自 `packages/core/package.json`）。 */
const SUBPATH_TARGETS = {
  '.': './dist/index.js',
  './llm/types': './dist/llm/types.js',
  './llm/providers': './dist/llm/providers/index.js',
  './tools/types': './dist/tools/types.js',
  './tools/helpers': './dist/tools/helpers.js',
  './skills': './dist/skills/index.js',
  './sandbox/*': './dist/sandbox/*.js',
};

/**
 * 拆开数据集里的子路径列（形如 `` `.`, `./skills` ``）。
 * @param {string} raw 原文
 * @returns {string[]} 子路径
 */
function splitSubpaths(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => part.trim().replace(/`/g, ''))
    .filter(Boolean);
}

/**
 * 子路径单元格：每段各包一层行内代码。
 * @param {string} raw 原文
 * @returns {string} 行内文本
 */
function subpathCell(raw) {
  const parts = splitSubpaths(raw);
  return parts.length === 0 ? '—' : parts.map((part) => `\`${part}\``).join(' ');
}

/**
 * 用途单元格：`API.md` 缺表行的那两条显式说明。
 * @param {object} record 导出记录
 * @returns {string} 行内文本
 */
function summaryCell(record) {
  return record.summary || '源码有、`API.md` 的表里缺这一行（见本页偏差说明）';
}

/**
 * 一批导出记录 → 一张表。
 * @param {object[]} records 记录
 * @param {string} caption 标题
 * @returns {object} table block
 */
function exportTable(records, caption) {
  return {
    t: 'table',
    caption,
    head: ['符号', '子路径', '用途（源码/`API.md` 原文）'],
    rows: records.map((r) => [`\`${r.name}\``, subpathCell(r.subpath), summaryCell(r)]),
  };
}

/**
 * 某子路径上的值导出数（派生）。
 * @param {string} subpath 子路径
 * @returns {number} 记录数
 */
function exportCountFor(subpath) {
  return apiExports.filter((r) => splitSubpaths(r.subpath).includes(subpath)).length;
}

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'api/install',
    title: '安装与最小示例',
    group: 'api',
    order: 10,
    phase: 'A',
    template: 'steps',
    summary:
      '安装 `@aragon-agent/core`（可选 `isolated-vm`），装起 registry 与第一个 `Agent`，再跑通一次带事件订阅的流式回合：五步，全程不碰 CLI。',
    keywords: ['npm install', '@aragon-agent/core', 'AragonAgent', '最小示例', '流式', 'engine'],
    seeAlso: ['api/agent', 'api/tools', 'start/install'],
    sourceRefs: [
      { path: 'packages/core/README.md', lines: '17-23', snippet: 'npm install @aragon-agent/core' },
      { path: 'packages/core/package.json', lines: '90-95', snippet: '"node": ">=18"' },
      { path: 'packages/core/src/engine/agent.ts', lines: '160-176', snippet: 'constructor(config: AgentConfig) {' },
      {
        path: 'packages/core/src/llm/providers/index.ts',
        lines: '165-178',
        snippet: 'export function initProviders(options?: ProviderRegistryOptions): ProviderRegistry {',
      },
    ],
    importLine: "import { Agent, defineTool, initProviders, textResult } from '@aragon-agent/core';",
    blocks: [
      {
        t: 'p',
        md:
          '`@aragon-agent/core` 是引擎，不是界面：它提供 `Agent`、provider 适配器、工具注册与执行、steering、' +
          '空闲看门狗与（可选）沙箱。配置、密钥、文件系统都来自宿主 —— CLI 只是其中一个宿主。',
      },
      { t: 'h2', text: '安装' },
      {
        t: 'steps',
        items: [
          {
            title: '装包',
            md: '这个包是 **ESM only**（`"type": "module"`）：只能 `import`，不能被 `require()` 加载。',
            code: { lang: 'bash', code: 'npm install @aragon-agent/core' },
          },
          {
            title: '（可选）装沙箱的原生依赖',
            md: '`ajv` 与 `isolated-vm` 都是 `optionalDependencies`：缺席时校验退化为内置子集、沙箱子路径不可用。',
            code: { lang: 'bash', code: 'npm install isolated-vm' },
          },
          {
            title: '建 provider registry',
            md: '`initProviders()` 注册 `anthropic` / `openai` / `google` 三个适配器，并默认挂上 `DEFAULT_RETRY_POLICY`。',
            code: { lang: 'ts', code: 'const registry = initProviders();' },
          },
          {
            title: '定义一个工具',
            md: '`defineTool` 只把你写的配置收成 `AgentTool`；`execute` 必须返回 `Promise<ToolResult>`。',
          },
          {
            title: '构造 `Agent` 并订阅事件',
            md:
              '`prompt()` 是入口（**没有** `agent.run()` 这个方法）；流式文本走 `message_update` 里嵌套的 `text_delta`。',
          },
        ],
      },
      { t: 'h2', text: '最小可运行示例' },
      { t: 'p', md: '定义工具、建 registry、构造 `Agent`、订阅流式文本、跑一个回合、退订。配好 `@types/node` 即可通过类型检查。' },
      {
        t: 'code',
        lang: 'ts',
        title: 'minimal.ts',
        code: [
          "import { Agent, defineTool, initProviders, textResult } from '@aragon-agent/core';",
          '',
          'const echo = defineTool<{ text: string }>({',
          "  name: 'echo',",
          "  label: 'Echo',",
          "  description: 'Repeat the given text back unchanged.',",
          "  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },",
          '  async execute(_toolCallId, params) {',
          '    return textResult(params.text);',
          '  },',
          '});',
          '',
          'const agent = new Agent({',
          "  systemPrompt: 'You are a terse assistant.',",
          "  model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },",
          '  tools: [echo],',
          '  providerRegistry: initProviders(),',
          '  getApiKey: (providerId) => process.env[`${providerId.toUpperCase()}_API_KEY`],',
          '  timeouts: { idleTimeout: 60_000, toolTimeout: 120_000 },',
          '});',
          '',
          'const unsubscribe = agent.subscribe((event) => {',
          "  if (event.type === 'message_update' && event.streamEvent.type === 'text_delta') {",
          '    process.stdout.write(event.streamEvent.delta);',
          '  }',
          "  if (event.type === 'turn_end') console.log(`\\n--- ${event.usage.outputTokens} tokens`);",
          '});',
          '',
          "await agent.prompt('Echo the word ready.');",
          'unsubscribe();',
        ].join('\n'),
      },
      { t: 'h2', text: '引擎与 CLI 的分工' },
      {
        t: 'table',
        caption: '同一个引擎的两个宿主',
        head: ['能力', 'Core（本组）', 'CLI'],
        rows: [
          ['LLM 调用、重试、输出上限', '提供', '通过 `--retry`、`maxTokens` 配置它'],
          ['工具注册与执行', '`ToolRegistry` / `ToolExecutor`', '19 个内置工具的具体实现'],
          ['配置与密钥', '只接收 `AgentConfig` 与 `getApiKey`', '读 `config.json`、`.env`、`--api-key`'],
          ['持久化与会话', '无（不碰 `node:*` 文件系统）', '会话文件、检查点、`--resume`（读旧写新）'],
          ['界面', '无', 'Ink TUI 与 `aragon exec` 机器契约'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: 'CJS 宿主只能动态 `import()`',
        md:
          'ESM-only 是硬约束。`require()` 会在 `package.json#exports` 的 `import` 条件上直接失败；' +
          '唯一可行的写法是 `const core = await import(\'@aragon-agent/core\')`。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '`ajv` 缺席会悄悄放宽校验',
        md:
          '不装 `ajv` 时只做内置子集校验：依赖 `$ref` / `definitions` 的约束**根本不会被检查**。' +
          '把 schema 当安全边界就显式依赖它。',
      },
      {
        t: 'h2',
        text: '三个常见坑',
      },
      {
        t: 'ul',
        items: [
          '**`prompt()` 不会 reject。** 循环里的异常被 `console.error` 记下后照常发 `agent_end`；成败要看事件。',
          '**运行中再调 `prompt()` / `continue()` 会抛错。** 先 `abort()` 或 `await waitForIdle()`。',
          '**事件顺序可信、内容要自己攒。** `message_update` 是片段，完整消息由你拼（见 [事件与订阅](/api/events/)）。',
        ],
      },
    ],
  },

  {
    id: 'api/agent',
    title: 'Agent 与 AgentConfig',
    group: 'api',
    order: 20,
    phase: 'A',
    template: 'api',
    summary:
      '`Agent` 就是引擎本身：十个配置字段、十二个生命周期方法、两条消息队列（steering 与 follow-up），以及只在该开时才开的三处超时。',
    keywords: ['Agent', 'AragonAgent', 'AgentConfig', 'AgentState', 'steering', 'watchdog'],
    seeAlso: ['api/tools', 'api/events', 'api/compaction'],
    sourceRefs: [
      { path: 'packages/core/src/engine/agent.ts', lines: '30-98', snippet: 'export interface AgentConfig {' },
      { path: 'packages/core/src/engine/agent.ts', lines: '104-111', snippet: 'export interface AgentState {' },
      { path: 'packages/core/src/engine/agent.ts', lines: '269-278', snippet: 'subscribe(listener: AgentEventListener): () => void {' },
      { path: 'packages/core/src/engine/agent.ts', lines: '284-292', snippet: 'steer(message: string, id?: string): void {' },
      { path: 'packages/core/src/engine/agent.ts', lines: '456-510', snippet: 'private async runLoopWithLifecycle(): Promise<void> {' },
      { path: 'packages/core/src/types.ts', lines: '34-44', snippet: 'export interface SteeringAcceptedEvent {' },
    ],
    importLine:
      "import { Agent, AragonAgent, type AgentConfig, type AgentState, type AgentEventListener } from '@aragon-agent/core';",
    signature: [
      'interface AgentConfig {',
      '  systemPrompt: string;',
      '  model: ModelRef;              // { providerId, modelId, baseUrl? }',
      '  tools: AgentTool[];',
      '  providerRegistry: ProviderRegistry;',
      '  getApiKey: (providerId: string) => string | undefined;',
      '  thinkingLevel?: ThinkingLevel;   // 默认 off',
      '  sandbox?: CodeActSandbox;',
      '  maxTokens?: number;             // 意愿值，永远被真实上限夹住',
      '  contextManager?: ContextManager;',
      '  timeouts?: { llmCallTimeout?; idleTimeout?; toolTimeout?; codeTimeout?;',
      '               compactionHardTimeout?; toolTimeoutOverrides? };',
      '}',
      '',
      'class Agent {',
      '  get state(): AgentState;',
      '  prompt(message: string | UserMessage): Promise<void>;',
      '  continue(): Promise<void>;',
      '  abort(): void;',
      '  waitForIdle(): Promise<void>;',
      '  subscribe(listener: AgentEventListener): () => void;',
      '  steer(message: string, id?: string): void;',
      '  followUp(message: string): void;',
      '  pauseIdleWatchdog(): void; resumeIdleWatchdog(): void;',
      '}',
      '',
      'const AragonAgent: typeof Agent; // 同一个类，两个名字',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '`Agent` 是引擎唯一的门面：消息历史、两条队列、工具注册表与执行器、空闲看门狗与可选的压缩端口都装在这一个对象上。' +
          '`AragonAgent` 是同一个类的发布别名（`export { Agent as AragonAgent }`），不是子类。',
      },
      { t: 'h2', text: '构造：`AgentConfig` 的全部字段' },
      {
        t: 'params',
        caption: '前五个必填；`model` 是 `ModelRef`，不是 `ModelInfo`',
        items: [
          { name: 'systemPrompt', type: 'string', required: true, desc: '初始系统提示词，之后可用 `setSystemPrompt()` 换掉。' },
          { name: 'model', type: 'ModelRef', required: true, desc: '`{ providerId, modelId, baseUrl? }`。引擎从不认识模型元数据。' },
          { name: 'tools', type: 'AgentTool[]', required: true, desc: '初始工具集，构造时按名字同步进内部 `ToolRegistry`。' },
          { name: 'providerRegistry', type: 'ProviderRegistry', required: true, desc: '流式来源，通常来自 `initProviders()`。' },
          {
            name: 'getApiKey',
            type: '(providerId: string) => string | undefined',
            required: true,
            desc: 'Core 不读环境变量，这一步是宿主的责任。',
          },
          { name: 'thinkingLevel', type: 'ThinkingLevel', desc: '扩展思考档位，默认 `off`；只有 Anthropic 适配器真的用它。' },
          { name: 'sandbox', type: 'CodeActSandbox', desc: '注入后循环才会把代码块当 CodeAct 执行。' },
          { name: 'maxTokens', type: 'number', desc: '输出上限意愿值；`undefined` 走每模型解析，且永远被真实上限夹住。' },
          { name: 'contextManager', type: 'ContextManager', desc: '压缩端口。不传时回合边界只是一次 `if`，行为与旧版本逐字节一致。' },
          { name: 'timeouts', type: 'object', desc: '六个旋钮，见下一张表；整体省略即全部默认。' },
        ],
      },
      { t: 'h2', text: '`timeouts` 的六个旋钮' },
      {
        t: 'table',
        caption: '默认值取自 `agent.ts` 的模块级常量',
        head: ['键', '默认', '超时之后发生什么'],
        rows: [
          ['`llmCallTimeout`', '`300_000`', '单次 LLM 调用被中止，回合以错误结束'],
          ['`idleTimeout`', '`60_000`', '这么久没有任何事件 → 看门狗 `abort()` 整个运行'],
          ['`toolTimeout`', '`120_000`', '`ToolExecutor` 对 `context.signal` 触发 abort'],
          ['`codeTimeout`', '`30_000`', 'CodeAct 代码执行被中止'],
          ['`compactionHardTimeout`', '`120_000`', '对 `compact()` 的硬上限，与宿主是否听话无关'],
          ['`toolTimeoutOverrides`', '`{}`', '按工具名覆盖；值 `0` 表示**根本不设上限**'],
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '`toolTimeout` 杀不掉不看 signal 的工具',
        md:
          '`ToolExecutor` 的超时是「对 `context.signal` 调 `abort()` 然后继续 await」，没有 `Promise.race`。' +
          '工具不订阅 signal，这个数字对它完全无效 —— 写法见 [工具定义与执行](/api/tools/)。',
      },
      { t: 'h2', text: '十二个公共方法' },
      {
        t: 'table',
        caption: '`state` 是唯一的 getter',
        head: ['方法', '签名', '说明'],
        rows: [
          ['`prompt`', '`(message: string \\| UserMessage) => Promise<void>`', '压入用户消息并跑完循环；运行中调用会抛错'],
          ['`continue`', '`() => Promise<void>`', '不新增用户消息，从现有历史继续'],
          ['`abort` / `waitForIdle`', '`() => void` / `() => Promise<void>`', '中止当前运行（幂等）；等到空闲'],
          ['`subscribe`', '`(listener) => () => void`', '注册监听器，返回退订函数'],
          ['`steer`', '`(message: string, id?: string) => void`', '高优先级插队，回合顶部或工具之间接收'],
          ['`followUp`', '`(message: string) => void`', '低优先级，`end_turn` 之后才消费'],
          ['`setModel` / `setSystemPrompt`', '`(value) => void`', '换模型 / 换系统提示词，下一条请求生效'],
          ['`setTools` / `clearAllQueues`', '`(tools: AgentTool[]) => void` / `() => void`', '重建工具表 / 清空两条队列'],
          ['`appendMessage` / `replaceMessages` / `clearMessages`', '`(message) => void` 等', '直接操作历史，用于从存储恢复会话'],
          ['`pauseIdleWatchdog` / `resumeIdleWatchdog`', '`() => void`', '等人期间关掉看门狗，务必 `try/finally`'],
        ],
      },
      { t: 'h2', text: 'steering 与回执' },
      {
        t: 'p',
        md:
          '`steer()` 是插队、`followUp()` 是排队；两者都只入队，真正写进历史发生在引擎的接收点。' +
          '想知道文本到底进去了没有，看 `steering_accepted`：它携带宿主生成的不透明 ID，' +
          '代表历史已接收，**不代表模型请求成功或回答完成**。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '带 ID 的 steering',
        code: [
          "import type { Agent } from '@aragon-agent/core';",
          'declare const agent: Agent;',
          'const stop = agent.subscribe((event) => {',
          "  if (event.type === 'steering_accepted') console.log(event.ids.join(','));",
          '});',
          "agent.steer('先别动 vendor/ 目录', 'host-42');",
          "agent.followUp('最后把改动列成清单');",
          "await agent.prompt('重构 src/parser.ts');",
          'stop();',
        ].join('\n'),
      },
      { t: 'h2', text: '空闲看门狗与“在等人”' },
      {
        t: 'p',
        md:
          '看门狗只在 `idleTimeout` 内没有任何事件时中止运行。重试退避与压缩由引擎自己暂停它；' +
          '第三类只有宿主知道：**工具在等一个人回答**。那看起来和卡死的网络调用一模一样。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '等人期间暂停（务必 try/finally）',
        code: [
          "import type { Agent } from '@aragon-agent/core';",
          'declare function promptOnStdin(question: string): Promise<string>;',
          '',
          'async function askHuman(agent: Agent, question: string): Promise<string> {',
          '  agent.pauseIdleWatchdog();',
          '  try {',
          '    return await promptOnStdin(question);',
          '  } finally {',
          '    agent.resumeIdleWatchdog();',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '两个幂等的时钟操作要成对',
        md:
          '`pauseIdleWatchdog()` 连 `kick()` 一起吞掉，等待期间到达的事件不会把它重新拉起；' +
          '`resumeIdleWatchdog()` 从「现在」重新计时。只 pause 不 resume，这一轮就再也没有上限。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '状态是只读视图，不是快照',
        md: '`agent.state.messages` 返回内部数组（类型上 `readonly`）。要留存历史请自己拷贝；压缩端口拿到的才是浅拷贝。',
      },
    ],
  },

  {
    id: 'api/tools',
    title: '工具定义与执行',
    group: 'api',
    order: 30,
    phase: 'A',
    template: 'api',
    summary:
      '工具的完整形状：八个字段、一个 `execute` 契约、四个结果工厂，以及为什么超时只能靠工具自己订阅 `context.signal` 才生效。',
    keywords: ['AgentTool', 'defineTool', 'ToolExecutor', 'ToolRegistry', 'HOST_TOOL_NAMES'],
    seeAlso: ['api/agent', 'tools/index', 'api/sandbox'],
    sourceRefs: [
      { path: 'packages/core/src/tools/types.ts', lines: '122-158', snippet: 'export interface AgentTool<TParams = Record<string, unknown>> {' },
      { path: 'packages/core/src/tools/types.ts', lines: '73-99', snippet: 'export interface ToolExecutionContext {' },
      { path: 'packages/core/src/tools/helpers.ts', lines: '110-124', snippet: 'export function defineTool<TParams = Record<string, unknown>>(' },
      { path: 'packages/core/src/tools/helpers.ts', lines: '20-42', snippet: 'export function textResult(text: string): ToolResult {' },
      { path: 'packages/cli/src/tools/index.ts', lines: '500-528', snippet: 'export const HOST_TOOL_NAMES = [' },
    ],
    importLine:
      "import { defineTool, textResult, errorResult, multiResult, ToolRegistry, ToolExecutor, type AgentTool } from '@aragon-agent/core';",
    signature: [
      'interface AgentTool<TParams = Record<string, unknown>> {',
      '  name: string; label: string; description: string;',
      '  parameters: JSONSchema7;',
      '  execute: (toolCallId: string, params: TParams, context: ToolExecutionContext)',
      '    => Promise<ToolResult>;',
      '  tags?: string[]; bridgeable?: boolean; bridgeName?: string;',
      '}',
      '',
      'interface ToolExecutionContext {',
      '  signal?: AbortSignal;',
      '  onProgress?: (update: ToolProgressUpdate) => void;',
      "  abortCause?: 'timeout' | 'external';",
      '}',
      '',
      'interface ToolResult { content: ToolResultContent[]; isError?: boolean }',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '一个工具就是一份自包含的声明：模型看到 `name` / `description` / `parameters`，人看到 `label`，引擎调用 `execute`。' +
          '没有基类、没有装饰器、没有全局注册 —— 放进 `AgentConfig.tools` 就够了。',
      },
      { t: 'h2', text: '`AgentTool` 的八个字段' },
      {
        t: 'params',
        caption: '前五个必填；后三个只影响 CodeAct 沙箱',
        items: [
          { name: 'name', type: 'string', required: true, desc: '唯一标识，也是模型调用时的函数名。建议 snake_case。' },
          { name: 'label', type: 'string', required: true, desc: '给人看的短名（UI 与日志），不参与模型请求。' },
          { name: 'description', type: 'string', required: true, desc: '原样进入模型请求。写清「什么时候该调它」比「它做什么」更重要。' },
          {
            name: 'parameters',
            type: 'JSONSchema7',
            required: true,
            desc: 'JSON Schema 7；约定 `type: \'object\'`，没有 `required` 时全部属性可选。',
          },
          {
            name: 'execute',
            type: 'ToolExecuteFn<TParams>',
            required: true,
            desc: '返回 `ToolResult`；失败用 `isError: true`，不要抛。',
          },
          { name: 'tags', type: 'string[]', desc: '分类标签（`filesystem`、`network`），宿主用来过滤，引擎不解释。' },
          { name: 'bridgeable', type: 'boolean', desc: '为 `true` 时注入 CodeAct 沙箱成为可 await 的全局函数，默认 `false`。' },
          { name: 'bridgeName', type: 'string', desc: '沙箱里的函数名，默认等于 `name`；习惯写成驼峰。' },
        ],
      },
      { t: 'h2', text: '`defineTool`：少写样板' },
      {
        t: 'code',
        lang: 'ts',
        title: '一个订阅 abort 的工具',
        code: [
          "import { defineTool, errorResult, textResult } from '@aragon-agent/core';",
          'interface ReadSectionParams { path: string; startLine: number; maxLines?: number }',
          'declare function readLines(params: ReadSectionParams): Promise<string[]>;',
          '',
          'const readSection = defineTool<ReadSectionParams>({',
          "  name: 'read_section',",
          "  label: 'Read section',",
          "  description: 'Read at most maxLines lines of a UTF-8 file, starting at startLine.',",
          '  parameters: {',
          "    type: 'object',",
          "    properties: { path: { type: 'string' }, startLine: { type: 'number', minimum: 1 } },",
          "    required: ['path', 'startLine'],",
          '    additionalProperties: false,',
          '  },',
          "  tags: ['filesystem', 'read-only'],",
          '  async execute(toolCallId, params, context) {',
          '    const cancelled = new Promise<never>((_resolve, reject) => {',
          "      context.signal?.addEventListener(",
          "        'abort',",
          '        () => reject(new Error(context.abortCause ?? \'external\')),',
          '        { once: true },',
          '      );',
          '    });',
          '    const lines = await Promise.race([readLines(params), cancelled]);',
          "    return lines.length === 0 ? errorResult(`${toolCallId}: empty`) : textResult(lines.join('\\n'));",
          '  },',
          '});',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '四个结果工厂够用了',
        md:
          '`textResult(text)`、`errorResult(message)`（自动加 `Error: ` 前缀并置 `isError`）、`imageResult(mediaType, data)`、' +
          '`multiResult(blocks, isError?)`。手写 `{ content: [...] }` 只会在将来加字段时漏掉一处。',
      },
      { t: 'h2', text: '执行契约：取消、进度与超时' },
      {
        t: 'ul',
        items: [
          '**`context.signal` 是唯一的取消通道。** 超时与用户中断都表现为一次 `abort`；不订阅就停不下来。',
          '**`context.abortCause` 说明原因。** `timeout` 值得建议重试或改后台运行，`external` 不该被建议重试。',
          '**`context.onProgress` 可选。** 长任务调它，宿主才知道你在推进；不调不会有人报错。',
          '**`execute` 不该抛。** 抛出的异常会被执行器兜住转成错误结果，但你写的错误信息就丢了。',
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '默认超时对“不听话”的工具是空操作',
        md:
          '`ToolExecutor` 没有 `Promise.race`：`abort()` 之后仍然 `await` 你的 promise。一个从不读 signal 的工具可以无限期挂着，' +
          '而 `toolTimeout` 一直是 120 秒。上面的写法（race + 一次性 abort 监听）是唯一可靠的形态。',
      },
      { t: 'h2', text: '`HOST_TOOL_NAMES` 与只读 / 变更' },
      {
        t: 'p',
        md:
          '`HOST_TOOL_NAMES` 是 CLI 的能力**全集**常量：它列出这个宿主能够注册的全部工具名，不等于当前会话真的注册了哪些。' +
          '它回答的是「技能声明的 `allowed-tools` 能不能真的生效」，所以功能关闭时不注册的名字也照样在表里。',
      },
      {
        t: 'table',
        caption: `CLI 的 ${tools.length} 个内置工具：变更标记决定它能不能被只读模式关掉`,
        head: ['工具', '变更', '用途', '依据'],
        rows: tools.map((tool) => [
          `\`${tool.name}\``,
          tool.mutating ? '**变更**' : '只读',
          tool.summary,
          `\`${tool.source.path}:${tool.source.lines}\``,
        ]),
      },
      {
        t: 'p',
        md:
          '只读 / 变更的分界不在 Core：被拒绝的工具**根本不会被注册**，模型因此不会围绕它做计划。' +
          '细节见 [权限模式与工具白名单](/exec/permissions/) 与 [工具总览](/tools/index/)。',
      },
    ],
  },

  {
    id: 'api/events',
    title: '事件与订阅',
    group: 'api',
    order: 40,
    phase: 'B',
    template: 'api',
    summary:
      '引擎发出的 12 种 `AgentEvent`、它们携带的 `StreamEvent`、订阅与退订的唯一写法，以及它与 CLI 侧 29 种 `ExecEvent` 的分工。',
    keywords: ['AgentEvent', 'StreamEvent', 'subscribe', 'message_update', 'ExecEvent'],
    seeAlso: ['exec/events', 'api/agent', 'api/limits'],
    sourceRefs: [
      { path: 'packages/core/src/types.ts', lines: '134-147', snippet: 'export type AgentEvent =' },
      { path: 'packages/core/src/types.ts', lines: '46-49', snippet: 'export interface MessageUpdateEvent {' },
      { path: 'packages/core/src/types.ts', lines: '99-132', snippet: 'export interface CompactionEndEvent {' },
      { path: 'packages/core/src/llm/types.ts', lines: '212-223', snippet: 'export type StreamEvent =' },
      { path: 'packages/cli/src/exec/events.ts', lines: '832-861', snippet: 'export type ExecEvent =' },
      { path: 'packages/core/src/engine/agent.ts', lines: '361-379', snippet: 'private emit(event: AgentEvent): void {' },
    ],
    importLine: "import { Agent, type AgentEvent, type AgentEventListener, type StreamEvent } from '@aragon-agent/core';",
    signature: [
      'type AgentEvent =',
      "  | { type: 'agent_start' }",
      "  | { type: 'agent_end'; messages: Message[] }",
      "  | { type: 'turn_start' }",
      "  | { type: 'turn_end'; message: AssistantMessage; usage: TokenUsage }",
      "  | { type: 'steering_accepted'; ids: readonly string[] }",
      "  | { type: 'message_update'; streamEvent: StreamEvent }",
      "  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }",
      "  | { type: 'tool_execution_end'; toolCallId: string; toolName: string;",
      '      result: ToolResult; isError: boolean; duration: number }',
      "  | { type: 'code_execution_start'; code: string; language: string }",
      "  | { type: 'code_execution_end'; output: string; error?: string; duration: number }",
      "  | { type: 'compaction_start'; trigger: CompactionTrigger; messageCount: number }",
      "  | { type: 'compaction_end'; applied: boolean; mode: 'summarized' | 'truncated' | 'none';",
      '      reason?: string; messagesBefore: number; messagesAfter: number;',
      '      droppedMessages: number; estimatedTokensBefore: number;',
      '      estimatedTokensAfter: number; durationMs: number }',
      '',
      'type AgentEventListener = (event: AgentEvent) => void;',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '事件是引擎唯一的外向通道：`prompt()` 只返回 `Promise<void>`，回合里发生了什么全部靠事件流表达。' +
          '这也解释了为什么 `agent_end` 在 `finally` 里发 —— 它是「这一轮结束了」的唯一信号。',
      },
      { t: 'h2', text: '两套事件：`AgentEvent` 与 `StreamEvent`' },
      {
        t: 'p',
        md:
          '`AgentEvent` 是**生命周期**，`StreamEvent` 是**词元**。后者不会单独发出来，它被包在 `message_update` 里：' +
          '`{ type: \'message_update\', streamEvent }`。所以监听器订阅一次，再按 `streamEvent.type` 分支即可。',
      },
      {
        t: 'table',
        caption: '12 种 `AgentEvent`',
        head: ['事件', '关键字段', '什么时候发'],
        rows: [
          ['`agent_start`', '—', '每次 `prompt()` / `continue()` 的最开头'],
          ['`agent_end`', '`messages`', '`finally` 里必发，含历史快照'],
          ['`turn_start`', '—', '每个回合发请求之前（压缩检查点之后）'],
          ['`turn_end`', '`message`、`usage`', '收到 `done` 之后，携带累计用量'],
          ['`steering_accepted`', '`ids`', '一批 steering 同步写入历史之后'],
          ['`message_update`', '`streamEvent`', '适配器每产出一个流事件'],
          ['`tool_execution_start`', '`toolCallId`、`toolName`、`args`', '工具开始执行'],
          ['`tool_execution_end`', '`result`、`isError`、`duration`', '工具结束（含错误）'],
          ['`code_execution_start` / `code_execution_end`', '`code` / `output`、`error`', 'CodeAct 代码块开始与结束'],
          ['`compaction_start`', '`trigger`、`messageCount`', '压缩即将开始（会暂停看门狗）'],
          ['`compaction_end`', '`applied`、`mode`、`reason` 等', '`finally` 里必发，恢复看门狗'],
        ],
      },
      { t: 'h2', text: '订阅、退订与监听器安全' },
      {
        t: 'p',
        md:
          '`subscribe(listener)` 返回退订函数，没有 `off()` 方法。监听器抛出的异常会被逐个捕获并打到 `console.error`，' +
          '不会中断循环 —— 但这意味着**写错的监听器是静默失效的**。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '按事件类型分派',
        code: [
          "import type { Agent, AgentEvent } from '@aragon-agent/core';",
          'declare const agent: Agent;',
          '',
          "const counts = new Map<AgentEvent['type'], number>();",
          'const unsubscribe = agent.subscribe((event) => {',
          '  counts.set(event.type, (counts.get(event.type) ?? 0) + 1);',
          '  switch (event.type) {',
          "    case 'message_update':",
          "      if (event.streamEvent.type === 'retry_scheduled') {",
          '        console.log(`第 ${event.streamEvent.attempt} 次重试 @ ${event.streamEvent.resumeAt}`);',
          '      }',
          '      break;',
          "    case 'tool_execution_end':",
          '      console.log(`${event.toolName} ${event.isError ? \'失败\' : \'成功\'} ${event.duration}ms`);',
          '      break;',
          "    case 'compaction_end':",
          '      console.log(`compaction applied=${event.applied} reason=${event.reason ?? \'-\'}`);',
          '      break;',
          '    default:',
          '      break;',
          '  }',
          '});',
          "await agent.prompt('整理 src/index.ts 的导出清单');",
          'unsubscribe();',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'note',
        title: '`resumeAt` 是绝对时刻，不是倒计时',
        md:
          '重试只发一次 `retry_scheduled`，带 `resumeAt`（epoch 毫秒）。引擎不会按秒推进度条：' +
          '那会是每次重试序列几百个事件，还会把渲染节奏写进库里。倒计时由你按自己的时钟算。',
      },
      { t: 'h2', text: '`AgentEvent` 与 CLI 的 `ExecEvent`' },
      {
        t: 'p',
        md:
          '两者长得像，但**不是同一层**。`AgentEvent` 是进程内类型化回调，消费者是宿主代码；' +
          '`ExecEvent` 是 `aragon exec` 写到 stdout 的 JSON 行，消费者是别的进程，必须自带 `seq` 与 `schemaVersion`。' +
          '多出的 17 个成员全是宿主概念（`todo`、`team`、`fast_*`、`job`、`ack`、`decision_*`、`hook_*`、`thread_state`），' +
          '而它**永远**不会成为 `AgentEvent` 的成员 —— 一个被 `public-api.test.ts` 冻结，一个被 `no-host-coupling.test.ts` 禁止。' +
          '清单见 [事件参考](/exec/events/)。',
      },
      {
        t: 'table',
        caption: '同一个回合的两种投影',
        head: ['维度', '`AgentEvent`', '`ExecEvent`'],
        rows: [
          ['传输', '进程内函数调用', 'stdout 上的一行 JSON'],
          ['成员数', '12', '29'],
          ['版本化', '无（跟着 core 的包版本走）', '`schemaVersion`，当前为 1'],
          ['谁能加成员', '不新增运行时导出即可', '只能加事件/字段，不能改名或删除'],
        ],
      },
      { t: 'h2', text: '看门狗策略由事件驱动' },
      {
        t: 'p',
        md:
          '`emit()` 的顺序是刻意的：先应用看门狗策略、再通知监听器、最后 `kick()`。所以即使某个监听器抛错，暂停/恢复也已经生效。',
      },
      {
        t: 'ul',
        items: [
          '`compaction_start` → 暂停，`compaction_end` → 恢复；后者从 `finally` 发出，这一对不会缺一个。',
          '`message_update` 里 `streamEvent.type === \'retry_scheduled\'` → 暂停，`\'retry_attempt\'` → 恢复。',
          '运行结束时 `watchdog.stop()` 会清掉 `paused`，中止发生在等待中途也不会让下一次运行「失聪」。',
        ],
      },
    ],
  },

  {
    id: 'api/providers',
    title: 'Provider 与模型',
    group: 'api',
    order: 50,
    phase: 'B',
    template: 'api',
    summary:
      '三个内置 provider、`ProviderRegistry` 的注册与派发、API key 的三层解析顺序、base URL 的覆盖点，以及单例为什么可能和你的策略不一致。',
    keywords: ['ProviderRegistry', 'initProviders', 'LLMProvider', 'apiKey', 'baseUrl'],
    seeAlso: ['config/env', 'guide/models', 'api/limits'],
    sourceRefs: [
      { path: 'packages/core/src/llm/providers/index.ts', lines: '30-58', snippet: 'export class ProviderRegistry {' },
      {
        path: 'packages/core/src/llm/providers/index.ts',
        lines: '165-178',
        snippet: 'export function initProviders(options?: ProviderRegistryOptions): ProviderRegistry {',
      },
      {
        path: 'packages/core/src/llm/providers/index.ts',
        lines: '186-215',
        snippet: 'export function getProviderRegistry(): ProviderRegistry {',
      },
      { path: 'packages/core/src/llm/provider.ts', lines: '31-87', snippet: 'export interface LLMRequest {' },
      { path: 'packages/cli/src/config/env.ts', lines: '63-68', snippet: "anthropic: ['ANTHROPIC_API_KEY']," },
      { path: 'packages/cli/src/config/load.ts', lines: '1304', snippet: 'export function makeGetApiKey(' },
    ],
    importLine:
      "import { ProviderRegistry, initProviders, getProviderRegistry, setProviderRegistry, streamLLM, DEFAULT_RETRY_POLICY } from '@aragon-agent/core';",
    signature: [
      'class ProviderRegistry {',
      '  constructor(options?: { retryPolicy?: RetryPolicy | null });',
      '  register(provider: LLMProvider): void;',
      '  get(id: string): LLMProvider | undefined;',
      '  has(id: string): boolean;',
      '  setRetryPolicy(policy: RetryPolicy | null): void;',
      '  getRetryPolicy(): RetryPolicy | null;',
      '  stream(providerId: string, request: LLMRequest): AsyncIterableIterator<StreamEvent>;',
      '  complete(providerId: string, request: LLMRequest): Promise<AssistantMessage>;',
      '  listModels(providerId: string, apiKey: string, baseUrl?: string): Promise<ModelInfo[]>;',
      '  getDefaultBaseUrl(providerId: string): string;',
      '}',
      '',
      'interface LLMProvider {',
      '  readonly id: string; readonly displayName: string; readonly defaultBaseUrl: string;',
      '  stream(request: LLMRequest): AsyncIterableIterator<StreamEvent>;',
      '  complete(request: LLMRequest): Promise<AssistantMessage>;',
      '  listModels(apiKey: string, baseUrl?: string, signal?: AbortSignal): Promise<ModelInfo[]>;',
      '}',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '适配器只做一件事：把通用 `LLMRequest` 翻成厂商的 HTTP 请求，再把响应翻回通用 `StreamEvent`。' +
          '`ProviderRegistry` 按 `provider.id` 分发，并把每一次 `stream()` 包进重试阶梯。',
      },
      { t: 'h2', text: '三个内置 provider' },
      {
        t: 'table',
        caption: '`initProviders()` 注册的全部适配器',
        head: ['`id`', '类', '默认 base URL', '宿主常用的环境变量'],
        rows: [
          ['`anthropic`', '`AnthropicProvider`', '`https://api.anthropic.com`', '`ANTHROPIC_API_KEY`'],
          ['`openai`', '`OpenAIProvider`', '`https://api.openai.com/v1`', '`OPENAI_API_KEY`'],
          [
            '`google`',
            '`GoogleProvider`',
            '`https://generativelanguage.googleapis.com`',
            '`GOOGLE_API_KEY`，其次 `GEMINI_API_KEY`',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '模型 id 不做白名单',
        md:
          '注册表只管 provider。模型 id 只是一个字符串：拼错不会被拦下，只会由厂商在第一次请求时返回 400/404。' +
          '需要上下文窗口、定价等元数据请用 `ModelRegistry`，见 [上下文窗口与模型表](/config/context-window/)。',
      },
      { t: 'h2', text: 'API key 的解析顺序' },
      {
        t: 'p',
        md:
          'Core **不读环境变量**：它只调用你传进 `AgentConfig.getApiKey` 的函数，把结果填到 `LLMRequest.apiKey`。' +
          '所以「顺序」是宿主的概念。CLI 作为参考实现是这样排的：',
      },
      {
        t: 'ol',
        items: [
          '一次性 `--api-key`：只对**当前** provider 生效，不写盘、不跨 provider 复用。',
          '配置文件里的 `apiKeys[providerId]`（`aragon config set apiKeys.anthropic …`）。',
          '环境变量：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`，`google` 再回退 `GEMINI_API_KEY`。',
          '都没有时返回 `undefined`：Core 把这次请求当普通失败，CLI 的 `preflight()` 提前给退出码 2。',
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '把顺序写进一个函数',
        md:
          '别把 key 查找散在三处。CLI 的 `makeGetApiKey(config)` 返回一个纯函数，`Agent` 与 `preflight()` 共用它 —— ' +
          '于是「说没 key 却又能跑」这类问题只有一个答案。',
      },
      { t: 'h2', text: 'base URL 与重试策略' },
      {
        t: 'table',
        caption: 'base URL 三层，从近到远',
        head: ['层', '取值', '典型用途'],
        rows: [
          ['请求级', '`LLMRequest.baseUrl`', '由 `AgentConfig.model.baseUrl` 透传，代理/网关按会话切换'],
          ['注册表默认', '`registry.getDefaultBaseUrl(providerId)`', '适配器自带的官方地址'],
          ['环境', '`ARAGON_BASE_URL` 等', 'CLI 读进 `config.baseUrl`，再作为 `ModelRef.baseUrl` 传入'],
        ],
      },
      {
        t: 'code',
        lang: 'ts',
        title: '四种构造方式，语义各不相同',
        code: [
          "import { DEFAULT_RETRY_POLICY, ProviderRegistry, initProviders, setProviderRegistry } from '@aragon-agent/core';",
          '',
          'const withRetry = initProviders();                                    // 产品默认',
          'const noRetry = initProviders({ retryPolicy: null });                 // 明确说不',
          'const tuned = initProviders({ retryPolicy: { ...DEFAULT_RETRY_POLICY, maxRetries: 3 } });',
          '',
          'tuned.setRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxRetries: 0 }); // 运行中改（/retry off）',
          'setProviderRegistry(tuned);                                      // 让单例也用同一策略',
          '',
          'const custom = new ProviderRegistry({ retryPolicy: null });      // 空表 + 自己的 provider',
          'declare const myProvider: LLMProvider;',
          'custom.register(myProvider);',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '单例不观察你自己那个 registry',
        md:
          '`getProviderRegistry()` 是**独立**的懒加载单例，永远带 `DEFAULT_RETRY_POLICY`；`streamLLM()` / `completeLLM()` 走的就是它。' +
          '要一个策略管全局，启动时调一次 `setProviderRegistry(initProviders({ retryPolicy }))`。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '未知 provider 是显式错误',
        md:
          '`stream()` / `complete()` / `listModels()` 解析不到 provider 时抛 `LLMError`（`invalid_request`，`retryable: false`），' +
          '消息里列出已注册的 id。它不会被重试 —— 名字拼错，重试一百次也一样。',
      },
    ],
  },

  {
    id: 'api/limits',
    title: '输出上限与重试',
    group: 'api',
    order: 60,
    phase: 'B',
    template: 'api',
    summary:
      '输出上限的六个常量与 `resolveOutputTokens` 的夹取顺序、一次性恢复怎么修掉 400，以及默认开启的十次重试阶梯和它的四个结构边界。',
    keywords: ['maxTokens', 'resolveOutputTokens', 'withRetry', 'RETRY_LIMITS', 'Retry-After'],
    seeAlso: ['api/providers', 'config/reference', 'exec/budgets'],
    sourceRefs: [
      { path: 'packages/core/src/llm/output-limits.ts', lines: '29-48', snippet: 'export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;' },
      { path: 'packages/core/src/llm/output-limits.ts', lines: '175-199', snippet: 'export interface OutputLimitInput {' },
      {
        path: 'packages/core/src/llm/output-limits.ts',
        lines: '250-258',
        snippet: 'export function resolveOutputTokens(input: OutputLimitInput): OutputLimitResolution {',
      },
      {
        path: 'packages/core/src/llm/output-limit-recovery.ts',
        lines: '328-355',
        snippet: 'export async function sendWithOutputLimitRecovery(opts: RecoveryOptions): Promise<RecoveryAttempt> {',
      },
      { path: 'packages/core/src/llm/retry.ts', lines: '46-60', snippet: 'export const RETRY_LIMITS = {' },
      { path: 'packages/core/src/llm/retry.ts', lines: '83-111', snippet: 'export const DEFAULT_RETRY_POLICY: RetryPolicy = {' },
      {
        path: 'packages/core/src/llm/retry.ts',
        lines: '217-240',
        snippet: 'export function isRetryableError(err: unknown, signal?: AbortSignal): RetryDecision {',
      },
    ],
    importLine:
      "import { resolveOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, sendWithOutputLimitRecovery, withRetry, DEFAULT_RETRY_POLICY, RETRY_LIMITS } from '@aragon-agent/core';",
    signature: [
      'interface OutputLimitInput {',
      '  providerId: string; modelId: string;',
      '  requested?: number;',
      '  modelLimits?: { maxOutputTokens?: number; contextWindow?: number };',
      '  thinkingBudget?: number; estimatedPromptTokens?: number;',
      '}',
      '',
      'interface OutputLimitResolution {',
      '  value: number;                          // 永远 >= MIN_MAX_OUTPUT_TOKENS',
      '  ceiling?: number;',
      "  source: 'requested' | 'auto';",
      "  clampedBy?: 'ceiling' | 'context' | 'absolute';",
      '  thinkingBudget?: number;                // 0 = 整块 thinking 都不发',
      '}',
      '',
      'function resolveOutputTokens(input: OutputLimitInput): OutputLimitResolution;',
      'function sendWithOutputLimitRecovery(opts: RecoveryOptions): Promise<RecoveryAttempt>;',
      '',
      'interface RecoveryAttempt {',
      '  response: Response;',
      '  bodyText: string;                        // 已读过一次，别再次 .text()',
      '  adjustment?: { from: number; to: number; reason: OutputLimitFailure[\'kind\'] };',
      '}',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '无条件发一个大 `max_tokens` 只对上限足够大的模型安全。三家厂商都会用 400 回敬过大的上限，而循环里的 400 会结束回合。' +
          '所以规则是：**默认值是意愿，模型真实上限是法律**，差距静默抹平而不是让运行失败。',
      },
      { t: 'h2', text: '六个常量' },
      {
        t: 'table',
        caption: '全部来自 `llm/output-limits.ts`；包内其它地方不许再写这些数字',
        head: ['常量', '值', '含义'],
        rows: [
          ['`DEFAULT_MAX_OUTPUT_TOKENS`', '`64000`', '产品默认；AUTO 永远不超过它'],
          ['`MIN_MAX_OUTPUT_TOKENS`', '`256`', '地板：再低一个回合连可用的工具调用都产不出'],
          ['`SAFE_FALLBACK_MAX_OUTPUT_TOKENS`', '`8192`', '恢复时解析不出真实上限就用它'],
          ['`ABSOLUTE_MAX_OUTPUT_TOKENS`', '`200000`', '手改配置的理智上限'],
          ['`THINKING_HEADROOM_TOKENS`', '`4096`', '保证 Anthropic 的 `max_tokens > budget_tokens`'],
          ['`CONTEXT_SAFETY_MARGIN_TOKENS`', '`1024`', '给「故意粗糙」的 prompt 估计留的余量'],
        ],
      },
      { t: 'h2', text: '`resolveOutputTokens` 的七步' },
      {
        t: 'p',
        md:
          '上限来源四个，优先级 `learned-from-error` > discovery > 静态表 > `64000`。下面这个夹取顺序是规范，不是实现细节：',
      },
      {
        t: 'ol',
        items: [
          '`ceiling = learned ?? modelLimits.maxOutputTokens ?? staticCeilingFor(...)`。',
          '意愿值 = `requested ?? 64000`。**AUTO 不超过产品默认**，哪怕模型允许 100000（OpenAI 把它算进上下文窗口）。',
          '按 `ceiling` 向下夹 → `clampedBy: \'ceiling\'`。',
          '仅 OpenAI 且两个值都给齐时，保证 `max_tokens + prompt <= context - 1024` → `clampedBy: \'context\'`。',
          '按 `ABSOLUTE_MAX_OUTPUT_TOKENS` 夹 → `clampedBy: \'absolute\'`。',
          '保持 `max_tokens > thinking.budget_tokens`：能抬就抬上限，抬不动就降预算，连 1024 地板都装不下时返回 `thinkingBudget: 0`。',
          '按 `MIN_MAX_OUTPUT_TOKENS` 落地板。',
        ],
      },
      {
        t: 'code',
        lang: 'ts',
        title: '看一次真实的夹取结果',
        code: [
          "import { resolveOutputTokens } from '@aragon-agent/core';",
          '',
          'const resolution = resolveOutputTokens({',
          "  providerId: 'anthropic',",
          "  modelId: 'claude-3-5-sonnet-20241022',",
          '  modelLimits: { maxOutputTokens: 8_192, contextWindow: 200_000 },',
          '  thinkingBudget: 10_240,',
          '});',
          '',
          'console.log(resolution.value);          // 8192：被模型真实上限夹住',
          'console.log(resolution.clampedBy);      // ceiling',
          'console.log(resolution.thinkingBudget); // 4096：8192 装不下 10240 的预算',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '`thinkingBudget: 0` 是“别发这一块”',
        md:
          'Anthropic 的 `budget_tokens` 有 1024 硬地板，发更小的值是非法请求。所以装不下时返回 `0`，适配器据此完全省略 `thinking` 字段。' +
          '把 `0` 当成「等于 0 的预算」发出去会换来一个 400。',
      },
      { t: 'h2', text: '一次性恢复：`sendWithOutputLimitRecovery`' },
      {
        t: 'ul',
        items: [
          '**2xx 立刻返回，body 不读。** 流式响应必须完整交给 SSE 解析器；偷看一眼 `bodyUsed` 就变 `true`。',
          '**非 2xx 只读一次 body**，作为 `RecoveryAttempt.bodyText` 交回；再次 `.text()` 会抛 `TypeError: Body is unusable`。',
          '**只在输出上限类 400 上修一次**，绝不循环；学到的东西（真实上限或 token 字段方言）记进进程级 map。',
          '**第二次失败原样上浮。** 恢复只负责把一次本可避免的失败变成成功。',
        ],
      },
      {
        t: 'code',
        lang: 'ts',
        title: '包一层 fetch，让它自己去修',
        code: [
          "import { sendWithOutputLimitRecovery } from '@aragon-agent/core';",
          '',
          'const attempt = await sendWithOutputLimitRecovery({',
          "  providerId: 'openai',",
          "  modelId: 'gpt-4o',",
          "  body: { model: 'gpt-4o', max_tokens: 64_000, messages: [] },",
          "  tokenField: 'max_tokens',",
          '  send: (body) =>',
          "    fetch('https://api.openai.com/v1/chat/completions', {",
          "      method: 'POST',",
          "      headers: { 'content-type': 'application/json' },",
          '      body: JSON.stringify(body),',
          '    }),',
          '});',
          '',
          'if (!attempt.response.ok) throw new Error(attempt.bodyText); // 复用 bodyText',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '两个 learned map 是进程级的，测试必须清',
        md:
          '`learnModelCeiling` 与 `learnTokenField` 写模块级状态，永不持久化。任何让它们学到东西的测试都必须在 `afterEach` 里调' +
          ' `clearLearnedCeilings()` / `clearLearnedTokenFields()`，否则一个学到 8192 的用例会污染下一个文件。',
      },
      { t: 'h2', text: '重试：默认就是开的' },
      {
        t: 'p',
        md:
          '`ProviderRegistry.stream()` 把每次调用包进 `withRetry`，`complete()` 又走 `stream()`，于是主代理、每个子代理、' +
          '所有 provider 都零改动获得重试。默认十次重试、`1 s → 2 → 4 → 8 → 16 → 30 s` 等抖动阶梯、`240 s` 预算。',
      },
      {
        t: 'table',
        caption: '`RETRY_LIMITS`：机制能做什么，不是用户策略',
        head: ['字段', '值', '含义'],
        rows: [
          ['`hardMaxRetries`', '`20`', '任何一层传进来的 `maxRetries` 都夹到不超过它'],
          ['`absoluteMaxDelayMs`', '`120_000`', '单次等待的硬上限'],
          ['`retryAfterCeilingMs`', '`60_000`', '更大的 `Retry-After` 不等待，直接带厂商数字上浮'],
          ['`minDelayMs`', '`100`', '抖动后的地板，避免出现 0 ms 的「重试」'],
        ],
      },
      {
        t: 'ul',
        items: [
          '**会重试：** `rate_limit`（429）、`overloaded`（529）、`server_error`（5xx）、`network_error`、`timeout`（408）。',
          '**不会重试：** `auth_error`、`invalid_request`、`context_overflow`、`unknown`。',
          '**中止永远不是重试。** `wrapFetchError` 把 `AbortError` 标成 `retryable: true`，所以 `isRetryableError` **先**看 `signal.aborted`。',
          '**`Retry-After` 是下限不是替代。** 第九次重试时来的 `Retry-After: 1` 不会撤销前八次退避。',
          '**内容流出后的重启被支持**，并发 `stream_restart` 带 `discardedToolCallIds`；不想要就设 `onPartialStream: false`。',
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '半开连接不在覆盖范围内',
        md:
          '既没有 FIN 也没有 RST、只是不再送字节的 socket 不产生任何事件，`withRetry` 因此永远不醒；兜底的是空闲看门狗。' +
          '在这一层加停滞计时器并不安全：Anthropic 的 `ping` 帧被适配器吃掉了，长思考停顿与死连接无法区分。',
      },
    ],
  },

  {
    id: 'api/compaction',
    title: '上下文压缩端口',
    group: 'api',
    order: 70,
    phase: 'B',
    template: 'api',
    summary:
      '压缩是一个注入端口：`shouldCompact` 同步判断、`compact` 异步接管；四个纯函数让宿主与引擎用同一套规则判断哪里能切、切完还能不能发。',
    keywords: ['ContextManager', 'planCompaction', 'findSafeCutIndices', 'relieveTail', 'validateHistory'],
    seeAlso: ['guide/context', 'api/agent', 'config/context-window'],
    sourceRefs: [
      { path: 'packages/core/src/engine/context-manager.ts', lines: '64-97', snippet: 'export interface ContextManager {' },
      {
        path: 'packages/core/src/engine/compaction.ts',
        lines: '33-61',
        snippet: 'export function findSafeCutIndices(messages: readonly Message[]): number[] {',
      },
      { path: 'packages/core/src/engine/compaction.ts', lines: '147', snippet: 'export function planCompaction(' },
      { path: 'packages/core/src/engine/compaction.ts', lines: '222', snippet: 'export function validateHistory(' },
      { path: 'packages/core/src/engine/compaction.ts', lines: '303', snippet: 'export function relieveTail(' },
      { path: 'packages/core/src/engine/agent-loop.ts', lines: '400-420', snippet: "ctx.emit({ type: 'turn_start' });" },
      { path: 'packages/core/src/types.ts', lines: '80-98', snippet: 'export interface CompactionStartEvent {' },
    ],
    importLine:
      "import { planCompaction, findSafeCutIndices, relieveTail, validateHistory, type ContextManager } from '@aragon-agent/core';",
    signature: [
      'interface ContextManager {',
      '  shouldCompact(probe: CompactionProbe): boolean;   // 同步、便宜、无副作用',
      '  compact(ctx: CompactionContext): Promise<CompactionOutcome>;',
      '}',
      '',
      'interface CompactionProbe {',
      '  readonly messageCount: number;',
      '  readonly lastUsage?: TokenUsage;                  // 第一次请求前是 undefined',
      '  readonly turnIndex: number;',
      "  readonly trigger: 'pressure' | 'overflow';",
      '}',
      '',
      'interface CompactionContext extends CompactionProbe {',
      '  readonly messages: readonly Message[];            // 浅拷贝',
      '  readonly systemPrompt: string;',
      '  readonly model: ModelRef;',
      '  readonly signal: AbortSignal;',
      '}',
      '',
      'type CompactionOutcome =',
      "  | { action: 'keep'; reason: string }",
      "  | { action: 'replace'; messages: Message[]; mode: 'summarized' | 'truncated';",
      '      summary?: string; reason?: string };',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '长跑会话迟早填满上下文窗口，然后以一个 400 结束。引擎的回答是**只提供一个端口**：在每个回合边界' +
          '（steering 排空之后、`turn_start` 之前）问一次 `ContextManager` 要不要压缩，要的话把历史副本交给它，再采纳它交回来的东西。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '机制在库里，策略在库外',
        md:
          '本包没有 `ModelInfo` 也刻意不去学：阈值多少、哪个模型总结、摘要写成什么样、失败之后怎么办，全部是端口另一侧的决定。',
      },
      { t: 'h2', text: '两个方法，两种时间尺度' },
      {
        t: 'p',
        md:
          '`shouldCompact` 是**同步**的：一个异步端口会在每次运行、每个回合上压一个微任务与一个 promise 分配，' +
          '而这个判断 99% 以上是 `false`。同步让「关着」与「没到阈值」都真的零成本。',
      },
      {
        t: 'table',
        caption: '引擎给出的六条保证',
        head: ['保证', '细节'],
        rows: [
          ['关掉是免费的', '不传 `contextManager`，检查点只是一次对不存在字段的 `if`'],
          ['引擎会校验并可能拒绝', '孤儿 `tool_result`、未闭合 `tool_call`、空数组、变长的历史都不被采纳'],
          ['你拿到的是副本', '`ctx.messages` 是浅拷贝，改它不会破坏引擎状态'],
          ['调用有硬上限', '引擎把它与 `ctx.signal` 和 120 s 天花板赛跑，不依赖宿主守规矩'],
          ['畸形返回值会降级', 'resolved `undefined`、或没有 `messages` 的 `replace` → `manager_bad_outcome`'],
          ['`compaction_end` 必发', '从 `finally` 发出，因为它负责恢复看门狗'],
        ],
      },
      { t: 'h2', text: '四个纯函数' },
      {
        t: 'table',
        caption: '没有 I/O、没有时钟、不认识 provider',
        head: ['函数', '作用', '何时用'],
        rows: [
          [
            '`findSafeCutIndices(messages)`',
            '列出所有能安全切分、不会拆散工具调用与结果的索引',
            '想自己实现切分策略时',
          ],
          [
            '`planCompaction(messages, { keepRecentTurns, protectedPrefix? })`',
            '留下至少 N 个完整回合的最大安全切点，或 `null`',
            '`null` 而不是 0 长度头，是为了让「尾部本身就超了」变成一次有界结果',
          ],
          [
            '`validateHistory(messages, { previousLength? })`',
            '结构闸门：`empty` / `orphan_tool_result` / `unclosed_tool_call` / `grew`',
            '宿主在**空闲**时手动 splice（没有循环就够不到引擎的闸门）',
          ],
          [
            '`relieveTail(messages, opts)`',
            '从最旧的 `tool_result` 起裁剪超长正文，直到估算进预算',
            '保留的尾部本身就超窗口时的最后一档',
          ],
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '`relieveTail` 改内容，不改结构',
        md:
          '它不删消息、不动 `toolCallId`、不改 `role`，所以通过 `validateHistory` 的历史裁剪后仍然通过 —— ' +
          '这正是它能在已经拼接过的历史上安全运行的原因。每次裁剪都在模型读到的文本里留话，标记由宿主提供（库里没有字形）。',
      },
      { t: 'h2', text: '宿主必须实现什么' },
      {
        t: 'ol',
        items: [
          '**处理 `lastUsage` 是 `undefined`。** 恢复一个大会话的第一次请求没有用量可读，「0%」是错的答案。',
          '**把 `ctx.signal` 透进自己的 LLM 调用。** 引擎会自己赛跑，但你中途抛出会浪费一次已经付过钱的调用。',
          '**用 `planCompaction` 找切点，别按角色写规则。** 历史不总是干净的 `user → assistant → tool_result*`。',
          '**采纳之前自己先 `validateHistory`。** 在宿主侧悄悄失败并记录，好过让引擎报 `invalid_history`。',
          '**永远返回一个 `CompactionOutcome`。** `keep` 带原因比抛异常有用：`compaction_end.reason` 会把它带给用户。',
        ],
      },
      {
        t: 'code',
        lang: 'ts',
        title: '一个完整的 `ContextManager`',
        code: [
          "import type { CompactionProbe, CompactionOutcome, ContextManager, Message } from '@aragon-agent/core';",
          'declare function occupancy(probe: CompactionProbe): number;',
          'declare function summarize(head: readonly Message[], signal: AbortSignal): Promise<string>;',
          'declare const messages: Message[];',
          'declare const systemPrompt: string;',
          '',
          'const contextManager: ContextManager = {',
          '  shouldCompact: (probe) => occupancy(probe) >= 0.9,',
          '',
          '  async compact(ctx): Promise<CompactionOutcome> {',
          '    const plan = planCompaction(ctx.messages, { keepRecentTurns: 4, protectedPrefix: 1 });',
          "    if (!plan) return { action: 'keep', reason: 'nothing_to_drop' };",
          '',
          '    const summary = await summarize(ctx.messages.slice(0, plan.cutIndex), ctx.signal);',
          '    const anchor = ctx.messages[0]!;',
          '    const summaryBlock: Message = {',
          "      role: 'user',",
          '      content: `<compacted_context>\\n${summary}\\n</compacted_context>`,',
          '      timestamp: 0,',
          '    };',
          '    const proposed = [anchor, summaryBlock, ...ctx.messages.slice(plan.cutIndex)];',
          '',
          '    const check = validateHistory(proposed, { previousLength: ctx.messages.length });',
          "    if (!check.ok) return { action: 'keep', reason: `invalid_history: ${check.reason}` };",
          "    return { action: 'replace', mode: 'summarized', messages: proposed, summary };",
          '  },',
          '};',
          '',
          '// 最后一档：保留的尾部本身就超预算',
          'const relieved = relieveTail(messages, {',
          '  from: 1, clipChars: 8_000, targetTokens: 60_000, systemPrompt,',
          '  marker: (removed) => `\\n[... 已裁剪 ${removed} 个字符]`,',
          '});',
          'const safe = findSafeCutIndices(relieved.messages); // 与引擎同一套规则',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '120 秒与看门狗：别在这里做长任务',
        md:
          '`compaction_start` 暂停了空闲看门狗，所以这次调用期间**只有**引擎的硬上限在跑。总结跑两分钟会被判成 `manager_timeout`，' +
          '而这个上限不可配置（除了给测试用的 `timeouts.compactionHardTimeout`）。总结用快模型。',
      },
    ],
  },

  {
    id: 'api/skills',
    title: 'SkillRegistry 与技能格式',
    group: 'api',
    order: 80,
    phase: 'B',
    template: 'api',
    summary:
      '`SkillRegistry` 的作用域与遮蔽、`SKILL.md` 的 frontmatter 字段、三级渐进加载，以及每条字节预算的真实数值和它为什么按字节算。',
    keywords: ['SkillRegistry', 'SKILL.md', 'frontmatter', 'skill 工具', '字节预算'],
    seeAlso: ['guide/skills', 'tools/skills', 'api/types'],
    sourceRefs: [
      { path: 'packages/core/src/skills/skill-registry.ts', lines: '1-40', snippet: 'export class SkillRegistry {' },
      {
        path: 'packages/core/src/skills/frontmatter.ts',
        lines: '80-95',
        snippet: 'export function parseFrontmatter(source: string): ParsedFrontmatter | null {',
      },
      { path: 'packages/core/src/skills/types.ts', lines: '9-31', snippet: 'export interface SkillFrontmatter {' },
      { path: 'packages/core/src/skills/constants.ts', lines: '14-22', snippet: 'export const SKILL_CATALOG_MAX_BYTES = 6000;' },
      { path: 'packages/core/src/skills/constants.ts', lines: '66-83', snippet: 'export const SKILL_BODY_MAX_BYTES = 30_000;' },
      { path: 'packages/core/src/skills/constants.ts', lines: '135-152', snippet: 'export const ALWAYS_SKILLS_MAX_BYTES = 12_000;' },
      { path: 'packages/core/src/skills/disclosure.ts', lines: '258-278', snippet: 'export function renderSkillCatalog(' },
      { path: 'packages/core/src/skills/validate.ts', lines: '93-131', snippet: "err('SKILL_NAME_MISSING', 'name is required');" },
    ],
    importLine:
      "import { SkillRegistry, parseFrontmatter, renderSkillCatalog, createSkillTool, SKILL_CATALOG_MAX_BYTES } from '@aragon-agent/core';",
    signature: [
      'interface SkillFrontmatter {',
      '  name: string; description: string; version: string;',
      '  license?: string; author?: string; homepage?: string;',
      '  keywords: string[]; allowedTools: string[];',
      "  activation: 'auto' | 'always' | 'manual';",
      '  raw: Record<string, string | string[]>;',
      '}',
      '',
      'class SkillRegistry {',
      '  add(record: SkillRecord): void;      // 后加的赢，输家进 shadowed[]',
      '  get(name: string): SkillRecord | undefined;',
      '  catalog(): SkillRecord[];',
      '  alwaysOn(extraNames?: string[]): SkillRecord[];',
      '  activate(name: string): boolean;',
      '  isActive(name: string): boolean;',
      '  setDisabled(name: string, disabled: boolean): void;',
      '  replaceAll(records: SkillRecord[]): void;',
      '}',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '技能是一份带 frontmatter 的 Markdown 加一个「按需加载」的约定。Core 只提供纯逻辑：解析、校验、注册表、预算、渲染与 Level 2 工具工厂；' +
          '文件系统、网络、进程全部在宿主侧，通过 `SkillHost` 端口进来 —— 这就是本包不含任何 `node:*` import 的原因。',
      },
      { t: 'h2', text: '`SKILL.md` 的格式' },
      {
        t: 'table',
        caption: 'frontmatter 字段（解析器是严格子集 YAML：`key: value` 与 `[a, b]`）',
        head: ['键', '必填', '说明'],
        rows: [
          ['`name`', '是', 'kebab-case，匹配 `SKILL_NAME_PATTERN`；与目录不同名只报警告'],
          ['`description`', '是', '一句话说清「做什么 + 什么时候用」，会原样进 Level 1 目录行'],
          ['`version`', '是', '非 semver 只报警告并回退 `0.0.0`，不拒绝安装'],
          ['`allowed-tools`', '否', '工具名列表，最多 32 条；能否生效取决于宿主的 `HOST_TOOL_NAMES`'],
          ['`activation`', '否', '`auto`（默认）/ `always`（正文常驻）/ `manual`（只能由 `/name` 触发）'],
          ['`keywords` / `license` / `author` / `homepage`', '否', '检索词与元信息，引擎不解释'],
        ],
      },
      {
        t: 'code',
        lang: 'text',
        title: '一个最小可用的 SKILL.md',
        code: [
          '---',
          'name: deploy-preview',
          'description: 为当前分支构建预览环境并返回可访问的 URL。用户想“看一眼效果”时使用。',
          'version: 1.2.0',
          'allowed-tools: [bash, read_file]',
          'activation: auto',
          '---',
          '',
          '# Deploy preview',
          '',
          '1. 读 package.json 确认构建脚本。',
          '2. `bash` 执行构建，工作目录是仓库根。',
          '3. 把 URL 原样贴回来，不要总结它。',
        ].join('\n'),
      },
      { t: 'h2', text: '三级渐进加载与字节预算' },
      {
        t: 'table',
        caption: '每一级只在你真的需要时才付 token',
        head: ['级别', '进入哪里', '天花板'],
        rows: [
          ['Level 1 · 目录', '系统提示词里的 `<available_skills>` 块', '`SKILL_CATALOG_MAX_BYTES`（6000 字节）'],
          ['Level 2 · 正文', '`skill` 工具的返回结果', '`SKILL_BODY_MAX_BYTES`（30 000），整体 `SKILL_RESULT_MAX_BYTES`（60 000）'],
          ['Level 3 · 附带文件', '`<skill_files>` 只列路径，模型自己读', '最多 `SKILL_FILES_MAX`（50）条'],
        ],
      },
      {
        t: 'table',
        caption: '字节预算表（标 `*_BYTES` 的一律按 UTF-8 字节计）',
        head: ['常量', '值', '约束的对象'],
        rows: [
          ['`SKILL_CATALOG_MAX_BYTES`', '`6000`', '整个 `<available_skills>` 块'],
          ['`SKILL_DESC_LINE_MAX`', '`220`', '单个条目的描述（这一条按字符，是显示宽度）'],
          ['`SKILL_BODY_MAX_BYTES`', '`30000`', '`skill` 结果里的正文'],
          ['`SKILL_RESULT_MAX_BYTES`', '`60000`', '整个 `skill` 结果，刻意压在 100 000 字节之下'],
          ['`ALWAYS_SKILLS_MAX_BYTES`', '`12000`', '`activation: always` 的正文总预算'],
          ['`SKILL_MD_MAX_BYTES`', '`524288`', '扫描器愿意读的最大 `SKILL.md`'],
          ['`SKILL_FIND_MAX_BYTES`', '`8000`', '`skill_find` 的结果块'],
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '为什么是字节而不是字符',
        md:
          '`ToolExecutor` 在 100 000 **字节**处按字节边界截断。一个「30 000 字符」的预算在中文内容上会变成 90 000 字节，' +
          '被上游悄悄砍一半 —— 砍掉的往往是结尾的闭合标签，交给模型的就是一个结构坏掉的块。',
      },
      { t: 'h2', text: '作用域、遮蔽与校验码' },
      {
        t: 'p',
        md:
          '优先级由 `add()` 的**顺序**决定：宿主从低到高扫根（`bundled` → `user` → `project` → `env`），同名后加的赢，' +
          '输家不会消失而是记进赢家的 `shadowed[]`，`/skills` 才能显示「被 project 遮蔽」。' +
          '`active` 回答「正文发过没有」（只增不减），帧（`enterFrame` / `beginUserTurn`）回答「这一回合允许哪些工具」（会过期）。',
      },
      {
        t: 'p',
        md:
          '`validateSkillFrontmatter` / `validateStagedSkill` 返回 `{ level, code, message }`；`code` 是公开接口，改名等同破坏性变更。' +
          '常见值：`SKILL_NAME_MISSING`、`SKILL_NAME_INVALID`、`SKILL_DESC_TOO_LONG`、`SKILL_ALLOWED_TOOLS_INVALID`、' +
          '`SKILL_PATH_TRAVERSAL`、`SKILL_SYMLINK_REJECTED`、`SKILL_TOTAL_TOO_LARGE`。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '从一份文件到一个可用的 Level 2 工具',
        code: [
          "import type { SkillFileRef, SkillRecord, SkillRegistry } from '@aragon-agent/core';",
          'declare const registry: SkillRegistry;',
          'declare const skillMdText: string;',
          'declare const body: string;',
          'declare const files: SkillFileRef[];',
          '',
          'const parsed = parseFrontmatter(skillMdText);',
          "if (!parsed) throw new Error('SKILL.md 没有可用 frontmatter');",
          '',
          'const record: SkillRecord = {',
          "  name: 'deploy-preview',",
          "  description: '为当前分支构建预览环境并返回 URL。',",
          "  scope: 'project',",
          "  dir: '/work/acme/skills/deploy-preview',",
          "  entryPath: '/work/acme/skills/deploy-preview/SKILL.md',",
          '  frontmatter: {',
          "    name: 'deploy-preview', description: '为当前分支构建预览环境并返回 URL。',",
          "    version: '1.2.0', keywords: ['deploy'], allowedTools: ['bash'], activation: 'auto',",
          '    raw: parsed.data,',
          '  },',
          '  body: null, files: null, bytes: Buffer.byteLength(skillMdText),',
          '  disabled: false, issues: [], invalid: false, shadowed: [], manifest: null,',
          "  writable: true, integrity: 'unverified',",
          '};',
          '',
          'const catalog = renderSkillCatalog([record], { maxBytes: SKILL_CATALOG_MAX_BYTES });',
          'const skillTool = createSkillTool({',
          '  registry,',
          '  loadBody: () => ({ body, files }),',
          '  bodyMaxBytes: SKILL_BODY_MAX_BYTES,',
          '});',
        ].join('\n'),
      },
      {
        t: 'callout',
        kind: 'note',
        title: '`renderSkillCatalog` 返回空串是特性',
        md:
          '没有合格技能（全禁用、全 `manual`、或 `--no-skills`）时它返回 `\'\'`，系统提示词里那一块完全不存在 —— ' +
          '这才让「关掉技能」的输出与没有这个功能时逐字节相同。别把空串当错误。',
      },
    ],
  },

  {
    id: 'api/sandbox',
    title: 'isolated-vm 沙箱',
    group: 'api',
    order: 90,
    phase: 'B',
    template: 'api',
    summary:
      'CodeAct 沙箱藏在 `@aragon-agent/core/sandbox/*` 子路径后面：一个 V8 Isolate、三座桥、五个配置字段，以及它明确“不是”什么的隔离边界。',
    keywords: ['isolated-vm', 'CodeAct', 'IsolatedVmSandbox', '沙箱', 'SandboxConfig'],
    seeAlso: ['api/agent', 'exec/permissions', 'tools/index'],
    sourceRefs: [
      { path: 'packages/core/src/sandbox/types.ts', lines: '15-34', snippet: 'export interface SandboxConfig {' },
      { path: 'packages/core/src/sandbox/types.ts', lines: '100-123', snippet: 'export interface CodeActSandbox {' },
      {
        path: 'packages/core/src/sandbox/isolated-vm-sandbox.ts',
        lines: '28-60',
        snippet: 'export class IsolatedVmSandbox implements CodeActSandbox {',
      },
      {
        path: 'packages/core/src/sandbox/tool-bridge.ts',
        lines: '24-42',
        snippet: 'async injectAll(context: ivm.Context): Promise<void> {',
      },
      { path: 'packages/core/src/sandbox/http-bridge.ts', lines: '40-53', snippet: 'export class HttpBridge {' },
      { path: 'packages/core/package.json', lines: '61-64', snippet: '"./sandbox/*": {' },
      { path: 'packages/core/src/index.ts', lines: '371-385', snippet: 'Sandbox exports are NOT re-exported here' },
    ],
    importLine: "import { IsolatedVmSandbox } from '@aragon-agent/core/sandbox/isolated-vm-sandbox';",
    signature: [
      'interface SandboxConfig {',
      '  memoryLimitMB?: number;      // 默认 128',
      '  defaultTimeout?: number;     // 默认 30_000',
      '  tools?: AgentTool[];         // 只有 bridgeable: true 的会被注入',
      '  allowedHosts?: string[];     // 空数组（默认）= 所有 HTTP 都被拒绝',
      '  globals?: Record<string, unknown>;',
      '}',
      '',
      'interface CodeActSandbox {',
      '  execute(code: string, options?: ExecuteOptions): Promise<ExecuteResult>;',
      '  reset(): Promise<void>;',
      '  dispose(): void;',
      '  get isDisposed(): boolean;',
      '}',
      '',
      'interface ExecuteResult {',
      '  returnValue?: string;',
      '  consoleOutput: ConsoleEntry[];',
      '  error?: { name: string; message: string; stack?: string };',
      '  duration: number;',
      '  toolCalls: SandboxToolCall[];',
      '}',
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          'CodeAct 是另一种循环形态：模型不调工具，而是写一小段 JavaScript 在隔离环境里执行，通过桥接进来的函数去碰外部世界。' +
          '这个实现用 `isolated-vm`：独立的 V8 Isolate、固定内存与时间上限。',
      },
      { t: 'h2', text: '为什么它不在根导出里' },
      {
        t: 'p',
        md:
          '`isolated-vm` 是原生模块，与某些嵌入式 V8 运行时（例如 Electron）不兼容。挂在根 barrel 上会让每个只想要 `Agent` 的消费者' +
          '在 `import` 时就被绊倒。所以根导出只给**类型**，实现只能从 `@aragon-agent/core/sandbox/*` 懒加载 —— ' +
          '这是 `exports` 映射里唯一带 `*` 的一条。',
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '宿主侧的正确写法是动态 import',
        md: '只有真的要用沙箱时才 `await import(\'@aragon-agent/core/sandbox/isolated-vm-sandbox\')`，别在启动路径上静态加载原生模块。',
      },
      { t: 'h2', text: '三座桥' },
      {
        t: 'table',
        caption: '沙箱内部能看见的一切都来自这三座桥',
        head: ['桥', '注入什么', '边界'],
        rows: [
          ['Console bridge', '收集 `console.log/warn/error/info`', '按时间顺序进 `ExecuteResult.consoleOutput`'],
          [
            'Tool bridge',
            '把 `bridgeable: true` 的工具注入成 `async fn(args): Promise<string>`',
            '每次调用记进 `toolCalls`；名字取 `bridgeName`，缺省用 `name`',
          ],
          [
            'HTTP bridge',
            '注入受限的 `globalThis.fetch`，返回 `{ status, statusText, headers, body }`',
            '主机白名单；单请求 10 s、响应 1 MB 上限',
          ],
        ],
      },
      { t: 'p', md: 'HTTP 桥返回的不是 WHATWG `Response`：`body` 已经是字符串，没有 `.json()`，解析要自己 `JSON.parse(response.body)`。' },
      { t: 'h2', text: '`SandboxConfig` 与生命周期' },
      {
        t: 'params',
        caption: '除 `tools` 外全部有默认值',
        items: [
          { name: 'memoryLimitMB', type: 'number', default: '128', desc: 'V8 Isolate 的内存上限（MB）。' },
          { name: 'defaultTimeout', type: 'number', default: '30_000', desc: '单次 `execute()` 的默认超时（ms）。' },
          { name: 'tools', type: 'AgentTool[]', desc: '被桥接的候选；只有 `bridgeable: true` 的会真的注入。' },
          { name: 'allowedHosts', type: 'string[]', desc: 'HTTP 白名单。**默认空数组意味着全部拒绝**，不是全部允许。' },
          { name: 'globals', type: 'Record<string, unknown>', desc: '预注入的全局变量，例如仓库名或配置常量。' },
        ],
      },
      {
        t: 'p',
        md:
          '生命周期是懒的：`new` 不创建 Isolate，第一次 `execute()` 才创建 Context；之后复用同一个 Context，所以上次定义的变量这次还在；' +
          '`reset()` 换一个新 Context 并重挂桥；`dispose()` 释放整个 Isolate，之后所有调用都会抛。',
      },
      {
        t: 'code',
        lang: 'ts',
        title: '构造、执行、收尾',
        code: [
          "import type { AgentTool } from '@aragon-agent/core';",
          "import { IsolatedVmSandbox } from '@aragon-agent/core/sandbox/isolated-vm-sandbox';",
          'declare const tools: AgentTool[];',
          '',
          'const sandbox = new IsolatedVmSandbox({',
          "  memoryLimitMB: 128, defaultTimeout: 30_000, allowedHosts: ['api.github.com'],",
          "  tools, globals: { REPO: 'acme/api' },",
          '});',
          '',
          'const result = await sandbox.execute(',
          '  `',
          '    const response = await fetch("https://api.github.com/repos/" + REPO);',
          '    const data = JSON.parse(response.body);',
          '    console.log("stars", data.stargazers_count);',
          '    data.stargazers_count;',
          '  `,',
          '  { timeout: 10_000 },',
          ');',
          '',
          'console.log(result.returnValue, result.consoleOutput, result.toolCalls);',
          'sandbox.dispose();',
        ].join('\n'),
      },
      { t: 'h2', text: '它隔离什么，不隔离什么' },
      {
        t: 'table',
        caption: '把边界说清楚，比说“安全”有用',
        head: ['维度', '有', '没有'],
        rows: [
          ['内存', 'Isolate 级上限（默认 128 MB）', '按次调用的内存配额'],
          ['时间', '单次 `execute()` 超时，可由 `options.timeout` 覆盖', '总生命周期预算'],
          ['网络', '白名单 HTTP 桥；未列出的主机被拒绝', '路径/方法级策略'],
          ['文件系统', '只能通过你自己桥接进来的工具', '任何内置 `fs`'],
          ['进程', '无', '`process`、`require`、子进程'],
          ['宿主边界', '独立 V8 Isolate', '操作系统级沙箱（cgroup / seccomp / 容器）'],
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '这不是容器的替代品',
        md:
          '`isolated-vm` 隔的是 JS 执行环境，不是内核资源。要跑不可信代码，仍然需要容器或虚拟机的边界；' +
          '这个沙箱的定位是「让模型写的小脚本别污染主进程」。',
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '没装原生模块时，失败发生在 import 时',
        md:
          '`isolated-vm` 缺席时，这个子路径在解析阶段就抛。把动态 `import()` 包在 `try/catch` 里做能力降级，' +
          '比在构造时才发现要好。',
      },
    ],
  },

  {
    id: 'api/types',
    title: '类型导出与子路径导出',
    group: 'api',
    order: 100,
    phase: 'B',
    template: 'api',
    summary:
      'Core 的全部 86 个值导出（按类、函数、常量分组）、七个 `exports` 子路径，以及 `packages/core/API.md` 与源码之间那处尚未对齐的偏差。',
    keywords: ['导出', 'exports', '子路径', 'API.md', 'public-api', '类型导出'],
    seeAlso: ['api/install', 'api/skills', 'appendix/compat'],
    sourceRefs: [
      { path: 'packages/core/src/index.ts', lines: '1-16', snippet: 'Agent core — barrel export.' },
      { path: 'packages/core/src/index.ts', lines: '256-259', snippet: "export { computeToolPolicy, evaluateToolCall } from './skills/tool-policy.js';" },
      { path: 'packages/core/src/index.ts', lines: '371-385', snippet: 'Sandbox exports are NOT re-exported here' },
      { path: 'packages/core/API.md', lines: '13-17', snippet: '## Runtime (value) exports — 85' },
      { path: 'packages/core/package.json', lines: '36-66', snippet: '"./skills": {' },
      { path: 'packages/core/src/skills/index.ts', lines: '1-11', snippet: 'Skills submodule barrel' },
    ],
    importLine: "import * as core from '@aragon-agent/core';",
    signature: [
      '// 7 个可通过 package.json#exports 解析的入口：',
      "import * as root from '@aragon-agent/core';                    // .",
      "import type * as llm from '@aragon-agent/core/llm/types';",
      "import { initProviders } from '@aragon-agent/core/llm/providers';",
      "import type * as toolTypes from '@aragon-agent/core/tools/types';",
      "import { defineTool } from '@aragon-agent/core/tools/helpers';",
      "import { SkillRegistry } from '@aragon-agent/core/skills';",
      "import { IsolatedVmSandbox } from '@aragon-agent/core/sandbox/isolated-vm-sandbox';",
    ].join('\n'),
    blocks: [
      {
        t: 'p',
        md:
          '根 barrel 的**值导出**由 Core 的 `public-api.test.ts` 冻结：加一个要在三处同步（`src/index.ts`、测试里的 `EXPECTED`、`API.md`）。' +
          '本页清单是从 `src/index.ts` 数出来的 —— 共 ' + EXPORT_COUNT + ' 个值导出，全部可在包根 `import`。',
      },
      { t: 'h2', text: '按类别分组的 ' + EXPORT_COUNT + ' 个值导出' },
      ...KIND_ORDER.flatMap((kind) => {
        const records = apiExports.filter((record) => record.kind === kind);
        if (records.length === 0) return [];
        return [
          { t: 'h3', text: `${KIND_LABELS[kind]}（${records.length} 个）` },
          exportTable(records, `${KIND_LABELS[kind]}导出一览（${records.length} 条）`),
        ];
      }),
      { t: 'h2', text: '七个 `exports` 子路径' },
      {
        t: 'p',
        md:
          '`package.json#exports` 一共七个入口：根 + 六个；`typesVersions` 里有同样的六条，照顾不读 `exports` 的旧 `moduleResolution`。' +
          '下表的值导出数是从数据集派生的 —— `./llm/types`、`./tools/types`、`./sandbox/*` 基本只装类型。',
      },
      {
        t: 'table',
        caption: '子路径、值导出数与目标文件',
        head: ['子路径', '值导出数', '目标文件'],
        rows: apiSubpaths.map((subpath) => [
          `\`${subpath}\``,
          String(exportCountFor(subpath)),
          `\`${SUBPATH_TARGETS[subpath] ?? `./dist/${subpath.replace(/^\.\//, '')}`}\``,
        ]),
      },
      {
        t: 'callout',
        kind: 'note',
        title: '子路径不是“内部分包”',
        md:
          '`./skills` 与 `./tools/helpers` 暴露的是**同一份实现**的更多名字（`renderAlwaysSkills`、`byteLength`、`truncateToBytes`），' +
          '不是另一份代码。这样根导出被冻结时，CLI 需要的东西也够用。',
      },
      { t: 'h2', text: '与 `API.md` 的偏差' },
      {
        t: 'callout',
        kind: 'warn',
        title: '`API.md` 说 85，源码是 86；它的表里有 84 行',
        md:
          '以 `packages/core/src/index.ts` 为准：本页的 ' + EXPORT_COUNT + ' 个值导出是数出来的。`packages/core/API.md` 的标题写 85，' +
          '它的运行时导出表实际只有 84 行 —— 缺的正是 ' + apiDocGaps.map((r) => `\`${r.name}\``).join(' 与 ') +
          ' 这两条（`skills/tool-policy.ts` 里的两个工具策略入口）。`CHANGELOG.md` 的「85 → 86 runtime exports」与源码一致，' +
          '所以偏差在文档表格，不在代码。',
      },
      {
        t: 'p',
        md:
          '两组数字可以互相验证：表里 84 行 + 缺的 ' + apiDocGaps.length + ' 条 = ' + EXPORT_COUNT + '，正好等于源码的导出名数量。' +
          '这就是为什么本组页面不引用「85」这个数字：它至少错了两处（标题计数与表行数），而错误的计数会让人以为有一条导出「不该存在」。',
      },
      {
        t: 'callout',
        kind: 'tip',
        title: '怎么自己复核',
        md:
          '数 `src/index.ts` 里 `export {…}` 与 `export const|class|function` 的名字（`export type` 不计入），再和 `API.md` 的运行时表比。' +
          '`skills/tool-policy.ts` 那行 `export { computeToolPolicy, evaluateToolCall }` 最容易漏：它夹在两段大注释之间。',
      },
      { t: 'h2', text: '类型导出与设计过的“不导出”' },
      {
        t: 'ul',
        items: [
          '**类型导出不改变运行时表面。** `AgentConfig`、`AgentEvent`、`SkillFrontmatter`、`StreamEvent` 只存在于 `.d.ts`，`Object.keys()` 里看不到。',
          '**沙箱实现只在子路径里**，根 barrel 只导出它的类型 —— 理由见 [isolated-vm 沙箱](/api/sandbox/)。',
          '**`normalizePolicy` 与 `decide` 故意不导出。** 它们是两个公开入口的实现细节，推上去只为冻结的表面多加两个没人该调的名字。',
          '**CLI 自己的事件类型永远不会进来。** `ExecEvent`、`TeamEvent`、`TodoEvent`、`FastEvent`、`CompactionEvent` 都是宿主概念。',
        ],
      },
    ],
  },
];
