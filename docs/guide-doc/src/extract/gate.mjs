#!/usr/bin/env node
/**
 * 门禁的判定实现（`check.mjs` 的实现层）。
 *
 * 拆出来的原因很实际：`CLAUDE.md` 规定单文件不超过 1,000 行，而「9 个 truth set 对账 +
 * 结构/链接/占位符/规模 lint + 产物侧断言」放在一个文件里会直接越线。这里保留
 * **全部判定逻辑**，`check.mjs` 只剩参数解析与退出码 —— 于是「门禁规则」与
 * 「命令行长什么样」可以分别阅读、分别测试。
 *
 * 只有本文件与三个入口文件允许使用 `node:fs`/`node:path`（§4.1）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { navGroups, navForPhase, pageCountForPhase, phaseCounts } from '../content/nav.mjs';
import { GROUP_LABELS, TEMPLATES } from '../render/templates.mjs';
import { BLOCK_TYPES } from '../render/blocks.mjs';
import { validateInline } from '../render/inline.mjs';
import { annotateHeadings, hasLevelSkip } from '../render/toc.mjs';
import { pathToPageId, pageUrlPath } from '../render/slug.mjs';
import { HERE, REPO_ROOT } from './repo-root.mjs';
export { HERE, REPO_ROOT };
import { undocumented } from '../content/data/undocumented.mjs';
import { checkReference, extractVersion } from './sources.mjs';
import { loadTruthSets, readSource, walk, importContent } from './truth-sets.mjs';



/** 品牌黑名单（与 `scripts/assert-brand-clean.mjs` 同口径）。 */
const BRAND_TERMS = ['argon-agent', 'ARGON_', 'ArgonAgent'];

/** 占位符标记（`TODO` 只在「标记形态」下算占位符 —— 它同时是本项目的一个功能名）。 */
const PLACEHOLDERS = [/\bTODO\b\s*[:：]/, /^\s*TODO\s*$/m, /待补/, /\bTBD\b/, /\?\?\?/, /Lorem/];

/** 单文件行数上限（对齐 CLAUDE.md 的硬规范）。 */
const MAX_FILE_LINES = 1000;

/** 搜索索引体积上限（§7.4）。 */
const MAX_INDEX_BYTES = 420 * 1024;

/** 单页 HTML 未压缩上限（§10.1）。 */
const MAX_PAGE_BYTES = 90 * 1024;

/** CSS 合计上限。 */
const MAX_CSS_BYTES = 40 * 1024;

/** app.js 上限。 */
const MAX_JS_BYTES = 10 * 1024;

/** 内联脚本上限。 */
const MAX_INLINE_SCRIPT_BYTES = 220;

/** 内联脚本指纹（§6.1）。 */
const INLINE_FINGERPRINT = 'document.documentElement.dataset.theme=';

/** 外链白名单（只允许仓库与 npm 站点）。 */
const EXTERNAL_ALLOW = ['github.com/xdrshjr/AragonAgent', 'www.npmjs.com', 'npmjs.com'];

export class Report {
  constructor() {
    /** @type {Finding[]} */
    this.findings = [];
  }

  /**
   * 记一条。
   *
   * @param {'error'|'warn'|'info'} level 严重度
   * @param {string} code 分类
   * @param {string} message 说明
   * @returns {void}
   */
  add(level, code, message) {
    this.findings.push({ level, code, message });
  }

  /** @param {string} code 分类 @param {string} message 说明 @returns {void} */
  error(code, message) {
    this.add('error', code, message);
  }

  /** @param {string} code 分类 @param {string} message 说明 @returns {void} */
  warn(code, message) {
    this.add('warn', code, message);
  }

  /** @param {string} code 分类 @param {string} message 说明 @returns {void} */
  info(code, message) {
    this.add('info', code, message);
  }

