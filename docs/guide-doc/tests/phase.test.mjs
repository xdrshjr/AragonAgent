/**
 * 分阶段交付（spec §2.2 / AC-2，P0-2 新增套件）。
 *
 * 三件事：
 *   ① `nav.mjs` 是唯一页清单：`A` 29 页、`all` 56 页，分组分布逐项钉死；
 *   ② 真跑两次 `build.mjs`（写到 `.tmp-test-a` / `.tmp-test-all`）：exit 0、
 *      30 / 57 个 `index.html`、`_meta.json` 的 pages 与 phaseCounts 正确；
 *   ③ 阶段 A 里指向阶段 B 页面的链接必须渲染成**不可点的 `.pending` 占位**，
 *      而不是带 `href` 的死链（AC-8）。
 *
 * 关于 ③ 的取证方式：`build.mjs` 现在只把**本阶段**的页面集合作为 `pageMap` 传给渲染层
 * （链接解析用全量导航），因此阶段 A 的产物里既会有 `.pending` 占位，也不会有指向阶段 B
 * 页面的 `href`。两条断言都直接落在产物上；下面第 ③ 节还保留一次「收窄 pageMap 直接驱动
 * renderPage」的机制级证明，这样即使将来 build 又改了口径，机制本身仍被单测盯住。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  allPageIds,
  navForPhase,
  navGroups,
  pageCountForPhase,
  phaseCounts,
} from '../src/content/nav.mjs';
import { pageUrlPath } from '../src/render/slug.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_DOC = path.resolve(HERE, '..');
const DIR_A = path.resolve(GUIDE_DOC, '.tmp-test-a');
const DIR_ALL = path.resolve(GUIDE_DOC, '.tmp-test-all');

/** 阶段 A 各分组的页数（§2.2 的交付切分）。 */
const GROUP_A_COUNTS = {
  start: 5,
  guide: 8,
  config: 2,
  cli: 3,
  exec: 6,
  api: 3,
  tools: 1,
  troubleshoot: 1,
};

// ---------------------------------------------------------------------------
// ① nav.mjs
// ---------------------------------------------------------------------------

test('nav.mjs：phaseCounts 恰好是 {A:29,B:27}', () => {
  assert.deepEqual(phaseCounts(), { A: 29, B: 27 });
  assert.equal(phaseCounts().A + phaseCounts().B, navGroups.flatMap((group) => group.pages).length);
});

test('nav.mjs：页数 A=29 / all=56', () => {
  assert.equal(pageCountForPhase('A'), 29);
  assert.equal(pageCountForPhase('all'), 56);
});

test('nav.mjs：navForPhase(A) 里没有 B 页，且 56 个 id 全局唯一', () => {
  const phaseAIds = navForPhase('A').flatMap((group) => group.pages.map((page) => page.id));
  assert.equal(phaseAIds.length, 29);
  for (const group of navForPhase('A')) {
    for (const page of group.pages) assert.equal(page.phase, 'A', `${page.id} 不该出现在阶段 A`);
  }
  assert.equal(new Set(allPageIds).size, 56, '56 个页面 id 必须唯一（URL 由 id 派生）');
  assert.deepEqual([...phaseAIds].sort(), [...allPageIds].filter((id) => phaseAIds.includes(id)).sort());
});

test('nav.mjs：阶段 A 的分组页数逐项正确', () => {
  const counts = Object.fromEntries(
    navForPhase('A').map((group) => [group.id, group.pages.length]),
  );
  assert.deepEqual(counts, GROUP_A_COUNTS);
  // appendix 组在阶段 A 里整组缺席（其 2 页都是 B）。
  assert.equal(counts.appendix, undefined);
});

// ---------------------------------------------------------------------------
// ② 真跑两次 build
// ---------------------------------------------------------------------------

/** 每次构建只跑一次：两个测试共享同一个结果。 */
const builds = new Map();

/**
 * 跑一次 `main([...])`。
 *
 * @param {'A'|'all'} phase 阶段
 * @param {string} out 输出目录
 * @returns {Promise<number>} 退出码
 */
function buildOnce(phase, out) {
  if (!builds.has(phase)) {
    builds.set(
      phase,
      import(pathToFileURL(path.join(GUIDE_DOC, 'build.mjs')).href).then((module) =>
        module.main(['--phase', phase, '--out', out]),
      ),
    );
  }
  return builds.get(phase);
}

/**
 * 递归列出目录下的文件。
 *
 * @param {string} dir 目录
 * @returns {string[]} 绝对路径
 */
