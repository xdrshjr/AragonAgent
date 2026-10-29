/**
 * 对比度复算（spec §3.2，AC-12）。
 *
 * 设计期用 WCAG 相对亮度公式逐对实测了 **72 组**；本套件把同一套公式跑在
 * `src/assets/tokens.css` 的当前值上，防止有人改 token 把某一档掉到 4.5:1 以下：
 *   主 token     8 个前景 × 3 种底色（bg / surface / elevated）× 2 主题 = 48
 *   代码 token   12 类 × 2 主题（各自对 --elevated）                    = 24
 *
 * `--line` 只是 1 px 装饰线（1.37 / 1.20），不承载文字，因此不参与 4.5:1；
 * 但它被当文字色用的写法必须绝迹（`color: var(--line)`），最后一节 grep 这条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(HERE, '..', 'src', 'assets');
const TOKENS_CSS = path.join(ASSETS_DIR, 'tokens.css');

/** 8 个前景 token（正文、次要、元信息、两个强调色、三个语义色）。 */
const FOREGROUNDS = ['text', 'text-2', 'text-3', 'accent', 'accent-2', 'ok', 'warn', 'bad'];

/** 3 种底色（页面底 → 卡片 → 悬浮层/代码块）。 */
const BACKGROUNDS = ['bg', 'surface', 'elevated'];

/** 12 类代码着色 token。 */
const CODE_TOKENS = [
  'c-key',
  'c-str',
  'c-num',
  'c-com',
  'c-fn',
  'c-type',
  'c-attr',
  'c-punct',
  'c-add',
  'c-del',
  'c-flag',
  'c-out',
];

/** 每个主题块里应有 24 个颜色 token：3 底色 + 1 装饰线 + 8 前景 + 12 代码。 */
const COLOR_TOKENS_PER_THEME = 24;

/** WCAG 的对比度门槛（正文 4.5:1）。 */
const MIN_RATIO = 4.5;

/**
 * 取 CSS 里某个选择器的声明块（花括号配平，避免手写正则把嵌套算漏）。
 *
 * @param {string} css 样式表全文
 * @param {RegExp} selector 选择器模式
 * @returns {string} 声明块内部文本
 * @throws {Error} 找不到选择器
 */
function blockOf(css, selector) {
  const match = selector.exec(css);
  if (!match) throw new Error(`tokens.css 里找不到选择器 ${selector}`);
  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, index);
    }
  }
  throw new Error(`选择器 ${selector} 的块没有闭合`);
}

/**
 * 把一个声明块解析成 `token → 值` 映射（只保留以 `#rrggbb` 写出的颜色）。
 *
 * @param {string} body 声明块内部文本
 * @returns {Map<string, string>} token 名（含 `--`）到色值
 */
function colorTokens(body) {
  const tokens = new Map();
  for (const declaration of body.split(';')) {
    const match = declaration.match(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*$/m);
    if (match) tokens.set(match[1], match[2].toUpperCase());
  }
  return tokens;
}

/**
 * sRGB 单通道线性化（WCAG 2.1 的相对亮度定义）。
 *
 * @param {number} value 0–255
 * @returns {number} 线性值
 */
function linearize(value) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * 相对亮度。
 *
 * @param {string} hex `#RRGGBB`
 * @returns {number} 0–1
 */
function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

/**
 * 两色之间的对比度。
 *
 * @param {string} foreground 前景色 `#RRGGBB`
 * @param {string} background 背景色 `#RRGGBB`
 * @returns {number} 1–21
 */
function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 两位小数，便于与 §3.2 的表逐行对账。 */
const round2 = (value) => Math.round(value * 100) / 100;

const css = fs.readFileSync(TOKENS_CSS, 'utf8');
const themes = {
  dark: colorTokens(blockOf(css, /:root\s*\{/)),
  light: colorTokens(blockOf(css, /\[data-theme="light"\]\s*\{/)),
};

/**
 * 按 §3.2 的口径算出全部 72 组。
 *
 * @returns {{theme: string, fg: string, bg: string, ratio: number}[]} 72 组
 */
function collectPairs() {
  const pairs = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const fg of FOREGROUNDS) {
      for (const bg of BACKGROUNDS) {
        pairs.push({
          theme,
          fg,
          bg,
          ratio: contrastRatio(tokens.get(`--${fg}`), tokens.get(`--${bg}`)),
        });
      }
    }
    for (const code of CODE_TOKENS) {
      pairs.push({
        theme,
        fg: code,
        bg: 'elevated',
        ratio: contrastRatio(tokens.get(`--${code}`), tokens.get('--elevated')),
      });
    }
  }
  return pairs;
}

const pairs = collectPairs();

// ---------------------------------------------------------------------------
// 结构：两个主题各 24 个颜色 token，且键集合一致
// ---------------------------------------------------------------------------

test('tokens.css：两个主题各有 24 个颜色 token', () => {
  assert.equal(themes.dark.size, COLOR_TOKENS_PER_THEME, `暗色 ${themes.dark.size} 个：${[...themes.dark.keys()]}`);
  assert.equal(themes.light.size, COLOR_TOKENS_PER_THEME, `亮色 ${themes.light.size} 个`);
  assert.deepEqual([...themes.dark.keys()].sort(), [...themes.light.keys()].sort(), '两个主题的 token 名必须完全一致');
});

