/**
 * 搜索索引与打分（spec §9.1 / §7.4 / §7.7，AC-15 / AC-26）。
 *
 * 两件事必须被证明：
 *   ① 中文查询真的能找到该找到的页 —— 用**真实内容**（9 个页面模块、56 页）建索引，
 *      跑 §9.1 的三条固定断言；索引在测试里重建，不读 `dist/`（产物可能过期）。
 *   ② 索引与打分的边界行为 —— CJK bigram、结果上限、三级截断、`` plainText `` 去标记。
 *
 * 零依赖：只用 `node:test` / `node:assert/strict` 与 node 内建模块。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MAX_INDEX_BYTES,
  TRUNCATE_TRIGGER_BYTES,
  buildIndex,
  buildPageEntry,
  buildSections,
  matchScore,
  plainText,
  search,
  tokenizeQuery,
  truncateToBudget,
} from '../src/render/search.mjs';
import { pageUrlPath } from '../src/render/slug.mjs';
import { GROUP_LABELS } from '../src/render/templates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.resolve(HERE, '..', 'src', 'content', 'pages');

/** 9 个页面模块（与 `nav.mjs` 的 9 个分组一一对应）。 */
const PAGE_MODULES = [
  'start',
  'guide',
  'config',
  'cli',
  'exec',
  'api',
  'tools',
  'troubleshoot',
  'appendix',
];

/** 索引里只记录版本号；测试不关心真实版本，用固定值保证可重复。 */
const VERSIONS = { cli: '0.6.0-test', core: '0.2.0-test' };

/**
 * 用真实页面模块建立索引（56 页，含阶段 B）。
 *
 * @returns {Promise<object>} `search-index.json` 形态的索引对象
 */
async function buildRealIndex() {
  const pages = [];
  for (const name of PAGE_MODULES) {
    const url = pathToFileURL(path.join(PAGE_DIR, `${name}.mjs`)).href;
    const module = await import(url);
    pages.push(...(module.pages || []));
  }
  assert.equal(pages.length, 56, '9 个页面模块应提供 56 页（阶段 A 29 + 阶段 B 27）');
  const entries = pages.map((page) =>
    buildPageEntry(page, pageUrlPath(page.id), GROUP_LABELS[page.group] || page.group),
  );
  return buildIndex(entries, VERSIONS);
}

const index = await buildRealIndex();

/**
 * 查询结果里某页的排名（0 起）。
 *
 * @param {string} query 查询
 * @param {string} pageId 页面 id
 * @returns {number} 排名；未命中为 -1
 */
function rankOf(query, pageId) {
  const expected = pageUrlPath(pageId);
  return search(index, query).findIndex((result) => result.page.u === expected);
}

/** 查询前 N 名的 URL，失败时用于诊断。 */
function topUrls(query, count = 3) {
  return search(index, query)
    .slice(0, count)
    .map((result) => result.page.u)
    .join(' , ');
}

// ---------------------------------------------------------------------------
// §9.1 三条固定断言（AC-15）—— 跑真实内容
// ---------------------------------------------------------------------------

test('AC-15：`压缩` 命中 guide/context（前 3）', (t) => {
  const rank = rankOf('压缩', 'guide/context');
  t.diagnostic(`压缩 → ${topUrls('压缩')}`);
  assert.ok(rank >= 0 && rank < 3, `期望前 3 命中，实际排名 ${rank + 1}；前 3 是 ${topUrls('压缩')}`);
});

test('AC-15：`流式` 命中 exec/output（前 3）', (t) => {
  const rank = rankOf('流式', 'exec/output');
  t.diagnostic(`流式 → ${topUrls('流式')}`);
  assert.ok(rank >= 0 && rank < 3, `期望前 3 命中，实际排名 ${rank + 1}；前 3 是 ${topUrls('流式')}`);
});

test('AC-15：`exit code` 命中 cli/exit-codes（前 3）', (t) => {
  const rank = rankOf('exit code', 'cli/exit-codes');
  t.diagnostic(`exit code → ${topUrls('exit code')}`);
  assert.ok(
    rank >= 0 && rank < 3,
    `期望前 3 命中，实际排名 ${rank + 1}；前 3 是 ${topUrls('exit code')}`,
  );
});

