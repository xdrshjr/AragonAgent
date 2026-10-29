/**
 * 构建确定性（spec §6.5 / AC-18）。
 *
 * 两次构建写到两个临时目录，逐字节比对：只要渲染层或内容里混进时间、随机数、
 * 绝对路径、对象键序不稳的东西，这里就会红。
 *
 * 唯一允许变化的字段是 `_meta.json.builtAt`（构建时间戳）。为了让「除时间戳外
 * 逐字节相同」这句话真的可验证，本套件在两次构建期间把时钟**钉死**：
 *   · 钉死之后，连 `_meta.json` 都可以逐字节比对（`builtAt` 也就恒等了），
 *     因此任何差异都只有一个来源 —— 实现，而不是时钟；
 *   · 同时可以断言 HTML 里除页脚那一处构建元信息之外没有任何 ISO 时间戳
 *     （§6.5：时间戳只进 `_meta.json`，不进正文）。
 *
 * 时钟的替换只在这两次调用期间生效，`finally` 里立刻还原。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_DOC = path.resolve(HERE, '..');
const DIR_ONE = path.resolve(GUIDE_DOC, '.tmp-det-1');
const DIR_TWO = path.resolve(GUIDE_DOC, '.tmp-det-2');

/** 钉死的时钟（ISO 形态，因此「HTML 里有没有时间戳」这条断言是有效的）。 */
const FIXED_CLOCK = '2026-01-01T00:00:00.000Z';

/** ISO 时间戳的形态（精确到分钟即可，避免误伤 `2026-01-01` 这种日期写法）。 */
const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * 递归列出目录下的文件（返回相对路径，正斜杠）。
 *
 * @param {string} dir 目录
 * @returns {string[]} 相对路径
 */
function listFiles(dir) {
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(dir, '');
  return files.sort();
}

/**
 * 归一化 `_meta.json`：去掉构建时间戳，键按字典序重排。
 *
 * @param {string} text 原始 JSON 文本
 * @returns {string} 归一化后的文本
 */
function normalizeMeta(text) {
  const parsed = JSON.parse(text);
  delete parsed.builtAt;
  const sorted = Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify(sorted, null, 2);
}

/**
 * 在钉死的时钟下跑一次构建。
 *
 * @param {string} out 输出目录
 * @returns {Promise<number>} 退出码
 */
async function buildWithPinnedClock(out) {
  const module = await import(pathToFileURL(path.join(GUIDE_DOC, 'build.mjs')).href);
  const RealDate = globalThis.Date;
  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_CLOCK);
      else super(...args);
    }

    static now() {
      return RealDate.parse(FIXED_CLOCK);
    }
  }
  globalThis.Date = PinnedDate;
  try {
    return await module.main(['--phase', 'A', '--out', out]);
  } finally {
    globalThis.Date = RealDate;
  }
}

const results = { one: null, two: null };

test('AC-18：第一次构建 exit 0', async () => {
  results.one = await buildWithPinnedClock(DIR_ONE);
  assert.equal(results.one, 0);
});

test('AC-18：第二次构建 exit 0', async () => {
  results.two = await buildWithPinnedClock(DIR_TWO);
  assert.equal(results.two, 0);
});

test('AC-18：两次构建产出的文件清单完全一致', () => {
  const one = listFiles(DIR_ONE);
  const two = listFiles(DIR_TWO);
  assert.ok(one.length > 30, `产物文件太少（${one.length}），构建可能没跑完`);
  assert.deepEqual(two, one);
});

test('AC-18：除 _meta.json 的时间戳外，每个文件都逐字节相同', () => {
  const files = listFiles(DIR_ONE);
  const differences = [];
  for (const relative of files) {
    const first = fs.readFileSync(path.join(DIR_ONE, relative));
    const second = fs.readFileSync(path.join(DIR_TWO, relative));
    if (relative === '_meta.json') {
      const normalized = [normalizeMeta(first.toString('utf8')), normalizeMeta(second.toString('utf8'))];
      if (normalized[0] !== normalized[1]) differences.push(`${relative}（归一化后仍有差异）`);
      continue;
    }
    if (!first.equals(second)) {
      differences.push(`${relative}（${first.length} B vs ${second.length} B）`);
    }
  }
  assert.deepEqual(differences, [], `以下文件两次构建不一致：${differences.join('，')}`);
});

test('AC-18：_meta.json 只有 builtAt 一个字段随构建变化', () => {
  const one = JSON.parse(fs.readFileSync(path.join(DIR_ONE, '_meta.json'), 'utf8'));
  const two = JSON.parse(fs.readFileSync(path.join(DIR_TWO, '_meta.json'), 'utf8'));
  assert.equal(one.builtAt, FIXED_CLOCK, '时钟被钉死，builtAt 应等于固定值');
  assert.equal(two.builtAt, FIXED_CLOCK);
  const keys = new Set([...Object.keys(one), ...Object.keys(two)]);
  for (const key of keys) {
    if (key === 'builtAt') continue;
    assert.deepEqual(two[key], one[key], `_meta.json.${key} 两次构建不一致`);
  }
  assert.equal(one.pages, 29);
  assert.deepEqual(one.phaseCounts, { A: 29, B: 27 });
});

