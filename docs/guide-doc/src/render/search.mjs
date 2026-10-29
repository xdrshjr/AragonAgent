/**
 * 搜索索引生成与打分（前后端**同一函数**，§7.4 / §7.7）。
 *
 * 索引是数据，打分是纯函数；`app.js` 用的是同一套规则的客户端副本（由构建期一致性测试保证
 * 两边对同一条查询给出同样顺序 —— `tests/search.test.mjs` 直接跑本文件）。
 */

/** 索引 schema 版本。 */
export const SEARCH_SCHEMA_VERSION = 1;

/** 每页最多保留的节数（第 0 级）。 */
export const MAX_SECTIONS = 8;
/** 每节 `x` 的字数上限（第 0 级）。 */
export const MAX_SECTION_CHARS = 400;
/** 索引体积硬上限（字节）。 */
export const MAX_INDEX_BYTES = 420 * 1024;
/** 达到该体积就升到下一级截断。 */
export const TRUNCATE_TRIGGER_BYTES = 380 * 1024;

/**
 * 去掉 inline 标记、压缩空白，得到用于搜索的纯文本。
 *
 * @param {string} text 含标记的文本
 * @returns {string} 纯文本
 */
export function plainText(text) {
  return String(text == null ? '' : text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\{kbd:([^}]+)\}/g, (_, keys) => String(keys).split('+').join('+'))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一个 block 压成一行可搜索文本（用于节摘要）。
 *
 * @param {object} block 正文 block
 * @returns {string} 纯文本
 */
function blockText(block) {
  const parts = [];
  if (typeof block.md === 'string') parts.push(plainText(block.md));
  if (typeof block.text === 'string') parts.push(plainText(block.text));
  if (Array.isArray(block.items)) {
    for (const item of block.items) {
      if (typeof item === 'string') parts.push(plainText(item));
      else if (item && typeof item === 'object') {
        if (item.desc) parts.push(plainText(item.desc));
        if (item.md) parts.push(plainText(item.md));
        if (item.title) parts.push(plainText(item.title));
        if (item.when) parts.push(plainText(item.when));
        if (item.name) parts.push(item.name);
      }
    }
  }
  if (Array.isArray(block.rows)) {
    for (const row of block.rows) for (const cell of row) parts.push(plainText(cell));
  }
  if (Array.isArray(block.head)) for (const cell of block.head) parts.push(plainText(cell));
  if (typeof block.code === 'string') parts.push(plainText(block.code));
  return parts.filter(Boolean).join(' ');
}

/**
 * 生成一页的节数组（H2 分节，节内合并到 `x`）。
 *
 * @param {object} page 页面数据
 * @param {number} maxSections 节数上限
 * @param {number} maxChars 每节字数上限
 * @returns {{h: string, a: string, x: string}[]} 节数组
 */
export function buildSections(page, maxSections = MAX_SECTIONS, maxChars = MAX_SECTION_CHARS) {
  const sections = [];
  let current = { h: page.title, a: '', buffer: [] };
  for (const block of page.blocks || []) {
    if (block.t === 'h2') {
      sections.push(current);
      current = { h: plainText(block.text), a: block.id || '', buffer: [] };
      continue;
    }
    if (block.t === 'h3') {
      current.buffer.push(plainText(block.text));
      continue;
    }
    const text = blockText(block);
    if (text) current.buffer.push(text);
  }
  sections.push(current);
  return sections
    .map((section) => {
      const body = section.buffer.join(' ').replace(/\s+/g, ' ').trim();
      const clipped = body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body;
      return { h: section.h, a: section.a, x: clipped };
    })
    .slice(0, maxSections);
}

/**
 * 构造单页索引项。
 *
 * @param {object} page 页面数据
 * @param {string} url 该页相对当前页的 URL（调用方传 `'/'` 形态即可）
 * @param {string} groupLabel 分组中文名
 * @param {object} options 截断参数 `{maxSections, maxChars}`
 * @returns {object} 索引项
 */
export function buildPageEntry(page, url, groupLabel, options = {}) {
  const sections = buildSections(
    page,
    options.maxSections || MAX_SECTIONS,
    options.maxChars || MAX_SECTION_CHARS,
  );
  return {
    u: url,
    t: page.title,
    g: groupLabel,
    d: plainText(page.summary).slice(0, 140),
    k: (page.keywords || []).slice(0, 12),
    s: sections,
  };
}

/**
 * 构造完整索引对象。
 *
 * @param {object[]} entries 页面索引项
 * @param {{cli: string, core: string}} versions 版本号
 * @returns {object} `search-index.json` 的内容
 */
export function buildIndex(entries, versions) {
  return {
    v: SEARCH_SCHEMA_VERSION,
    lang: 'zh-CN',
    versions: { cli: versions.cli, core: versions.core },
    pages: entries,
  };
}

/**
 * 三级截断（§7.4）：先算字节，再按级别降级，仍超上限则返回 `ok: false`。
 *
 * @param {(options: {maxSections: number, maxChars: number}) => object} makeIndex 传入截断参数返回索引
 * @returns {{index: object, level: number, bytes: number, truncatedSections: number, ok: boolean}}
 *   截断结果；`ok: false` 表示三级之后仍然超预算（调用方应 exit 3）
 */
