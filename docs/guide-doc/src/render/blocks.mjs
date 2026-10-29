/**
 * 16 种 block 的渲染器注册表（§5.2）。
 *
 * 「不可扩展原则」：新增一种 block 必须同时改本文件、`inline` 校验与 `tests/blocks.test.mjs`，
 * 并且回答「现有 16 种为什么不够」。这条比「允许自由扩展」更难走形。
 */

import { escapeHtml } from './slug.mjs';
import { highlight } from './highlight.mjs';
import { renderInline } from './inline.mjs';

/** 白名单图标（`t:'raw'` 与页头共用；12 个，全部内联 SVG，`currentColor` + `stroke-width:1.5`）。 */
export const ICONS = {
  search:
    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4' +
    'M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  external: '<path d="M7 17 17 7M9 7h8v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  'arrow-up': '<path d="M12 20V5M6 11l6-6 6 6"/>',
};

/** 图标在 `<svg>` 里的包装尺寸。 */
const ICON_SIZE = 24;

/**
 * 渲染一个白名单图标。
 *
 * @param {string} name 图标名（必须是 `ICONS` 的键）
 * @returns {string} 内联 SVG
 * @throws {Error} 图标不在白名单
 */
export function renderIcon(name) {
  const path = ICONS[name];
  if (!path) throw new Error(`图标 \`${name}\` 不在白名单（可用：${Object.keys(ICONS).join(', ')}）`);
  return (
    `<svg class="icon icon-${name}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" width="${ICON_SIZE}" ` +
    `height="${ICON_SIZE}" aria-hidden="true" focusable="false" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `${path}</svg>`
  );
}

/** 已知 block 类型（`check.mjs` 用它拦未知类型）。 */
export const BLOCK_TYPES = [
  'p', 'h2', 'h3', 'ul', 'ol', 'code', 'table', 'params', 'events', 'callout',
  'steps', 'cards', 'kv', 'diff', 'tree', 'quote', 'hr', 'raw',
];

/**
 * @typedef {Object} RenderContext
 * @property {string} pageId 当前页面 id
 * @property {'A'|'all'} phase 交付阶段
 * @property {(md: string) => string} renderText inline 渲染器（已绑定链接解析）
 * @property {(target: string) => ({href: string, pending?: boolean, title?: string}|null)} resolve 链接解析
 * @property {string[]} warnings 收集 WARN（未知语言等）
 * @property {number} codeSeq 代码块序号计数器（用于复制按钮的 id）
 */

/**
 * 渲染 block 序列。
 *
 * @param {object[]} blocks block 序列
 * @param {RenderContext} ctx 渲染上下文
 * @returns {string} 拼接后的 HTML
 */
export function renderBlocks(blocks, ctx) {
  return blocks.map((block, index) => renderBlock(block, ctx, index)).join('');
}

/**
 * 渲染一个 block。
 *
 * @param {object} block block 数据
 * @param {RenderContext} ctx 渲染上下文
 * @param {number} [index] block 在本页中的序号（用于错误定位与复制按钮 id）
 * @returns {string} HTML
 * @throws {Error} 未知 block 类型或数据不合法
 */
export function renderBlock(block, ctx, index = 0) {
  if (!block || typeof block.t !== 'string') {
    throw new Error(`block #${index} 缺少 \`t\` 字段（页面 ${ctx.pageId}）`);
  }
  const renderer = RENDERERS[block.t];
  if (!renderer) throw new Error(`未知 block 类型 \`${block.t}\`（页面 ${ctx.pageId}，block #${index}）`);
  return renderer(block, ctx, index);
}

/**
 * 断言 block 的必填字段是否存在（缺失即抛错，指名页面 + block 序号 + 字段）。
 *
 * @param {object} block block 数据
 * @param {string[]} fields 必填字段
 * @param {RenderContext} ctx 渲染上下文
 * @param {number} index block 序号
 * @returns {void}
 */
function requireFields(block, fields, ctx, index) {
  for (const field of fields) {
    if (block[field] === undefined || block[field] === null) {
      throw new Error(`block #${index}（${block.t}）缺少字段 \`${field}\`，页面 ${ctx.pageId}`);
    }
  }
}

