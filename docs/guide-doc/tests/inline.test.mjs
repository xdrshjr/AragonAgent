/**
 * 保护什么：inline 只有 4 种语法，但「未闭合」与「转义」这两件事必须每次都可断言。
 *
 * 为什么需要它：这两类回归都是**静默**的 —— 未闭合的反引号会把后半段正文吞进 <code>，
 * 转义顺序写反则会让正文里的 <script> 变成真标签。构建仍然 exit 0，页面仍然「看起来正常」，
 * 只有读者会少半句话或者被打穿。所以边界只能靠这里的断言钉住。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderInline, validateInline } from '../src/render/inline.mjs';

/** 只接管站内绝对路径，其他目标返回 null（走默认的站外链接分支）。 */
const siteResolver = (target) => (target.startsWith('/') ? { href: `..${target}`, title: '站点内页' } : null);

/** 取出全部错误码，便于断言「校验器发现的正是这一类问题」。 */
const codesOf = (md) => validateInline(md).map((entry) => entry.code);

test('四种语法都能渲染：code / strong / link / kbd', () => {
  assert.equal(renderInline('`npm run build`'), '<code>npm run build</code>');
  assert.equal(renderInline('**必填**'), '<strong>必填</strong>');
  assert.equal(
    renderInline('[TUI](/guide/tui/)', { resolveLink: siteResolver }),
    '<a href="../guide/tui/" title="站点内页">TUI</a>',
  );
  const kbd = renderInline('按 {kbd:Ctrl+B} 打开面板');
  assert.equal((kbd.match(/<kbd>/g) || []).length, 2);
  assert.match(kbd, /<kbd>Ctrl<\/kbd>\+<kbd>B<\/kbd>/);
});

test('合法的行内文本不产生任何错误码', () => {
  assert.deepEqual(codesOf('带 `code`、**加粗**、[链接](/guide/tui/) 与 {kbd:Esc} 的一段话'), []);
});

test('未闭合的反引号被拒绝，而不是静默吞掉后半段', () => {
  assert.deepEqual(codesOf('运行 `npm run build'), ['unclosed-code']);
  assert.throws(() => renderInline('运行 `npm run build'), /unclosed-code/);
});

test('未闭合的 ** 加粗被拒绝', () => {
  assert.deepEqual(codesOf('**要点'), ['unclosed-strong']);
  assert.throws(() => renderInline('**要点'), /unclosed-strong/);
});

test('未闭合的链接被拒绝', () => {
  // `]` 缺失：`[` 与 `]` 数量不一致，而不是「闭嘴当成普通文字」。
  assert.deepEqual(codesOf('见 [TUI(/guide/tui/)'), ['unclosed-link']);
  assert.throws(() => renderInline('见 [TUI(/guide/tui/)'), /unclosed-link/);
});

test('未闭合与空的 {kbd:...} 分别报 unclosed-kbd 与 empty-kbd', () => {
  assert.deepEqual(codesOf('按 {kbd:Ctrl'), ['unclosed-kbd']);
  assert.deepEqual(codesOf('按 {kbd:}'), ['empty-kbd']);
  assert.throws(() => renderInline('按 {kbd:}'), /empty-kbd/);
});

test('正文里的 <script> 被转义，原始标签永不出现在输出里', () => {
  // 校验层先拦一道：正文不允许裸 HTML。
  assert.deepEqual(codesOf('<script>alert(1)</script>'), ['raw-html']);
  assert.throws(() => renderInline('<script>alert(1)</script>'), /raw-html/);
  // 反例区（counterExamples）跳过校验，此时唯一的安全网就是转义。
  const text = renderInline('<script>alert(1)</script>', { counterExamples: true });
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(text.includes('<script'), false);
});

test('行内代码里的标签同样先转义再包裹', () => {
  const code = renderInline('`<script>alert(1)</script>`', { counterExamples: true });
  assert.match(code, /^<code>&lt;script&gt;/);
  assert.equal(code.includes('<script'), false);
  assert.equal(code.includes('</script>'), false);
});

test('CLI 文档的占位符 <id> / <dir> 不算裸 HTML 标签', () => {
  assert.deepEqual(codesOf('把 <id> 换成 <dir> 里的实际值'), []);
  assert.match(renderInline('把 <id> 换掉'), /&lt;id&gt;/);
});

test('站内链接未解析时不是坏链：pending 占位不可点，且不带 href', () => {
  const html = renderInline('[引擎 API](/api/agent/)', {
    resolveLink: () => ({ href: '', pending: true, title: '引擎 API' }),
  });
  assert.match(html, /<span class="pending" aria-disabled="true">/);
  assert.equal(html.includes('<a '), false);
  assert.equal(html.includes('href'), false);
});

test('resolveLink 给出的相对 href 原样落进 <a href>', () => {
  assert.equal(renderInline('[x](/x/)', { resolveLink: () => ({ href: '../x/' }) }), '<a href="../x/">x</a>');
  // 站内链接绝不产出以 `/` 开头的绝对路径（子路径部署的前提）。
  const href = renderInline('[x](/x/)', { resolveLink: () => ({ href: 'x/' }) });
  assert.equal(href.includes('href="/'), false);
});

test('https 外链带 target=_blank 与 rel=noopener noreferrer', () => {
  const html = renderInline('[文档](https://example.com/a)');
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  // 装饰性图标必须对辅助技术隐身。
  assert.match(html, /class="icon icon-external"[^>]*aria-hidden="true"/);
});

test('代码片段里的 ** 是 glob，不是未闭合的加粗', () => {
  assert.deepEqual(codesOf('包含 `src/**/*.ts` 的文件'), []);
  assert.equal(renderInline('包含 `src/**/*.ts` 的文件'), '包含 <code>src/**/*.ts</code> 的文件');
});

test('非 https 的 scheme 被校验层拒绝（javascript: 进不了 href）', () => {
  assert.deepEqual(codesOf('点[这里](javascript:alert(1))'), ['bad-scheme']);
  assert.throws(() => renderInline('点[这里](javascript:alert(1))'), /bad-scheme/);
});
