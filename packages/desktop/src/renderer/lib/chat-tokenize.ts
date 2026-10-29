/**
 * A deliberately tiny syntax tokenizer for code blocks. It produces tokens that the caller
 * renders as React nodes (no HTML strings: the strict CSP would drop inline `style=`, and a
 * highlighter that builds markup from model output is an injection surface we do not need).
 *
 * It is a lexer, not a parser: comments, strings, numbers, keywords. That is the whole of what
 * makes a snippet readable, and it is linear in the input with no backtracking.
 */

export type TokenType = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'add' | 'del' | 'meta';

export interface CodeToken {
  text: string;
  type: TokenType;
}

/** Above this many lines a block is shown as plain text (the spec's degradation point). */
export const HIGHLIGHT_MAX_LINES = 2000;

type Family = 'c' | 'hash' | 'json' | 'diff' | 'plain';

const FAMILY_BY_LANG: Record<string, Family> = {
  js: 'c', jsx: 'c', ts: 'c', tsx: 'c', javascript: 'c', typescript: 'c', java: 'c', c: 'c', cpp: 'c',
  'c++': 'c', cs: 'c', csharp: 'c', go: 'c', rust: 'c', rs: 'c', kotlin: 'c', swift: 'c', php: 'c', css: 'c',
  py: 'hash', python: 'hash', sh: 'hash', bash: 'hash', shell: 'hash', zsh: 'hash', ruby: 'hash',
  rb: 'hash', yaml: 'hash', yml: 'hash', toml: 'hash', powershell: 'hash', ps1: 'hash', dockerfile: 'hash',
  json: 'json', jsonc: 'json', diff: 'diff', patch: 'diff',
};

const KEYWORDS = new Set((
  'abstract async await break case catch class const continue default delete do else enum export ' +
  'extends false finally fn for from func function if impl implements import in instanceof interface ' +
  'let match mod mut new null of package private protected pub public readonly return self static ' +
  'struct super switch this throw true try type typeof undefined use var void while with yield ' +
  'def elif except lambda None pass raise True False and or not is as del global nonlocal print ' +
  'echo fi then done esac export local set unset'
).split(' '));

const C_LEXER = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const HASH_LEXER = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g;
const JSON_LEXER = /()("(?:[^"\\\n]|\\.)*"?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(true|false|null)/g;

function lex(code: string, pattern: RegExp): CodeToken[] {
  const tokens: CodeToken[] = [];
  let cursor = 0;
  const push = (text: string, type: TokenType): void => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += text;
    else tokens.push({ text, type });
  };
  for (const match of code.matchAll(pattern)) {
    const at = match.index ?? 0;
    push(code.slice(cursor, at), 'plain');
    cursor = at + match[0].length;
    if (match[1]) push(match[0], 'comment');
    else if (match[2]) push(match[0], 'string');
    else if (match[3]) push(match[0], 'number');
    else push(match[0], KEYWORDS.has(match[0]) ? 'keyword' : 'plain');
  }
  push(code.slice(cursor), 'plain');
  return tokens;
}

function lexDiff(code: string): CodeToken[] {
  return code.split('\n').flatMap((line, index, all) => {
    const text = index < all.length - 1 ? `${line}\n` : line;
    if (!text) return [];
    const type: TokenType = line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')
      ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'plain';
    return [{ text, type }];
  });
}

export function languageFamily(lang: string | undefined): Family {
  return FAMILY_BY_LANG[(lang ?? '').toLowerCase()] ?? 'plain';
}

export function countLines(code: string): number {
  let lines = 1;
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) lines += 1;
  return lines;
}

export function tokenize(code: string, lang?: string): CodeToken[] {
  const family = languageFamily(lang);
  if (family === 'plain' || countLines(code) > HIGHLIGHT_MAX_LINES) return [{ text: code, type: 'plain' }];
  if (family === 'diff') return lexDiff(code);
  return lex(code, family === 'c' ? C_LEXER : family === 'json' ? JSON_LEXER : HASH_LEXER);
}
