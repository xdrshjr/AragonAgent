/**
 * 6 种页面模板（§2.1）。
 *
 * 模板**只负责骨架与段位顺序**，所有 H2/H3 都来自内容 block —— 这样 TOC、锚点与
 * 「不跳级」校验只需要一套逻辑（`toc.mjs`），模板不会各自发明标题。
 */

import { escapeHtml } from './slug.mjs';
import { renderBlocks } from './blocks.mjs';

/** 模板名 → 允许值。 */
export const TEMPLATES = ['hub', 'prose', 'steps', 'flags', 'events', 'api'];

/** 分组 id → 中文名（导航与面包屑共用）。 */
export const GROUP_LABELS = {
  start: '开始',
  guide: '日常使用',
  config: '配置',
  cli: 'CLI 参考',
  exec: '机器契约',
  api: '引擎 API',
  tools: '内置工具',
  troubleshoot: '排错',
  appendix: '附录',
};

/**
 * 校验模板名。
 *
 * @param {string} template 模板名
 * @returns {void}
 * @throws {Error} 模板不存在
 */
export function assertTemplate(template) {
  if (!TEMPLATES.includes(template)) {
    throw new Error(`未知模板 \`${template}\`（可用：${TEMPLATES.join(', ')}）`);
  }
}

/**
 * 渲染页头（H1 + 摘要 + 元信息行）。
 *
 * 缺 `title` / `summary` 直接抛错，而不是把 `undefined` 印在页面上：
 * §13.1 要求「缺字段 → 抛错」，而 `blocks` 是可选的例外（空页合法）。
 *
 * @param {object} page 页面数据
 * @param {object} ctx 渲染上下文
 * @returns {string} HTML
 * @throws {Error} 当 `title` 或 `summary` 缺失时
 */
function renderPageHead(page, ctx) {
  for (const field of ['title', 'summary']) {
    if (typeof page[field] !== 'string' || page[field].trim() === '') {
      throw new Error(`页面 \`${page.id || '?'}\` 缺少字段 \`${field}\``);
    }
  }
  const groupLabel = GROUP_LABELS[page.group] || page.group;
  const meta = [];
  if (ctx.site && ctx.site.versions) {
    meta.push(`适用 CLI ${ctx.site.versions.cli} · Core ${ctx.site.versions.core}`);
  }
  meta.push(`阅读约 ${estimateReadingMinutes(page)} 分钟`);
  if (page.phase === 'B') meta.push('本页随阶段 B 发布');
  return (
    '<header class="page-head">' +
    `<p class="page-eyebrow">${escapeHtml(groupLabel)}</p>` +
    `<h1 class="page-title">${ctx.renderText(page.title)}</h1>` +
    `<p class="page-summary">${ctx.renderText(page.summary)}</p>` +
    `<p class="page-meta">${meta.map((item) => escapeHtml(item)).join('<span class="dot">·</span>')}</p>` +
    '</header>'
  );
}

/**
 * 粗略阅读时长（中文按 350 字/分钟，代码行按 4 行/分钟）。
 *
 * @param {object} page 页面数据
 * @returns {number} 分钟数（至少 1）
 */
export function estimateReadingMinutes(page) {
  let chars = 0;
  let codeLines = 0;
  for (const block of page.blocks || []) {
    if (typeof block.md === 'string') chars += block.md.length;
    if (Array.isArray(block.items)) {
      chars += block.items.reduce((sum, item) => {
        if (typeof item === 'string') return sum + item.length;
        return sum + String(item.md || item.desc || item.title || '').length;
      }, 0);
    }
    if (typeof block.code === 'string') codeLines += block.code.split('\n').length;
  }
  const minutes = chars / 350 + codeLines / 40;
  return Math.max(1, Math.round(minutes + 0.4));
}

/**
 * 「相关内容」（`seeAlso`）：本阶段之外的页面渲染为不可点占位。
 *
 * @param {object} page 页面数据
 * @param {object} ctx 渲染上下文
 * @param {Map<string, object>} ctx.pageMap 本阶段页面集合
 * @returns {string} HTML（无相关内容时为空串）
 */
