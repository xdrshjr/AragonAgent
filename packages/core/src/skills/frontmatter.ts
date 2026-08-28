/**
 * SKILL.md frontmatter parser — a deliberately STRICT SUBSET of YAML (D9).
 *
 * Why not depend on `yaml`: `@aragon-agent/core` ships zero required runtime
 * dependencies (only `ajv` / `isolated-vm` as optional), and real SKILL.md
 * frontmatter only ever uses scalars, quoted strings, inline arrays and block
 * arrays. Unknown keys are preserved verbatim in `data` so a future Anthropic
 * field never breaks parsing.
 *
 * Every rule below is numbered to match spec §4.3 and has a dedicated test.
 */

import { FRONTMATTER_MAX_BYTES, FRONTMATTER_MAX_LINES } from './constants.js';

export interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  /** Everything after the closing delimiter, `trimStart()`-ed. */
  body: string;
  /** Non-fatal warnings (duplicate keys, tab indentation, bad key syntax). */
  errors: string[];
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Rule 1: strip a UTF-8 BOM and normalize CRLF / lone CR to LF. */
function normalizeSource(source: string): string {
  const noBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return noBom.replace(/\r\n?/g, '\n');
}

/**
 * Rule 5: `#` only starts a comment at the start of a line or after whitespace,
 * so a URL fragment (`homepage: https://x/y#v1`) survives. Text inside a leading
 * quoted string is skipped first — `description: "a # b"` keeps its hash.
 */
function stripComment(value: string): string {
  const quote = value[0];
  let i = 0;
  if (quote === '"' || quote === "'") {
    i = 1;
    while (i < value.length) {
      if (value[i] === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      if (value[i] === quote) {
        i += 1;
        break;
      }
      i += 1;
    }
  }
  for (; i < value.length; i += 1) {
    if (value[i] !== '#') continue;
    if (i === 0 || /\s/.test(value[i - 1] as string)) return value.slice(0, i);
  }
  return value;
}

/** Rule 4c: remove surrounding quotes, honouring only `\"` and `\\`. */
function dequote(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replace(/''/g, "'");
  return inner.replace(/\\(["\\])/g, '$1');
}

/** Rule 4b: `[a, b, "c d"]` → `['a', 'b', 'c d']`. */
function parseInlineArray(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((item) => dequote(item.trim()))
    .filter((item) => item.length > 0);
}

/**
 * Parse the frontmatter block of a SKILL.md.
 *
 * Returns `null` when there is no usable frontmatter at all — no opening `---`,
 * no closing delimiter, or a block that blows past the hard limits of rule 8.
 * `null` is never an exception: a malformed skill degrades to `invalid` in the
 * registry and stays visible to the user (§4.4), it does not crash discovery.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter | null {
  const text = normalizeSource(source);
  const lines = text.split('\n');

  // Rule 2: the opening `---`, optionally preceded by blank lines.
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) start += 1;
  if (start >= lines.length || lines[start]!.trim() !== '---') return null;

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '---' || trimmed === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const blockLines = lines.slice(start + 1, end);

  // Rule 8: hard limits — a pathological file must not become a parsing DoS.
  if (blockLines.length > FRONTMATTER_MAX_LINES) return null;
  if (Buffer.byteLength(blockLines.join('\n'), 'utf-8') > FRONTMATTER_MAX_BYTES) return null;

  const data: Record<string, string | string[]> = {};
  const errors: string[] = [];
  let pendingArrayKey: string | null = null;
  /** Keys opened with an empty value — only these may collapse back to `''`. */
  const emptyValueKeys = new Set<string>();

  const setKey = (key: string, value: string | string[]): void => {
    // Rule 7: last one wins, but say so.
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      errors.push(`duplicate key "${key}" - the last value wins`);
    }
    data[key] = value;
  };

  for (let i = 0; i < blockLines.length; i += 1) {
    const rawLine = blockLines[i]!;
    if (rawLine.trim().length === 0) continue;

    const indent = /^[ \t]*/.exec(rawLine)![0];
    // Rule 6: tabs are never valid YAML indentation.
    if (indent.includes('\t')) {
      errors.push(`line ${i + 1}: tab indentation is not supported`);
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed.startsWith('#')) continue;

    // Block-array continuation (rule 4a).
    if (pendingArrayKey !== null && trimmed.startsWith('- ')) {
      const item = dequote(stripComment(trimmed.slice(2).trim()).trim());
      if (item.length > 0) (data[pendingArrayKey] as string[]).push(item);
      continue;
    }
    pendingArrayKey = null;

    if (indent.length > 0) {
      errors.push(`line ${i + 1}: unexpected indentation outside a block list`);
      continue;
    }

    // Rule 3: split on the FIRST colon.
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      errors.push(`line ${i + 1}: not a "key: value" pair`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    if (!KEY_PATTERN.test(key)) {
      errors.push(`line ${i + 1}: invalid key "${key}"`);
      continue;
    }

    // Trim BEFORE stripping comments: `stripComment` only recognizes a leading
    // quote at index 0, so a value like ` "a # b"` would otherwise lose its hash.
    const rawValue = stripComment(trimmed.slice(colon + 1).trim()).trim();

    if (rawValue.length === 0) {
      // Empty value: either a block array follows, or it really is empty.
      setKey(key, []);
      emptyValueKeys.add(key);
      pendingArrayKey = key;
      continue;
    }
    emptyValueKeys.delete(key);
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      setKey(key, parseInlineArray(rawValue));
      continue;
    }
    setKey(key, dequote(rawValue));
  }

  // An empty-valued key with no `- ` items behind it was a scalar all along.
  // `keywords: []` is NOT touched — it was written as an explicit empty array.
  for (const key of emptyValueKeys) {
    const value = data[key];
    if (Array.isArray(value) && value.length === 0) data[key] = '';
  }

  return { data, body: lines.slice(end + 1).join('\n').trimStart(), errors };
}
