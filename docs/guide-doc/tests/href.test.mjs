/**
 * 保护什么：站内链接的 4 条 URL 映射、6 条 index/子路径用例，以及「所有 href 都是相对路径」。
 *
 * 为什么需要它：链接算错时构建照常成功，只有读者点到 404 才会发现。而 `index` 特例
 * （`start/index` 是站点根、`tools/index` 是 `/tools/`）是重构时最容易被"顺手简化"的一条规则；
 * 一旦有人改成 `path.posix.relative`，`./` 与 `../` 的层数就会静默偏移一层。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assetHref, pageUrlPath, resolveHref } from '../src/render/slug.mjs';

/** 9 条代表性页面 id：四个映射类别 + 深层页 + 404。 */
const SAMPLES = [
  'start/index',
  'tools/index',
  'tools/files',
  'guide/tui',
  'guide/keybindings',
  'config/reference',
  'exec/events',
  'api/agent',
  '404',
];

/**
 * 极小的 URL 拼接器：`dirPath` 视为目录（目录式 URL），逐段消化 `rel` 里的 `..` 与 `.`。
 *
 * @param {string} dirPath 页面所在目录（以 `/` 结尾）
 * @param {string} rel 相对路径
 * @returns {string} 归一化后的站内绝对路径
 */
function joinUrl(dirPath, rel) {
  const parts = dirPath.split('/').filter(Boolean);
  for (const piece of rel.split('/').filter(Boolean)) {
    if (piece === '.') continue;
    if (piece === '..') {
      assert.ok(parts.length > 0, `相对路径 ${rel} 逃出了站点根`);
      parts.pop();
      continue;
    }
    parts.push(piece);
  }
  if (parts.length === 0) return '/';
  // 目录式 URL 保留尾部 `/`；指向文件（如 assets/app.x.css）时不加。
  return `/${parts.join('/')}${rel.endsWith('/') ? '/' : ''}`;
}

test('§2.3 的四条映射：站点根 / 组首页 / 普通页 / 404', () => {
  // start/index → '/'
  assert.equal(resolveHref('guide/tui', 'start/index'), '../../');
  // <group>/index → '/<group>/'
  assert.equal(resolveHref('guide/tui', 'tools/index'), '../../tools/');
  // <group>/<page> → '/<group>/<page>/'
  assert.equal(resolveHref('tools/files', 'guide/keybindings'), '../../guide/keybindings/');
  // 404 → '/404/'
  assert.equal(resolveHref('tools/files', '404'), '../../404/');
});

test('六条 index/子路径用例（P1-9）', () => {
  // 1. 站点根 → 自己
  assert.equal(resolveHref('start/index', 'start/index'), './');
  // 2. 深层页 → 站点根
  assert.equal(resolveHref('guide/tui', 'start/index'), '../../');
  // 3. 组首页 → 本组子页（先"下"一层，不是"上"一层）
  assert.equal(resolveHref('tools/index', 'tools/files'), 'files/');
  // 4. 自身往返恒为 './'
  assert.equal(resolveHref('guide/keybindings', 'guide/keybindings'), './');
  assert.equal(resolveHref('tools/index', 'tools/index'), './');
  // 5. 子路径部署：从站点根页出发不带前导 `/`，因此挪到 /aragon-docs/ 下仍成立
  assert.equal(resolveHref('start/index', 'guide/tui'), 'guide/tui/');
  // 6. 404 特例：从 404 页回到站点根
  assert.equal(resolveHref('404', 'start/index'), '../');
  assert.equal(resolveHref('start/index', '404'), '404/');
});

test('每一条 href 都是相对路径，且不含反斜杠（Windows 构建不得泄漏分隔符）', () => {
  for (const from of SAMPLES) {
    for (const to of SAMPLES) {
      const href = resolveHref(from, to);
      assert.equal(href.startsWith('/'), false, `${from} → ${to} 产出了绝对路径 ${href}`);
      assert.equal(href.includes('\\'), false, `${from} → ${to} 产出了反斜杠 ${href}`);
      // 目录式 URL 一律以 `/` 结尾（或就是 `./`）。
      assert.ok(href.endsWith('/'), `${from} → ${to} 缺少尾部斜杠：${href}`);
    }
  }
});

test('全组合性质：拼回页面目录后必须等于目标的 pageUrlPath', () => {
  for (const from of SAMPLES) {
    for (const to of SAMPLES) {
      const href = resolveHref(from, to);
      assert.equal(
        joinUrl(pageUrlPath(from), href),
        pageUrlPath(to),
        `${from} → ${to}（href=${href}）拼回来不等于 ${pageUrlPath(to)}`,
      );
    }
  }
});

test('assetHref：按页面深度回退到 assets/', () => {
  assert.equal(assetHref('guide/tui', 'app.x.css'), '../../assets/app.x.css');
  assert.equal(assetHref('start/index', 'app.x.css'), 'assets/app.x.css');
  assert.equal(assetHref('tools/index', 'app.x.css'), '../assets/app.x.css');
  assert.equal(assetHref('404', 'app.x.css'), '../assets/app.x.css');
});

test('assetHref 与页面深度一致：拼回目录后落在 /assets/ 下', () => {
  for (const from of SAMPLES) {
    assert.equal(joinUrl(pageUrlPath(from), assetHref(from, 'app.x.css')), '/assets/app.x.css');
  }
});