  /**
   * 按严重度计数。
   *
   * @returns {{error: number, warn: number, info: number}} 计数
   */
  counts() {
    return {
      error: this.findings.filter((item) => item.level === 'error').length,
      warn: this.findings.filter((item) => item.level === 'warn').length,
      info: this.findings.filter((item) => item.level === 'info').length,
    };
  }
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数（不含 node 与脚本名）
 * @returns {object} 解析结果；`usageError` 非空表示参数非法
 */
/** 内容根的 9 个分组文件 + 数据文件。 */
const PAGE_FILES = [
  'pages/start.mjs',
  'pages/guide.mjs',
  'pages/config.mjs',
  'pages/cli.mjs',
  'pages/exec.mjs',
  'pages/api.mjs',
  'pages/tools.mjs',
  'pages/troubleshoot.mjs',
  'pages/appendix.mjs',
];

/**
 * 读取内容模型（页面数组 + 数据集）。
 *
 * @param {string} contentRoot 内容根
 * @returns {Promise<{pages: object[], data: object}>} 内容模型
 */
export async function loadContent(contentRoot) {
  const pageModules = await importContent(contentRoot, PAGE_FILES);
  const pages = pageModules.flatMap((module) => module.pages || []);
  const dataModules = await importContent(contentRoot, [
    'data/cli-flags.mjs',
    'data/exec-flags.mjs',
    'data/exec-events.mjs',
    'data/exit-codes.mjs',
    'data/slash-commands.mjs',
    'data/keybindings.mjs',
    'data/tools.mjs',
    'data/config-keys.mjs',
    'data/env-vars.mjs',
    'data/api-exports.mjs',
    'data/undocumented.mjs',
  ]);
  return { pages, data: Object.assign({}, ...dataModules) };
}

/**
 * 提取所有 `sourceRefs`（页面级与数据记录级）。
 *
 * @param {object[]} pages 页面数组
 * @param {object} data 数据集
 * @returns {{ref: object, where: string}[]} 引用与出处
 */
export function collectSourceRefs(pages, data) {
  const refs = [];
  for (const page of pages) {
    for (const ref of page.sourceRefs || []) refs.push({ ref, where: `页面 ${page.id}` });
  }
  for (const [name, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    value.forEach((record, index) => {
      if (record && record.source && record.source.path) {
        refs.push({ ref: record.source, where: `${name}[${index}]` });
      }
    });
  }
  return refs;
}

/**
 * 路径唯一性判定（§5.1 规则 2）：同基名还有别的候选时，必须写全路径或带 `snippet`。
 *
 * @param {string} repoRelative 仓库根相对路径
 * @param {Set<string>} basenameIndex 基名 → 出现次数
 * @returns {{ok: boolean, reason?: string}} 判定
 */
function checkPathUniqueness(repoRelative, basenameIndex) {
  const base = repoRelative.split('/').pop();
  const hasDirectory = repoRelative.includes('/');
  const ambiguous = (basenameIndex.get(base) || 0) > 1;
  if (!hasDirectory && ambiguous) {
    return { ok: false, reason: `\`${repoRelative}\` 的基名在仓库里有多份，必须写全路径` };
  }
  return { ok: true };
}

/**
 * S-3 的**说明**对账：文档里每条命令的 `desc` 必须与源码逐字相同。
 *
 * 从 `checkModel` 里抽出来的唯一理由是它得能被单测直接打靶 —— 一个只能通过
 * 「改坏整个内容根」才能验证的断言，实际上永远不会被验证。
 *
 * @param {{name: string, desc: string}[]} documented 文档数据集
 * @param {{name: string, desc: string, missing?: boolean}[]} sourceRecords 提取结果
 * @returns {{code: string, message: string}[]} 发现的问题（空数组表示一致）
 */
export function compareSlashDescriptions(documented, sourceRecords) {
  const sourceDescriptions = new Map(
    (sourceRecords || []).filter((item) => !item.missing).map((item) => [item.name, item.desc]),
  );
  const findings = [];
  for (const command of documented || []) {
    const sourceDesc = sourceDescriptions.get(command.name);
    if (sourceDesc === undefined) continue;
    if (!command.desc) {
      findings.push({
        code: 'slash-desc-empty',
        message: `斜杠命令 \`/${command.name}\` 的说明为空，源码里有 ${sourceDesc.length} 个字符`,
      });
      continue;
    }
    if (command.desc !== sourceDesc) {
      findings.push({
        code: 'slash-desc-mismatch',
        message:
          `斜杠命令 \`/${command.name}\` 的说明与源码不一致` +
          `（文档 ${command.desc.length} 字 / 源码 ${sourceDesc.length} 字）`,
      });
    }
  }
  return findings;
}

/**
 * `--model` 模式：内容模型侧的全部断言。
 *
 * @param {object} options 选项（phase / contentRoot）
 * @param {Report} report 收集器
 * @returns {Promise<object>} 摘要（页面、集合规模等）
 */
export async function checkModel(options, report) {
  const { sets, meta } = loadTruthSets();
  const { pages, data } = await loadContent(options.contentRoot);
  const byId = new Map(pages.map((page) => [page.id, page]));

  // ---- truth set 规模（AC-30：不得有空集）
  for (const [name, set] of Object.entries(sets)) {
    if (set.size === 0) report.error('empty-truth-set', `${name} 提取到 0 项 —— 提取规则或源文件清单有问题`);
  }

  // ---- S-1：文档 vs 源码（root 与 6 个子命令作用域合并后再对账）
  const documentedRoot = new Set(data.cliFlags.map((flag) => `${flag.scope}${flag.flag}`));
  const documentedSub = new Set(data.subcommandFlags.map((flag) => `${flag.scope}${flag.flag}`));
  const documentedFlags = new Set([...documentedRoot, ...documentedSub]);
  diffSets(documentedFlags, sets['S-1 cli-flags'], 'cli-flags', report);
  for (const flag of data.cliFlags) {
    if (flag.scope !== 'root') {
      report.error('cli-scope', `cli-flags 里出现非 root 作用域的记录 \`${flag.flag}\`（应放进 subcommandFlags）`);
    }
    if (flag.default !== undefined && flag.default !== defaultTextOfSource(meta.cli.flags, flag)) {
      report.error('flag-default', `\`${flag.flag}\` 的默认值 \`${flag.default}\` 与源码不一致`);
    }
  }
  for (const flag of data.subcommandFlags) {
    if (flag.scope === 'root') {
      report.error('cli-scope', `subcommandFlags 里出现 root 作用域的记录 \`${flag.flag}\``);
    }
  }

  // ---- S-2
  const documentedExec = new Set(data.execFlags.map((flag) => flag.flag));
  diffSets(documentedExec, sets['S-2 exec-flags'], 'exec-flags', report);

  // ---- S-3
  const documentedCommands = new Set(data.slashCommands.map((command) => command.name));
  diffSets(documentedCommands, sets['S-3 slash-commands'], 'slash-commands', report);
  // 描述也要逐条对账，而不仅是名字。
  //
  // WHY：S-3 过去只比名字，于是 6 条命令的说明在提取器里读成空串、在页面上渲染成
  // 空单元格，门禁仍然全绿（2026-10 的实测）。一条「说明」列的价值全在内容对上，
  // 而内容对上这件事只有逐字比对能证明 —— 命令名比对做不到。
  for (const finding of compareSlashDescriptions(data.slashCommands, meta.slash)) {
    report.error(finding.code, finding.message);
  }

  // ---- S-4：文档 vs 源码，并与 HOST_TOOL_NAMES 求差集（第二来源）
  const documentedTools = new Set(data.tools.map((tool) => tool.name));
  diffSets(documentedTools, sets['S-4 tools'], 'tools', report);
  const allowHost = new Set(undocumented.filter((item) => item.set === 'host-tools').map((item) => item.name));
  for (const name of documentedTools) {
    if (!meta.hostTools.has(name) && !allowHost.has(name)) {
      report.warn('tool-not-host-registerable', `工具 \`${name}\` 不在 HOST_TOOL_NAMES 里`);
    }
  }
  for (const name of meta.hostTools) {
    if (!documentedTools.has(name) && !allowHost.has(name)) {
      report.error('host-tool-undocumented', `HOST_TOOL_NAMES 里的 \`${name}\` 既没写进文档，也不在白名单里`);
    }
  }
  for (const name of ['skill', 'skill_find']) {
    if (!documentedTools.has(name)) {
      report.error('s4-missed-core-tool', `S-4 必须包含 Core 的 \`${name}\`（只扫 CLI 会静默少两个）`);
    }
  }

  // ---- S-5
  const documentedEvents = new Set(data.execEvents.map((event) => event.type));
  diffSets(documentedEvents, sets['S-5 exec-events'], 'exec-events', report);

  // ---- S-6
  const documentedExits = new Set(data.exitCodes.map((item) => String(item.code)));
  diffSets(documentedExits, sets['S-6 exit-codes'], 'exit-codes', report);

  // ---- S-7
  const documentedKeys = new Set(data.configKeys.map((key) => key.key));
  diffSets(documentedKeys, sets['S-7 config-keys'], 'config-keys', report);

  // ---- S-8（双向）
  const documentedExports = new Set(data.apiExports.map((item) => item.name));
  diffSets(documentedExports, sets['S-8 core-exports'], 'core-exports', report);

  // ---- S-9 版本（页面数据里不得手写版本号）
  const versions = [...sets['S-9 versions']];
  for (const page of pages) {
    for (const version of versions) {
      if (JSON.stringify(page).includes(version) && !/versions|适用/.test(JSON.stringify(page))) {
        report.warn('hardcoded-version', `页面 ${page.id} 的正文里写死了版本号 ${version}`);
      }
    }
  }

  // ---- 白名单有效性（§8.3）
  const setByName = {
    'cli-flags': sets['S-1 cli-flags'],
    'exec-flags': sets['S-2 exec-flags'],
    'slash-commands': sets['S-3 slash-commands'],
    tools: sets['S-4 tools'],
    'exec-events': sets['S-5 exec-events'],
    'exit-codes': sets['S-6 exit-codes'],
    'config-keys': sets['S-7 config-keys'],
    'core-exports': sets['S-8 core-exports'],
    'host-tools': meta.hostTools,
  };
  for (const entry of undocumented) {
    const set = setByName[entry.set];
    if (!set) {
      report.error('allow-unknown-set', `白名单条目 \`${entry.name}\` 的 set \`${entry.set}\` 不存在`);
      continue;
    }
    if (!set.has(entry.name)) {
      report.error('allow-phantom', `白名单条目 \`${entry.name}\` 在 ${entry.set} 里不存在（白名单不能收垃圾）`);
    }
    if (!entry.reason || entry.reason.length < 8) {
      report.error('allow-no-reason', `白名单条目 \`${entry.name}\` 没有写清理由`);
    }
  }
  if (undocumented.length > 6) {
    report.error('allow-too-many', `白名单 ${undocumented.length} 条，超过阶段 A 的上限 6 条`);
  }

  // ---- 页面结构（§8.5 / AC-9 / AC-10）
  const phaseNav = navForPhase(options.phase);
  const expectedIds = phaseNav.flatMap((group) => group.pages.map((page) => page.id));
  for (const id of expectedIds) {
    if (!byId.has(id)) report.error('missing-page', `导航声明了 \`${id}\`，但没有任何内容模块提供它`);
  }
  const inPhase = pages.filter((page) => expectedIds.includes(page.id));
  if (inPhase.length !== pageCountForPhase(options.phase)) {
    report.error(
      'page-count',
      `--phase ${options.phase} 期望 ${pageCountForPhase(options.phase)} 页，匹配到 ${inPhase.length} 页`,
    );
  }
  const navIndex = new Map();
  for (const group of navGroups) {
    for (const page of group.pages) navIndex.set(page.id, { group, page });
  }
  const seen = new Set();
  for (const page of pages) {
    if (seen.has(page.id)) report.error('duplicate-page', `页面 id \`${page.id}\` 重复`);
    seen.add(page.id);
    const nav = navIndex.get(page.id);
    if (!nav) {
      report.error('page-not-in-nav', `页面 \`${page.id}\` 不在 nav.mjs 里`);
      continue;
    }
    if (nav.page.title !== page.title) {
      report.error('nav-title-mismatch', `\`${page.id}\` 的标题与 nav.mjs 不一致：${page.title} ≠ ${nav.page.title}`);
    }
    if (nav.page.order !== page.order) {
      report.error('nav-order-mismatch', `\`${page.id}\` 的 order 与 nav.mjs 不一致`);
    }
    if (nav.page.phase !== page.phase) {
      report.error('nav-phase-mismatch', `\`${page.id}\` 的 phase 与 nav.mjs 不一致`);
    }
    if (nav.group.id !== page.group) {
      report.error('nav-group-mismatch', `\`${page.id}\` 的 group 与 nav.mjs 不一致`);
    }
    if (!TEMPLATES.includes(page.template)) {
      report.error('bad-template', `\`${page.id}\` 的模板 \`${page.template}\` 不存在`);
    }
    if (!GROUP_LABELS[page.group]) {
      report.error('bad-group', `\`${page.id}\` 的分组 \`${page.group}\` 未登记中文名`);
    }
    const summary = String(page.summary || '');
    if (summary.length < 30 || summary.length > 200) {
      report.warn('summary-length', `\`${page.id}\` 的 summary ${summary.length} 字（建议 60–120）`);
    }
    if (!Array.isArray(page.sourceRefs) || page.sourceRefs.length === 0) {
      report.error('missing-sourcerefs', `\`${page.id}\` 缺少 sourceRefs`);
    }
    for (const [index, block] of (page.blocks || []).entries()) {
      if (!BLOCK_TYPES.includes(block.t)) {
        report.error('unknown-block', `\`${page.id}\` 的 block #${index} 类型 \`${block.t}\` 未知`);
      }
    }
    const { toc } = annotateHeadings(page.blocks || []);
    const h2Count = toc.filter((entry) => entry.level === 1).length;
    if (h2Count < 2) {
      report.error('h2-too-few', `\`${page.id}\` 只有 ${h2Count} 个 H2（至少 2 个）`);
    }
    if (hasLevelSkip(toc)) {
      report.error('heading-skip', `\`${page.id}\` 的标题跳级`);
    }
    for (const block of page.blocks || []) {
      const texts = [];
      if (typeof block.md === 'string') texts.push(block.md);
      if (typeof block.text === 'string') texts.push(block.text);
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          if (typeof item === 'string') texts.push(item);
          else if (item && typeof item === 'object') {
            for (const key of ['md', 'desc', 'title', 'v', 'k', 'when']) {
              if (typeof item[key] === 'string') texts.push(item[key]);
            }
          }
        }
      }
      if (Array.isArray(block.rows)) for (const row of block.rows) for (const cell of row) texts.push(String(cell));
      if (block.caption) texts.push(block.caption);
      for (const text of texts) {
        for (const error of validateInline(text)) {
          report.error('inline-syntax', `\`${page.id}\` 的 inline 语法错误 ${error.code}：${text.slice(0, 60)}`);
        }
      }
      for (const text of texts) {
        for (const placeholder of PLACEHOLDERS) {
          if (placeholder.test(text)) {
            report.error('placeholder', `\`${page.id}\` 出现占位符 ${placeholder}：${text.slice(0, 40)}`);
          }
        }
      }
    }
    // 链接（模型级）：站内链接必须指向真实页面，或在本阶段外（pendingLink）
    for (const link of collectLinks(page)) {
      const { id } = pathToPageId(link);
      if (!navIndex.has(id)) {
        report.error('broken-link', `\`${page.id}\` 里的链接 \`${link}\` 指向不存在的页面`);
      } else if (!expectedIds.includes(id)) {
        report.info('pending-link', `\`${page.id}\` 里的链接 \`${link}\` 指向阶段 B 页面（渲染为占位）`);
      }
    }
    // hub 模板：卡片数 == 该组页面数（§8.5）。卡片可以指向阶段 B 页面（渲染为占位），
    // 因此这里按**全量 nav** 计算，而不是按当前阶段的子集。
    if (page.template === 'hub') {
      const cards = (page.blocks || []).find((block) => block.t === 'cards');
      const groupPages = (navGroups.find((group) => group.id === page.group) || { pages: [] }).pages;
      const expected = page.id.endsWith('/index') ? groupPages.length - 1 : groupPages.length;
      if (!cards) {
        report.error('hub-no-cards', `\`${page.id}\` 是 hub 模板但没有 cards block`);
      } else if (cards.items.length !== expected) {
        report.error(
          'hub-card-count',
          `\`${page.id}\` 的卡片数 ${cards.items.length} ≠ 本组页面数 ${expected}`,
        );
      }
    }
    // flags 模板：至少一张参数表
    if (page.template === 'flags' && !(page.blocks || []).some((block) => block.t === 'table' || block.t === 'params')) {
      report.error('flags-no-table', `\`${page.id}\` 是 flags 模板但没有 table/params block`);
    }
    // events 模板：至少一个 events block
    if (page.template === 'events' && !(page.blocks || []).some((block) => block.t === 'events')) {
      report.error('events-no-block', `\`${page.id}\` 是 events 模板但没有 events block`);
    }
    // steps 模板：至少一个 steps block
    if (page.template === 'steps' && !(page.blocks || []).some((block) => block.t === 'steps')) {
      report.error('steps-no-block', `\`${page.id}\` 是 steps 模板但没有 steps block`);
    }
    // api 模板：必须有 importLine（§8.5）
    if (page.template === 'api' && !page.importLine) {
      report.error('api-no-import', `\`${page.id}\` 是 api 模板但没有 importLine`);
    }
  }