export function truncateToBudget(makeIndex) {
  const levels = [
    { maxSections: MAX_SECTIONS, maxChars: MAX_SECTION_CHARS },
    { maxSections: MAX_SECTIONS, maxChars: 300 },
    { maxSections: 6, maxChars: 300 },
    { maxSections: 3, maxChars: 300 },
  ];
  let last = null;
  for (let level = 0; level < levels.length; level += 1) {
    const index = makeIndex(levels[level]);
    const bytes = Buffer.byteLength(JSON.stringify(index), 'utf8');
    last = { index, level, bytes };
    const over = level === 0 ? bytes > TRUNCATE_TRIGGER_BYTES : bytes > MAX_INDEX_BYTES;
    if (!over) {
      return { ...last, truncatedSections: countTruncated(index, levels[level]), ok: true };
    }
  }
  return { ...last, truncatedSections: countTruncated(last.index, levels[levels.length - 1]), ok: false };
}

/**
 * 统计被截断的节数（`x` 以 `…` 结尾即视为被截断）。
 *
 * @param {object} index 索引
 * @param {{maxSections: number}} options 当前级别
 * @returns {number} 截断节数
 */
function countTruncated(index, options) {
  let count = 0;
  for (const page of index.pages) {
    if (page.s.length >= options.maxSections) count += 1;
    for (const section of page.s) if (section.x.endsWith('…')) count += 1;
  }
  return count;
}

/**
 * 是否为 CJK 字符。
 *
 * @param {string} char 单个字符
 * @returns {boolean} 是 CJK 则为 `true`
 */
export function isCjk(char) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char);
}

/**
 * 把查询切成 token：ASCII 整词 + CJK bigram（`'压缩'` → `'压缩'`）。
 *
 * @param {string} query 原始查询
 * @returns {string[]} 小写 token
 */
export function tokenizeQuery(query) {
  const text = String(query == null ? '' : query).trim().toLowerCase();
  if (!text) return [];
  const tokens = [];
  const words = text.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  for (const word of words) {
    if (/^[\x00-\x7f]+$/.test(word)) {
      tokens.push(word);
      continue;
    }
    if (word.length === 1) {
      tokens.push(word);
      continue;
    }
    for (let index = 0; index < word.length - 1; index += 1) {
      tokens.push(word.slice(index, index + 2));
    }
    tokens.push(word);
  }
  return [...new Set(tokens)];
}

/**
 * token 在文本里的命中分（ASCII 整词 1.0 / 前缀 0.7 / CJK 1.0）。
 *
 * @param {string} haystack 已小写的文本
 * @param {string} token 查询 token
 * @returns {number} 0–1
 */
export function matchScore(haystack, token) {
  if (!token) return 0;
  if (isCjk(token[0])) return haystack.includes(token) ? 1 : 0;
  if (haystack.includes(token)) return 1;
  const words = haystack.split(/[^\p{L}\p{N}_-]+/u);
  return words.some((word) => word.startsWith(token)) ? 0.7 : 0;
}

/**
 * 打分与排序（§7.7）：`8·title + 4·heading + 3·keywords + 1·section·coverage`。
 *
 * @param {object} index 索引对象
 * @param {string} query 查询
 * @param {number} [limit] 结果上限（默认 12）
 * @returns {{page: object, section: object|null, sectionIndex: number, score: number}[]} 结果
 */
export function search(index, query, limit = 12) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const results = [];
  index.pages.forEach((page, pageOrder) => {
    const title = String(page.t).toLowerCase();
    const keywords = (page.k || []).join(' ').toLowerCase();
    const desc = String(page.d).toLowerCase();
    let titleScore = 0;
    let keywordScore = 0;
    let descScore = 0;
    let matched = 0;
    for (const token of tokens) {
      const titleHit = matchScore(title, token);
      const keywordHit = matchScore(keywords, token);
      const descHit = matchScore(desc, token);
      if (titleHit || keywordHit || descHit) matched += 1;
      titleScore += titleHit;
      keywordScore += keywordHit;
      descScore += descHit;
    }
    page.s.forEach((section, sectionIndex) => {
      const heading = String(section.h).toLowerCase();
      const body = String(section.x).toLowerCase();
      let headingScore = 0;
      let bodyScore = 0;
      let sectionMatched = 0;
      for (const token of tokens) {
        const headHit = matchScore(heading, token);
        const bodyHit = matchScore(body, token);
        if (headHit || bodyHit) sectionMatched += 1;
        headingScore += headHit;
        bodyScore += bodyHit;
      }
      const coverage = sectionMatched / tokens.length;
      if (coverage === 0) {
        // 页面级命中（标题/关键词/摘要）但没有任何小节命中时，用**第一节**作为落点。
        // 否则「关键词命中、正文没命中」的页面会彻底消失 —— `exit code` 查不到 `cli/exit-codes`
        // 就是这个漏洞：它的标题是中文，关键词里才有英文。
        if (sectionIndex !== 0) return;
        if (titleScore === 0 && keywordScore === 0 && descScore === 0) return;
      }
      const bonus = coverage === 1 && tokens.length > 0 ? 2 : 0;
      const score =
        8 * titleScore + 4 * headingScore + 3 * keywordScore + 1 * bodyScore * coverage + bonus +
        descScore * 0.5;
      results.push({ page, section, sectionIndex, score, pageOrder });
    });
  });
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.pageOrder !== b.pageOrder) return a.pageOrder - b.pageOrder;
    return a.sectionIndex - b.sectionIndex;
  });
  const perPage = new Map();
  const limited = [];
  for (const result of results) {
    const used = perPage.get(result.page.u) || 0;
    if (used >= 2) continue;
    perPage.set(result.page.u, used + 1);
    limited.push(result);
    if (limited.length >= limit) break;
  }
  return limited;
}
