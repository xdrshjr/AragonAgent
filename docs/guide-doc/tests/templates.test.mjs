/**
 * 保护什么：6 种模板的骨架与专属段位、「未知模板/缺字段」的显式失败，以及跨阶段 seeAlso 的降级。
 *
 * 为什么需要它：模板是 56 页共用的骨架。少一个 `<h1>` 只是页面看起来"没标题"，
 * 少一条 `api` 的 importLine 只是复制粘贴时多跑一趟源码；`seeAlso` 指向 B 阶段页面时若
 * 仍然输出 `<a href>`，就会在同一份产物里同时存在「先发 29 页」与 27 条断链。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GROUP_LABELS, TEMPLATES, estimateReadingMinutes, renderTemplate } from '../src/render/templates.mjs';
import { createContext } from '../src/render/page.mjs';

/** 阶段 A 的页面集合（pageMap 里只有它，因此另一条自然是「阶段 B」）。 */
const PAGES = [
  { id: 'start/index', title: '总览', phase: 'A' },
  { id: 'guide/tui', title: 'TUI 界面', phase: 'A' },
  { id: 'guide/later', title: '稍后上线', phase: 'B' },
];

const NAV_GROUPS = [
  { id: 'start', pages: [PAGES[0]] },
  { id: 'guide', pages: [PAGES[1], PAGES[2]] },
];

/**
 * 用真实 `createContext` 造上下文：链接解析、pageMap 与 navTitle 的口径必须与构建一致。
 *
 * @param {object} page 当前页面
 * @returns {object} 渲染上下文
 */
function makeCtx(page) {
  const pageMap = new Map(PAGES.filter((entry) => entry.phase === 'A').map((entry) => [entry.id, entry]));
  return createContext({ page, pageMap, navGroups: NAV_GROUPS, warnings: [] });
}

/**
 * 一页的最小数据。
 *
 * @param {object} [overrides] 覆盖字段
 * @returns {object} 页面数据
 */
function makePage(overrides = {}) {
  return {
    id: 'guide/tui',
    group: 'guide',
    phase: 'A',
    template: 'prose',
    title: 'TUI 界面',
    summary: '一段摘要',
    blocks: [],
    seeAlso: [],
    ...overrides,
  };
}

for (const template of TEMPLATES) {
  test(`模板 ${template} 渲染出页头 H1 与自己的骨架类名`, () => {
    const page = makePage({ template });
    const html = renderTemplate(page, makeCtx(page));
    assert.match(html, /<article class="prose prose-/);
    assert.match(html, new RegExp(`prose-${template}"`));
    assert.match(html, /<h1 class="page-title">TUI 界面<\/h1>/);
    assert.match(html, /class="page-eyebrow">日常使用/);
    assert.match(html, /class="page-summary">一段摘要/);
  });
}

test('hub 模板给出「本组共 N 页」的入口说明', () => {
  const page = makePage({ id: 'start/index', group: 'start', template: 'hub', title: '总览' });
  const html = renderTemplate(page, makeCtx(page));
  assert.match(html, /<p class="hub-lede">/);
  assert.match(html, /本组共 1 页/);
  assert.match(html, /class="page-eyebrow">开始/);
});

test('steps / flags / events 模板各有不可省略的 lede', () => {
  for (const [template, marker] of [
    ['steps', '<p class="steps-lede">'],
    ['flags', '<p class="flags-lede">'],
    ['events', '<p class="events-lede">'],
  ]) {
    const page = makePage({ template });
    const html = renderTemplate(page, makeCtx(page));
    assert.ok(html.includes(marker), `${template} 缺少 ${marker}`);
  }
});

test('api 模板在正文之前渲染 importLine 与 signature 两个代码块', () => {
  const page = makePage({
    template: 'api',
    importLine: "import { Agent } from '@aragon-agent/core';",
    signature: 'class Agent { prompt(message: string): Promise<void> }',
    blocks: [{ t: 'h2', id: 'usage', text: '用法' }],
  });
  const html = renderTemplate(page, makeCtx(page));
  assert.match(html, /class="code-block import-line"/);
  assert.match(html, /class="code-block signature-block"/);
  assert.match(html, /import \{ Agent \} from &#39;@aragon-agent\/core&#39;;/);
  assert.match(html, /prompt\(message: string\)/);
  assert.match(html, /aria-label="导入语句"/);
  assert.match(html, /aria-label="类型签名"/);
  // 位置固定在**正文之前**（页头的 H1 之后、作者 block 之前）。
  assert.ok(html.indexOf('import-line') < html.indexOf('id="usage"'), 'importLine 必须在正文之前');
  assert.ok(html.indexOf('<h1') < html.indexOf('import-line'), '页头 H1 必须第一');
});

test('api 模板在缺少 importLine / signature 时只是不渲染那一段', () => {
  const page = makePage({ template: 'api' });
  const html = renderTemplate(page, makeCtx(page));
  assert.equal(html.includes('import-line'), false);
  assert.equal(html.includes('signature-block'), false);
  assert.match(html, /<h1/);
});

test('未知模板抛错并列出可用模板', () => {
  const page = makePage({ template: 'landing' });
  assert.throws(() => renderTemplate(page, makeCtx(page)), /未知模板 \`landing\`/);
});

test('缺少 blocks 字段仍然渲染（空页不是错误）', () => {
  const page = makePage();
  delete page.blocks;
  const html = renderTemplate(page, makeCtx(page));
  assert.match(html, /<h1 class="page-title">/);
  assert.match(html, /<\/article>$/);
});

test('缺少 title / summary 立刻抛错，而不是把 undefined 印在页面上', () => {
  for (const field of ['title', 'summary']) {
    const page = makePage();
    delete page[field];
    assert.throws(
      () => renderTemplate(page, makeCtx(page)),
      new RegExp(`缺少字段 \\\`${field}\\\``),
      `缺 ${field} 必须抛错：§13.1 的「缺字段 → 抛错」`,
    );
  }
  const blank = makePage({ summary: '   ' });
  assert.throws(() => renderTemplate(blank, makeCtx(blank)), /缺少字段 `summary`/);
});