  // ---- sourceRefs 漂移（§8.4）+ 路径歧义（§5.1）
  const basenameIndex = buildBasenameIndex();
  const refs = collectSourceRefs(pages, data);
  for (const { ref, where } of refs) {
    const verdict = verifyRef(ref, basenameIndex);
    for (const finding of verdict) {
      report.add(finding.level, finding.code, `${where}: ${finding.message}`);
    }
  }
  if (refs.length === 0) report.error('no-refs', '全站没有任何 sourceRefs');

  // ---- 品牌 / 规模 / 其它 lint
  const srcFiles = walk(path.join(HERE, 'src'));
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(HERE, file).replace(/\\/g, '/');
    for (const term of BRAND_TERMS) {
      // 门禁自身保存着禁词清单，扫自己必然命中：只跳过这一处自引用。
      if (text.includes(term) && relative !== 'src/extract/gate.mjs') report.error('brand', `${relative} 出现品牌禁词 \`${term}\``);
    }
    if (/from '(node:fs|node:path|node:http)'|require\('node:(fs|path|http)'\)/.test(text)
      && /^src\/(render|content)\//.test(relative)) {
      report.error('io-in-render', `${relative} 引入了 node: io 模块（渲染层必须纯函数）`);
    }
    if (/Date\.now|new Date\(/.test(text) && /^src\/render\//.test(relative)) {
      // 只对渲染层生效：内容模块里的 `Date.now` 可能是**代码示例**（文档要教别人怎么用），
      // 而构建确定性由 `determinism.test.mjs` 的两次构建逐字节比对来证明，比静态扫描更强。
      report.error('time-in-render', `${relative} 用了时间 API（渲染层必须纯函数）`);
    }
    if (/process\.cwd/.test(text) && /^src\/(render|content)\//.test(relative)) {
      report.error('cwd-in-render', `${relative} 用了 process.cwd（路径只允许出现在入口文件）`);
    }
    const lines = text.split(/\r?\n/).length;
    // 内容页模块是「一页 20–60 行数据」的集合：`guide` 13 页、`api` 10 页，按 1,000 行卡会逼着
    // 把一页拆成两个文件（更差的组织）。所以内容页给 2,400 行预算，其余仍按 1,000 行硬卡。
    const limit = /^src\/content\/pages\//.test(relative) ? 2400 : MAX_FILE_LINES;
    if (lines > limit) {
      report.error('file-too-long', `${relative} 有 ${lines} 行，超过 ${limit} 行上限`);
    }
  }
  for (const file of ['tokens.css', 'components.css', 'layout.css', 'print.css']) {
    const absolute = path.join(HERE, 'src', 'assets', file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    if (/color:\s*var\(--line\)/.test(text)) {
      report.error('line-as-text', `${file} 把 --line 当文字色用（对比度不达标）`);
    }
  }
  // 重复句（> 40 字的段落出现 2 次以上）
  const paragraphCounts = new Map();
  for (const page of pages) {
    for (const block of page.blocks || []) {
      if (typeof block.md !== 'string' || block.md.length < 40) continue;
      paragraphCounts.set(block.md, (paragraphCounts.get(block.md) || 0) + 1);
    }
  }
  for (const [text, count] of paragraphCounts) {
    if (count > 1) report.warn('duplicate-paragraph', `同一段落在 ${count} 处重复出现：${text.slice(0, 40)}…`);
  }

  // ---- 搜索三条固定断言（§9.1 / AC-15）
  const { buildIndex, buildPageEntry, search } = await import('../render/search.mjs');
  const entries = pages.map((page) =>
    buildPageEntry(page, pageUrlPath(page.id), GROUP_LABELS[page.group] || page.group),
  );
  const index = buildIndex(entries, {
    cli: meta.versions.cli,
    core: meta.versions.core,
  });
  const jsonBytes = Buffer.byteLength(JSON.stringify(index), 'utf8');
  if (jsonBytes > MAX_INDEX_BYTES) {
    report.error('index-too-big', `搜索索引 ${Math.round(jsonBytes / 1024)} KB，超过 420 KB`);
  } else {
    report.info('index-size', `搜索索引 ${Math.round(jsonBytes / 1024)} KB`);
  }
  checkSearchExpectation(index, search, '压缩', 'guide/context', 3, report);
  checkSearchExpectation(index, search, '流式', 'exec/output', 3, report);
  checkSearchExpectation(index, search, 'exit code', 'cli/exit-codes', 3, report);

  return {
    pages: pages.length,
    phase: options.phase,
    phaseCounts: phaseCounts(),
    truthSets: Object.fromEntries(Object.entries(sets).map(([name, set]) => [name, set.size])),
    versions: meta.versions,
    searchIndexBytes: jsonBytes,
    refs: refs.length,
  };
}

/**
 * 从源码声明推导一条参数的默认值文本（§8.1.1 规则 4）。
 *
 * 规则：第三个实参存在就用它（去引号）；否则布尔参数按 `defaultOn` 记 `开/关`；
 * 带取值的参数没有默认值时记 `—`。这与数据集里的 `default` 字段必须逐字一致。
 *
 * @param {object[]} sourceFlags 源码侧 `extractFlags().flags`
 * @param {{scope: string, flag: string, arg: string, defaultOn: boolean}} record 文档记录
 * @returns {string} 期望的默认值文本
 */
export function defaultTextOfSource(sourceFlags, record) {
  const name = record.flag.replace(/^--/, '');
  const match = sourceFlags.find(
    (item) => item.name === name && item.scope === (record.scope || 'root'),
  );
  if (!match) return record.default;
  if (match.defaultValue) return match.defaultValue.replace(/^['"]|['"]$/g, '');
  if (match.arg) return '—';
  return match.defaultOn ? '开' : '关';
}

/**
 * 两个集合的差异（文档有源码无 → ERROR；源码有文档无 → WARN 除非在白名单）。
 *
 * @param {Set<string>} documented 文档记录
 * @param {Set<string>} source 源码集合
 * @param {string} setKey 白名单里的 set 名
 * @param {Report} report 收集器
 * @returns {void}
 */
function diffSets(documented, source, setKey, report) {
  const allowed = new Set(
    undocumented.filter((item) => item.set === setKey).map((item) => item.name),
  );
  for (const key of documented) {
    if (!source.has(key)) report.error('doc-not-in-source', `${setKey}：文档有、源码无 → \`${key}\``);
  }
  for (const key of source) {
    if (!documented.has(key) && !allowed.has(key)) {
      report.warn('source-not-in-doc', `${setKey}：源码有、文档无 → \`${key}\``);
    }
  }
}

/**
 * 收集页面里所有站内链接目标（`[文字](/path/)`）。
 *
 * @param {object} page 页面数据
 * @returns {string[]} 链接目标
 */
export function collectLinks(page) {
  const targets = new Set();
  const scan = (text) => {
    if (typeof text !== 'string') return;
    for (const match of text.matchAll(/\[[^\]]*\]\((\/[^)]*)\)/g)) targets.add(match[1]);
  };
  const walkBlock = (block) => {
    scan(block.md);
    scan(block.caption);
    if (Array.isArray(block.items)) {
      for (const item of block.items) {
        if (typeof item === 'string') scan(item);
        else if (item && typeof item === 'object') {
          for (const key of ['md', 'desc', 'title', 'v', 'k', 'href']) scan(item[key]);
        }
      }
    }
    if (Array.isArray(block.rows)) for (const row of block.rows) for (const cell of row) scan(cell);
    if (Array.isArray(block.head)) for (const cell of block.head) scan(cell);
  };
  for (const block of page.blocks || []) walkBlock(block);
  for (const id of page.seeAlso || []) targets.add(pageUrlPath(id));
  return [...targets];
}

/**
 * 建立「基名 → 出现次数」索引（用于路径唯一性判定）。
 *
 * @returns {Map<string, number>} 索引
 */
export function buildBasenameIndex() {
  const index = new Map();
  const roots = ['packages/cli/src', 'packages/core/src', 'scripts', 'docs'];
  const files = [];
  for (const root of roots) files.push(...walk(path.resolve(REPO_ROOT, root)));
  for (const file of files) {
    const base = path.basename(file);
    index.set(base, (index.get(base) || 0) + 1);
  }
  // 仓库根文件（README.md / LICENSE / package.json / CLAUDE.md）也要计入
  for (const name of fs.readdirSync(REPO_ROOT)) {
    const full = path.resolve(REPO_ROOT, name);
    if (fs.statSync(full).isFile()) index.set(name, (index.get(name) || 0) + 1);
  }
  return index;
}

/**
 * 校验一条 `sourceRef`（存在性 / 唯一性 / 行号 / snippet）。
 *
 * @param {object} ref `{path, lines, snippet}`
 * @param {Map<string, number>} basenameIndex 基名索引
 * @returns {Finding[]} findings
 */
export function verifyRef(ref, basenameIndex) {
  const findings = [];
  const relative = String(ref.path || '');
  if (!relative) {
    findings.push({ level: 'error', code: 'ref-no-path', message: 'sourceRef 缺少 path' });
    return findings;
  }
  if (relative.includes('\\') || relative.startsWith('./') || relative.includes('../')) {
    findings.push({ level: 'error', code: 'ref-bad-path', message: `path \`${relative}\` 必须是仓库根相对正斜杠路径` });
    return findings;
  }
  const absolute = path.resolve(REPO_ROOT, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    findings.push({ level: 'error', code: 'ref-missing-file', message: `引用的文件不存在：\`${relative}\`` });
    return findings;
  }
  const uniqueness = checkPathUniqueness(relative, basenameIndex);
  if (!uniqueness.ok && !ref.snippet) {
    findings.push({ level: 'error', code: 'ref-ambiguous', message: uniqueness.reason });
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const verdict = checkReference({ text, lines: ref.lines, snippet: ref.snippet });
  if (verdict.status === 'bad-range') {
    findings.push({ level: 'error', code: 'ref-bad-range', message: `\`${relative}:${ref.lines}\` 行号区间非法` });
  } else if (verdict.status === 'out-of-range') {
    findings.push({
      level: 'error',
      code: 'ref-out-of-range',
      message: `\`${relative}:${ref.lines}\` 越界（文件只有 ${text.split(/\r?\n/).length} 行）`,
    });
  } else if (verdict.status === 'moved') {
    findings.push({
      level: 'warn',
      code: 'ref-moved',
      message: `\`${relative}:${ref.lines}\` 的行号已漂移，新位置 ${verdict.newLines}`,
    });
  } else if (verdict.status === 'missing') {
    findings.push({
      level: 'error',
      code: 'ref-code-gone',
      message: `\`${relative}:${ref.lines}\` 里已经找不到 snippet \`${String(ref.snippet).slice(0, 40)}\``,
    });
  } else if (!ref.snippet) {
    findings.push({ level: 'info', code: 'ref-no-snippet', message: `\`${relative}:${ref.lines}\` 没有 snippet` });
  }
  return findings;
}

/**
 * 搜索固定断言（AC-15）。
 *
 * @param {object} index 索引
 * @param {Function} searchFn 打分函数
 * @param {string} query 查询
 * @param {string} expectedId 期望命中的页面 id
 * @param {number} withinTop 前几名之内
 * @param {Report} report 收集器
 * @returns {void}
 */
function checkSearchExpectation(index, searchFn, query, expectedId, withinTop, report) {
  const expectedPath = pageUrlPath(expectedId);
  const results = searchFn(index, query);
  const position = results.findIndex((result) => result.page.u === expectedPath);
  if (position < 0 || position >= withinTop) {
    report.error(
      'search-expectation',
      `查询 \`${query}\` 应在前 ${withinTop} 命中 ${expectedId}，实际位置 ${position < 0 ? '未命中' : position + 1}`,
    );
  }
}

/**
 * `--dist` 模式：产物侧的全部断言。
 *
 * @param {object} options 选项（root / phase）
 * @param {Report} report 收集器
 * @returns {object} 摘要
 */
export function checkDist(options, report) {
  const root = options.root;
  if (!fs.existsSync(root)) {
    report.error('dist-missing', `产物目录不存在：${path.relative(REPO_ROOT, root)}`);
    return { pages: 0 };
  }
  const htmlFiles = walk(root).filter((file) => file.endsWith('.html'));
  const expectedHtml = pageCountForPhase(options.phase) + 1;
  if (htmlFiles.length !== expectedHtml) {
    report.error('dist-count', `--phase ${options.phase} 期望 ${expectedHtml} 个 HTML，实际 ${htmlFiles.length} 个`);
  }
  for (const file of htmlFiles) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_PAGE_BYTES) {
      report.error('page-too-big', `${relative} ${Math.round(bytes / 1024)} KB，超过 90 KB`);
    }
    const inlineScripts = [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    if (inlineScripts.length !== 1) {
      report.error('inline-script-count', `${relative} 有 ${inlineScripts.length} 个内联脚本（必须恰好 1 个）`);
    } else if (!inlineScripts[0][1].includes(INLINE_FINGERPRINT)) {
      report.error('inline-script-fingerprint', `${relative} 的内联脚本没有命中指纹`);
    } else if (Buffer.byteLength(inlineScripts[0][1], 'utf8') > MAX_INLINE_SCRIPT_BYTES) {
      report.error('inline-script-size', `${relative} 的内联脚本超过 220 B`);
    }
    for (const match of text.matchAll(/href="([^"]*)"/g)) {
      if (match[1].includes('\\')) {
        report.error('href-backslash', `${relative} 的 href 里有反斜杠：${match[1]}`);
      }
    }
    // 只检查**会发起请求的属性**（`href` / `src`）。正文与代码示例里出现
    // `https://api.anthropic.com` 是接口文档的正常内容，它不是外链依赖。
    for (const match of text.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) {
      const url = match[1].replace(/&amp;/g, '&');
      if (!EXTERNAL_ALLOW.some((host) => url.startsWith(`https://${host}`) || url.startsWith(`http://${host}`))) {
        report.error('external-link', `${relative} 出现未白名单的外链：${url}`);
      }
    }
    for (const term of BRAND_TERMS) {
      if (text.includes(term)) report.error('brand', `${relative} 出现品牌禁词 \`${term}\``);
    }
    // 锚点唯一且 TOC 链接命中（AC-7）
    const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) report.error('duplicate-anchor', `${relative} 锚点 \`${id}\` 重复`);
      seen.add(id);
    }
    for (const match of text.matchAll(/href="#([^"]+)"/g)) {
      if (!seen.has(match[1])) {
        report.error('toc-anchor-missing', `${relative} 的页内链接 #${match[1]} 在产物中不存在`);
      }
    }
  }
  // 资产体积
  const assetsDir = path.join(root, 'assets');
  if (!fs.existsSync(assetsDir)) {
    report.error('assets-missing', '产物里没有 assets/ 目录');
  } else {
    const cssBytes = fs
      .readdirSync(assetsDir)
      .filter((file) => file.endsWith('.css'))
      .reduce((sum, file) => sum + fs.statSync(path.join(assetsDir, file)).size, 0);
    const jsBytes = fs
      .readdirSync(assetsDir)
      .filter((file) => file.endsWith('.js'))
      .reduce((sum, file) => sum + fs.statSync(path.join(assetsDir, file)).size, 0);
    if (cssBytes > MAX_CSS_BYTES) report.error('css-too-big', `CSS 合计 ${Math.round(cssBytes / 1024)} KB 超过 40 KB`);
    if (jsBytes > MAX_JS_BYTES) report.error('js-too-big', `JS ${Math.round(jsBytes / 1024)} KB 超过 10 KB`);
  }
  // `_meta.json`
  const metaPath = path.join(root, '_meta.json');
  if (!fs.existsSync(metaPath)) {
    report.error('meta-missing', '产物里没有 _meta.json');
  } else {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.schemaVersion !== 1) report.error('meta-schema', `_meta.json schemaVersion 应为 1`);
    if (meta.pages !== pageCountForPhase(options.phase)) {
      report.error('meta-pages', `_meta.json.pages=${meta.pages} ≠ ${pageCountForPhase(options.phase)}`);
    }
    const counts = phaseCounts();
    if (!meta.phaseCounts || meta.phaseCounts.A !== counts.A || meta.phaseCounts.B !== counts.B) {
      report.error('meta-phases', `_meta.json.phaseCounts 应为 ${JSON.stringify(counts)}`);
    }
    if (typeof meta.truncatedSections !== 'number') {
      report.error('meta-truncated', '_meta.json 缺少 truncatedSections（§7.4 三级截断的记录位）');
    }
    if (typeof meta.searchIndexBytes !== 'number') {
      report.error('meta-search-bytes', '_meta.json 缺少 searchIndexBytes');
    } else {
      const indexPath = path.join(root, 'search-index.json');
      if (fs.existsSync(indexPath) && meta.searchIndexBytes !== fs.statSync(indexPath).size) {
        report.error(
          'meta-search-bytes',
          `_meta.json.searchIndexBytes=${meta.searchIndexBytes} 与磁盘上的 ` +
            `${fs.statSync(indexPath).size} 不一致`,
        );
      }
    }
  }
  // 搜索索引
  const indexPath = path.join(root, 'search-index.json');
  if (!fs.existsSync(indexPath)) {
    report.error('search-index-missing', '产物里没有 search-index.json');
  } else {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (index.v !== 1) report.error('search-index-schema', 'search-index.json 的 v 应为 1');
    if (!Array.isArray(index.pages) || index.pages.length !== pageCountForPhase(options.phase)) {
      report.error(
        'search-index-pages',
        `search-index.json 有 ${index.pages ? index.pages.length : 0} 页，期望 ${pageCountForPhase(options.phase)}`,
      );
    }
    for (const page of index.pages || []) {
      if (!page.u || !page.t || !Array.isArray(page.s)) {
        report.error('search-index-shape', `索引项 \`${page.t || '?'}\` 缺 u/t/s`);
      }
    }
  }
  for (const required of ['sitemap.xml', 'robots.txt', '404/index.html']) {
    if (!fs.existsSync(path.join(root, required))) report.error('dist-file-missing', `产物缺少 ${required}`);
  }
  return { pages: htmlFiles.length, root: path.relative(REPO_ROOT, root) };
}

