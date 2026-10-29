/**
 * HTML 转义、锚点 slug 与站内链接解析。
 *
 * 三个函数都是纯函数，因此可以被单测 100% 覆盖（§4.1 纪律：本目录不碰 fs/time）。
 */

/** 需要转义的五个字符（`&` 必须第一个替换，否则会二次转义）。 */
const ESCAPES = [
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
];

/**
 * 转义 HTML 文本。所有正文都经过这里，这是全站唯一的信任边界（§6.1）。
 *
 * @param {unknown} value 任意值，非字符串会被 String() 转换
 * @returns {string} 可安全插入 HTML 文本节点的字符串
 */
export function escapeHtml(value) {
  const text = value == null ? '' : String(value);
  let out = text;
  for (const [char, entity] of ESCAPES) out = out.split(char).join(entity);
  return out;
}

/** slug 需要丢弃的标点（含中文全角）。 */
const SLUG_DROP = /[()[\]{}（）[\]、，。：；!?"'`~^|<>·—–]/g;
/** 既不是字母也不是数字的连续片段（保留 Unicode 字母与 CJK）。 */
const SLUG_GAP = /[^\p{L}\p{N}]+/gu;

/**
 * 把标题变成锚点 id：去空白→`-`，保留 Unicode 字母/数字/CJK，ASCII 小写化。
 *
 * @param {string} text 标题文本
 * @returns {string} 锚点 id；空结果降级为 `'section'`
 *
 * @example
 * slug('全局参数（101 处声明）') // '全局参数101-处声明'
 */
export function slug(text) {
  const normalized = String(text == null ? '' : text)
    .replace(SLUG_DROP, '')
    .replace(/['"‘’“”]/g, '')
    .replace(SLUG_GAP, '-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized === '' ? 'section' : normalized;
}

/**
 * 为一个页面内的一组标题分配唯一锚点 id（重复时追加 `-2`、`-3`…）。
 *
 * 与「生成 `-2` 再覆盖已有 `-2`」不同：这里持有一个 `Set` 并**循环取号直到不撞**
 * （§2.3 / P2-9），因此显式标题 `用法-2` 与自动编号不会互相覆盖。
 *
 * @param {string[]} titles 按文档顺序的标题文本
 * @param {Set<string>} [taken] 预占用的 id（例如页面显式指定的 `id`）
 * @returns {string[]} 与输入等长的唯一 id 数组
 */
export function assignSlugs(titles, taken = new Set()) {
  const used = new Set(taken);
  const ids = [];
  for (const title of titles) {
    const base = slug(title);
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    used.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

/**
 * 页面 id → 对外 URL 路径（§2.3 的四条穷尽映射，`start/index` 即站点根）。
 *
 * @param {string} id 页面 id，如 `'guide/tui'`、`'tools/index'`、`'404'`
 * @returns {string} 以 `/` 开头并以 `/` 结尾的绝对路径
 */
export function pageUrlPath(id) {
  if (id === '404') return '/404/';
  const [group, page] = id.split('/');
  if (page === undefined) return `/${group}/`;
  if (page === 'index') return group === 'start' ? '/' : `/${group}/`;
  return `/${group}/${page}/`;
}

/**
 * @typedef {'root'|'group'|'page'|'404'} UrlKind
 */

/**
 * 判定某个 id 命中 §2.3 映射表中的哪一行（正好命中一条）。
 *
 * @param {string} id 页面 id
 * @returns {UrlKind} 命中类别
 */
export function urlKind(id) {
  if (id === '404') return '404';
  const parts = id.split('/');
  if (parts.length === 1) return 'group';
  if (parts[1] === 'index') return parts[0] === 'start' ? 'root' : 'group';
  return 'page';
}

/**
 * 站内相对链接：从页面 `from` 指向页面 `to`（含 `index` 特例与子路径部署）。
 *
 * 结果永远是相对路径（不以 `/` 开头），因此站点可以整体挪到 `/aragon-docs/` 之下
 * 而无需改一行代码（AC-20）。
 *
 * @param {string} from 源页面 id
 * @param {string} to 目标页面 id
 * @returns {string} 例如 `'../../config/reference/'`
 *
 * @example
 * resolveHref('guide/keybindings', 'config/reference') // '../../config/reference/'
 * resolveHref('guide/tui', 'start/index')              // '../../'
 */
export function resolveHref(from, to) {
  const fromPath = pageUrlPath(from);
  const toPath = pageUrlPath(to);
  // `fromPath` 已经是页面所在目录（目录式 URL），因此它就是相对基准，不能再削一段。
  const fromParts = fromPath.split('/').filter(Boolean);
  const toParts = toPath.split('/').filter(Boolean);
  const isDirTarget = toPath.endsWith('/');

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = new Array(fromParts.length - common).fill('..');
  const down = toParts.slice(common);
  const segments = [...up, ...down];
  if (segments.length === 0) return './';
  if (isDirTarget) return `${segments.join('/')}/`;
  return segments.join('/');
}

/**
 * 资源链接（`dist/assets/**`）：从页面 `from` 指向 `assets/<file>`。
 *
 * @param {string} from 源页面 id（`'404'` 也可）
 * @param {string} file 资源文件名，例如 `'app.a1b2c3d4.css'`
 * @returns {string} 例如 `'../../assets/app.a1b2c3d4.css'`
 */
export function assetHref(from, file) {
  const depth = pageUrlPath(from).split('/').filter(Boolean).length;
  return `${'../'.repeat(depth)}assets/${file}`;
}

/**
 * 页面 id → 产物文件路径（相对 dist 根，始终用正斜杠）。
 *
 * @param {string} id 页面 id
 * @returns {string} 例如 `'guide/tui/index.html'`、`'index.html'`、`'404/index.html'`
 */
export function outputPath(id) {
  if (id === '404') return '404/index.html';
  if (id === 'start/index') return 'index.html';
  const parts = id.split('/');
  if (parts.length === 1) return `${parts[0]}/index.html`;
  if (parts[1] === 'index') return `${parts[0]}/index.html`;
  return `${parts[0]}/${parts[1]}/index.html`;
}

/**
 * 站内绝对路径 → 页面 id（`pageUrlPath` 的逆函数，供内容里的 `[文字](/guide/tui/)` 使用）。
 *
 * @param {string} urlPath 以 `/` 开头的站内路径，可带 `#anchor` 尾注
 * @returns {{id: string, anchor: string}} 页面 id 与（可能为空的）锚点
 */
export function pathToPageId(urlPath) {
  const raw = String(urlPath == null ? '' : urlPath);
  const hashAt = raw.indexOf('#');
  const anchor = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  const path = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { id: 'start/index', anchor };
  if (parts.length === 1) return { id: parts[0] === '404' ? '404' : `${parts[0]}/index`, anchor };
  return { id: parts.slice(0, 2).join('/'), anchor };
}
