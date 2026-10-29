#!/usr/bin/env node
/**
 * 构建入口（§4.3 的 13 步，顺序不可换）。
 *
 * 这是**唯一写盘者**：读内容 → 渲染 → 校验 → 写 `dist.tmp` → 原子 rename 为 `dist`。
 * 任何一步失败都不会留下半个站点：校验在写盘前跑 `check.mjs --model`，
 * 写盘后在 `dist.tmp` 上跑 `--dist`，只有两者都绿才替换线上目录。
 *
 * 退出码：0 成功 | 1 内容/结构错误 | 2 用法错误 | 3 准确性门禁失败。
 */

import crypto from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { navForPhase, pageCountForPhase, phaseCounts } from './src/content/nav.mjs';
import { withVersions, normalizeBase, absoluteUrl } from './src/site.config.mjs';
import { GROUP_LABELS } from './src/render/templates.mjs';
import { renderPage } from './src/render/page.mjs';
import { render404 } from './src/render/layout.mjs';
import { outputPath, pageUrlPath } from './src/render/slug.mjs';
import { annotateHeadings } from './src/render/toc.mjs';
import { buildIndex, buildPageEntry, truncateToBudget } from './src/render/search.mjs';
import { Report, checkModel, checkDist } from './src/extract/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 用法说明。 */
const USAGE = `用法: node docs/guide-doc/build.mjs [options]

  --out <dir>       输出目录（默认 docs/guide-doc/dist）
  --base <path>     canonical/OG/sitemap 的前缀（默认 '/'，如 '/aragon-docs/'）
  --phase A|all     交付阶段（默认 A）。A → 29 页，all → 56 页
  --check           只跑校验，不写盘（等价于 check.mjs --model --phase <phase>）
  --strict          WARN 视为 ERROR
  --report <file>   写 JSON 构建报告
  -h, --help

退出码: 0 成功 | 1 内容/结构错误 | 2 用法错误 | 3 准确性门禁失败`;

/**
 * 解析参数（非法参数 → exit 2）。
 *
 * @param {string[]} argv 参数
 * @returns {object} 选项；`usageError` 非空表示非法
 */
export function parseArgs(argv) {
  const options = {
    out: path.join(HERE, 'dist'),
    base: '/',
    phase: 'A',
    checkOnly: false,
    strict: false,
    report: null,
    contentRoot: path.join(HERE, 'src', 'content'),
    help: false,
    usageError: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.checkOnly = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (['--out', '--base', '--phase', '--report'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) {
        options.usageError = `${arg} 需要一个值`;
        return options;
      }
      index += 1;
      if (arg === '--out') options.out = path.resolve(process.cwd(), value);
      else if (arg === '--base') options.base = value;
      else if (arg === '--report') options.report = path.resolve(process.cwd(), value);
      else {
        if (value !== 'A' && value !== 'all') {
          options.usageError = `--phase 只接受 A 或 all（收到 \`${value}\`）`;
          return options;
        }
        options.phase = value;
      }
    } else {
      options.usageError = `未知参数 \`${arg}\``;
      return options;
    }
  }
  return options;
}

/**
 * 读取两个包的版本号（除源码文本外，这是唯一的外部输入）。
 *
 * @returns {{cli: string, core: string}} 版本号
 */
export function readVersions() {
  const read = (relative) => JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, relative), 'utf8'));
  return {
    cli: read('packages/cli/package.json').version,
    core: read('packages/core/package.json').version,
  };
}