test('正文 block 会被渲染进 article，位置在页头之后', () => {
  const page = makePage({
    blocks: [
      { t: 'h2', id: 'usage', text: '用法' },
      { t: 'p', md: '按 {kbd:Ctrl+B} 看面板' },
    ],
  });
  const html = renderTemplate(page, makeCtx(page));
  assert.match(html, /<h2 id="usage">用法<\/h2>/);
  assert.match(html, /<p>按 <kbd>Ctrl<\/kbd>\+<kbd>B<\/kbd> 看面板<\/p>/);
  assert.ok(html.indexOf('page-title') < html.indexOf('id="usage"'));
});

test('seeAlso：阶段内页面可点，阶段外页面降级为 .pending 且没有 href', () => {
  const page = makePage({ seeAlso: ['guide/tui', 'guide/later', 'guide/unknown'] });
  const html = renderTemplate(page, makeCtx(page));
  const section = html.slice(html.indexOf('class="see-also"'));
  assert.match(section, /<h2 id="see-also-title"/);
  // 阶段内：真实 <a href>，相对路径由 resolveHref 给出。
  assert.match(section, /<li><a href="\.\/">TUI 界面<\/a><\/li>/);
  // 阶段外（导航里有、pageMap 里没有）与完全未知的都用同一套占位。
  assert.equal((section.match(/<span class="pending" aria-disabled="true">/g) || []).length, 2);
  assert.match(section, /稍后上线/);
  assert.match(section, /guide\/unknown/);
  assert.equal(section.includes('href="guide/later/'), false);
});

test('seeAlso 为空时不产出空段位', () => {
  const html = renderTemplate(makePage(), makeCtx(makePage()));
  assert.equal(html.includes('see-also'), false);
});

test('estimateReadingMinutes：空页至少 1 分钟，且随正文增长', () => {
  assert.ok(estimateReadingMinutes({}) >= 1);
  assert.ok(estimateReadingMinutes({ blocks: [] }) >= 1);
  const short = estimateReadingMinutes({ blocks: [{ md: '字'.repeat(350) }] });
  const long = estimateReadingMinutes({ blocks: [{ md: '字'.repeat(3500) }] });
  assert.ok(short >= 1);
  assert.ok(long > short, `长文（${long} 分钟）必须比短文（${short} 分钟）更久`);
  assert.ok(estimateReadingMinutes({ blocks: [{ code: Array(400).fill('x').join('\n') }] }) >= 4);
});

test('页头把阶段 B 的页面明确标注出来', () => {
  const page = makePage({ phase: 'B' });
  const html = renderTemplate(page, makeCtx(page));
  assert.match(html, /本页随阶段 B 发布/);
});

test('GROUP_LABELS 覆盖导航分组，未知分组回落为 id 本身', () => {
  assert.equal(GROUP_LABELS.guide, '日常使用');
  assert.equal(GROUP_LABELS.appendix, '附录');
  const page = makePage({ group: 'mystery' });
  assert.match(renderTemplate(page, makeCtx(page)), /class="page-eyebrow">mystery/);
});
