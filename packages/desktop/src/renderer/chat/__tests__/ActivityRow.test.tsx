import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import { ACTIVITY_PHRASES } from '@aragon-agent/tui/ui/activity-phrases';
import { setLanguage } from '../../i18n/index.js';
import { ZH_THINKING_WORDS } from '../../lib/tool-voice-i18n.js';
import { ActivityRow } from '../ActivityRow.js';
import { mountSession, reduce, unmountSession } from './kit.js';

const RUNNING: ViewAction[] = [{ type: 'runStart' }, { type: 'turnStart' }];
const text = (view: ReturnType<typeof render>): string => view.container.querySelector('.activity-text')?.textContent ?? '';

beforeEach(() => { setLanguage('en'); });
afterEach(() => { cleanup(); unmountSession(); vi.useRealTimers(); setLanguage('en'); });

describe('ActivityRow', () => {
  it('shows a thinking word and the clock while a run is live', () => {
    mountSession({ view: reduce(RUNNING) });
    const view = render(<ActivityRow sessionId="s1" voiceMode="friendly" />);
    expect(ACTIVITY_PHRASES).toContain(text(view));
    expect(view.container.querySelector('.activity-clock')!.textContent).toBe('00:00');
  });

  it('renders nothing when idle, in developer mode, or once prose is streaming', () => {
    mountSession({ view: reduce([]) });
    expect(render(<ActivityRow sessionId="s1" voiceMode="friendly" />).container.firstChild).toBeNull();
    cleanup(); unmountSession();
    mountSession({ view: reduce(RUNNING) });
    expect(render(<ActivityRow sessionId="s1" voiceMode="developer" />).container.firstChild).toBeNull();
    cleanup(); unmountSession();
    mountSession({ view: reduce([...RUNNING, { type: 'textDelta', delta: 'Working on it' }]) });
    expect(render(<ActivityRow sessionId="s1" voiceMode="friendly" />).container.firstChild).toBeNull();
  });

  it('names the running tool instead, with +N for parallel calls', () => {
    const tools: ViewAction[] = ['a', 'b'].flatMap((id): ViewAction[] => [
      { type: 'toolCallStart', toolCallId: id, toolName: 'grep' },
      { type: 'toolCallEnd', toolCallId: id, args: { pattern: 'retry' } },
      { type: 'toolExecStart', toolCallId: id },
    ]);
    mountSession({ view: reduce([...RUNNING, ...tools]) });
    const view = render(<ActivityRow sessionId="s1" voiceMode="friendly" />);
    expect(text(view)).toMatch(/(Searching for|Hunting for|Tracking down) retry \+1$/);
    expect(text(view)).not.toContain('grep');
  });

  it('keeps rotating words out of any live region', () => {
    mountSession({ view: reduce(RUNNING) });
    const view = render(<ActivityRow sessionId="s1" voiceMode="friendly" />);
    const row = view.container.querySelector('.activity-row')!;
    expect(row.getAttribute('aria-label')).toBe('Working');
    expect(row.querySelector('.activity-text')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('rotates the word every four seconds and counts the elapsed time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mountSession({ view: reduce(RUNNING) });
    const view = render(<ActivityRow sessionId="s1" voiceMode="friendly" />);
    const first = text(view);
    act(() => { vi.advanceTimersByTime(4100); });
    expect(text(view)).not.toBe(first);
    expect(view.container.querySelector('.activity-clock')!.textContent).toBe('00:04');
  });

  it('speaks Chinese in the zh-CN interface', () => {
    setLanguage('zh-CN');
    mountSession({ view: reduce(RUNNING) });
    const view = render(<ActivityRow sessionId="s1" voiceMode="friendly" />);
    expect(ZH_THINKING_WORDS).toContain(text(view));
  });
});