/**
 * 交付用的 `app.js`：去掉整行注释与行首缩进，其余一个字节不动。
 *
 * WHY 需要这一步：§10.1 的 JS 上限是 10 KB，而本文件在补上 §7.7 的「最近访问」、
 * 客户端与服务端同一套打分之后是 11.6 KB 源码 —— 代码没有一行是摆设，能减的只有
 * 不改变语义的部分。**不换行、不合并语句、不动字符串**：只删「整行都是 `//`」的行与
 * 每行前导空白，这两种操作在任何 JS 上都不会改变语义（这里没有多行模板字符串，
 * 而即便将来有人加了，`assertParses` 也会在写盘前把构建打红）。
 *
 * WHY 不是让源文件自己变丑：源文件是给人读的，产物是给浏览器读的，两者的预算不该共享。
 *
 * @param {string} source `src/assets/app.js` 的原文
 * @returns {string} 可交付的脚本
 */
export function compactScript(source) {
  const lines = source.split(/\r?\n/);
  const kept = lines
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/^\s+/, '').replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  const output = `${kept.join('\n')}\n`;
  assertParses(output);
  return output;
}

/**
 * 产物必须仍然是一段能编译的脚本，否则构建失败而不是交付一个坏资产。
 *
 * 用 `new vm.Script` 而不是正则自查：注释剥离的唯一真实风险是「把代码当注释删了」，
 * 而这件事只有解析器知道。
 *
 * @param {string} script 待校验的脚本文本
 * @returns {void}
 */
export function assertParses(script) {
  try {
    new vm.Script(script, { filename: 'app.js' });
  } catch (error) {
    throw new Error(`压缩后的 app.js 无法解析（注释剥离改坏了代码）：${error.message}`);
  }
}

/**
 * 资产文件名（内容哈希前 8 位 → 同内容同哈希 → 构建可确定）。
 *
 * @param {string} assetsDir 资产源目录
 * @returns {{css: string, js: string, cssBody: string, jsBody: string, hash: string}} 资产信息
 */
export function hashAssets(assetsDir) {
  const cssFiles = ['tokens.css', 'layout.css', 'components.css', 'print.css'];
  const cssBody = cssFiles
    .map((file) => `/* ${file} */\n${fs.readFileSync(path.join(assetsDir, file), 'utf8')}`)
    .join('\n');
  const jsBody = compactScript(fs.readFileSync(path.join(assetsDir, 'app.js'), 'utf8'));
  const hash = crypto
    .createHash('sha256')
    .update(cssBody)
    .update(jsBody)
    .digest('hex')
    .slice(0, 8);
  return { css: `app.${hash}.css`, js: `app.${hash}.js`, cssBody, jsBody, hash };
}

/**
 * 把页面正文压平成搜索索引项（用 `pageUrlPath` 保证 `u` 与产物一致）。
 *
 * 先跑 `annotateHeadings` 再建索引：`buildSections` 读的是 `block.id`，而自动 slug
 * 只存在于「注解之后」的那份 block 上。用原始页面建索引，每条命中都只有 `a: ''`，
 * 于是搜索能命中、落点却永远是页首 —— 一个只影响体验、不影响任何断言的漏洞。
 *
 * @param {object[]} pages 页面
 * @param {{maxSections: number, maxChars: number}} [level] 三级截断的档位
 * @returns {object[]} 索引项
 */
function makeEntries(pages, level) {
  return pages.map((page) =>
    buildPageEntry(
      { ...page, blocks: annotateHeadings(page.blocks || []).blocks },
      pageUrlPath(page.id),
      GROUP_LABELS[page.group] || page.group,
      level,
    ),
  );
}

/**
 * 动态加载页面模块（`build.mjs` 里唯一允许的 import 时机：内容模块是数据，不是依赖）。
 *
 * @returns {Promise<object[]>} 页面数组（按 nav 顺序排序后返回）
 */
export async function loadPages() {
  const pageModuleDir = path.join(HERE, 'src', 'content', 'pages');
  const modules = [];
  for (const file of fs.readdirSync(pageModuleDir).filter((name) => name.endsWith('.mjs')).sort()) {
    modules.push(await import(`file://${path.join(pageModuleDir, file).replace(/\\/g, '/')}`));
  }
  return modules.flatMap((module) => module.pages || []);
}