test('AC-18：资产文件名带同一个 8 位内容哈希', () => {
  const assetsOf = (dir) => fs.readdirSync(path.join(dir, 'assets')).sort();
  const one = assetsOf(DIR_ONE);
  const two = assetsOf(DIR_TWO);
  assert.deepEqual(two, one, '两次构建的资产文件名必须一致');
  const names = one.filter((name) => /^app\.[0-9a-f]{8}\.(css|js)$/.test(name));
  assert.equal(names.length, 2, `应有 app.<hash>.css 与 app.<hash>.js，实际 ${one.join(',')}`);
  const hashes = new Set(names.map((name) => name.match(/^app\.([0-9a-f]{8})\./)[1]));
  assert.equal(hashes.size, 1, `CSS 与 JS 必须共用同一个哈希，实际 ${[...hashes].join(',')}`);
  const [hash] = [...hashes];
  assert.equal(fs.readFileSync(path.join(DIR_ONE, 'assets', 'LATEST'), 'utf8').trim(), hash);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(DIR_ONE, '_meta.json'), 'utf8')).assetHash,
    hash,
    '_meta.json.assetHash 应与文件名里的哈希一致',
  );
});

test('§6.5：HTML 里除页脚构建元信息外没有任何 ISO 时间戳', (t) => {
  const htmlFiles = listFiles(DIR_ONE).filter((relative) => relative.endsWith('.html'));
  assert.equal(htmlFiles.length, 30, '阶段 A 应有 30 个 HTML');
  let stamped = 0;
  for (const relative of htmlFiles) {
    const text = fs.readFileSync(path.join(DIR_ONE, relative), 'utf8');
    const stamps = text.match(new RegExp(ISO_STAMP.source, 'g')) || [];
    if (stamps.length === 0) continue;
    // 页脚固定带一处 `构建于 <ISO> · commit …`（§2.4 的构建元信息）；把它剥掉之后，
    // 正文里不允许再出现任何时间戳 —— 那才是「正文不落时间」这条规则的实质。
    const body = text.replace(/构建于\s*[^·<]*·/, '构建于 <stripped> ·');
    const remaining = body.match(new RegExp(ISO_STAMP.source, 'g')) || [];
    assert.deepEqual(remaining, [], `${relative} 的正文里出现了 ISO 时间戳`);
    assert.equal(stamps.length, 1, `${relative} 只应有页脚那一处时间戳，实际 ${stamps.length} 处`);
    stamped += 1;
  }
  t.diagnostic(`30 个 HTML 里 ${stamped} 个带页脚构建时间戳，正文 0 处`);
});

after(() => {
  for (const dir of [DIR_ONE, DIR_TWO]) {
    for (const suffix of ['', '.tmp', '.old']) {
      fs.rmSync(`${dir}${suffix}`, { recursive: true, force: true });
    }
  }
});
test('交付的 app.js：整行注释与缩进被剥掉，但仍然是同一段可执行的脚本', async () => {
  const { compactScript } = await import(
    pathToFileURL(path.join(GUIDE_DOC, 'build.mjs')).href
  );
  const source = fs.readFileSync(path.join(GUIDE_DOC, 'src', 'assets', 'app.js'), 'utf8');
  const shipped = compactScript(source);
  // ① 整行注释不会进产物（它们在源码里解释 WHY，浏览器不需要）。
  assert.equal(
    shipped.split('\n').filter((line) => /^\s*\/\//.test(line)).length,
    0,
    '交付脚本里不该有整行注释',
  );
  // ② 行首缩进被去掉，代码行数保持不变（不合并语句，不改语义）。
  assert.ok(
    shipped.split('\n').filter((line) => /^\s+\S/.test(line)).length === 0,
    '交付脚本里不该有行首缩进',
  );
  // ③ 幂等：再压一次不该再有变化 —— 否则「同样的源码两次构建同一个哈希」就靠不住。
  assert.equal(compactScript(shipped), shipped, 'compactScript 必须是幂等的');
  // ④ 注释里的内容不能是某一行的唯一来源：删掉注释后，每一行代码都还在源码里。
  for (const line of shipped.split('\n').filter(Boolean)) {
    assert.ok(
      source.includes(line.trim()),
      `交付脚本里出现了源码中没有的行（可能是把代码当注释删了）：${line.slice(0, 60)}`,
    );
  }
});

test('app.js 的交付体积在 §10.1 的 10 KB 预算内', () => {
  const jsName = fs.readdirSync(path.join(DIR_ONE, 'assets')).find((name) => name.endsWith('.js'));
  assert.ok(jsName, '产物里应有 app.js');
  const bytes = fs.statSync(path.join(DIR_ONE, 'assets', jsName)).size;
  assert.ok(bytes <= 10 * 1024, `交付的 app.js 是 ${bytes} 字节，超过 10 KB 预算`);
});
