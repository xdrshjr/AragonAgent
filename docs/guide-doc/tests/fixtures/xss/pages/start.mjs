/**
 * xss fixture：真实 start 页面 + 一个首块即注入载荷的 `start/five-minutes` 副本。
 *
 * sourceRefs 原样保留（引用仍然有效），因此这个 fixture 触发的差异只有「正文里
 * 出现了裸 HTML」这一件事；渲染层必须先转义、再包裹，AC-5 按产物文本断言。
 */

import { pages as realPages } from '../../../../src/content/pages/start.mjs';

/** 恶意载荷：裸 <script> 标签。 */
export const XSS_PAYLOAD = '注入测试 <script>alert(1)</script>';

export const pages = realPages.map((page) =>
  page.id === 'start/five-minutes'
    ? { ...page, blocks: [{ t: 'p', md: XSS_PAYLOAD }, ...(page.blocks || [])] }
    : page);
