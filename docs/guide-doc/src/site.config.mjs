/**
 * 站点元信息。
 *
 * 这里刻意只放**纯数据与纯函数**：本文件被 `src/content/**` 与 `src/render/**` 共同引用，
 * 而这两个目录受 §4.1 的纪律约束（不得出现 `node:fs`/`node:path`/`Date.now`）。
 * 版本号不在此处读取 —— `build.mjs` 解析两个 package.json 后通过 `withVersions()` 注入，
 * 这样「版本从哪来」只有一个答案，产物也因此可确定（AC-18 / AC-27）。
 */

/** 站点静态配置。 */
export const siteConfig = {
  /** 站点名，用于 <title> 后缀与页头。 */
  siteName: 'AragonAgent 文档',
  /** 站点一句话定位，用于首页与 meta。 */
  tagline: 'Agent 引擎、TUI 与 headless 机器契约的权威参考',
  /** 语言（结构预留 `lang`，B 之后若要英文镜像只需再挂一份内容）。 */
  lang: 'zh-CN',
  /** 默认 origin（canonical / OpenGraph 用）；发布者可用 --base 覆盖路径前缀。 */
  origin: 'https://github.com/xdrshjr/AragonAgent',
  /** 源码仓库（页脚与「本页依据」里的 blob 链接）。 */
  repoUrl: 'https://github.com/xdrshjr/AragonAgent',
  /** blob 链接使用的分支。 */
  repoBranch: 'main',
  /** 部署路径前缀，`--base` 可覆盖；始终以 `/` 结尾。 */
  basePath: '/',
  /** 许可证。 */
  license: 'MIT',
  /** 主题存储键（客户端与引导脚本共用，唯一真源）。 */
  themeKey: 'aragon-docs:theme',
  /** 搜索索引里 `x` 字段的字数上限（§7.4 三级截断的第 0 级）。 */
  searchSnippetChars: 400,
};

/**
 * 注入构建期版本号，返回新的站点配置对象。
 *
 * @param {{cli: string, core: string}} versions 两个包的版本号
 * @returns {typeof siteConfig & {versions: {cli: string, core: string}}}
 */
export function withVersions(versions) {
  return { ...siteConfig, versions: { cli: versions.cli, core: versions.core } };
}

/**
 * 归一化 `--base` 取值：确保以 `/` 开头并以 `/` 结尾。
 *
 * @param {string} base 命令行传入的前缀，可为 `'/'`、`'/aragon-docs'`、`'aragon-docs/'`
 * @returns {string} 归一化结果，例如 `'/aragon-docs/'`
 */
export function normalizeBase(base) {
  if (!base) return '/';
  let value = base.startsWith('/') ? base : `/${base}`;
  if (!value.endsWith('/')) value = `${value}/`;
  return value;
}

/**
 * 拼装绝对 URL（canonical / og:url / sitemap 用）。
 *
 * @param {string} origin 站点 origin，无尾斜杠
 * @param {string} basePath 归一化后的 basePath
 * @param {string} urlPath 站内绝对路径，例如 `'/guide/tui/'`
 * @returns {string}
 */
export function absoluteUrl(origin, basePath, urlPath) {
  const trimmedOrigin = origin.replace(/\/+$/, '');
  const trimmedPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  return `${trimmedOrigin}${basePath}${trimmedPath}`;
}
