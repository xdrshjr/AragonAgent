/**
 * Lightweight markdown renderer for Ink (spec §4 / §4.7).
 *
 * Supports: fenced code blocks (syntax-highlighted via cli-highlight, on a left
 * rail with a language tag), six DISTINCT heading weights, horizontal rules,
 * unordered/ordered lists, blockquotes, pipe tables, and inline **bold** /
 * *italic* / `code` / ~~strike~~. Anything else renders as plain text. Still
 * intentionally small — not a CommonMark implementation.
 *
 * The grammar lives in `markdown-blocks.ts`; this file only renders. That was
 * true of the file header long before it was true of the file
 * (tui-render-performance R2): the block grammar used to run here, in the render
 * body, on every frame. Both expensive halves are now memoised on the input
 * string — `parseMarkdownCached` for the AST, `highlightCached` for the ANSI —
 * while theme and glyphs stay render-time, so `/theme` still takes effect
 * immediately (K-5).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs, type Glyphs } from './glyphs.js';
import { railBorderProps } from './layout/Gutter.js';
import { highlightCached, parseMarkdownCached } from './render-cache.js';
import {
  formatTable,
  isRule,
  parseHeading,
  parseInline,
  type MdBlock,
} from './markdown-blocks.js';

interface MarkdownProps {
  text: string;
  theme: Theme;
  caps: TermCapabilities;
}

/** Width of the `---` rule. Fixed so it cannot force a wrap on narrow frames. */
const RULE_WIDTH = 24;

export function Markdown({ text, theme, caps }: MarkdownProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const blocks = parseMarkdownCached(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i, theme, glyphs))}
    </Box>
  );
}

function renderBlock(
  block: MdBlock,
  key: number,
  theme: Theme,
  glyphs: Glyphs,
): React.ReactElement {
  switch (block.kind) {
    case 'code':
      return (
        <CodeBlock
          key={`b${key}`}
          code={block.code}
          lang={block.lang}
          theme={theme}
          glyphs={glyphs}
        />
      );
    case 'table': {
      // Glyphs are injected rather than hardcoded: this module is inside the
      // ASCII-only scan, and the pure parser defaults to ASCII `|` / `-`.
      const formatted = formatTable(block.rows, block.align, {
        separator: glyphs.railVertical,
        rule: glyphs.hrule,
      });
      return (
        <Box key={`b${key}`} flexDirection="column">
          {formatted.map((row, r) => (
            <Text key={r} wrap="truncate" bold={r === 0} color={tableRowColor(r, theme)}>
              {row}
            </Text>
          ))}
        </Box>
      );
    }
    default:
      return <InlineLine key={`b${key}`} line={block.text} theme={theme} glyphs={glyphs} />;
  }
}

/**
 * Table row 0 is the header (bold + accent); row 1 is the divider drawn under it.
 *
 * The divider must stay distinguishable at colour level 0, where bold is dropped
 * to nothing, so it is MUTED and never bold: in `--no-color` the `----` run is
 * itself the signal, and in a coloured tier the weight difference separates the
 * header from the rule beneath it.
 */
function tableRowColor(index: number, theme: Theme): string | undefined {
  if (index === 0) return theme.accent;
  if (index === 1) return theme.muted;
  return undefined;
}

/**
 * Fenced code. The round border is gone (§4.3): nested inside a tool card it
 * produced a box inside a box and squeezed an 80-column terminal down to 74
 * usable columns. A left rail plus the language tag conveys the same "this is
 * code" boundary for 1 column and 0 rows.
 *
 * The language tag is a muted TITLE, not a body row: it used to carry a chip
 * background and one padding space either side of the text, so it rendered as
 * `  |  ts` above code rows that start at `| export ...` — a body line that
 * happened to be the language. It keeps its own row on purpose: the height
 * estimator (`virtual-window.estimateEntryRows`) counts RAW markdown lines and
 * has no code-block branch, so the fence line must still occupy exactly 1 row.
 */
function CodeBlock({
  code,
  lang,
  theme,
  glyphs,
}: {
  code: string;
  lang: string;
  theme: Theme;
  glyphs: Glyphs;
}): React.ReactElement {
  const rendered = highlightCached(code, lang);
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      {...railBorderProps(glyphs.railVertical, theme.border)}
    >
      {lang.length > 0 && (
        <Text bold color={theme.muted}>
          {lang}
        </Text>
      )}
      <Text>{rendered}</Text>
    </Box>
  );
}

/** Six heading levels used to render identically; now they carry three weights. */
function headingStyle(level: number, theme: Theme): { color: string | undefined } {
  if (level <= 2) return { color: theme.primary };
  if (level === 3) return { color: theme.accent };
  return { color: theme.assistant };
}

function InlineLine({
  line,
  theme,
  glyphs,
}: {
  line: string;
  theme: Theme;
  glyphs: Glyphs;
}): React.ReactElement {
  const heading = parseHeading(line);
  if (heading) {
    const style = headingStyle(heading.level, theme);
    if (heading.level === 1) {
      return (
        <Box flexDirection="column">
          <Text bold color={style.color}>
            {heading.text}
          </Text>
          <Text color={theme.border}>{glyphs.hrule.repeat(RULE_WIDTH)}</Text>
        </Box>
      );
    }
    return (
      <Text bold color={style.color}>
        {heading.text}
      </Text>
    );
  }

  if (isRule(line)) {
    return <Text color={theme.border}>{glyphs.hrule.repeat(RULE_WIDTH)}</Text>;
  }

  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) {
    return (
      <Text color={theme.muted} italic>
        {glyphs.railVertical} {renderInline(quote[1] ?? '', theme)}
      </Text>
    );
  }
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (bullet) {
    return (
      <Text>
        {bullet[1]}
        <Text color={theme.accent}>{glyphs.bullet} </Text>
        {renderInline(bullet[3] ?? '', theme)}
      </Text>
    );
  }
  const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (ordered) {
    return (
      <Text>
        {ordered[1]}
        <Text color={theme.accent}>{ordered[2]}. </Text>
        {renderInline(ordered[3] ?? '', theme)}
      </Text>
    );
  }
  return <Text>{renderInline(line, theme)}</Text>;
}

/** Turn parsed inline spans into Ink `<Text>` nodes. */
export function renderInline(text: string, theme: Theme): React.ReactNode {
  const spans = parseInline(text);
  if (spans.length === 0) return text;
  return spans.map((span, i) => {
    switch (span.kind) {
      case 'code':
        return (
          <Text key={`i${i}`} color={theme.code}>
            {span.text}
          </Text>
        );
      case 'bold':
        return (
          <Text key={`i${i}`} bold>
            {span.text}
          </Text>
        );
      case 'italic':
        return (
          <Text key={`i${i}`} italic>
            {span.text}
          </Text>
        );
      case 'strike':
        return (
          <Text key={`i${i}`} strikethrough>
            {span.text}
          </Text>
        );
      default:
        return span.text;
    }
  });
}