function renderSeeAlso(page, ctx) {
  const ids = (page.seeAlso || []).filter(Boolean);
  if (ids.length === 0) return '';
  const items = ids
    .map((id) => {
      const target = ctx.pageMap.get(id);
      if (!target) {
        const title = ctx.navTitle(id) || id;
        return `<li><span class="pending" aria-disabled="true">${escapeHtml(title)}` +
          '<span class="pending-tag">阶段 B 提供</span></span></li>';
      }
      const href = ctx.linkTo(id);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(target.title)}</a></li>`;
    })
    .join('');
  return (
    '<section class="see-also" aria-labelledby="see-also-title">' +
    '<h2 id="see-also-title" class="h2-plain">相关内容</h2>' +
    `<ul class="see-also-list">${items}</ul></section>`
  );
}

/**
 * 渲染模板主体（不含 TOC/侧栏/页脚）。
 *
 * @param {object} page 页面数据
 * @param {object} ctx 渲染上下文
 * @returns {string} `<article>` 的 HTML
 */
export function renderTemplate(page, ctx) {
  assertTemplate(page.template);
  const head = renderPageHead(page, ctx);
  const extra = EXTRA_SLOTS[page.template] ? EXTRA_SLOTS[page.template](page, ctx) : '';
  const body = renderBlocks(page.blocks || [], ctx);
  const seeAlso = renderSeeAlso(page, ctx);
  return `<article class="prose prose-${page.template}">${head}${extra}${body}${seeAlso}</article>`;
}

/**
 * 各模板在正文之前的专属段位（§2.1 的固定顺序）。
 */
const EXTRA_SLOTS = {
  /** hub：卡片网格由 `cards` block 承担，这里只给一句视图入口说明。 */
  hub(page, ctx) {
    const count = ctx.groupCount ? ctx.groupCount(page.group) : (page.blocks || []).length;
    return `<p class="hub-lede">${ctx.renderText(`本组共 ${count} 页；选一页开始，或按 \`Ctrl+K\` 搜关键词。`)}</p>`;
  },

  /** prose：摘要之后紧跟适用版本（已在页头）+ 正文。 */
  prose() {
    return '';
  },

  /** steps：正文前显式声明「照做即可」，把前置条件留给作者用 `p`/`callout` 写。 */
  steps() {
    return '<p class="steps-lede">按顺序执行；每一步后面的命令都可以直接复制。</p>';
  },

  /** flags：正文前给出「看哪一列」的一句话，降低参数表的门槛。 */
  flags() {
    return (
      '<p class="flags-lede">表格第 5 列「依据」指向源码行；' +
      '默认值来自声明本身，不是猜测。</p>'
    );
  },

  /** events：正文前提醒 stream-json 前提。 */
  events() {
    return (
      '<p class="events-lede">仅当使用 <code>--output-format stream-json</code> 时才会产生下列事件；' +
      '<code>--output-format json</code> 只在结束时输出 <code>result</code>。</p>'
    );
  },

  /** api：导入行 + 签名块由页面数据提供，位置固定在正文之前。 */
  api(page, ctx) {
    const parts = [];
    if (page.importLine) {
      parts.push(
        '<figure class="code-block import-line"><figcaption class="code-head">' +
        '<span class="code-lang">TS</span><span class="code-title">导入</span></figcaption>' +
        `<pre class="code" tabindex="0" role="region" aria-label="导入语句"><code>${escapeHtml(
          page.importLine,
        )}</code></pre></figure>`,
      );
    }
    if (page.signature) {
      parts.push(
        '<figure class="code-block signature-block"><figcaption class="code-head">' +
        '<span class="code-lang">TS</span><span class="code-title">签名</span></figcaption>' +
        `<pre class="code" tabindex="0" role="region" aria-label="类型签名"><code>${escapeHtml(
          page.signature,
        )}</code></pre></figure>`,
      );
    }
    return parts.join('');
  },
};