test('AC-15：`stream-json` 命中 exec/output（前 3，spec §13.1 指定的第三条）', (t) => {
  // §13.1 / AC-15 点名的第三条查询是 `stream-json`，不是「流式」：它的难点在于
  // tokenizeQuery 会把连字符词拆成 `stream` / `json` / 整词三条 token，而 `exec/output`
  // 的标题是中文「输入输出格式」—— 只有 keywords 与摘要命中才活得下来。
  const rank = rankOf('stream-json', 'exec/output');
  t.diagnostic(`stream-json → ${topUrls('stream-json')}`);
  assert.ok(
    rank >= 0 && rank < 3,
    `期望前 3 命中，实际排名 ${rank + 1}；前 3 是 ${topUrls('stream-json')}`,
  );
});

test('真实索引的规模在预算内且 schema 正确（AC-26）', () => {
  const bytes = Buffer.byteLength(JSON.stringify(index), 'utf8');
  assert.equal(index.v, 1);
  assert.equal(index.lang, 'zh-CN');
  assert.deepEqual(index.versions, VERSIONS);
  assert.equal(index.pages.length, 56);
  assert.ok(bytes <= MAX_INDEX_BYTES, `索引 ${bytes} B 超过 ${MAX_INDEX_BYTES} B`);
  for (const page of index.pages) {
    assert.ok(page.u && page.t, `索引项缺 u/t：${JSON.stringify(page).slice(0, 60)}`);
    assert.ok(Array.isArray(page.s), `索引项 ${page.u} 缺 s`);
  }
});

// ---------------------------------------------------------------------------
// 分词与打分
// ---------------------------------------------------------------------------

test('tokenizeQuery：CJK 走 bigram 并保留整词', () => {
  assert.deepEqual(tokenizeQuery('压缩'), ['压缩']);
  assert.deepEqual(tokenizeQuery('压缩上下文'), ['压缩', '缩上', '上下', '下文', '压缩上下文']);
});

test('tokenizeQuery：ASCII 分词并小写化', () => {
  assert.deepEqual(tokenizeQuery('Exit Code'), ['exit', 'code']);
  assert.deepEqual(tokenizeQuery('  --max-tokens  '), ['--max-tokens']);
});

test('tokenizeQuery：空查询退化为空数组', () => {
  assert.deepEqual(tokenizeQuery(''), []);
  assert.deepEqual(tokenizeQuery('   '), []);
  assert.deepEqual(tokenizeQuery(null), []);
});

test('search：空查询返回空结果（不返回全部页面）', () => {
  assert.deepEqual(search(index, ''), []);
  assert.deepEqual(search(index, '   '), []);
});

test('search：结果上限 12，且每页最多 2 节', () => {
  const results = search(index, '配置');
  assert.equal(results.length, 12, '宽查询应正好被 12 条上限截住');
  const perPage = new Map();
  for (const result of results) {
    const used = (perPage.get(result.page.u) || 0) + 1;
    perPage.set(result.page.u, used);
    assert.ok(used <= 2, `${result.page.u} 出现了 ${used} 节（上限 2）`);
  }
});