function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** 数 `index.html`（每个页面一个目录，404 也算一个）。 */
const countIndexHtml = (dir) => walk(dir).filter((file) => path.basename(file) === 'index.html').length;

/** 读产物里的 `_meta.json`。 */
const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf8'));

after(() => {
  for (const dir of [DIR_A, DIR_ALL]) {
    for (const suffix of ['', '.tmp', '.old']) {
      fs.rmSync(`${dir}${suffix}`, { recursive: true, force: true });
    }
  }
});

test('AC-2：`--phase A` → exit 0、30 个 HTML、_meta 29 页', async () => {
  const code = await buildOnce('A', DIR_A);
  assert.equal(code, 0, '阶段 A 构建应 exit 0');
  assert.equal(countIndexHtml(DIR_A), 30, '29 页 + 404');
  const meta = readMeta(DIR_A);
  assert.equal(meta.phase, 'A');
  assert.equal(meta.pages, 29);
  assert.deepEqual(meta.phaseCounts, { A: 29, B: 27 });
  assert.equal(meta.schemaVersion, 1);
  assert.equal(typeof meta.truncatedSections, 'number');
  assert.equal(typeof meta.searchIndexBytes, 'number');
});

test('AC-2：`--phase all` → exit 0、57 个 HTML、_meta 56 页', async () => {
  const code = await buildOnce('all', DIR_ALL);
  assert.equal(code, 0, '全量构建应 exit 0');
  assert.equal(countIndexHtml(DIR_ALL), 57, '56 页 + 404');
  const meta = readMeta(DIR_ALL);
  assert.equal(meta.phase, 'all');
  assert.equal(meta.pages, 56);
  assert.deepEqual(meta.phaseCounts, { A: 29, B: 27 });
});

test('阶段 A 的搜索索引只含本阶段页面（AC-26）', async () => {
  await buildOnce('A', DIR_A);
  const index = JSON.parse(fs.readFileSync(path.join(DIR_A, 'search-index.json'), 'utf8'));
  assert.equal(index.v, 1);
  assert.equal(index.pages.length, 29);
  const phaseAPaths = new Set(
    navForPhase('A').flatMap((group) => group.pages.map((page) => pageUrlPath(page.id))),
  );
  const stray = index.pages.map((page) => page.u).filter((url) => !phaseAPaths.has(url));
  assert.deepEqual(stray, [], `索引里混入了非阶段 A 的条目：${stray.join(',')}`);
});

// ---------------------------------------------------------------------------
// ③ 越阶段链接：占位机制（render 侧）与产物侧现状（diagnostic）
// ---------------------------------------------------------------------------

test('AC-8：收窄到阶段 A 的 pageMap 时，指向 B 页的链接渲染成不可点占位', async () => {
  const { renderPage } = await import(pathToFileURL(path.join(GUIDE_DOC, 'src', 'render', 'page.mjs')).href);
  const { navForPhase: phaseNav } = await import(
    pathToFileURL(path.join(GUIDE_DOC, 'src', 'content', 'nav.mjs')).href
  );
  const { withVersions, normalizeBase } = await import(
    pathToFileURL(path.join(GUIDE_DOC, 'src', 'site.config.mjs')).href
  );

  const pages = [];
  for (const group of navForPhase('all')) {
    const name = group.id;
    const module = await import(
      pathToFileURL(path.join(GUIDE_DOC, 'src', 'content', 'pages', `${name}.mjs`)).href
    );
    pages.push(...(module.pages || []));
  }
  const allById = new Map(pages.map((page) => [page.id, page]));
  const phaseANav = phaseNav('A');
  const phaseAMap = new Map(
    phaseANav.flatMap((group) => group.pages).map((entry) => [entry.id, allById.get(entry.id)]),
  );

  // `guide/tui` 正文里有指向 `guide/context`（阶段 B）的链接。
  const source = allById.get('guide/tui');
  assert.ok(source, 'guide/tui 应存在');
  const shared = {
    site: withVersions({ cli: '0.0.0-test', core: '0.0.0-test' }),
    basePath: normalizeBase('/'),
    assets: { css: 'app.00000000.css', js: 'app.00000000.js' },
    meta: { builtAt: '', commit: 'test' },
    warnings: [],
    pageMap: phaseAMap,
    fullNavGroups: phaseNav('all'),
  };
  const { html } = renderPage(source, phaseANav, shared);

  const pending = [...html.matchAll(/<span class="pending"[^>]*>[\s\S]{0,300}?<span class="pending-tag">/g)];
  assert.ok(pending.length > 0, '阶段 A 的渲染里应出现 .pending 占位');
  for (const chunk of pending) {
    assert.ok(!chunk[0].includes('href='), `占位不得带 href：${chunk[0].slice(0, 80)}`);
  }
  assert.ok(!/href="[^"]*guide\/context[^"]*"/.test(html), '阶段 B 的页面不该被渲染成可点击的 href');
});

