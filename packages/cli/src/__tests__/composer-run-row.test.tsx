/** The editor owns no run animation or shortcut row; fixed bottom chrome does. */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import stringWidth from 'string-width';
import { Composer } from '../ui/Composer.js';
import { StatusBar } from '../ui/StatusBar.js';
import { planStatusDetail } from '../ui/layout/status-detail-layout.js';
import { BottomStatusRow } from '../ui/BottomStatusRow.js';
import { initialViewState } from '../agent/reducer.js';
import { interactionCopy } from '../ui/interaction-copy.js';
import { getTheme } from '../ui/theme.js';
import { renderRowsAtWidth } from './render-at-width.js';

const caps = { colorLevel: 0, unicode: true } as const;
const theme = getTheme('cool', caps);
const state = initialViewState();
const composer = (cols: number, running: boolean) => <Composer cols={cols} cursorVisible={false} isActive
  running={running} history={[]} commands={[]} cwd={process.cwd()} showHint
  submitCount={0} hintsEnabled agentMode="build" theme={theme} caps={caps}
  onSubmit={() => ({ accepted: true })} />;

const status = (running: boolean, reducedMotion = false) => <StatusBar columns={80} speedKnown={true}
  model="test" provider="test" usageTotal={state.usageTotal} context={state.context}
  status={running ? 'running' : 'idle'} runPhase={running ? 'generating' : 'idle'}
  elapsedMs={1000} thinkingLevel="xhigh" tokPerSec={10} theme={theme} caps={caps}
  reducedMotion={reducedMotion} />;

const braille = (text: string) => (text.match(/[\u2800-\u28ff]/g) ?? []).length;

describe('fixed activity and action chrome', () => {
  it.each([39, 80, 100])('renders only the three-row input at %i columns', (cols) => {
    const idle = renderRowsAtWidth(composer(cols, false), cols);
    const running = renderRowsAtWidth(composer(cols, true), cols);
    expect(idle).toHaveLength(3);
    expect(running).toHaveLength(3);
    expect(idle.join('\n')).toContain(interactionCopy.idlePlaceholder.slice(0, 25));
    expect(running.join('\n')).toContain(interactionCopy.runningPlaceholder);
    expect(running.join('\n')).not.toContain('Esc');
    expect(braille(running.join('\n'))).toBe(0);
    expect(running.every((row) => stringWidth(row) <= cols)).toBe(true);
  });

  it('keeps one complete interrupt clause outside the editor and one status animation', () => {
    const rows = renderRowsAtWidth(<Box flexDirection="column">
      {composer(80, true)}
      <BottomStatusRow theme={theme} columns={80} plan={planStatusDetail({
        status: { columns:80, phase:'generating', pendingCount:0, usageTotal:state.usageTotal, context:state.context,
          elapsedMs:1000, thinkingLevel:'xhigh', tokPerSec:10, speedKnown:true },
        hints:{cols:80,interactionPhase:'running'}, model:'test', provider:'test'
      })} />
      {status(true)}
    </Box>, 80);
    expect(rows).toHaveLength(5);
    expect(rows[3]).toContain(interactionCopy.interrupt);
    expect(rows[3]).toContain('Enter');
    expect(rows[4]).toMatch(/Write|Generating/);
    expect(rows.slice(0, 3).join('\n')).not.toContain('Esc');
    expect(braille(rows.join('\n'))).toBe(1);
    expect(braille(rows[4]!)).toBe(1);
  });

  it('disables animation for reduced motion and idle without adding chrome rows', () => {
    for (const running of [false, true]) {
      const rows = renderRowsAtWidth(status(running, true), 80);
      expect(rows).toHaveLength(1);
      expect(braille(rows.join('\n'))).toBe(0);
    }
  });
});