test('tokens.css：参与复算的 token 一个都不能缺', () => {
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const name of [...BACKGROUNDS, ...FOREGROUNDS, ...CODE_TOKENS, 'line']) {
      assert.ok(tokens.has(`--${name}`), `${theme} 主题缺 --${name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-12：72 组逐对断言
// ---------------------------------------------------------------------------

test('AC-12：全部 72 组对比度都 ≥ 4.5:1', (t) => {
  assert.equal(pairs.length, 72, `应复算 72 组（48 主 token + 24 代码 token），实际 ${pairs.length} 组`);
  const failures = [];
  for (const { theme, fg, bg, ratio } of pairs) {
    if (!(ratio >= MIN_RATIO)) failures.push(`${theme} --${fg} on --${bg} = ${round2(ratio)}`);
  }
  t.diagnostic(`最低值 ${round2(Math.min(...pairs.map((pair) => pair.ratio)))}`);
  assert.deepEqual(failures, [], `以下组合低于 ${MIN_RATIO}:1 —— ${failures.join('，')}`);
});

test('AC-12：主 token 48 组逐条断言（8 前景 × 3 底色 × 2 主题）', () => {
  const main = pairs.filter((pair) => FOREGROUNDS.includes(pair.fg));
  assert.equal(main.length, 48);
  for (const { theme, fg, bg, ratio } of main) {
    assert.ok(ratio >= MIN_RATIO, `${theme} --${fg} on --${bg} = ${round2(ratio)} < ${MIN_RATIO}`);
  }
});

test('AC-12：代码 token 24 组逐条断言（12 类 × 2 主题，对 --elevated）', () => {
  const code = pairs.filter((pair) => CODE_TOKENS.includes(pair.fg));
  assert.equal(code.length, 24);
  for (const { theme, fg, ratio } of code) {
    assert.ok(ratio >= MIN_RATIO, `${theme} --${fg} on --elevated = ${round2(ratio)} < ${MIN_RATIO}`);
  }
});

test('AC-12：已知最低值是 4.75（亮色 --c-add / --ok 在 --elevated 上）', () => {
  const minimum = Math.min(...pairs.map((pair) => pair.ratio));
  assert.equal(round2(minimum), 4.75, `最低值应是 4.75，实际 ${round2(minimum)}`);

  const bottoms = pairs
    .filter((pair) => round2(pair.ratio) === 4.75)
    .map((pair) => `${pair.theme}:${pair.fg}@${pair.bg}`)
    .sort();
  assert.deepEqual(bottoms, ['light:c-add@elevated', 'light:ok@elevated']);
});

// ---------------------------------------------------------------------------
// 公式本身的自检：复算结果要能和 §3.2 的表对上
// ---------------------------------------------------------------------------

test('对比度公式与 §3.2 的实测值一致（抽样复核）', () => {
  const expected = [
    ['dark', 'text', 'bg', 16.18],
    ['dark', 'text-2', 'elevated', 8.53],
    ['dark', 'text-3', 'surface', 5.83],
    ['dark', 'ok', 'bg', 8.02],
    ['light', 'text', 'surface', 17.81],
    ['light', 'text-3', 'elevated', 4.86],
    ['light', 'warn', 'bg', 5.56],
    ['light', 'bad', 'elevated', 5.75],
  ];
  for (const [theme, fg, bg, value] of expected) {
    const actual = round2(contrastRatio(themes[theme].get(`--${fg}`), themes[theme].get(`--${bg}`)));
    assert.equal(actual, value, `${theme} --${fg} on --${bg} 应是 ${value}，实算 ${actual}`);
  }
  const codeExpected = [
    ['dark', 'c-key', 7.75],
    ['dark', 'c-num', 8.47],
    ['light', 'c-key', 6.46],
    ['light', 'c-attr', 7.23],
  ];
  for (const [theme, token, value] of codeExpected) {
    const actual = round2(contrastRatio(themes[theme].get(`--${token}`), themes[theme].get('--elevated')));
    assert.equal(actual, value, `${theme} --${token} 应是 ${value}，实算 ${actual}`);
  }
});

test('--line 只作装饰：不进 4.5:1 统计，但两档都低于 1.5:1', () => {
  for (const theme of ['dark', 'light']) {
    const ratio = contrastRatio(themes[theme].get('--line'), themes[theme].get('--bg'));
    assert.ok(ratio < 1.5, `${theme} --line 对 --bg 是 ${round2(ratio)}，装饰线应几乎不可见`);
    assert.ok(!FOREGROUNDS.includes('line') && !CODE_TOKENS.includes('line'));
  }
});

// ---------------------------------------------------------------------------
// P2-3：`--line` 不得被当文字色
// ---------------------------------------------------------------------------

test('P2-3：src/assets 的 CSS 里没有 `color: var(--line)`', () => {
  const cssFiles = fs.readdirSync(ASSETS_DIR).filter((file) => file.endsWith('.css'));
  assert.ok(cssFiles.length >= 2, `应有多个 CSS 文件，实际 ${cssFiles.join(',')}`);
  const offenders = [];
  for (const file of cssFiles) {
    const text = fs.readFileSync(path.join(ASSETS_DIR, file), 'utf8');
    if (/color:\s*var\(--line\)/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `以下文件把 --line 当文字色：${offenders.join(',')}`);
});
