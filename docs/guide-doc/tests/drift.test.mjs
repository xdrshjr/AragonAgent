/**
 * 引用漂移（spec §8.4）与两道 fixture 负向闸门（AC-4 / AC-5）。
 *
 * 三层：
 *   ① `checkReference` —— 纯函数，固定文本片段即可穷尽 ok / moved / missing /
 *      out-of-range / bad-range 五种判定；
 *   ② `verifyRef` —— 真实仓库文件上的存在性、路径形态与基名歧义（P0-1）；
 *   ③ fixture 端到端 —— `check.mjs --model --content-root <fixture>` 必须 exit 3 且
 *      指名那条幽灵参数；`xss` fixture 的注入载荷必须被转义（不能出现裸 `<script>`）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkReference } from '../src/extract/sources.mjs';
import { buildBasenameIndex, verifyRef } from '../src/extract/gate.mjs';
import { REPO_ROOT } from '../src/extract/repo-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_DOC = path.resolve(HERE, '..');
const FIXTURE_ROOT = path.join(HERE, 'fixtures');

/** 一段 60 行的合成文本：第 20 行带唯一标记，其余行只有行号。 */
const SYNTHETIC = Array.from({ length: 60 }, (_, index) =>
  index === 19 ? 'line 20 TARGET_MARKER' : `line ${index + 1}`,
).join('\n');

/** 取 findings 里指定 code 的那几条。 */
const withCode = (findings, code) => findings.filter((finding) => finding.code === code);

/** 取 findings 里 level === 'error' 的那几条。 */
const errorsOf = (findings) => findings.filter((finding) => finding.level === 'error');

// ---------------------------------------------------------------------------
// ① checkReference（纯函数）
// ---------------------------------------------------------------------------

test('checkReference：区间与 snippet 都对得上 → ok', () => {
  assert.deepEqual(checkReference({ text: SYNTHETIC, lines: '20', snippet: 'TARGET_MARKER' }), {
    status: 'ok',
  });
  assert.deepEqual(checkReference({ text: SYNTHETIC, lines: '19-21', snippet: 'line 20 TARGET_MARKER' }), {
    status: 'ok',
  });
});

test('checkReference：代码整体下移 10 行 → moved，并给出新区间', () => {
  const verdict = checkReference({ text: SYNTHETIC, lines: '10', snippet: 'TARGET_MARKER' });
  assert.equal(verdict.status, 'moved');
  assert.equal(verdict.newLines, '20', '新位置应指向真正的第 20 行');
});

test('checkReference：代码被删掉 → missing', () => {
  const verdict = checkReference({ text: SYNTHETIC, lines: '20', snippet: 'DELETED_MARKER' });
  assert.equal(verdict.status, 'missing');
  assert.equal(verdict.newLines, undefined);
});

test('checkReference：区间越过文件末尾 → out-of-range', () => {
  assert.equal(checkReference({ text: SYNTHETIC, lines: '61-70' }).status, 'out-of-range');
  assert.equal(checkReference({ text: SYNTHETIC, lines: '1-999' }).status, 'out-of-range');
});

test('checkReference：区间反序或非数字 → bad-range', () => {
  assert.equal(checkReference({ text: SYNTHETIC, lines: '30-10' }).status, 'bad-range');
  assert.equal(checkReference({ text: SYNTHETIC, lines: 'abc' }).status, 'bad-range');
  assert.equal(checkReference({ text: SYNTHETIC, lines: '0' }).status, 'out-of-range');
});

test('checkReference：没有 snippet 时只校验区间形态 → ok', () => {
  assert.equal(checkReference({ text: SYNTHETIC, lines: '5' }).status, 'ok');
  assert.equal(checkReference({ text: SYNTHETIC, lines: '5-60' }).status, 'ok');
});

// ---------------------------------------------------------------------------
// ② verifyRef（真实仓库 + 基名索引）
// ---------------------------------------------------------------------------

const basenameIndex = buildBasenameIndex();

