/**
 * HTML 骨架与公共区块（§2.4 / §7.6）。
 *
 * 本文件不读文件、不取时间：所有外部信息（资产哈希、版本、commit）由 `build.mjs` 通过
 * `ctx` 注入，因此同一份内容两次构建逐字节相同（AC-18）。
 */

import { escapeHtml, assetHref, resolveHref } from './slug.mjs';
import { renderIcon } from './blocks.mjs';
import { GROUP_LABELS } from './templates.mjs';
import { renderToc } from './toc.mjs';

/**
 * 站内相对链接（layout 只有这一个链接来源）。
 *
 * @param {string} from 源页面 id
 * @param {string} to 目标页面 id
 * @returns {string} 相对 URL
 */
function href(from, to) {
  return resolveHref(from, to);
}

/**
 * 主题首帧引导脚本 —— 全站**唯一**的内联脚本（§6.1，≤ 220 B）。
 *
 * 命中指纹 `document.documentElement.dataset.theme=`，`check.mjs --dist` 按它校验。
 *
 * @param {string} themeKey localStorage 键名
 * @returns {string} `<script>` 标签
 */
export function themeBootstrapScript(themeKey) {
  return (
    '<script>document.documentElement.dataset.theme=' +
    `(localStorage['${themeKey}']||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'))</script>`
  );
}

/**
 * 渲染页头。
 *
 * @param {object} ctx 渲染上下文
 * @param {string} pageId 当前页面 id
 * @returns {string} HTML
 */
function renderHeader(ctx, pageId) {
  const versions = ctx.site.versions || { cli: '0.0.0', core: '0.0.0' };
  const chipText = `CLI ${escapeHtml(versions.cli)} · Core ${escapeHtml(versions.core)}`;
  // 版本 chip 指向 `appendix/compat`，但那是阶段 B 页面：本阶段没有它时渲染成不可点 chip，
  // 否则每个页面都会带一个指向未发布页面的 href（AC-8）。
  const chip = ctx.pageMap.has('appendix/compat')
    ? `<a class="version-chip" href="${href(pageId, 'appendix/compat')}" ` +
      `title="${chipText}">${chipText}</a>`
    : `<span class="version-chip" title="${chipText}">${chipText}</span>`;
  return (
    '<header class="site-header">' +
    '<div class="header-inner">' +
    `<button type="button" class="icon-btn nav-toggle" data-nav-toggle aria-label="打开导航" ` +
    `aria-controls="site-nav" aria-expanded="false">${renderIcon('menu')}</button>` +
    `<a class="brand" href="${href(pageId, 'start/index')}">` +
    '<span class="brand-mark" aria-hidden="true"></span>' +
    `<span class="brand-name">${escapeHtml(ctx.site.siteName)}</span></a>` +
    chip +
    '<div class="header-actions">' +
    `<button type="button" class="search-btn" data-search-open aria-label="搜索文档（Ctrl+K）">` +
    `${renderIcon('search')}<span class="search-btn-text">搜索</span>` +
    `<span class="search-btn-kbd">Ctrl K</span></button>` +
    `<a class="icon-btn" href="${escapeHtml(ctx.site.repoUrl)}" target="_blank" ` +
    `rel="noopener noreferrer" aria-label="GitHub 仓库">${renderIcon('external')}</a>` +
    `<button type="button" class="icon-btn" data-theme-toggle aria-label="切换明暗主题">` +
    `${renderIcon('moon')}${renderIcon('sun')}</button>` +
    '</div></div></header>'
  );
}

/**
 * 渲染左侧导航树（`<details open>` 服务端渲染，无 JS 可折叠）。
 *
 * @param {object} ctx 渲染上下文
 * @param {string} pageId 当前页面 id
 * @returns {string} HTML
 */
