/**
 * 保护什么：整站锚点与 URL 的唯一真源 —— escapeHtml / slug / assignSlugs / pageUrlPath /
 * outputPath / pathToPageId。
 *
 * 为什么需要它：这些函数算错时构建不会报错。锚点从 `-2` 变成 `-3` 只会让别人的收藏失效，
 * `start/index` 的映射被"顺手简化"成 `/start/` 只会让站点根 404，中文标题被压成空串只会让
 * 所有锚点撞成同一个 id。没有这组断言，全部回归都只能等读者来报。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  assignSlugs,
  escapeHtml,
  outputPath,
  pageUrlPath,
  pathToPageId,
  slug,
  urlKind,
} from '../src/render/slug.mjs';

test('中文标题保留中文、丢弃全角括号与内部空格', () => {
  assert.equal(slug('全局参数（101 处声明）'), '全局参数101-处声明');
});

test('全角标点被丢弃（顿号、冒号、句号）', () => {
  assert.equal(slug('用法、说明'), '用法说明');
  assert.equal(slug('默认值：见下文。'), '默认值见下文');
});

test('ASCII 一律小写', () => {
  assert.equal(slug('CLI Reference'), 'cli-reference');
  assert.equal(slug('Ctrl+Enter'), 'ctrl-enter');
});

test('连续分隔符折叠成单个 -', () => {
  assert.equal(slug('a   b--c'), 'a-b-c');
});

test('首尾的 - 被修剪', () => {
  assert.equal(slug('  Hello   '), 'hello');
  assert.equal(slug('—— 用法 ——'), '用法');
});

test('没有任何可用字符时降级为 section（而不是空 id）', () => {
  assert.equal(slug(''), 'section');
  assert.equal(slug('——'), 'section');
  assert.equal(slug(null), 'section');
  assert.equal(slug(undefined), 'section');
});

test('页内重复标题依次得到 -2、-3', () => {
  assert.deepEqual(assignSlugs(['用法', '用法', '用法']), ['用法', '用法-2', '用法-3']);
});

test('已占用的 用法-2 不会覆盖，循环取号直到不撞', () => {
  // 页内本来就有标题 slug 化为 `用法-2` 时，第二个 `用法` 必须跳到 `-3`，
  // 而不是生成 `-2` 再把已有锚点覆盖掉（spec §2.3 / P2-9）。
  assert.deepEqual(assignSlugs(['用法', '用法'], new Set(['用法-2'])), ['用法', '用法-3']);
  assert.deepEqual(
    assignSlugs(['用法', '用法'], new Set(['用法', '用法-2', '用法-3'])),
    ['用法-4', '用法-5'],
  );
});

test('pageUrlPath：四条穷尽映射', () => {
  assert.equal(pageUrlPath('start/index'), '/');
  assert.equal(pageUrlPath('tools/index'), '/tools/');
  assert.equal(pageUrlPath('guide/tui'), '/guide/tui/');
  assert.equal(pageUrlPath('404'), '/404/');
});

test('urlKind 把四条映射区分成不同类别', () => {
  assert.equal(urlKind('start/index'), 'root');
  assert.equal(urlKind('tools/index'), 'group');
  assert.equal(urlKind('guide/tui'), 'page');
  assert.equal(urlKind('404'), '404');
});

test('outputPath：index 特例落地成 index.html，不出现 index/index.html', () => {
  assert.equal(outputPath('start/index'), 'index.html');
  assert.equal(outputPath('tools/index'), 'tools/index.html');
  assert.equal(outputPath('guide/tui'), 'guide/tui/index.html');
  assert.equal(outputPath('404'), '404/index.html');
});

test('pathToPageId 是 pageUrlPath 的逆函数', () => {
  for (const id of ['start/index', 'tools/index', 'guide/tui', '404']) {
    assert.deepEqual(pathToPageId(pageUrlPath(id)), { id, anchor: '' });
  }
});

test('pathToPageId 保留 #anchor 尾注', () => {
  assert.deepEqual(pathToPageId('/guide/tui/#options'), { id: 'guide/tui', anchor: 'options' });
  assert.deepEqual(pathToPageId('#options'), { id: 'start/index', anchor: 'options' });
  assert.deepEqual(pathToPageId('/'), { id: 'start/index', anchor: '' });
});

test('escapeHtml 转义全部五个字符', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('escapeHtml 先把 & 换掉，因此单次调用不会重复转义', () => {
  // `&` 排在替换表第一位：`&lt;` 进来只会被处理一次，不会变成 `&amp;amp;lt;`。
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('escapeHtml 把 null/undefined 当成空串而不是 "null"', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});
