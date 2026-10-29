/**
 * 标题抽取与锚点分配。
 *
 * 一页的 H2/H3 既要进右栏 TOC，也要能作为跨页链接的落点，因此 id 必须在**渲染前**
 * 一次性分配好（§4.3 步骤 8），且在整页范围内唯一。
 */

import { assignSlugs } from './slug.mjs';

/**
 * @typedef {Object} TocEntry
 * @property {1|2} level 1 = H2，2 = H3
 * @property {string} text 标题文本
 * @property {string} id 锚点 id
 */

/**
 * @typedef {Object} TocResult
 * @property {object[]} blocks 新的 block 数组（`h2`/`h3` 带上了 `id`）
 * @property {TocEntry[]} toc 扁平化的目录（按文档顺序）
 */

/**
 * 为页面正文里的 H2/H3 分配唯一 id，并返回 TOC。
 *
 * - 作者显式给出的 `block.id` 会被占用，但不会参与自动取号；
 * - 与已有标题撞名时按 `-2`、`-3` 递增，直到不撞（§2.3 / P2-9）；
 * - 返回新的 block 对象，**不修改入参**（确定性 + 好测）。
 *
 * `used` 只从 `reserved`（模板自带的锚点）起算，**不是**从「所有显式 id」起算：
 * 后者会让每一个作者写下的 id 立刻与自己的名字相撞，于是第一个用 `id:` 的人拿到的
 * 锚点会变成 `foo-2` —— 链接与目录一起指向不存在的 `#foo`。
 *
 * @param {object[]} blocks 页面正文 block 序列
 * @param {string[]} [reserved] 模板自带、不属于 block 的锚点 id（如 `see-also-title`）
 * @returns {TocResult} 带 id 的 block 与新 TOC
 */
export function annotateHeadings(blocks, reserved = []) {
  const explicit = new Set(reserved);
  for (const block of blocks) {
    if ((block.t === 'h2' || block.t === 'h3') && block.id) explicit.add(block.id);
  }

  const headings = blocks.filter((block) => block.t === 'h2' || block.t === 'h3');
  const titles = headings.map((block) => block.text);
  const generated = assignSlugs(titles, explicit);
  const idByBlock = new Map();

  headings.forEach((block, index) => {
    idByBlock.set(block, block.id || generated[index]);
  });

  const used = new Set(reserved);
  const toc = [];
  const nextBlocks = blocks.map((block) => {
    if (block.t !== 'h2' && block.t !== 'h3') return block;
    let id = idByBlock.get(block);
    if (used.has(id)) {
      const base = id;
      let counter = 2;
      while (used.has(id)) {
        id = `${base}-${counter}`;
        counter += 1;
      }
    }
    used.add(id);
    toc.push({ level: block.t === 'h2' ? 1 : 2, text: block.text, id });
    return id === block.id ? block : { ...block, id };
  });

  return { blocks: nextBlocks, toc };
}

/**
 * 页内是否跳级（H2 之前出现 H3，或首个标题是 H3）。
 *
 * @param {TocEntry[]} toc 目录
 * @returns {boolean} 跳级则为 `true`
 */
export function hasLevelSkip(toc) {
  if (toc.length > 0 && toc[0].level === 2) return true;
  for (let index = 1; index < toc.length; index += 1) {
    if (toc[index].level - toc[index - 1].level > 1) return true;
  }
  return false;
}

/**
 * 渲染右侧 TOC（纯 `<a href="#id">`，无 JS 也可用）。
 *
 * @param {TocEntry[]} toc 目录
 * @param {(text: string) => string} renderText 行内文本渲染器
 * @returns {string} `<aside>` 的 HTML
 */
export function renderToc(toc, renderText) {
  if (toc.length === 0) return '';
  const items = toc
    .map(
      (entry) =>
        `<li class="toc-item toc-level-${entry.level}">` +
        `<a href="#${entry.id}" data-toc-link>${renderText(entry.text)}</a></li>`,
    )
    .join('');
  return (
    '<aside class="toc" id="page-toc" aria-label="本页目录">' +
    '<p class="toc-title">本页目录</p>' +
    `<ul class="toc-list" data-toc>${items}</ul>` +
    '<div class="toc-progress" aria-hidden="true"><span></span></div>' +
    '</aside>'
  );
}
