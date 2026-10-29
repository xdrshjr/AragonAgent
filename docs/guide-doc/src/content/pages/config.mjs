/**
 * 配置分组（`config`）的页面。
 *
 * 配置键表格来自 `src/content/data/config-keys.mjs`（truth set S-7，46 个顶层键），
 * 因此「文档里少写一个键」会被门禁抓到，而不是靠人记。
 */

import { configKeys } from '../data/config-keys.mjs';
import { envVars } from '../data/env-vars.mjs';

/**
 * 按 `area` 把配置键分桶。
 *
 * @param {object[]} records 配置键记录
 * @returns {Map<string, object[]>} 分组
 */
function groupByArea(records) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.area)) groups.set(record.area, []);
    groups.get(record.area).push(record);
  }
  return groups;
}

/**
 * 配置键表。
 *
 * @param {string} title 组标题
 * @param {object[]} records 记录
 * @returns {object} table block
 */
function keyTable(title, records) {
  return {
    t: 'table',
    caption: `${title}（${records.length} 个键）`,
    head: ['键', '类型', '默认值', '含义', '依据'],
    rows: records.map((record) => [
      `\`${record.key}\``,
      record.type,
      `\`${record.default}\``,
      record.meaning || '—',
      `\`${record.source.path}:${record.source.lines}\``,
    ]),
  };
}

/** 46 个顶层键按领域分桶。 */
const keyGroups = groupByArea(configKeys);

/**
 * @type {object[]}
 */