function renderNav(ctx, pageId) {
  const groups = ctx.navGroups || [];
  const currentGroup = pageId.split('/')[0];
  const items = groups
    .map((group) => {
      const links = group.pages
        .map((page) => {
          const pending = !ctx.pageMap.has(page.id);
          if (pending) {
            return (
              `<li><span class="nav-link is-pending" aria-disabled="true">` +
              `${escapeHtml(page.title)}<span class="pending-tag">B</span></span></li>`
            );
          }
          const isCurrent = page.id === pageId;
          const cls = isCurrent ? 'nav-link is-current' : 'nav-link';
          const current = isCurrent ? ' aria-current="page"' : '';
          return (
            `<li><a class="${cls}"${current} href="${href(pageId, page.id)}">` +
            `${escapeHtml(page.title)}</a></li>`
          );
        })
        .join('');
      const open = group.id === currentGroup ? ' open' : '';
      return (
        `<details class="nav-group"${open}>` +
        `<summary class="nav-group-title">${escapeHtml(GROUP_LABELS[group.id] || group.id)}</summary>` +
        `<ul class="nav-list">${links}</ul></details>`
      );
    })
    .join('');
  return (
    '<div class="nav-scrim" data-nav-close hidden></div>' +
    '<nav class="nav" id="site-nav" aria-label="文档导航">' +
    '<div class="nav-head"><span class="nav-title">全部文档</span>' +
    `<button type="button" class="icon-btn nav-close" data-nav-close aria-label="关闭导航">` +
    `${renderIcon('close')}</button></div>` +
    `<div class="nav-body">${items}</div></nav>`
  );
}

/**
 * 渲染页脚（构建元信息 + 许可证）。
 *
 * @param {object} ctx 渲染上下文
 * @returns {string} HTML
 */
function renderFooter(ctx) {
  const meta = ctx.meta || {};
  // 页脚**不打印构建时间**：HTML 里出现时间戳就让「两次构建逐字节相同」不可能成立（§6.5）。
  // 时间只写进 `_meta.json`，那里本来就是机器读的。
  const bits = [
    `commit ${escapeHtml(meta.commit || 'dev')}`,
    `本阶段 ${escapeHtml(String(ctx.pageMap.size))} 页`,
  ];
  return (
    '<footer class="site-footer">' +
    `<div class="footer-inner"><p class="footer-meta">${bits.join(' · ')}</p>` +
    `<p class="footer-license">许可证 ${escapeHtml(ctx.site.license)} · ` +
    `<a href="${escapeHtml(ctx.site.repoUrl)}" target="_blank" rel="noopener noreferrer">源代码</a></p>` +
    '</div></footer>'
  );
}

/**
 * 渲染搜索对话框（无 JS 时 `hidden`，不会挡住阅读）。
 *
 * @returns {string} HTML
 */
function renderSearchDialog() {
  return (
    '<div class="modal" id="search" role="dialog" aria-modal="true" ' +
    'aria-labelledby="search-title" hidden>' +
    '<div class="modal-backdrop" data-search-close></div>' +
    '<div class="modal-panel">' +
    '<p class="visually-hidden" id="search-title">站内搜索</p>' +
    '<div class="search-box">' + `${renderIcon('search')}` +
    '<input type="search" data-search-input placeholder="搜索文档（中文直接输入）" ' +
    'aria-label="搜索关键词" autocomplete="off" spellcheck="false">' +
    `<button type="button" class="icon-btn" data-search-close aria-label="关闭搜索">` +
    `${renderIcon('close')}</button></div>` +
    '<p class="search-count" data-search-count aria-live="polite"></p>' +
    '<ul class="search-results" data-search-results role="listbox" aria-label="搜索结果"></ul>' +
    '<p class="search-hint">' +
    '<kbd>↑</kbd><kbd>↓</kbd> 移动 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</p>' +
    '</div></div>'
  );
}

