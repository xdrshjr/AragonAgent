/**
 * 保护什么：BLOCK_TYPES 里每一种 block 都有渲染器、都有必需标记，且不合法数据会**抛错**
 * 而不是渲染出半截 HTML。
 *
 * 为什么需要它：block 是内容作者唯一的表达通道。少一个 `h2` 的 id 只让 TOC 静默少一项；
 * 表格列数不一致在生产里会渲染成错位的行列；`raw` 白名单一旦漏判就是 XSS 通道。
 * 这些都不会让构建失败，所以只能在这里显式断言。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BLOCK_TYPES,
  ICONS,
  renderBlock,
  renderBlocks,
  renderEventCard,
  renderIcon,
} from '../src/render/blocks.mjs';
import { renderInline } from '../src/render/inline.mjs';

/**
 * 构造最小渲染上下文（与 `createContext` 同形，但不拉起整页依赖）。
 *
 * @param {object} [overrides] 覆盖默认字段，例如自定义 `resolve`
 * @returns {object} RenderContext
 */
function makeCtx(overrides = {}) {
  const resolve = overrides.resolve || (() => null);
  return {
    pageId: 'guide/tui',
    phase: 'A',
    resolve,
    renderText: (md) => renderInline(md, { resolveLink: resolve }),
    warnings: [],
    codeSeq: 0,
    ...overrides,
  };
}

/** 每种 block 的最小合法数据 + 它必须产出的标记。 */
const FIXTURES = new Map([
  ['p', { block: { t: 'p', md: '一段正文' }, expect: '<p>一段正文</p>' }],
  ['h2', { block: { t: 'h2', id: 'usage', text: '用法' }, expect: '<h2 id="usage">用法</h2>' }],
  ['h3', { block: { t: 'h3', id: 'step', text: '步骤' }, expect: '<h3 id="step">步骤</h3>' }],
  ['ul', { block: { t: 'ul', items: ['甲', '乙'] }, expect: '<ul><li>甲</li><li>乙</li></ul>' }],
  ['ol', { block: { t: 'ol', items: ['甲'] }, expect: '<ol><li>甲</li></ol>' }],
  ['code', { block: { t: 'code', lang: 'ts', code: 'const a = 1;' }, expect: 'role="region"' }],
  ['table', { block: { t: 'table', head: ['参数'], rows: [['a']] }, expect: '<table class="table">' }],
  ['params', { block: { t: 'params', items: [{ name: 'phase' }] }, expect: '<table class="table params">' }],
  ['events', { block: { t: 'events', items: [{ type: 'assistant' }] }, expect: '<article class="event-card"' }],
  ['callout', { block: { t: 'callout', kind: 'note', md: '说明' }, expect: '<aside class="callout callout-note">' }],
  ['steps', { block: { t: 'steps', items: [{ title: '安装', md: '跑一次' }] }, expect: '<ol class="steps" start="1">' }],
  ['cards', { block: { t: 'cards', items: [{ title: '卡片' }] }, expect: '<ul class="cards cards-2">' }],
  ['kv', { block: { t: 'kv', items: [{ k: '键', v: '值' }] }, expect: '<dl class="kv">' }],
  ['diff', { block: { t: 'diff', before: '{}', after: '{"a":1}' }, expect: '<div class="diff">' }],
  ['tree', { block: { t: 'tree', root: 'src', lines: ['src/a.ts'] }, expect: '<pre class="code tree"' }],
  ['quote', { block: { t: 'quote', md: '一句话' }, expect: '<blockquote class="quote">' }],
  ['hr', { block: { t: 'hr' }, expect: '<hr>' }],
  ['raw', { block: { t: 'raw', svg: 'info' }, expect: '<svg class="icon icon-info"' }],
]);

test('每一种 block 类型都渲染出必需标记（新增类型必须同时补夹具）', () => {
  assert.equal(BLOCK_TYPES.length, FIXTURES.size, 'BLOCK_TYPES 与夹具数量不一致');
  for (const type of BLOCK_TYPES) {
    const fixture = FIXTURES.get(type);
    assert.ok(fixture, `BLOCK_TYPES 里的 \`${type}\` 没有测试夹具`);
    const html = renderBlock(fixture.block, makeCtx(), 0);
    assert.equal(typeof html, 'string', `${type} 未返回字符串`);
    assert.ok(html.includes(fixture.expect), `${type} 缺少 ${fixture.expect}\n实际：${html.slice(0, 300)}`);
  }
});

