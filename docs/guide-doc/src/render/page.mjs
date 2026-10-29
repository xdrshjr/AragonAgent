/**
 * 页面组装：把一条 `Page` 记录变成完整 HTML。
 *
 * 顺序（§4.3 步骤 8–9）：分配锚点 → 渲染模板 → 加 TOC → 加前后页 → 加「本页依据」→ 套骨架。
 */

import { escapeHtml, resolveHref, pageUrlPath, pathToPageId } from './slug.mjs';
import { renderInline } from './inline.mjs';
import { annotateHeadings } from './toc.mjs';
import { renderTemplate } from './templates.mjs';
import { renderLayout } from './layout.mjs';

/** 模板自带、不来自 block 的锚点 id（避免与作者标题撞名）。 */
const RESERVED_IDS = ['see-also-title'];

/**
 * 「源码不在本仓库」的包根（仓库根相对，带尾斜杠）。
 *
 * WHY：`@aragon-agent/core` 与 `@aragon-agent/cli` 只以 npm 包的形式对外发布，源码留在
 * 私有 monorepo 里。指向这两个目录的 blob 链接在公开仓库上一律 404，所以「本页依据」里
 * 这类引用**不渲染成链接**，只把 `path:lines` 作为出处记录保留 —— 出处是真的，链接不是。
 */
export const PRIVATE_SOURCE_ROOTS = ['packages/core/', 'packages/cli/'];

/** 私有出处的悬浮说明（`title`），让「不是链接」这件事在页面上有据可查。 */
export const PRIVATE_SOURCE_NOTE =
  '私有源码：packages/core 与 packages/cli 不随本仓库发布，此处只记录出处与行号';

/**
 * 判定一条 `sourceRef` 指向的路径是否**不在本仓库**。
 *
 * @param {string} repoRelative 仓库根相对路径
 * @returns {boolean} true 表示该路径属于未开源的包
 */
export function isPrivateSourcePath(repoRelative) {
  const value = String(repoRelative == null ? '' : repoRelative);
  return PRIVATE_SOURCE_ROOTS.some((root) => value.startsWith(root));
}

/**
 * 构造一页的渲染上下文。
 *
 * @param {object} options 参数
 * @param {object} options.page 当前页面
 * @param {Map<string, object>} options.pageMap 本阶段页面集合
 * @param {object[]} options.navGroups 导航分组
 * @param {object} options.site 站点配置（含版本）
 * @param {string} options.basePath 归一化后的部署前缀
 * @param {object} options.assets 资产文件名 `{css, js}`
 * @param {object} options.meta 构建元信息 `{builtAt, commit}`
 * @param {string[]} options.warnings WARN 收集器
 * @returns {object} 渲染上下文
 */
export function createContext({ page, pageMap, navGroups, fullNavGroups, site, basePath, assets, meta, warnings }) {
  // 链接解析用**全量**导航（56 页）：只有全量索引才知道「某个 id 是阶段 B 的页面」，
  // 才能把它降级成 pendingLink 而不是报成断链。
  const linkNav = fullNavGroups || navGroups;
  const navIndex = new Map();
  for (const group of linkNav) for (const entry of group.pages) navIndex.set(entry.id, entry);

  /**
   * 站内链接解析：内容作者写 `[文字](/guide/tui/)` 或 `[文字](#anchor)`。
   *
   * @param {string} target 链接目标
   * @returns {{href: string, pending?: boolean, title?: string}|null} 解析结果
   */
  const resolve = (target) => {
    if (target.startsWith('#')) return { href: target };
    // `guide/tui` 与 `/guide/tui/` 同义：站内路径一律按站根解释。带前导 `./`、`../`
    // 的写法在静态站里没有意义（`validateInline` 已经拒掉），这里只兜住前者。
    const normalized = target.startsWith('/') ? target : `/${target}`;
    const { id, anchor } = pathToPageId(normalized);
    const navEntry = navIndex.get(id);
    if (!navEntry) {
      warnings.push(`${page.id}: 站内链接 \`${target}\` 指向不在导航里的页面`);
      return { href: target };
    }
    const known = pageMap.has(id);
    const suffix = anchor ? `#${anchor}` : '';
    if (!known) return { href: '', pending: true, title: navEntry.title };
    return { href: `${resolveHref(page.id, id)}${suffix}`, title: navEntry.title };
  };

  return {
    pageId: page.id,
    phase: page.phase,
    site,
    basePath,
    assets,
    meta,
    pageMap,
    navGroups,
    resolve,
    linkTo: (id) => resolveHref(page.id, id),
    navTitle: (id) => (navIndex.get(id) || {}).title,
    renderText: (md) => renderInline(md, { resolveLink: resolve }),
    groupCount: (groupId) => {
      const group = linkNav.find((item) => item.id === groupId);
      if (!group) return 0;
      return group.pages.filter((entry) => pageMap.has(entry.id)).length;
    },
    warnings,
    codeSeq: 0,
  };
}

/**
 * 渲染一页。
 *
 * @param {object} page 页面数据
 * @param {object[]} navGroups 导航分组
 * @param {object} shared 共享上下文（site/basePath/assets/meta/warnings/pageMap）
 * @returns {{html: string, toc: object[]}} HTML 与目录
 */
