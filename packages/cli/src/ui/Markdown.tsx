/**
 * Lightweight markdown renderer for Ink (spec §4).
 *
 * Supports: fenced code blocks (syntax-highlighted via cli-highlight), ATX
 * headings, unordered/ordered list markers, blockquotes, and inline **bold** /
 * *italic* / `code`. Anything else renders as plain text. This is intentionally
 * small — not a CommonMark implementation.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import type { Theme } from './theme.js';

interface MarkdownProps {
  text: string;
  theme: Theme;
}

const FENCE = /^```(\w*)\s*$/;

export function Markdown({ text, theme }: MarkdownProps): React.ReactElement {
  const lines = text.split('\n');
  const blocks: React.ReactElement[] = [];

  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line.trim());
    if (fence) {
      // Collect until the closing fence.
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test((lines[i] ?? '').trim())) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push(
        <CodeBlock key={`b${key++}`} code={codeLines.join('\n')} lang={lang} theme={theme} />,
      );
      continue;
    }
    blocks.push(<InlineLine key={`b${key++}`} line={line} theme={theme} />);
    i += 1;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}

function CodeBlock({
  code,
  lang,
  theme,
}: {
  code: string;
  lang: string;
  theme: Theme;
}): React.ReactElement {
  let rendered = code;
  try {
    rendered = highlight(code, { language: lang || undefined, ignoreIllegals: true });
  } catch {
    rendered = code;
  }
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
      <Text>{rendered}</Text>
    </Box>
  );
}

function InlineLine({ line, theme }: { line: string; theme: Theme }): React.ReactElement {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    return (
      <Text bold color={theme.primary}>
        {heading[2]}
      </Text>
    );
  }
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) {
    return (
      <Text color={theme.muted} italic>
        │ {renderInline(quote[1] ?? '', theme)}
      </Text>
    );
  }
  const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (bullet) {
    return (
      <Text>
        {bullet[1]}
        <Text color={theme.accent}>• </Text>
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

/** Parse inline spans: `code`, **bold**, *italic*. Returns Ink <Text> nodes. */
export function renderInline(text: string, theme: Theme): React.ReactNode {
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(
        <Text key={`i${key++}`} color={theme.code}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith('**')) {
      parts.push(
        <Text key={`i${key++}`} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`i${key++}`} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}