test('表格列数不一致立刻抛错，并指明 block 序号', () => {
  const block = { t: 'table', head: ['参数', '默认'], rows: [['a', '1'], ['b']] };
  assert.throws(() => renderBlock(block, makeCtx(), 7), /block #7/);
  assert.throws(() => renderBlock(block, makeCtx(), 7), /第 2 行/);
});

test('renderBlocks 用真实下标定位出错的那一块', () => {
  const blocks = [{ t: 'hr' }, { t: 'table', head: ['a'], rows: [['x', 'y']] }];
  assert.throws(() => renderBlocks(blocks, makeCtx()), /block #1/);
});

test('未知 block 类型抛错（不可扩展原则）', () => {
  assert.throws(() => renderBlock({ t: 'carousel' }, makeCtx(), 2), /未知 block 类型/);
  assert.throws(() => renderBlock({ md: '缺 t' }, makeCtx(), 2), /block #2 缺少/);
});

test('raw 只接受白名单图标，非白名单抛错', () => {
  assert.throws(() => renderBlock({ t: 'raw', svg: 'script' }, makeCtx(), 1), /白名单/);
  assert.match(renderBlock({ t: 'raw', svg: 'search' }, makeCtx(), 1), /^<svg/);
});

test('renderIcon 对未知图标名抛错并列出可用项', () => {
  assert.ok(Object.keys(ICONS).length >= 12);
  assert.match(renderIcon('moon'), /^<svg[^>]*aria-hidden="true"/);
  assert.throws(() => renderIcon('rocket'), /不在白名单/);
});

test('code 块可聚焦、有可读名称，且复制按钮的 id 对得上 <pre>', () => {
  const ctx = makeCtx();
  const html = renderBlock({ t: 'code', lang: 'ts', code: 'const a = 1;' }, ctx, 3);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="region"/);
  assert.match(html, /aria-label="代码：ts"/);
  const target = html.match(/data-copy="#([^"]+)"/);
  assert.ok(target, '缺少复制按钮的 data-copy');
  assert.match(html, new RegExp(`id="${target[1]}"`));
  // 序号递增：同一页的第二个代码块不能复用 id。
  const second = renderBlock({ t: 'code', lang: 'ts', code: 'const b = 2;' }, ctx, 4);
  assert.equal(second.includes(`id="${target[1]}"`), false);
  assert.equal(ctx.codeSeq, 2);
});

test('code 块对未知语言只记一条 WARN，不抛错', () => {
  const ctx = makeCtx();
  const html = renderBlock({ t: 'code', lang: 'rust', code: 'fn main() {}' }, ctx, 0);
  assert.match(html, /<pre/);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /rust/);
});

test('events 每个 item 一张卡，字段齐全', () => {
  const ctx = makeCtx();
  const html = renderBlock(
    {
      t: 'events',
      items: [
        {
          type: 'assistant',
          subtype: 'delta',
          streamOnly: true,
          when: '每个增量',
          fields: [{ name: 'text', type: 'string', desc: '增量文本' }],
          example: '{"text":"hi"}',
        },
        { type: 'result', when: '结束时', fields: [], example: '{"ok":true}' },
      ],
    },
    ctx,
    0,
  );
  assert.equal((html.match(/<article class="event-card"/g) || []).length, 2);
  assert.match(html, /id="event-assistant-delta"/);
  assert.match(html, /id="event-result"/);
  assert.match(html, /class="event-type">assistant/);
  assert.match(html, /class="event-sub">\/delta/);
  assert.match(html, /仅 stream-json/);
  assert.match(html, /class="event-field-type">string/);
  assert.match(html, /class="event-field-desc">增量文本/);
  assert.match(html, /class="event-when">每个增量/);
});

test('renderEventCard 直接调用时同一份字段约定（templates 复用）', () => {
  const html = renderEventCard({ type: 'tool', fields: [{ name: 'name' }] }, makeCtx());
  assert.match(html, /id="event-tool"/);
  assert.match(html, /<li><code>name<\/code>/);
});

test('callout 的 danger 变体同时给出 alert 图标与「危险」字样', () => {
  const html = renderBlock({ t: 'callout', kind: 'danger', md: '会删数据' }, makeCtx(), 0);
  assert.match(html, /class="callout callout-danger"/);
  assert.match(html, /icon-alert/);
  assert.match(html, /<span>危险<\/span>/);
  assert.match(html, /会删数据/);
});

test('cards 指向未上线页面时不带 href（pending 不可点）', () => {
  const ctx = makeCtx({ resolve: (target) => (target === '/guide/later/' ? { href: '', pending: true } : null) });
  const pending = renderBlock({ t: 'cards', items: [{ title: '稍后上线', href: '/guide/later/' }] }, ctx, 0);
  assert.match(pending, /is-pending/);
  assert.match(pending, /<span class="pending" aria-disabled="true">/);
  assert.equal(pending.includes('<a'), false);
  assert.equal(pending.includes('href'), false);

  const linked = renderBlock(
    { t: 'cards', items: [{ title: 'TUI', href: '/guide/tui/', badge: '已上线' }] },
    makeCtx({ resolve: () => ({ href: '../tui/' }) }),
    0,
  );
  assert.match(linked, /<a class="card-link" href="..\/tui\/">/);
  assert.match(linked, /class="badge">已上线/);
});

test('diff 两侧都进可聚焦区域，改前/改后各有一个可读名称', () => {
  const html = renderBlock({ t: 'diff', before: '{}', after: '{"a":1}' }, makeCtx(), 0);
  assert.match(html, /aria-label="改前代码"/);
  assert.match(html, /aria-label="改后代码"/);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 2);
});

test('tree 的注释列被包成 tree-comment，其余文本转义', () => {
  const html = renderBlock({ t: 'tree', root: 'src', lines: ['src/a.ts #入口', 'src/<b>.ts'] }, makeCtx(), 0);
  assert.match(html, /class="tree-comment">#入口/);
  assert.match(html, /&lt;b&gt;/);
});