test('阶段 A 产物里没有指向阶段 B 页面的 href，且占位确实存在', async (t) => {
  await buildOnce('A', DIR_A);
  const bIds = new Set(
    navForPhase('all')
      .flatMap((group) => group.pages)
      .filter((page) => page.phase === 'B')
      .map((page) => page.id),
  );
  const urlToId = new Map(allPageIds.map((id) => [pageUrlPath(id), id]));
  let crossing = 0;
  for (const file of walk(DIR_A).filter((entry) => entry.endsWith('.html'))) {
    const relative = path.relative(DIR_A, file).replace(/\\/g, '/');
    const dirUrl = `/${relative.replace(/index\.html$/, '')}`;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/href="([^"]*)"/g)) {
      const href = match[1];
      if (!href || href.startsWith('#') || /^https?:/.test(href)) continue;
      const resolved = path.posix.normalize(`${dirUrl}${href}`);
      const id = urlToId.get(resolved.endsWith('/') ? resolved : `${resolved}/`);
      if (id && bIds.has(id)) crossing += 1;
    }
  }
  assert.equal(crossing, 0, `阶段 A 产物里仍有 ${crossing} 个指向 B 页面的 href（应当渲染为占位）`);
  const indexHtml = fs.readFileSync(path.join(DIR_A, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('class="pending"'), '首页应出现越阶段链接的占位');
});

test('阶段 A 的导航只列本阶段页面（导航树里没有 B 项）', async () => {
  await buildOnce('A', DIR_A);
  const html = fs.readFileSync(path.join(DIR_A, 'index.html'), 'utf8');
  const nav = html.match(/<div class="nav-body">([\s\S]*?)<\/nav>/);
  assert.ok(nav, '产物里应有导航树');
  const hrefs = [...nav[1].matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 0);
  const urlToId = new Map(allPageIds.map((id) => [pageUrlPath(id), id]));
  for (const href of hrefs) {
    // 首页的导航里的相对链接形如 `./`、`./guide/tui/`，要按「当前页目录」解析。
    const resolved = path.posix.normalize(`/${href}`);
    const id = urlToId.get(resolved.endsWith('/') ? resolved : `${resolved}/`);
    assert.ok(id, `导航里的链接解析不到任何页面：${href}`);
    const entry = navForPhase('A').flatMap((group) => group.pages).find((page) => page.id === id);
    assert.ok(entry, `导航里出现了非阶段 A 的链接：${href}（id=${id}）`);
  }
  assert.ok(!html.includes('class="nav-link is-pending"'), '阶段 A 的导航不应出现占位项');
});
// ---------------------------------------------------------------------------
// ④ 门禁侧的越阶段计数（AC-8 的另一半：pendingLink 不计入断链）
// ---------------------------------------------------------------------------

test('阶段 A 的门禁把越阶段链接记成 INFO，且一条断链都不报', async () => {
  const { checkModel, Report } = await import(
    pathToFileURL(path.join(GUIDE_DOC, 'src', 'extract', 'gate.mjs')).href
  );
  const report = new Report();
  const contentRoot = path.join(GUIDE_DOC, 'src', 'content');
  await checkModel({ phase: 'A', contentRoot, mode: 'model' }, report);
  const byCode = (code) => report.findings.filter((finding) => finding.code === code);
  // pendingLink 是 INFO：它证明「越阶段链接被发现」，而不是「越阶段链接被当成断链」。
  assert.equal(
    byCode('pending-link').filter((finding) => finding.level !== 'info').length,
    0,
    'pendingLink 只能是 INFO —— 它不计入断链（AC-8）',
  );
  assert.ok(
    byCode('pending-link').length > 0,
    '阶段 A 必须至少有一条 pending-link，否则这条断言永远为真',
  );
  assert.deepEqual(byCode('link-broken'), [], '阶段 A 不应出现断链');
  assert.equal(report.counts().error, 0, '门禁在阶段 A 不应报 error');
});