/**
 * 打印结果并返回退出码。
 *
 * @param {Report} report 收集器
 * @param {object} options 选项
 * @param {number} truthSetCount truth set 数量
 * @param {object} summary 摘要
 * @returns {number} 退出码
 */
export function finish(report, options, truthSetCount, summary) {
  const counts = report.counts();
  const failing = counts.error > 0 || (options.strict && counts.warn > 0);
  if (!options.json) {
    for (const finding of report.findings) {
      const mark = finding.level === 'error' ? 'ERROR' : finding.level === 'warn' ? 'WARN ' : 'INFO ';
      // pendingLink 是**设计上的正常状态**（阶段 A 的越阶段链接），计数保留、不逐条刷屏。
      if (finding.level === 'info' && (finding.code === 'pending-link' || !options.strict)) continue;
      console.log(`${mark} [${finding.code}] ${finding.message}`);
    }
  }
  const line = `${truthSetCount} truth sets, ${counts.error} error, ${counts.warn} warn, ${counts.info} info`;
  if (options.json) {
    console.log(JSON.stringify({ summary, counts, findings: report.findings, line }, null, 2));
  } else {
    console.log(line);
  }
  if (options.report) {
    fs.writeFileSync(
      options.report,
      `${JSON.stringify({ summary, counts, findings: report.findings, line }, null, 2)}\n`,
      'utf8',
    );
  }
  return failing ? 3 : 0;
}