export function renderPage(page, navGroups, shared) {
  const ctx = createContext({ page, navGroups, ...shared });
  const { blocks, toc } = annotateHeadings(page.blocks || [], RESERVED_IDS);
  const normalised = { ...page, blocks };
  const body = renderTemplate(normalised, ctx);
  const sourcesHtml = renderSources(normalised, ctx);
  const { prevHtml, nextHtml } = renderPager(normalised, ctx);
  const html = renderLayout({
    page: normalised,
    body,
    toc,
    prevHtml,
    nextHtml,
    sourcesHtml,
    ctx: { ...ctx, urlPath: pageUrlPath(normalised.id) },
  });
  return { html, toc };
}

/**
 * 「本页依据」：`path:lines` 清单。
 *
 * 指向**本仓库里存在**的文件的引用渲染成 GitHub blob 链接；指向未开源包
 * （`packages/core`、`packages/cli`）的引用只渲染成行内代码 —— 那两个包的源码不随
 * 本仓库发布，链接过去只会 404。出处照样可见、可核对，只是不可点。
 *
 * @param {object} page 页面数据
 * @param {object} ctx 渲染上下文
 * @returns {string} HTML
 */
function renderSources(page, ctx) {
  const refs = page.sourceRefs || [];
  if (refs.length === 0) return '';
  const items = refs.map((ref) => renderSourceItem(ref, ctx.site)).join('');
  return (
    '<section class="sources" aria-labelledby="sources-title">' +
    '<h2 id="sources-title" class="h2-plain">本页依据</h2>' +
    `<ul class="sources-list">${items}</ul></section>`
  );
}

/**
 * 渲染「本页依据」里的一条引用（`<li>`）。
 *
 * 抽成导出函数的唯一理由：产物侧的那次同构替换（把已交付 `dist/` 里指向未开源包的
 * 死链降级成文本）必须与渲染层逐字节一致，否则源码与产物就会各说一套。
 *
 * @param {{path: string, lines?: string}} ref 引用
 * @param {object} site 站点配置（公开引用需要 `repoUrl` / `repoBranch`）
 * @returns {string} HTML
 */
export function renderSourceItem(ref, site) {
  const label = `${ref.path}:${ref.lines}`;
  if (isPrivateSourcePath(ref.path)) {
    return (
      `<li><code class="source-ref-private" title="${escapeHtml(PRIVATE_SOURCE_NOTE)}">` +
      `${escapeHtml(label)}</code></li>`
    );
  }
  const url = blobUrl(site, ref.path, ref.lines);
  return `<li><a class="source-ref" href="${escapeHtml(url)}" target="_blank" ` +
    `rel="noopener noreferrer"><code>${escapeHtml(label)}</code></a></li>`;
}

/**
 * 生成 GitHub blob 链接（单行不加锚点后缀）。
 *
 * @param {object} site 站点配置
 * @param {string} path 仓库根相对路径
 * @param {string} lines 行号表达式，如 `'120-168'` 或 `'42'`
 * @returns {string} 绝对 URL
 */
export function blobUrl(site, path, lines) {
  const base = `${String(site.repoUrl).replace(/\/+$/, '')}/blob/${site.repoBranch}/${path}`;
  if (!lines) return base;
  const [start, end] = String(lines).split('-');
  if (!/^\d+$/.test(start)) return base;
  return end && end !== start ? `${base}#L${start}-L${end}` : `${base}#L${start}`;
}

/**
 * 上一页 / 下一页（按 nav 顺序的扁平序列）。
 *
 * @param {object} page 页面数据
 * @param {object} ctx 渲染上下文
 * @returns {{prevHtml: string, nextHtml: string}} 两段 HTML
 */
function renderPager(page, ctx) {
  const flat = ctx.navGroups.flatMap((group) =>
    group.pages.filter((entry) => ctx.pageMap.has(entry.id)).map((entry) => entry.id),
  );
  const index = flat.indexOf(page.id);
  const prevId = index > 0 ? flat[index - 1] : null;
  const nextId = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null;
  const build = (id, dir, label) => {
    if (!id) return '';
    const title = ctx.navTitle(id) || id;
    const arrow = dir === 'prev' ? '<span aria-hidden="true">←</span>' : '';
    const arrowEnd = dir === 'next' ? '<span aria-hidden="true">→</span>' : '';
    return (
      `<a class="pager-link pager-${dir}" href="${escapeHtml(ctx.linkTo(id))}" rel="${dir}">` +
      `${arrow}<span class="pager-text"><span class="pager-dir">${label}</span>` +
      `<span class="pager-title">${escapeHtml(title)}</span></span>${arrowEnd}</a>`
    );
  };
  return {
    prevHtml: build(prevId, 'prev', '上一页'),
    nextHtml: build(nextId, 'next', '下一页'),
  };
}

/**
 * 渲染导航树里的页面标题（供 `pendingLink` 使用）。
 *
 * @param {object[]} navGroups 导航分组
 * @param {string} id 页面 id
 * @returns {string} 标题或 id 本身
 */
export function navTitleOf(navGroups, id) {
  for (const group of navGroups) {
    for (const entry of group.pages) if (entry.id === id) return entry.title;
  }
  return id;
}