/** 各 block 的渲染器。 */
const RENDERERS = {
  p(block, ctx, index) {
    requireFields(block, ['md'], ctx, index);
    return `<p>${ctx.renderText(block.md)}</p>`;
  },

  h2(block, ctx, index) {
    requireFields(block, ['text', 'id'], ctx, index);
    return `<h2 id="${escapeHtml(block.id)}">${ctx.renderText(block.text)}</h2>`;
  },

  h3(block, ctx, index) {
    requireFields(block, ['text', 'id'], ctx, index);
    return `<h3 id="${escapeHtml(block.id)}">${ctx.renderText(block.text)}</h3>`;
  },

  ul(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const items = block.items.map((item) => `<li>${ctx.renderText(item)}</li>`).join('');
    return `<ul>${items}</ul>`;
  },

  ol(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const start = block.start && block.start !== 1 ? ` start="${Number(block.start)}"` : '';
    const items = block.items.map((item) => `<li>${ctx.renderText(item)}</li>`).join('');
    return `<ol${start}>${items}</ol>`;
  },

  code(block, ctx) {
    requireFields(block, ['lang', 'code'], ctx, ctx.codeSeq);
    const id = `code-${ctx.pageId.replace(/\W+/g, '-')}-${ctx.codeSeq}`;
    ctx.codeSeq += 1;
    const result = highlight(block.code, block.lang);
    if (result.degraded) ctx.warnings.push(`${ctx.pageId}: 代码块语言 \`${block.lang}\` 未识别，已退化为纯文本`);
    const title = block.title ? `<span class="code-title">${escapeHtml(block.title)}</span>` : '';
    const langLabel = languageLabel(block.lang);
    const lines = result.html.split('\n');
    const marked = Array.isArray(block.highlight)
      ? lines
          .map((line, i) =>
            block.highlight.includes(i + 1) ? `<span class="code-line is-hl">${line}</span>` : line,
          )
          .join('\n')
      : result.html;
    return (
      `<figure class="code-block">` +
      `<figcaption class="code-head">${langLabel}${title}` +
      `<button type="button" class="copy-btn" data-copy="#${id}" aria-label="复制代码">` +
      `${renderIcon('copy')}<span class="copy-label">复制</span></button></figcaption>` +
      `<pre class="code" id="${id}" tabindex="0" role="region" aria-label="代码：${escapeHtml(block.lang)}">` +
      `<code>${marked}</code></pre></figure>`
    );
  },

  table(block, ctx, index) {
    requireFields(block, ['head', 'rows'], ctx, index);
    const width = block.head.length;
    block.rows.forEach((row, rowIndex) => {
      if (row.length !== width) {
        throw new Error(
          `表格列数不一致（页面 ${ctx.pageId}，block #${index}，第 ${rowIndex + 1} 行）：` +
            `表头 ${width} 列，该行 ${row.length} 列`,
        );
      }
    });
    const head = block.head.map((cell) => `<th scope="col">${ctx.renderText(cell)}</th>`).join('');
    const body = block.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${ctx.renderText(cell)}</td>`).join('')}</tr>`)
      .join('');
    const caption = block.caption
      ? `<caption>${ctx.renderText(block.caption)}</caption>`
      : '<caption class="visually-hidden">参数与说明对照表</caption>';
    const dense = block.dense ? ' is-dense' : '';
    return `<div class="table-wrap"><table class="table${dense}">${caption}` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  },

  params(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const head =
      '<thead><tr><th scope="col">参数</th><th scope="col">类型</th><th scope="col">必填</th>' +
      '<th scope="col">默认</th><th scope="col">说明</th></tr></thead>';
    const rows = block.items
      .map((item) => {
        const req = item.required
          ? '<span class="req" aria-label="必填">*</span>'
          : '<span class="muted">否</span>';
        const def = item.default ? `<code>${escapeHtml(item.default)}</code>` : '<span class="muted">—</span>';
        const source = item.source ? `<span class="param-source">${ctx.renderText(item.source)}</span>` : '';
        return (
          `<tr><td><code>${escapeHtml(item.name)}</code></td>` +
          `<td>${escapeHtml(item.type || '—')}</td><td>${req}</td><td>${def}</td>` +
          `<td>${ctx.renderText(item.desc)}${source}</td></tr>`
        );
      })
      .join('');
    const caption = block.caption
      ? `<caption>${ctx.renderText(block.caption)}</caption>`
      : '<caption class="visually-hidden">参数表</caption>';
    return `<div class="table-wrap"><table class="table params">${caption}${head}` +
      `<tbody>${rows}</tbody></table></div>`;
  },

  events(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    return block.items.map((item) => renderEventCard(item, ctx)).join('');
  },

  callout(block, ctx, index) {
    requireFields(block, ['kind', 'md'], ctx, index);
    const kind = ['note', 'tip', 'warn', 'danger'].includes(block.kind) ? block.kind : 'note';
    const iconName = kind === 'tip' ? 'check' : kind === 'note' ? 'info' : 'alert';
    const labels = { note: '说明', tip: '提示', warn: '注意', danger: '危险' };
    const title = block.title || labels[kind];
    return (
      `<aside class="callout callout-${kind}">` +
      `<p class="callout-title">${renderIcon(iconName)}<span>${escapeHtml(title)}</span></p>` +
      `<div class="callout-body">${ctx.renderText(block.md)}</div></aside>`
    );
  },

  steps(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const start = block.start ? Number(block.start) : 1;
    const items = block.items
      .map((item, itemIndex) => {
        const code = item.code ? renderInlineStepCode(item.code, ctx, start + itemIndex) : '';
        return (
          `<li class="step"><p class="step-title">${ctx.renderText(item.title)}</p>` +
          `<div class="step-body">${ctx.renderText(item.md)}</div>${code}</li>`
        );
      })
      .join('');
    return `<ol class="steps" start="${start}">${items}</ol>`;
  },

  cards(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const cols = Number(block.cols || 2);
    const items = block.items
      .map((item) => {
        const badge = item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : '';
        const target = ctx.resolve(item.href);
        const inner =
          `<span class="card-title">${ctx.renderText(item.title)}</span>${badge}` +
          `<span class="card-desc">${ctx.renderText(item.desc)}</span>`;
        if (!target || target.pending) {
          return `<li class="card is-pending"><span class="pending" aria-disabled="true">${inner}` +
            '<span class="pending-tag">阶段 B 提供</span></span></li>';
        }
        return `<li class="card"><a class="card-link" href="${escapeHtml(target.href)}">${inner}</a></li>`;
      })
      .join('');
    return `<ul class="cards cards-${cols}">${items}</ul>`;
  },

  kv(block, ctx, index) {
    requireFields(block, ['items'], ctx, index);
    const rows = block.items
      .map((item) => `<dt>${ctx.renderText(item.k)}</dt><dd>${ctx.renderText(item.v)}</dd>`)
      .join('');
    return `<dl class="kv">${rows}</dl>`;
  },

  diff(block, ctx, index) {
    requireFields(block, ['before', 'after'], ctx, index);
    const lang = block.lang || 'json';
    const before = highlight(block.before, lang).html;
    const after = highlight(block.after, lang).html;
    return (
      '<div class="diff">' +
      `<div class="diff-side diff-before"><p class="diff-label">改前</p><pre class="code" tabindex="0" ` +
      `role="region" aria-label="改前代码"><code>${before}</code></pre></div>` +
      `<div class="diff-side diff-after"><p class="diff-label">改后</p><pre class="code" tabindex="0" ` +
      `role="region" aria-label="改后代码"><code>${after}</code></pre></div></div>`
    );
  },

  tree(block, ctx, index) {
    requireFields(block, ['root', 'lines'], ctx, index);
    const commentIdx = block.lines.map((line) => commentStart(line));
    const width = Math.max(...commentIdx.filter((value) => value > 0), 0);
    const body = block.lines
      .map((line) => {
        const cut = commentStart(line);
        if (cut < 0) return escapeHtml(line);
        const pad = ' '.repeat(Math.max(width - cut, 1));
        return (
          `${escapeHtml(line.slice(0, cut))}${pad}` +
          `<span class="tree-comment">${escapeHtml(line.slice(cut))}</span>`
        );
      })
      .join('\n');
    return (
      `<figure class="code-block tree-block"><figcaption class="code-head">` +
      `<span class="code-lang">目录</span><span class="code-title">${escapeHtml(block.root)}</span>` +
      `</figcaption><pre class="code tree" tabindex="0" role="region" aria-label="目录结构">` +
      `<code>${body}</code></pre></figure>`
    );
  },

  quote(block, ctx, index) {
    requireFields(block, ['md'], ctx, index);
    const cite = block.cite ? `<cite>${ctx.renderText(block.cite)}</cite>` : '';
    return `<blockquote class="quote"><p>${ctx.renderText(block.md)}</p>${cite}</blockquote>`;
  },

  hr() {
    return '<hr>';
  },

  raw(block, ctx, index) {
    const svg = block.svg;
    if (typeof svg !== 'string' || !Object.prototype.hasOwnProperty.call(ICONS, svg)) {
      throw new Error(`\`t:'raw'\` 只能引用白名单图标（页面 ${ctx.pageId}，block #${index}，收到 \`${svg}\`）`);
    }
    return renderIcon(svg);
  },
};