test('buildBasenameIndex：README.md 有多份，因此裸基名是有歧义的', () => {
  assert.ok(basenameIndex.size > 0);
  assert.ok(
    (basenameIndex.get('README.md') || 0) > 1,
    `README.md 应有多份，实际 ${basenameIndex.get('README.md') || 0} 份`,
  );
});

test('verifyRef：裸 `README.md` + snippet 合法（仓库根 README 允许这么写）', () => {
  const findings = verifyRef({ path: 'README.md', lines: '5', snippet: 'AragonAgent' }, basenameIndex);
  assert.deepEqual(errorsOf(findings), []);
});

test('verifyRef（P0-1）：裸 `README.md` 无 snippet → ref-ambiguous', () => {
  const findings = verifyRef({ path: 'README.md', lines: '5-9' }, basenameIndex);
  const ambiguous = withCode(findings, 'ref-ambiguous');
  assert.equal(ambiguous.length, 1, `期望 1 条 ref-ambiguous，实际 ${JSON.stringify(findings)}`);
  assert.equal(ambiguous[0].level, 'error');
});

test('verifyRef：全路径 + 唯一基名 + 无 snippet 合法（只有 INFO）', () => {
  const findings = verifyRef({ path: 'packages/cli/README.md', lines: '1227-1327' }, basenameIndex);
  assert.deepEqual(errorsOf(findings), []);
  assert.equal(withCode(findings, 'ref-no-snippet').length, 1);
});

test('verifyRef：路径里出现 `..` → ref-bad-path', () => {
  const findings = verifyRef({ path: 'docs/../README.md', lines: '1-5' }, basenameIndex);
  assert.equal(errorsOf(findings)[0].code, 'ref-bad-path');
});

test('verifyRef：反斜杠路径 → ref-bad-path', () => {
  const findings = verifyRef({ path: 'packages\\cli\\README.md', lines: '1-5' }, basenameIndex);
  assert.equal(errorsOf(findings)[0].code, 'ref-bad-path');
});

test('verifyRef：文件不存在 → ref-missing-file', () => {
  const findings = verifyRef(
    { path: 'packages/cli/src/__definitely_missing__.ts', lines: '1-5' },
    basenameIndex,
  );
  assert.equal(errorsOf(findings).length, 1);
  assert.equal(errorsOf(findings)[0].code, 'ref-missing-file');
});

test('verifyRef：缺少 path → ref-no-path', () => {
  const findings = verifyRef({ lines: '1-5' }, basenameIndex);
  assert.equal(errorsOf(findings)[0].code, 'ref-no-path');
});

test('verifyRef：真实文件的越界区间 → ref-out-of-range', () => {
  const findings = verifyRef({ path: 'packages/cli/package.json', lines: '100000-100010' }, basenameIndex);
  assert.equal(errorsOf(findings)[0].code, 'ref-out-of-range');
});

test('verifyRef：真实文件的 snippet 已消失 → ref-code-gone', () => {
  const findings = verifyRef(
    { path: 'packages/cli/package.json', lines: '1-5', snippet: 'package with a deleted field name' },
    basenameIndex,
  );
  assert.equal(errorsOf(findings)[0].code, 'ref-code-gone');
});

// ---------------------------------------------------------------------------
// ③ 两道 fixture 闸门（AC-4 / AC-5）
// ---------------------------------------------------------------------------

