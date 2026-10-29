/**
 * 微型 inline 语法（只有 4 种，§6.2）：`code`、**strong**、[text](href)、{kbd:...}。
 *
 * 未闭合标记一律抛错，不静默降级 —— 静默降级会让错误的文档变成「看起来没事」的文档。
 * 这里同时导出校验函数，`check.mjs --model` 与 `build.mjs` 共用同一份实现。
 */

import { escapeHtml } from './slug.mjs';

/**
 * 允许出现在 `<a href>` 里的目标形态：站内路径（`/guide/tui/` 或 `guide/tui`）、页内锚点、
 * https 外链。
 *
 * `./`、`../` 被有意排除：产物是按页面 id 生成的目录式 URL，没有「当前目录」这回事，
 * 相对写法只会在多一层目录时静默指错。
 */
const HREF_ALLOWED =
  /^(?!\.\.?\/)(\/|[a-z0-9][a-z0-9./_-]*\/?$|#[^\s]+$|https:\/\/)/i;

/**
 * @typedef {Object} InlineError
 * @property {string} code 机器可读的错误码
 * @property {string} message 面向作者的中文说明
 * @property {number} offset 出错位置在输入串中的下标
 */

/**
 * 校验一段 inline 文本，返回全部问题（空数组 = 通过）。
 *
 * 校验项：反引号成对、`**` 成对、`[...](...)` 完整且 scheme 允许、`{kbd:...}` 闭合且非空、
 * 不含裸 HTML 标签、不含 `__` 斜体。
 *
 * @param {string} md 待校验文本
 * @returns {InlineError[]} 问题清单
 */
export function validateInline(md) {
  const text = String(md == null ? '' : md);
  const errors = [];
  const push = (code, message, offset) => errors.push({ code, message, offset });

  const backticks = (text.match(/`/g) || []).length;
  if (backticks % 2 !== 0) push('unclosed-code', '行内代码的反引号没有成对闭合', text.length);

  // `**` 只在**代码片段之外**才算加粗标记：`src/**/*.ts` 这种 glob 里也有 `**`，
  // 把它计入会让合法的行内代码被判成"未闭合"。
  const outsideCode = text.replace(/`[^`]*`/g, '`x`');
  const strongs = (outsideCode.match(/\*\*/g) || []).length;
  if (strongs % 2 !== 0) push('unclosed-strong', '`**` 加粗标记没有成对闭合', text.length);
  if (/__[^_]+__/.test(outsideCode)) push('italic-unsupported', '不支持 `__斜体__`，请改用 `**加粗**`', 0);

  const stripped = outsideCode;
  // 只拦真正的 HTML 标签。CLI 文档里 `<id>`、`<dir>` 这类占位符是常态，若一并拦下，
  // 作者会被迫改写源码原文；而渲染层本来就全转义，真正的风险面是「标签形态」。
  if (/<\/?(script|iframe|img|a|div|span|style|link|meta|object|embed|svg|form|input|br|p|b|i|em|strong)\b[^>]*>/i.test(stripped)) {
    push('raw-html', '正文不允许裸 HTML 标签；需要结构请用 block', stripped.search(/<\/?[a-z]/i));
  }
  if (/\{kbd:[^}]*$/.test(text)) push('unclosed-kbd', '`{kbd:...}` 没有闭合', text.length);
  if (/\{kbd:\s*\}/.test(text)) push('empty-kbd', '`{kbd:}` 为空，至少给一个键名', 0);

  const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g;
  let match = linkRe.exec(text);
  while (match) {
    const href = match[2].trim();
    if (href === '') push('empty-href', '链接目标为空', match.index);
    else if (!HREF_ALLOWED.test(href)) {
      push('bad-scheme', `链接目标 \`${href}\` 不被允许（只允许站内相对路径、#锚点、https://）`, match.index);
    }
    if (match[1].trim() === '') push('empty-link-text', '链接文本为空', match.index);
    match = linkRe.exec(text);
  }
  const openBrackets = (text.match(/\[/g) || []).length;
  const closeBrackets = (text.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) push('unclosed-link', '`[` 与 `]` 数量不一致', text.length);

  return errors;
}

/**
 * 渲染 inline 文本为 HTML。
 *
 * @param {string} md inline 文本
 * @param {object} [options] 选项
 * @param {boolean} [options.counterExamples] 为真时跳过校验（反例区专用）
 * @param {(target: string) => ({href: string, pending?: boolean, title?: string}|null)} [options.resolveLink]
 *   站内链接解析器：返回 `null` 表示不是站内链接（原样保留）；返回 `pending: true` 时渲染为不可点占位
 * @returns {string} 已转义的 HTML 片段
 * @throws {Error} 当 `validateInline` 发现问题时抛出，消息内联全部错误码与位置
 */
export function renderInline(md, options = {}) {
  const text = String(md == null ? '' : md);
  if (!options.counterExamples) {
    const errors = validateInline(text);
    if (errors.length > 0) {
      const detail = errors.map((e) => `${e.code}@${e.offset}`).join(', ');
      throw new Error(`inline 语法错误（${detail}）：${text.slice(0, 80)}`);
    }
  }
  return transform(text, options.resolveLink);
}

/**
 * 真正的替换过程：先切出代码片段，再处理其余标记，最后转义文本。
 *
 * 顺序不可换：代码片段内的内容不参与后续标记解析，且所有文本都走 `escapeHtml`。
 *
 * @param {string} text 原始文本
 * @param {Function} [resolveLink] 站内链接解析器
 * @returns {string} HTML
 */
function transform(text, resolveLink) {
  const parts = [];
  const codeRe = /`([^`]+)`/g;
  let cursor = 0;
  let match = codeRe.exec(text);
  while (match) {
    if (match.index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, match.index) });
    parts.push({ kind: 'code', value: match[1] });
    cursor = match.index + match[0].length;
    match = codeRe.exec(text);
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });

  return parts
    .map((part) => {
      if (part.kind === 'code') return `<code>${escapeHtml(part.value)}</code>`;
      return renderTextRun(part.value, resolveLink);
    })
    .join('');
}

/**
 * 处理一段不含行内代码的文本：先替换 `{kbd:}`，再处理链接与加粗。
 *
 * @param {string} text 文本片段
 * @param {Function} [resolveLink] 站内链接解析器
 * @returns {string} HTML
 */
function renderTextRun(text, resolveLink) {
  let out = escapeHtml(text);

  out = out.replace(/\{kbd:([^}]+)\}/g, (_, keys) => {
    const chips = String(keys)
      .split('+')
      .map((key) => `<kbd>${key.trim()}</kbd>`)
      .join('+');
    return chips;
  });

  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (whole, label, href) => {
    const target = href.trim();
    const resolved = resolveLink ? resolveLink(target) : null;
    if (resolved && resolved.pending) {
      return (
        `<span class="pending" aria-disabled="true">${label}` +
        '<span class="pending-tag">阶段 B 提供</span></span>'
      );
    }
    if (resolved) {
      // 标题来自 nav 数据，不是作者写的 Markdown，因此它**没有**经过本函数的
      // escapeHtml：一个含 `"` 的标题会让 href 之后的属性整个断掉。
      const titleAttr = resolved.title ? ` title="${escapeHtml(resolved.title)}"` : '';
      return `<a href="${safeHrefTarget(resolved.href)}"${titleAttr}>${label}</a>`;
    }
    const external = /^https:\/\//i.test(target);
    const externalAttrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    const icon = external ? EXTERNAL_ICON : '';
    return `<a href="${safeHrefTarget(target)}"${externalAttrs}>${label}${icon}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out;
}

/** 站外链接图标（12 个白名单图标之一，纯装饰因此 `aria-hidden`）。 */
export const EXTERNAL_ICON =
  '<svg class="icon icon-external" viewBox="0 0 24 24" width="12" height="12" ' +
  'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">' +
  '<path d="M7 17 17 7M9 7h8v8"/></svg>';

/**
 * 属性值里唯一必须挡住的字符是 `"`：`&` 与 `<` 在这里不会破坏结构。
 *
 * 两个调用方的来路不同，所以这个函数不做假设：Markdown 作者写的 `href` 已经过
 * `escapeHtml`，而 `resolveHref` 产出的站内 `href` 由页面 id 拼成（`[a-z0-9-/]`）。
 * 两者都只缺省略号里那一件事 —— 把 `"` 换成 `&quot;`。
 *
 * @param {string} href href 文本（已转义或由页面 id 拼成）
 * @returns {string} 可直接放进属性值的字符串
 */
function safeHrefTarget(href) {
  return href.replace(/"/g, '&quot;');
}