/**
 * 步骤内的代码块（无 `title`，复制按钮 id 用页面 + 步骤号）。
 *
 * @param {{lang: string, code: string}} item 代码数据
 * @param {RenderContext} ctx 渲染上下文
 * @param {number} seq 序号
 * @returns {string} HTML
 */
function renderInlineStepCode(item, ctx, seq) {
  const id = `code-${ctx.pageId.replace(/\W+/g, '-')}-step-${seq}`;
  const result = highlight(item.code, item.lang || 'bash');
  if (result.degraded) ctx.warnings.push(`${ctx.pageId}: 步骤代码语言 \`${item.lang}\` 未识别`);
  return (
    `<figure class="code-block"><figcaption class="code-head">` +
    `<span class="code-lang">${languageLabel(item.lang || 'bash')}</span>` +
    `<button type="button" class="copy-btn" data-copy="#${id}" aria-label="复制命令">` +
    `${renderIcon('copy')}<span class="copy-label">复制</span></button></figcaption>` +
    `<pre class="code" id="${id}" tabindex="0" role="region" aria-label="代码：` +
    `${escapeHtml(item.lang || 'bash')}"><code>${result.html}</code></pre></figure>`
  );
}

/**
 * 语言标签（页面上显示的人类可读名）。
 *
 * @param {string} lang 语言名
 * @returns {string} 例如 `<span class="code-lang">ts</span>`
 */