/** 运行 check.mjs（fixture 负向测试的唯一入口），返回退出码与输出。 */
function runCheck(args) {
  const script = path.join(GUIDE_DOC, 'check.mjs');
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      output: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

test('AC-4：missing-flag fixture 让门禁 exit 3 并指名那条幽灵参数', () => {
  const { status, output } = runCheck([
    '--model',
    '--content-root',
    path.join(FIXTURE_ROOT, 'missing-flag'),
  ]);
  assert.equal(status, 3, `期望 exit 3，实际 ${status}；输出：${output.slice(0, 400)}`);
  assert.ok(
    output.includes('--definitely-not-a-flag'),
    '输出必须指名幽灵参数（只给一个非零退出码不足以定位问题）',
  );
  assert.ok(output.includes('doc-not-in-source'), `输出应含 doc-not-in-source：${output.slice(0, 400)}`);
});

test('AC-4：真实内容根跑同一个门禁是绿的（对照，说明 fixture 才是失败原因）', () => {
  const { status, output } = runCheck(['--model']);
  assert.equal(status, 0, `真实内容根应 exit 0，实际 ${status}；输出：${output.slice(0, 400)}`);
  assert.ok(!output.includes('--definitely-not-a-flag'));
});

test('AC-5：xss fixture 的注入载荷在渲染输出里被转义', async () => {
  const { renderInline } = await import(pathToFileURL(path.join(GUIDE_DOC, 'src', 'render', 'inline.mjs')).href);
  const { renderPage } = await import(pathToFileURL(path.join(GUIDE_DOC, 'src', 'render', 'page.mjs')).href);
  const { navForPhase } = await import(pathToFileURL(path.join(GUIDE_DOC, 'src', 'content', 'nav.mjs')).href);
  const { withVersions, normalizeBase } = await import(
    pathToFileURL(path.join(GUIDE_DOC, 'src', 'site.config.mjs')).href
  );
  const fixtureUrl = pathToFileURL(path.join(FIXTURE_ROOT, 'xss', 'pages', 'start.mjs')).href;
  const fixture = await import(fixtureUrl);
  const page = fixture.pages.find((entry) => entry.id === 'start/five-minutes');
  assert.ok(page, 'xss fixture 应提供被替换的 start/five-minutes 页面');
  const [first] = page.blocks;
  assert.equal(first.t, 'p');
  assert.ok(first.md.includes('<script>alert(1)</script>'), 'fixture 的载荷应是裸 <script>');

  // 渲染层有**两道**防线，两道都要满足 AC-5：
  // ① 转义发生在包裹之前 —— 载荷进 HTML 时是 `&lt;script&gt;`；
  const html = renderInline(first.md, { counterExamples: true });
  assert.ok(html.includes('&lt;script&gt;'), `输出应含转义后的标签：${html}`);
  assert.ok(!html.includes('<script>alert'), `输出不得含可执行的载荷：${html}`);

  // ② `renderInline` 的校验在 `build` 的路径上先一步拒收裸 HTML 标签，
  //    所以整页渲染不会把这行正文放出去（更早的防线，错误码见 inline.mjs 的 raw-html）。
  assert.throws(() => renderInline(first.md), /raw-html/, '整页渲染前必须由 validateInline 拒收裸 HTML 标签');

  const shared = {
    site: withVersions({ cli: '0.0.0-test', core: '0.0.0-test' }),
    basePath: normalizeBase('/'),
    assets: { css: 'app.00000000.css', js: 'app.00000000.js' },
    meta: { builtAt: '', commit: 'test' },
    warnings: [],
    pageMap: new Map(fixture.pages.map((entry) => [entry.id, entry])),
    fullNavGroups: navForPhase('all'),
  };
  assert.throws(() => renderPage(page, navForPhase('A'), shared), /raw-html/);
});

test('fixtures：两个内容根都齐全（9 个页面模块 + 11 个数据模块）', () => {
  const pageFiles = fs.readdirSync(path.join(FIXTURE_ROOT, 'missing-flag', 'pages')).sort();
  const dataFiles = fs.readdirSync(path.join(FIXTURE_ROOT, 'missing-flag', 'data')).sort();
  assert.equal(pageFiles.length, 9, `页面模块应 9 个，实际 ${pageFiles.join(',')}`);
  assert.equal(dataFiles.length, 11, `数据模块应 11 个，实际 ${dataFiles.join(',')}`);
  assert.deepEqual(fs.readdirSync(path.join(FIXTURE_ROOT, 'xss', 'pages')).sort(), pageFiles);
  assert.deepEqual(fs.readdirSync(path.join(FIXTURE_ROOT, 'xss', 'data')).sort(), dataFiles);
});