/**
 * 主流程。
 *
 * @param {string[]} argv 参数
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  const started = Date.now();
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.usageError) {
    console.error(`参数错误：${options.usageError}`);
    console.error(USAGE);
    return 2;
  }

  // 步骤 1–7：参数 → 内容 → 结构校验 → check --model（写盘前）
  const report = new Report();
  const modelReport = new Report();
  const summary = await checkModel(options, modelReport);
  const modelCounts = modelReport.counts();
  if (modelCounts.error > 0 || (options.strict && modelCounts.warn > 0)) {
    for (const finding of modelReport.findings) {
      if (finding.level === 'error' || (options.strict && finding.level === 'warn')) {
        console.error(`ERROR [${finding.code}] ${finding.message}`);
      }
    }
    console.error(
      `门禁未通过：${modelCounts.error} error, ${modelCounts.warn} warn（未触碰 dist/）`,
    );
    return 3;
  }
  if (options.checkOnly) {
    console.log(`校验通过：${summary.pages} 页，${modelCounts.error} error, ${modelCounts.warn} warn`);
    return 0;
  }

  // 步骤 8–11：渲染 → TOC → 写 dist.tmp → check --dist
  const versions = readVersions();
  const site = withVersions(versions);
  const basePath = normalizeBase(options.base);
  const assets = hashAssets(path.join(HERE, 'src', 'assets'));
  const pages = await loadPages();
  const navGroups = navForPhase(options.phase);
  const allPages = new Map(pages.map((page) => [page.id, page]));

  // 时间戳只写进 _meta.json（HTML 内不出现，§6.5 —— 否则两次构建不可能逐字节相同）
  const builtAt = new Date().toISOString();
  const meta = { builtAt, commit: process.env.GIT_COMMIT || 'dev' };
  const warnings = [];

  const ordered = [];
  for (const group of navGroups) {
    for (const entry of group.pages) {
      const page = allPages.get(entry.id);
      if (!page) {
        report.error('missing-page', `\`${entry.id}\` 没有内容模块`);
        continue;
      }
      ordered.push(page);
    }
  }

  // 本阶段的页面集合才是渲染上下文里的「已知页面」：指向阶段 B 的链接因此降级为
  // pendingLink 占位（§2.2 末）。链接**解析**用全量导航，是否可点用本阶段集合决定。
  const pageMap = new Map(ordered.map((page) => [page.id, page]));
  const shared = { site, basePath, assets, meta, warnings, pageMap, fullNavGroups: navForPhase('all') };

  const outputs = new Map();
  for (const page of ordered) {
    const { html } = renderPage(page, navGroups, shared);
    outputs.set(outputPath(page.id), html);
  }
  outputs.set('404/index.html', render404({
    site,
    basePath,
    assets,
    meta,
    pageMap,
    navGroups,
    warnings,
    pageId: '404',
    renderText: (md) => md,
  }));

  // 搜索索引（三级截断，§7.4）
  const truncated = truncateToBudget((level) =>
    buildIndex(makeEntries(ordered, level), versions),
  );
  if (!truncated.ok) {
    console.error(
      `搜索索引 ${Math.round(truncated.bytes / 1024)} KB，三级截断后仍超 420 KB —— 内容量本身超预算`,
    );
    return 3;
  }
  const searchBody = `${JSON.stringify(truncated.index, null, 0)}\n`;
  // 字节数按**实际写出的内容**计（含结尾换行），否则 `_meta.json` 与磁盘会差 1 字节。
  const searchIndexBytes = Buffer.byteLength(searchBody, 'utf8');
  outputs.set('search-index.json', searchBody);
  outputs.set(
    'sitemap.xml',
    renderSitemap(site, basePath, ordered),
  );
  outputs.set('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${absoluteUrl(site.origin, basePath, 'sitemap.xml')}\n`);
  outputs.set(
    '_meta.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        site: site.siteName,
        builtAt,
        generator: 'docs/guide-doc/build.mjs',
        versions: site.versions,
        commit: meta.commit,
        base: basePath,
        phase: options.phase,
        pages: ordered.length,
        phaseCounts: phaseCounts(),
        assetHash: assets.hash,
        warnCount: warnings.length,
        counterExampleLines: 0,
        truncatedSections: truncated.truncatedSections,
        searchIndexBytes,
        searchIndexOverBudget: !truncated.ok,
        staleDirs: [],
      },
      null,
      2,
    )}\n`,
  );
  outputs.set(`assets/${assets.css}`, assets.cssBody);
  outputs.set(`assets/${assets.js}`, assets.jsBody);
  outputs.set('assets/LATEST', `${assets.hash}\n`);
  outputs.set('.nojekyll', '');

  const tmp = `${options.out}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const [relative, body] of outputs) {
    const absolute = path.join(tmp, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body, 'utf8');
  }

  const distReport = new Report();
  checkDist({ root: tmp, phase: options.phase }, distReport);
  const distCounts = distReport.counts();
  if (distCounts.error > 0 || (options.strict && distCounts.warn > 0)) {
    for (const finding of distReport.findings) {
      if (finding.level === 'error') console.error(`ERROR [${finding.code}] ${finding.message}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(`产物不合格：${distCounts.error} error（dist/ 一字未动）`);
    return 3;
  }

  // 步骤 12：原子发布
  const old = `${options.out}.old`;
  const staleDirs = [];
  try {
    if (fs.existsSync(options.out)) {
      fs.rmSync(old, { recursive: true, force: true });
      fs.renameSync(options.out, old);
    }
    fs.renameSync(tmp, options.out);
  } catch (error) {
    if (fs.existsSync(old) && !fs.existsSync(options.out)) fs.renameSync(old, options.out);
    console.error(`发布失败，已回滚：${error.message}`);
    return 1;
  }
  try {
    if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // Windows 上 serve.mjs 持着句柄会 EBUSY：失败的是清理而不是发布，只记 WARN（P2-6）。
    staleDirs.push(path.basename(old));
    warnings.push(`${path.basename(old)} 清理失败（句柄被占用），下次构建会重试`);
  }
  if (staleDirs.length > 0) {
    const metaPath = path.join(options.out, '_meta.json');
    const metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    metaJson.staleDirs = staleDirs;
    metaJson.warnCount = warnings.length;
    fs.writeFileSync(metaPath, `${JSON.stringify(metaJson, null, 2)}\n`, 'utf8');
  }

  // 步骤 13：摘要
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const totalBytes = [...outputs.values()].reduce((sum, body) => sum + Buffer.byteLength(body, 'utf8'), 0);
  console.log(
    `构建完成：${ordered.length} 页（+404）· 资产 ${assets.hash} · ` +
      `${Math.round(totalBytes / 1024)} KB · ${elapsed}s · WARN ${warnings.length}`,
  );
  for (const warning of warnings) console.log(`WARN  ${warning}`);
  if (options.report) {
    fs.writeFileSync(
      options.report,
      `${JSON.stringify(
        {
          phase: options.phase,
          pages: ordered.length,
          html: outputs.size,
          assetHash: assets.hash,
          bytes: totalBytes,
          elapsedSeconds: Number(elapsed),
          warnCount: warnings.length,
          searchIndexBytes,
          truncatedSections: truncated.truncatedSections,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return 0;
}

/**
 * 渲染 sitemap（不含 404，绝对地址由 `--base` 决定）。
 *
 * @param {object} site 站点配置
 * @param {string} basePath 归一化前缀
 * @param {object[]} pages 页面
 * @returns {string} XML
 */
export function renderSitemap(site, basePath, pages) {
  const urls = pages
    .map((page) => `  <url><loc>${absoluteUrl(site.origin, basePath, pageUrlPath(page.id).slice(1))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