function languageLabel(lang) {
  const normalized = String(lang || 'text').toLowerCase();
  const pretty = { ts: 'TS', js: 'JS', json: 'JSON', bash: 'Shell', text: 'Output' }[normalized];
  return `<span class="code-lang">${escapeHtml(pretty || normalized)}</span>`;
}

/**
 * 事件卡（`events` 模板与 `events` block 共用）。
 *
 * @param {object} item 事件记录
 * @param {RenderContext} ctx 渲染上下文
 * @returns {string} HTML
 */
export function renderEventCard(item, ctx) {
  const sub = item.subtype ? `<span class="event-sub">/${escapeHtml(item.subtype)}</span>` : '';
  const streamOnly = item.streamOnly
    ? '<span class="badge badge-warn">仅 stream-json</span>'
    : '';
  const fields = (item.fields || [])
    .map(
      (field) =>
        `<li><code>${escapeHtml(field.name)}</code>` +
        `<span class="event-field-type">${escapeHtml(field.type || '')}</span>` +
        `<span class="event-field-desc">${ctx.renderText(field.desc || '')}</span></li>`,
    )
    .join('');
  return (
    `<article class="event-card" id="event-${escapeHtml(item.type)}${item.subtype ? `-${escapeHtml(item.subtype)}` : ''}">` +
    `<h3 class="event-head"><code class="event-type">${escapeHtml(item.type)}</code>${sub}${streamOnly}</h3>` +
    `<p class="event-when">${ctx.renderText(item.when || '')}</p>` +
    `<ul class="event-fields">${fields}</ul>` +
    `<pre class="event-example"><code>${escapeHtml(item.example || '')}</code></pre></article>`
  );
}

/**
 * 目录树行内注释的起始下标（`#` 前至少有一个空格）。
 *
 * @param {string} line 一行目录树
 * @returns {number} 注释起点下标；没有注释返回 `-1`
 */
function commentStart(line) {
  const match = /\s#/.exec(line);
  return match ? match.index + 1 : -1;
}

/**
 * 便捷函数：渲染一段 inline 文本（内容作者在数据模块里写 `desc` 时复用同一实现）。
 *
 * @param {string} md inline 文本
 * @returns {string} HTML
 */
export function renderInlineText(md) {
  return renderInline(md);
}
