/**
 * Header (spec §4.2) — the always-present brand bar.
 *
 * In full-screen this is EXACTLY ONE ROW at every size, which is what makes the
 * viewport height monotonic in `rows` and the first submit jump-free. The 6-row
 * wordmark it used to host now lives in `SessionOpener`, inside the viewport.
 *
 * `banner` survives for the inline path only (`App.tsx` picks it with a local
 * ternary and never calls `pickHeaderVariant`), so inline keeps its v0.3.0
 * geometry. `art` is no longer reachable from here.
 *
 * Every line is `wrap="truncate"`: a long cwd silently costing a second row
 * would push the bottom chrome off-frame and break R2.
 */

import React from 'react';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { Logo, type HeaderVariant } from './Logo.js';

interface HeaderProps {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  hasKey: boolean;
  variant: HeaderVariant;
  theme: Theme;
  caps: TermCapabilities;
}

/** Collapse the home directory to `~` for a shorter path display. */
function tildeCwd(cwd: string): string {
  const home = homedir();
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function KeyDot({ hasKey, theme }: { hasKey: boolean; theme: Theme }): React.ReactElement {
  return (
    <Text color={hasKey ? theme.toolDone : theme.toolRunning}>
      {hasKey ? theme.symbols.keyOn : theme.symbols.keyOff} {hasKey ? 'key set' : 'no key'}
    </Text>
  );
}

export function Header({
  version,
  cwd,
  provider,
  model,
  hasKey,
  variant,
  theme,
  caps,
}: HeaderProps): React.ReactElement {
  if (variant === 'mini') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text wrap="truncate">
          <Logo variant="mini" theme={theme} caps={caps} />
        </Text>
      </Box>
    );
  }

  if (variant === 'bar') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text wrap="truncate">
          <Logo variant="bar" theme={theme} caps={caps} />
          <Text color={theme.accent}>
            {'  '}
            {provider}:{model}
          </Text>
          <Text color={theme.muted}>{'  '}{basename(cwd) || cwd}</Text>
          <Text color={hasKey ? theme.toolDone : theme.toolRunning}>
            {'  '}
            {hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}
          </Text>
        </Text>
      </Box>
    );
  }

  // `banner` (inline only): wordmark row + meta row.
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Logo variant={variant} theme={theme} caps={caps} />
      <Text wrap="truncate">
        <Text color={theme.muted}>v{version}</Text>
        <Text color={theme.accent}>
          {'   '}
          {provider}:{model}
        </Text>
        <Text>{'   '}</Text>
        <KeyDot hasKey={hasKey} theme={theme} />
        <Text color={theme.muted}>{'   '}{tildeCwd(cwd)}</Text>
      </Text>
    </Box>
  );
}
