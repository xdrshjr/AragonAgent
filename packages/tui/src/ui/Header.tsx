/**
 * One-row brand bar: word mark, identity, working directory, task summary and a
 * fixed-width hint column (tui-shortcut-drawer-and-task-summary §4.2 / §4.3).
 *
 * THIS COMPONENT COMPUTES NO WIDTHS ANY MORE. Both halves come from pure
 * planners - `planHeaderHints` for the right column and `planHeaderLeft` for the
 * clause ladder - so the only arithmetic left here is "join what I was given".
 * The old shape carried a `statusExpanded` flag, a kit switch and a prompts
 * switch, all of which existed to choose between header clauses; the clauses are
 * gone (the drawer lists the keys instead), so the props are gone with them.
 */
import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { Logo, type HeaderVariant } from './Logo.js';
import { pickGlyphs } from './glyphs.js';
import {
  planHeaderHints,
  HEADER_HINT_LIMITS,
  type HeaderPanelState,
} from './layout/header-hints.js';
import { planHeaderLeft } from './layout/header-left.js';

interface HeaderProps {
  cwd: string; provider: string; model: string; hasKey: boolean;
  variant: HeaderVariant; theme: Theme; caps: TermCapabilities;
  columns?: number;
  /**
   * What the right column says. Derived in ONE place - the line that renders
   * `<Header>` - so the two overlay slots cannot disagree about it.
   */
  panel?: HeaderPanelState;
  scrolledLines?: number;
  /**
   * The session's task label, or `null` while there is none.
   *
   * `null` WHILE PENDING TOO: a placeholder here would spend eight columns of the
   * row to draw an ellipsis and then move everything back when the label lands,
   * so the first submit visibly jogged the header. The label now appears once,
   * complete (P2-10).
   */
  taskSummary?: { text: string; tone: 'model' | 'fallback' } | null;
  /** `config.taskSummary.enabled`; `false` removes the cell without removing the words. */
  summaryEnabled?: boolean;
}

export function Header({
  cwd, provider, model, hasKey, variant, theme, caps,
  columns = 80, panel = 'none', scrolledLines = 0,
  taskSummary = null, summaryEnabled = true,
}: HeaderProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  // THE RIGHT COLUMN FIRST: it is the only clause that may never be dropped, so
  // the left half is planned against what is left after it (defect 12).
  const plan = planHeaderHints({ columns, panel, scrolledLines });
  const leftCells = Math.max(
    0,
    columns - plan.cells - HEADER_HINT_LIMITS.separatorCells,
  );
  const left = planHeaderLeft({
    leftCells,
    provider,
    model,
    cwd: basename(cwd) || cwd,
    hasKey,
    summary: taskSummary,
    summaryEnabled,
    ellipsis: glyphs.ellipsis,
  });
  return <Box flexDirection="row" height={1} width={columns} flexShrink={0} overflow="hidden">
    <Box width={leftCells} flexShrink={0} overflow="hidden">
      <Text wrap="truncate">
        <Logo variant={variant === 'mini' ? 'mini' : 'bar'} theme={theme} caps={caps} />
        {variant !== 'mini' && <>
          {left.text.model && <Text color={theme.accent}>{'  '}{left.text.model}</Text>}
          {left.text.cwd && <Text color={theme.muted}>{'  '}{left.text.cwd}</Text>}
          {/*
            THE SEPARATOR TRAVELS WITH THE SUMMARY, so the two cannot drift apart:
            a summary drawn without its dot reads as part of the directory name,
            and a dot drawn without a summary is a dangling mark on the row.
          */}
          {left.text.summary && <Text color={theme.muted}>{'  '}{glyphs.midDot}{' '}</Text>}
          {left.text.summary && (taskSummary?.tone === 'fallback'
            ? <Text color={theme.muted} dimColor>{left.text.summary}</Text>
            : <Text color={theme.primary}>{left.text.summary}</Text>)}
          <Text color={hasKey ? theme.toolDone : theme.toolRunning}>
            {'  '}{hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}
          </Text>
        </>}
      </Text>
    </Box>
    <Box width={HEADER_HINT_LIMITS.separatorCells} flexShrink={0} />
    <Box width={plan.cells} flexShrink={0} justifyContent="flex-end">
      <Text color={theme.muted} wrap="truncate">{plan.text}</Text>
    </Box>
  </Box>;
}