test('search：显式 limit 生效且结果按分数降序', () => {
  const results = search(index, '配置', 3);
  assert.equal(results.length, 3);
  const scores = results.map((result) => result.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('search：命中项带 page/section/sectionIndex/score', () => {
  const [first] = search(index, '压缩');
  assert.ok(first.page && first.page.u);
  assert.ok(first.section && typeof first.section.h === 'string');
  assert.equal(first.sectionIndex, index.pages.find((page) => page.u === first.page.u).s.indexOf(first.section));
  assert.ok(first.score > 0);
});

test('matchScore：CJK 逐字包含、ASCII 整词包含、空 token 为 0', () => {
  assert.equal(matchScore('压缩上下文', '压缩'), 1);
  assert.equal(matchScore('压缩上下文', '模型'), 0);
  assert.equal(matchScore('exit codes', 'exit'), 1);
  // 词中命中同样算 1（`compaction` 里含 `compact`）；前缀 0.7 的分支因此在
  // `includes` 之后不可达，这条断言把现状固定下来，避免打分口径被悄悄改动。
  assert.equal(matchScore('compaction', 'compact'), 1);
  assert.equal(matchScore('whatever', ''), 0);
});

// ---------------------------------------------------------------------------
// 三级截断（§7.4）
// ---------------------------------------------------------------------------

test('truncateToBudget：小索引停在第 0 级且 ok', () => {
  const small = truncateToBudget(() => ({
    v: 1,
    pages: [{ u: '/', t: 'T', g: 'G', d: 'd', k: [], s: [{ h: 'h', a: '', x: 'short' }] }],
  }));
  assert.equal(small.level, 0);
  assert.equal(small.ok, true);
  assert.ok(small.bytes < TRUNCATE_TRIGGER_BYTES);
  assert.equal(small.truncatedSections, 0);
});

test('truncateToBudget：真实索引仍停在第 0 级', () => {
  const result = truncateToBudget((level) =>
    buildIndex(
      index.pages.map((page) => ({ ...page, s: buildSections({ blocks: [] }, level.maxSections, level.maxChars) })),
      VERSIONS,
    ),
  );
  assert.equal(result.level, 0);
  assert.equal(result.ok, true);
});

test('truncateToBudget：超过触发线时升到第 1 级', () => {
  const escalated = truncateToBudget(({ maxChars }) => ({
    v: 1,
    pages: [
      {
        u: '/',
        t: 'T',
        g: 'G',
        d: 'd',
        k: [],
        // 第 0 级（maxChars 400）撑破 380 KB 触发线；第 1 级（maxChars 300）立刻回到小体积。
        s: [{ h: 'h', a: '', x: 'x'.repeat(maxChars === 300 ? 300 : 400 * 1024) }],
      },
    ],
  }));
  assert.equal(escalated.level, 1, '应先在第 1 级止住，不要一路砍到底');
  assert.equal(escalated.ok, true);
});

test('truncateToBudget：三级之后仍超预算才 ok:false', () => {
  const huge = () => ({
    v: 1,
    pages: [
      {
        u: '/',
        t: 'T',
        g: 'G',
        d: 'd',
        k: [],
        // 无论换到哪一级都还是 500 KB：四档全部试过仍不达标。
        s: [{ h: 'h', a: '', x: 'x'.repeat(500 * 1024) }],
      },
    ],
  });
  const result = truncateToBudget(huge);
  assert.equal(result.level, 3, '必须试满 4 档（0–3）才放弃');
  assert.equal(result.ok, false);
  assert.ok(result.bytes > MAX_INDEX_BYTES);
});

// ---------------------------------------------------------------------------
// 文本与节
// ---------------------------------------------------------------------------

test('plainText：去掉反引号、加粗与链接目标', () => {
  assert.equal(plainText('用 `--out` 指定 **输出目录**，见 [文档](/guide/tui/)。'), '用 --out 指定 输出目录，见 文档。');
  assert.equal(plainText('  多   空白\n折行  '), '多 空白 折行');
  assert.equal(plainText(null), '');
});

test('buildSections：按 H2 分节，节内合并到 x', () => {
  const sections = buildSections({
    title: '页面标题',
    blocks: [
      { t: 'p', md: '导语' },
      { t: 'h2', text: '第一节', id: 'first' },
      { t: 'p', md: '正文 **加粗**' },
      { t: 'h3', text: '子标题' },
      { t: 'p', md: '更多' },
    ],
  });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].h, '页面标题');
  assert.equal(sections[1].h, '第一节');
  assert.equal(sections[1].a, 'first');
  assert.match(sections[1].x, /正文 加粗 子标题 更多/);
});

test('buildPageEntry：截断到 8 节 / 400 字，摘要 140 字', () => {
  const page = {
    id: 'guide/tui',
    title: '界面导览',
    summary: '摘'.repeat(200),
    keywords: Array.from({ length: 20 }, (_, i) => `k${i}`),
    blocks: Array.from({ length: 12 }, (_, i) => ({ t: 'h2', text: `标题 ${i}`, id: `h${i}` })),
  };
  const entry = buildPageEntry(page, '/guide/tui/', '日常使用');
  assert.equal(entry.u, '/guide/tui/');
  assert.equal(entry.g, '日常使用');
  assert.equal(entry.d.length, 140);
  assert.equal(entry.k.length, 12);
  assert.ok(entry.s.length <= 8);
});
