/**
 * 零依赖语法高亮：12 类 token，4 种语言（§6.4）。
 *
 * 纪律（不可协商）：**先转义，再包裹**。实现方式是先把源码切成 token，再对每个 token 的
 * 文本单独 `escapeHtml`，最后包 `<span class="tok-*">` —— 任何情况下 HTML 都不会被当作代码
 * 解析，因此 `</pre><script>` 这类内容只能变成文字。
 */

import { escapeHtml } from './slug.mjs';

/** 语言别名 → 归一化语言名。 */
const LANG_ALIASES = new Map([
  ['ts', 'ts'],
  ['tsx', 'ts'],
  ['typescript', 'ts'],
  ['js', 'ts'],
  ['jsx', 'ts'],
  ['mjs', 'ts'],
  ['javascript', 'ts'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['bash', 'bash'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['zsh', 'bash'],
  ['shell-session', 'bash'],
  // `console` 是**输出**，不是要执行的命令：按 bash 高亮会把 `# 注释` 当成注释、
  // `--flag` 当成参数。§6.4 规定输出整体落在 `--c-out`，因此映射到 text。
  ['console', 'text'],
  ['text', 'text'],
  ['txt', 'text'],
  ['plain', 'text'],
  ['plaintext', 'text'],
  ['output', 'text'],
  ['', 'text'],
]);

/** TS/JS 关键字（含少量常用上下文词）。 */
const TS_KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'class', 'extends',
  'implements', 'interface', 'type', 'enum', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'await', 'async', 'yield', 'throw', 'try',
  'catch', 'finally', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'void', 'null',
  'undefined', 'true', 'false', 'as', 'satisfies', 'readonly', 'public', 'private',
  'protected', 'static', 'declare', 'abstract', 'keyof', 'infer', 'never', 'unknown', 'any',
]);

/**
 * 判断语言是否被支持。
 *
 * @param {string} lang 语言名（大小写无关）
 * @returns {boolean} 支持则为 `true`
 */
export function isKnownLang(lang) {
  return LANG_ALIASES.has(String(lang == null ? '' : lang).trim().toLowerCase());
}

/**
 * 归一化语言名。
 *
 * @param {string} lang 语言名
 * @returns {'ts'|'json'|'bash'|'text'} 归一化结果；未知语言退化为 `'text'`
 */
export function normalizeLang(lang) {
  return LANG_ALIASES.get(String(lang == null ? '' : lang).trim().toLowerCase()) || 'text';
}

/**
 * 把源码切成 `{type, text}` token 序列。
 *
 * @param {string} code 源码
 * @param {'ts'|'json'|'bash'|'text'} lang 归一化语言
 * @returns {{type: string, text: string}[]} token 序列
 */
function tokenize(code, lang) {
  if (lang === 'text') return [{ type: 'out', text: code }];
  if (lang === 'json') return tokenizeJson(code);
  if (lang === 'bash') return tokenizeBash(code);
  return tokenizeTs(code);
}

/**
 * 通用扫描循环：用一组带类型的正则依次吃掉输入。
 *
 * @param {string} code 源码
 * @param {{type: string, re: RegExp}[]} rules 规则（按优先级）
 * @param {string} fallbackType 未命中时的类型
 * @returns {{type: string, text: string}[]} token 序列
 */
function scan(code, rules, fallbackType) {
  const tokens = [];
  let index = 0;
  while (index < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = index;
      const found = rule.re.exec(code);
      if (found && found.index === index && found[0].length > 0) {
        tokens.push({ type: rule.type, text: found[0] });
        index += found[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const previous = tokens[tokens.length - 1];
      const char = code[index];
      if (previous && previous.type === fallbackType) previous.text += char;
      else tokens.push({ type: fallbackType, text: char });
      index += 1;
    }
  }
  return tokens;
}

/**
 * TS/JS 词法切分。
 *
 * @param {string} code 源码
 * @returns {{type: string, text: string}[]} token 序列
 */
function tokenizeTs(code) {
  const rules = [
    { type: 'com', re: /\/\/[^\n]*/y },
    { type: 'com', re: /\/\*[\s\S]*?\*\//y },
    { type: 'str', re: /'(?:[^'\\\n]|\\.)*'?/y },
    { type: 'str', re: /"(?:[^"\\\n]|\\.)*"?/y },
    { type: 'str', re: /`(?:[^`\\]|\\.)*`?/y },
    { type: 'num', re: /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)n?\b/y },
    { type: 'punct', re: /[{}()[\];,.:?!<>=+\-*/%&|^~]+/y },
    { type: 'ident', re: /[A-Za-z_$][\w$]*/y },
  ];
  const tokens = scan(code, rules, 'out');
  return tokens.map((token, index) => {
    if (token.type !== 'ident') return token;
    if (TS_KEYWORDS.has(token.text)) return { type: 'key', text: token.text };
    const next = tokens[index + 1];
    if (next && next.type === 'punct' && next.text.startsWith('(')) {
      return { type: 'fn', text: token.text };
    }
    if (/^[A-Z]/.test(token.text)) return { type: 'type', text: token.text };
    return token;
  });
}

/**
 * JSON 词法切分（键名与字符串分开着色）。
 *
 * @param {string} code 源码
 * @returns {{type: string, text: string}[]} token 序列
 */
function tokenizeJson(code) {
  const rules = [
    { type: 'attr', re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y },
    { type: 'str', re: /"(?:[^"\\]|\\.)*"/y },
    { type: 'num', re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/y },
    { type: 'key', re: /\b(?:true|false|null)\b/y },
    { type: 'punct', re: /[{}[\],:]/y },
  ];
  return scan(code, rules, 'out');
}

/**
 * bash / 控制台输出词法切分（flag 与变量单独着色）。
 *
 * @param {string} code 源码
 * @returns {{type: string, text: string}[]} token 序列
 */
function tokenizeBash(code) {
  const rules = [
    { type: 'com', re: /#[^\n]*/y },
    { type: 'str', re: /'(?:[^'\\]|\\.)*'?/y },
    { type: 'str', re: /"(?:[^"\\]|\\.)*"?/y },
    { type: 'flag', re: /(?<=\s|^)--?[A-Za-z][\w-]*/y },
    { type: 'attr', re: /\$(?:\{[^}]*\}|[A-Za-z_]\w*)/y },
    { type: 'out', re: /[^\s]+/y },
  ];
  return scan(code, rules, 'out');
}

/**
 * 渲染高亮代码块内容。
 *
 * @param {string} code 源码
 * @param {string} [lang] 语言标签
 * @returns {{html: string, lang: 'ts'|'json'|'bash'|'text', degraded: boolean}} 渲染结果
 *   `degraded` 为 `true` 表示语言未知，调用方应记一条 WARN（§6.4）
 */
export function highlight(code, lang = 'text') {
  const known = isKnownLang(lang);
  const resolved = normalizeLang(lang);
  const source = String(code == null ? '' : code).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const tokens = tokenize(source, resolved);
  const html = tokens
    .map((token) => {
      const safe = escapeHtml(token.text);
      if (token.type === 'out' || token.type === 'ident') return safe;
      return `<span class="tok-${token.type}">${safe}</span>`;
    })
    .join('');
  return { html, lang: resolved, degraded: !known };
}