export const pages = [
  {
    id: 'config/overview',
    title: '配置文件与优先级',
    group: 'config',
    order: 10,
    phase: 'A',
    template: 'prose',
    summary:
      '配置文件在哪、长什么样、谁的优先级最高：命令行参数 > 环境变量 > 配置文件 > 内置默认值，以及为什么写入是原子的。',
    keywords: ['config.json', '配置', '优先级', 'ARAGON_HOME', 'config set', '默认值'],
    seeAlso: ['config/reference', 'config/home', 'config/env'],
    sourceRefs: [
      { path: 'packages/cli/src/config/store.ts', lines: '1-40', snippet: 'config' },
      { path: 'packages/cli/src/config/schema.ts', lines: '2048-2148', snippet: 'DEFAULT_CONFIG' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '所有可持久化的设置都在一个 `config.json` 里。它没有任何"魔法"：一个 JSON 对象，' +
          '键名与 [全部配置键](/config/reference/) 一一对应，缺的键用内置默认值补。',
      },
      {
        t: 'h2',
        text: '优先级从高到低',
      },
      {
        t: 'table',
        caption: '四层覆盖关系（上一行覆盖下一行）',
        head: ['层', '例子', '适合'],
        rows: [
          ['命令行参数', '`--theme light`', '一次性覆盖；脚本与 CI'],
          ['环境变量', '`ARAGON_LOG_LEVEL=debug`', '容器与 CI 的注入；见 [环境变量](/config/env/)'],
          ['配置文件', '`config.json` 里的 `theme`', '长期个人偏好'],
          ['内置默认值', '`DEFAULT_CONFIG`', '什么都不写时的行为'],
        ],
      },
      {
        t: 'h2',
        text: '文件在哪',
      },
      {
        t: 'p',
        md:
          '默认在用户数据目录下，可用 `ARAGON_HOME` 整体改到别处（容器里常用）。' +
          '精确路径用命令问，不要靠记：',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '问路径，而不是猜路径',
        code: 'aragon config path   # 配置文件路径\naragon config home   # 数据目录（会话、日志、技能）',
      },
      {
        t: 'h2',
        text: '读写规则',
      },
      {
        t: 'steps',
        items: [
          {
            title: '读一个键',
            md: '嵌套键用点号。读不到时会打印内置默认值，而不是报错。',
            code: { lang: 'bash', code: 'aragon config get theme' },
          },
          {
            title: '写一个键',
            md:
              '写入是原子的（先写临时文件再替换，权限 0600），因此进程被杀不会留下半个 JSON。' +
              '写入只动你点名的键，其余键与注释顺序保持原样。',
            code: { lang: 'bash', code: 'aragon config set theme light' },
          },
          {
            title: '手改也行',
            md: '`aragon config edit` 会用 `$EDITOR` 打开它；保存后下一次启动生效（无需重启进程）。',
            code: { lang: 'bash', code: 'aragon config edit' },
          },
        ],
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '配置文件里的 API Key 优先于环境变量',
        md:
          '这与很多工具相反：一旦你在配置文件里写了 `apiKeys.anthropic`，它会盖住 `ANTHROPIC_API_KEY` 之类的环境变量。' +
          '在 CI 里请确认配置文件没有残留旧 key，或者用 `--api-key` 一次性覆盖（不落盘）。',
      },
    ],
  },

  {
    id: 'config/reference',
    title: '全部配置键',
    group: 'config',
    order: 20,
    phase: 'A',
    template: 'flags',
    summary:
      '`config.json` 的 46 个顶层键：声明类型、默认值与所在行。分组对象（如 `skills`、`log`）的内部键不在本表口径内。',
    keywords: ['config keys', '配置键', 'DEFAULT_CONFIG', '默认值', '46 个键'],
    seeAlso: ['config/overview', 'config/env', 'config/home'],
    sourceRefs: [
      { path: 'packages/cli/src/config/schema.ts', lines: '2048-2148', snippet: 'DEFAULT_CONFIG' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '下表由 `DEFAULT_CONFIG` 自动提取：46 个顶层键，第 2 列的类型取自 `PersistedConfig` 的声明，第 4 列是源码注释的中文概括，第 5 列能点开对应行。' +
          '「默认值」是源码里的**字面量**（可能是一个常量名），因此它同时也是那个常量的名字。',
      },
      {
        t: 'callout',
        kind: 'note',
        title: '口径：只承诺顶层键',
        md:
          '分组对象（`skills`、`log`、`team`、`todo`、`retry`、`prompts`、`taskSummary`、`jobs` 等）的内部键定义在各自的 ' +
          '`DEFAULT_*_CONFIG` 常量里。本页只承诺「46 个顶层键齐全」，因为它们才有稳定的机器可读口径。',
      },
      ...renderKeySections(keyGroups),
      {
        t: 'h2',
        text: '改配置的三种方式',
      },
      {
        t: 'kv',
        items: [
          { k: '`aragon config set <key> <value>`', v: '原子写入，只动一个键' },
          { k: '`aragon config edit`', v: '用 `$EDITOR` 整文件编辑' },
          { k: '环境变量', v: '不写文件、只影响本次运行，见 [环境变量](/config/env/)' },
        ],
      },
    ],
  },

  {
    id: 'config/env',
    title: '环境变量',
    group: 'config',
    order: 30,
    phase: 'B',
    template: 'flags',
    summary:
      '全仓扫描出的环境变量清单：`ARAGON_*` 覆盖配置、Provider 的 API Key 变量、以及宿主环境相关的读取点与它们的默认值。',
    keywords: ['环境变量', 'environment', 'env', 'ARAGON_HOME', 'ANTHROPIC_API_KEY', 'CI'],
    seeAlso: ['config/overview', 'config/reference', 'exec/overview'],
    sourceRefs: [
      { path: 'packages/cli/src/config/env.ts', lines: '63-72', snippet: 'PROVIDER_ENV_KEYS' },
      { path: 'packages/cli/src/config/app-paths.ts', lines: '120-137', snippet: 'ARAGON_HOME' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '环境变量只用于「不想写进文件」的设置：CI 注入、容器编排、一次性的调试开关。' +
          '下表按变量名字母序排列，每行的依据指向真正读取它的那一行。',
      },
      {
        t: 'h2',
        text: '变量清单',
      },
      {
        t: 'table',
        caption: `全仓扫描结果（${envVars.length} 条，按名称排序）`,
        head: ['变量', '作用', '默认', '依据'],
        rows: envVars.map((record) => [
          `\`${record.name}\``,
          record.purpose,
          record.default ? `\`${record.default}\`` : '—',
          `\`${record.source.path}:${record.source.lines}\``,
        ]),
      },
      {
        t: 'h2',
        text: '最常用的四个',
      },
      {
        t: 'kv',
        items: [
          { k: '`ARAGON_HOME`', v: '把整个数据目录搬走（容器里挂载卷）' },
          { k: '`ARAGON_LOG_LEVEL`', v: '临时提高日志级别，不必改配置文件' },
          { k: '`NO_COLOR`', v: '按社区约定关闭彩色输出' },
          { k: '`CI`', v: 'CI 环境下的行为分支（交互提示、彩色、进度条）' },
        ],
      },
      {
        t: 'callout',
        kind: 'tip',
        title: 'API Key 的解析顺序',
        md:
          'Provider 各自的 key 变量（如 `ANTHROPIC_API_KEY`）是最低优先级：配置文件里的 `apiKeys.<provider>` 与 `--api-key` 都会盖住它。' +
          '这条与直觉相反，见 [配置文件与优先级](/config/overview/)。',
      },
    ],
  },

  {
    id: 'config/home',
    title: '本地目录结构',
    group: 'config',
    order: 40,
    phase: 'B',
    template: 'flags',
    summary:
      '数据目录里每个子目录的用途：配置、会话、日志、技能、缓存。以及哪些可以安全删除、哪些删了会丢状态。',
    keywords: ['ARAGON_HOME', '目录结构', '数据目录', '会话文件', '日志', '缓存'],
    seeAlso: ['config/overview', 'config/logs', 'guide/sessions'],
    sourceRefs: [
      { path: 'packages/cli/src/config/app-paths.ts', lines: '120-140', snippet: 'ARAGON_HOME' },
      { path: 'README.md', lines: '168-183', snippet: 'aragon' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '所有"会一直存在"的东西都在一个目录下（默认 `~/.aragon-agent`，可用 `ARAGON_HOME` 改）。' +
          '结构稳定，因此备份与迁移只需搬一个目录。',
      },
      {
        t: 'h2',
        text: '目录结构',
      },
      {
        t: 'tree',
        root: '~/.aragon-agent/',
        lines: [
          'config.json            # 全部持久化设置',
          'sessions/              # 会话历史（可续接、可分支）',
          'logs/                  # 运行日志，按天滚动',
          'skills/                # 已安装技能（每个一个目录）',
          'cache/                 # 模型表、目录缓存（可删）',
          'transcripts/           # 导出的一次运行记录（若开启）',
        ],
      },
      {
        t: 'h2',
        text: '哪些可以删',
      },
      {
        t: 'table',
        caption: '删除代价（按"删了会不会丢东西"排列）',
        head: ['路径', '删掉的后果', '建议'],
        rows: [
          ['`cache/`', '下次启动重新拉模型表', '随时可删'],
          ['`logs/`', '丢失诊断线索', '排查结束后再删'],
          ['`transcripts/`', '丢失导出的运行记录', '按需'],
          ['`sessions/`', '丢失历史会话，无法续接', '先备份'],
          ['`skills/`', '技能需要重装', '先备份'],
          ['`config.json`', '回到全默认', '先备份'],
        ],
      },
      {
        t: 'callout',
        kind: 'note',
        title: '会话文件是纯 JSON',
        md:
          '`sessions/` 下的文件可以直接读、可以直接 `grep`。排查问题时比重新跑一遍更快。',
      },
    ],
  },

  {
    id: 'config/logs',
    title: '日志与诊断',
    group: 'config',
    order: 50,
    phase: 'B',
    template: 'prose',
    summary:
      '日志落在哪、级别怎么调、`aragon logs` 的四个参数怎么用，以及把一份可复现的诊断信息交给别人的最小集合。',
    keywords: ['日志', 'log', 'log-level', '诊断', 'trace', 'aragon logs'],
    seeAlso: ['config/home', 'troubleshoot/doctor', 'troubleshoot/faq'],
    sourceRefs: [
      { path: 'packages/cli/src/logging/logger.ts', lines: '1-40', snippet: 'export' },
      { path: 'packages/cli/README.md', lines: '3209', snippet: 'logs' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '日志的第一原则是**不要解析它**：给机器看的东西在 stdout 的事件流里，日志只给人看。' +
          '因此日志格式可以随时变，而事件格式有版本承诺（见 [版本与兼容承诺](/appendix/compat/)）。',
      },
      {
        t: 'h2',
        text: '调级别',
      },
      {
        t: 'kv',
        items: [
          { k: '配置文件', v: '`log.level`（或在 `config.json` 里设 `logLevel`）' },
          { k: '环境变量', v: '`ARAGON_LOG_LEVEL=debug`' },
          { k: '命令行', v: '`--log-level debug` / `--log-dir <path>` / `--log-file <path>`' },
        ],
      },
      {
        t: 'h2',
        text: '看日志',
      },
      {
        t: 'table',
        caption: '`aragon logs` 的参数',
        head: ['参数', '作用'],
        rows: [
          ['`--lines <n>`', '只取最后 n 行'],
          ['`--follow`', '持续跟随（类似 `tail -f`）'],
          ['`--level <level>`', '按级别过滤'],
          ['`--json`', '一行一个 JSON 对象，便于过滤'],
        ],
      },
      {
        t: 'h2',
        text: '报问题时给什么',
      },
      {
        t: 'steps',
        items: [
          {
            title: '版本与平台',
            md: '`aragon --version`、Node 版本、操作系统。这三行能排除一半的问题。',
            code: { lang: 'bash', code: 'aragon --version\nnode --version' },
          },
          {
            title: '一份 debug 日志',
            md: '复现一次，把 `--log-level debug` 期间的日志保存下来。注意先确认里面没有密钥。',
            code: { lang: 'bash', code: 'aragon --log-level debug --log-file /tmp/aragon-debug.log -p "复现步骤"' },
          },
          {
            title: '配置快照',
            md: '`aragon config list` 的输出（先把 `apiKeys` 里的值抹掉）。',
          },
        ],
      },
      {
        t: 'callout',
        kind: 'danger',
        title: '日志里可能有你的提示词',
        md: 'debug 级别会记录请求内容。分享前先搜一遍 `apiKeys`、`Bearer`、以及内部的 URL。',
      },
    ],
  },

  {
    id: 'config/context-window',
    title: '上下文窗口与模型表',
    group: 'config',
    order: 60,
    phase: 'B',
    template: 'prose',
    summary:
      '`contextWindow` 为什么默认是自动、模型表从哪里来、`model-windows.json` 的手工覆盖怎么用，以及自动值不可信时怎么办。',
    keywords: ['contextWindow', '上下文窗口', 'model-windows.json', 'token', '模型表'],
    seeAlso: ['guide/context', 'api/limits', 'config/reference'],
    sourceRefs: [
      { path: 'packages/core/src/llm/context-window.ts', lines: '1-40', snippet: 'context' },
      { path: 'packages/cli/README.md', lines: '2310-2400', snippet: 'context' },
    ],
    blocks: [
      {
        t: 'p',
        md:
          '上下文窗口不是"配一个数字就完事"：它同时影响能塞多少历史、什么时候触发压缩、以及输出上限能不能开满。' +
          '所以默认值是 **auto** —— 引擎去查真实模型，而不是在这里再写一遍可能过期的数字。',
      },
      {
        t: 'h2',
        text: '解析顺序',
      },
      {
        t: 'steps',
        items: [
          {
            title: '显式配置优先',
            md: '`config.json` 的 `contextWindow` 一旦是数字，其它来源都不再参与。',
          },
          {
            title: '模型表',
            md: '内置目录 + Provider 返回的模型信息（`ModelInfo.contextWindow`）。',
          },
          {
            title: '手工覆盖',
            md: '`model-windows.json` 用来修正上游给错或没给的模型窗口；它比内置表优先。',
          },
          {
            title: '兜底',
            md: '都没有时用一个明确标记的保守值，并且 `contextWindowSource` 会告诉你这次用的是哪一档。',
          },
        ],
      },
      {
        t: 'h2',
        text: '怎么确认这次用了多少',
      },
      {
        t: 'code',
        lang: 'bash',
        title: '看上下文用量',
        code: '/context',
      },
      {
        t: 'p',
        md:
          '`/context` 会显示已用 token、上限、以及上限的来源（`api` / `catalog` / `fallback` / `user`）。' +
          '看到 `fallback` 就该考虑手工覆盖了。',
      },
      {
        t: 'callout',
        kind: 'warn',
        title: '把 `contextWindow` 设小不是"省钱开关"',
        md:
          '设小会提前触发压缩，压缩本身要花一次模型调用。真要省钱用更便宜的模型或更少的回合。',
      },
    ],
  },
];

/**
 * 把配置键分组渲染成「H2 + 表格」序列。
 *
 * @param {Map<string, object[]>} groups 分组
 * @returns {object[]} block 序列
 */
function renderKeySections(groups) {
  const blocks = [];
  for (const [title, records] of groups) {
    blocks.push({ t: 'h2', text: title });
    if (records.length <= 18) {
      blocks.push(keyTable(title, records));
      continue;
    }
    for (let index = 0; index < records.length; index += 18) {
      blocks.push(keyTable(`${title}（续 ${Math.floor(index / 18) + 1}）`, records.slice(index, index + 18)));
    }
  }
  return blocks;
}