/**
 * 渲染整页 HTML。
 *
 * @param {object} params 参数
 * @param {object} params.page 页面数据
 * @param {string} params.body 已渲染的 `<article>`
 * @param {Array} params.toc 目录条目
 * @param {string} params.prevHtml 上一页链接（已渲染）
 * @param {string} params.nextHtml 下一页链接（已渲染）
 * @param {string} params.sourcesHtml 「本页依据」区块
 * @param {object} params.ctx 渲染上下文
 * @returns {string} 完整 HTML 文档
 */
export function renderLayout({ page, body, toc, prevHtml, nextHtml, sourcesHtml, ctx }) {
  const title = `${page.title} · ${ctx.site.siteName}`;
  // meta/OG 描述是纯文本字段：把摘要里的行内标记去掉，否则搜索结果里会看到反引号。
  const description = String(page.summary).replace(/`/g, '').replace(/\*\*/g, '');
  const canonical = `${String(ctx.site.origin).replace(/\/+$/, '')}${ctx.basePath}${ctx.urlPath.slice(1)}`;
  const cssHref = assetHref(page.id, ctx.assets.css);
  const jsHref = assetHref(page.id, ctx.assets.js);
  const tocHtml = renderToc(toc, ctx.renderText);
  const noscript = '<noscript><p class="noscript-note">搜索与主题切换需要 JavaScript；' +
    '正文、导航与目录在没有 JS 时依然完整可读。</p></noscript>';
  return (
    '<!doctype html>\n' +
    `<html lang="${escapeHtml(ctx.site.lang)}" data-theme="dark" data-base="${escapeHtml(ctx.basePath)}">` +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    `<meta name="description" content="${escapeHtml(description)}">` +
    `<link rel="canonical" href="${escapeHtml(canonical)}">` +
    '<meta property="og:type" content="article">' +
    `<meta property="og:title" content="${escapeHtml(title)}">` +
    `<meta property="og:description" content="${escapeHtml(description)}">` +
    `<meta property="og:url" content="${escapeHtml(canonical)}">` +
    '<meta name="color-scheme" content="dark light">' +
    themeBootstrapScript(ctx.site.themeKey) +
    `<link rel="stylesheet" href="${escapeHtml(cssHref)}">` +
    '</head>' +
    '<body>' +
    `<a class="skip-link" href="#main">跳到正文</a>` +
    renderHeader(ctx, page.id) +
    '<div class="shell">' +
    renderNav(ctx, page.id) +
    '<main class="main" id="main" tabindex="-1">' +
    body +
    `<div class="page-nav">${prevHtml}${nextHtml}</div>` +
    sourcesHtml +
    '</main>' +
    tocHtml +
    '</div>' +
    renderFooter(ctx) +
    renderSearchDialog() +
    `<button type="button" class="to-top" data-top aria-label="回到顶部">${renderIcon('arrow-up')}</button>` +
    noscript +
    `<script src="${escapeHtml(jsHref)}" defer></script>` +
    '</body></html>\n'
  );
}

/**
 * 渲染 404 页（`noindex`，不进 sitemap）。
 *
 * @param {object} ctx 渲染上下文
 * @returns {string} 完整 HTML
 */
export function render404(ctx) {
  const page = {
    id: '404',
    title: '页面不存在',
    summary: '这个地址没有对应的文档页；从导航或搜索重新进入。',
    group: 'start',
    phase: 'A',
  };
  const body =
    '<article class="prose prose-404">' +
    '<header class="page-head"><p class="page-eyebrow">404</p>' +
    '<h1 class="page-title">页面不存在</h1>' +
    `<p class="page-summary">${escapeHtml(page.summary)}</p></header>` +
    `<p><a href="${href('404', 'start/index')}">回到文档首页</a>，或按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 搜索。</p>` +
    '</article>';
  const html = renderLayout({
    page,
    body,
    toc: [],
    prevHtml: '',
    nextHtml: '',
    sourcesHtml: '',
    ctx: { ...ctx, urlPath: '/404/' },
  });
  return html.replace(
    '<meta name="color-scheme"',
    '<meta name="robots" content="noindex">\n<meta name="color-scheme"',
  );
}
