import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import { APPROVAL_GUARD_MS } from '../ApprovalCard.js';
import { ApprovalInline, HumanRequestDialog, useForeground } from '../ApprovalHost.js';

function Harness({ sessionId }: { sessionId: string }) {
  const foreground = useForeground(sessionId);
  return (
    <>
      <ApprovalInline sessionId={sessionId} foreground={foreground} cwd="/work/repo" onVisibilityChange={() => undefined} />
      <HumanRequestDialog sessionId={sessionId} foreground={foreground} />
    </>
  );
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
const tick = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms); }); };

let host: FakeHost;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  host = mountSession();
});

afterEach(() => {
  cleanup();
  unmountSession();
  vi.useRealTimers();
});

describe('ApprovalCard', () => {
  it('shows the complete summary, never clipped, so a difference at the end stays visible', () => {
    const summary = `${'echo a '.repeat(700)}&& rm important-file-LAST`;
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary, sessionAllowKey: 'bash' });
    const shown = screen.getByLabelText('What will run');
    expect(shown.textContent).toBe(summary);
    expect(shown.textContent).toContain('important-file-LAST');
  });

  it('is an alertdialog and starts with keyboard focus on Deny', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'npm test', sessionAllowKey: 'bash' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(document.activeElement).toBe(button('Deny'));
  });

  it('ignores presses for 400 ms after it appears, then accepts them', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'npm test', sessionAllowKey: 'bash' });
    for (const name of ['Deny', 'Allow once', 'Always allow bash this session']) {
      expect(button(name).getAttribute('aria-disabled')).toBe('true');
    }
    fireEvent.click(button('Allow once'));
    tick(APPROVAL_GUARD_MS - 1);
    fireEvent.click(button('Allow once'));
    expect(host.answers).toHaveLength(0);

    tick(1);
    expect(button('Allow once').getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(button('Allow once'));
    expect(host.answers).toEqual([{ id: 'r1', res: { k: 'tool-approval', decision: 'allow' } }]);
  });

  it('answers "always allow this session" with the matching decision', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'write_file', summary: 'write a.ts', sessionAllowKey: 'write_file' });
    tick(APPROVAL_GUARD_MS);
    fireEvent.click(button('Always allow write_file this session'));
    expect(host.answers[0]?.res).toEqual({ k: 'tool-approval', decision: 'allow-session' });
  });

  it('denies with a trimmed reason capped at 500 characters', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'rm x', sessionAllowKey: 'bash' });
    tick(APPROVAL_GUARD_MS);
    fireEvent.change(screen.getByLabelText(/Reason for denying/), { target: { value: `  ${'x'.repeat(600)}  ` } });
    fireEvent.click(button('Deny'));
    const res = host.answers[0]?.res as { decision: string; reason: string };
    expect(res.decision).toBe('deny');
    expect(res.reason).toHaveLength(500);
  });

  it('treats Esc as a deny, even inside the 400 ms window', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'npm test', sessionAllowKey: 'bash' });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(host.answers).toEqual([{ id: 'r1', res: { k: 'tool-approval', decision: 'deny' } }]);
  });

  it('highlights dangerous commands as a warning only: nothing is denied automatically', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'sudo rm -rf /var/cache', sessionAllowKey: 'bash' });
    tick(APPROVAL_GUARD_MS);
    expect(screen.getByRole('note').textContent).toContain('Deletes files recursively');
    expect(document.querySelectorAll('mark.danger').length).toBeGreaterThan(0);
    expect(host.answers).toHaveLength(0);
    expect(button('Allow once').getAttribute('aria-disabled')).toBe('false');
  });

  it('shows one request at a time and queues the rest in order', () => {
    render(<Harness sessionId="s1" />);
    host.request('r1', { k: 'tool-approval', tool: 'bash', summary: 'first command', sessionAllowKey: 'bash' });
    host.request('r2', { k: 'tool-approval', tool: 'write_file', summary: 'second command', sessionAllowKey: 'write_file' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByLabelText('What will run').textContent).toBe('first command');
    expect(screen.getByText('1 more waiting')).toBeTruthy();

    tick(APPROVAL_GUARD_MS);
    fireEvent.click(button('Allow once'));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByLabelText('What will run').textContent).toBe('second command');
    // The next card gets its OWN inertia window: the click that answered the first cannot reach it.
    expect(button('Allow once').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button('Deny'));
  });
});

describe('ask-user wizard', () => {
  const questions = [
    {
      id: 'scope', header: 'Scope', question: 'Which scope?', allowMultiple: false,
      options: [
        { label: 'Small', description: 'only this file', recommended: true, isOther: false },
        { label: 'Large', description: 'whole repo', recommended: false, isOther: false },
        { label: 'Other', description: '', recommended: false, isOther: true },
      ],
    },
    {
      id: 'checks', header: 'Checks', question: 'Which checks?', allowMultiple: true,
      options: [
        { label: 'Unit', description: '', recommended: true, isOther: false },
        { label: 'Lint', description: '', recommended: false, isOther: false },
        { label: 'Other', description: '', recommended: false, isOther: true },
      ],
    },
  ];

  it('walks the steps and answers with the exact shape the host expects', () => {
    render(<Harness sessionId="s1" />);
    host.request('q1', { k: 'ask-user', questions });
    expect(button('Next').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText(/Large/));
    fireEvent.click(button('Next'));
    fireEvent.click(screen.getByLabelText(/Unit/));
    fireEvent.click(screen.getByLabelText('Lint'));
    fireEvent.click(button('Submit answers'));
    expect(host.answers).toEqual([{
      id: 'q1',
      res: {
        k: 'ask-user', cancelled: false,
        answers: [
          { id: 'scope', selected: ['Large'], custom: null },
          { id: 'checks', selected: ['Unit', 'Lint'], custom: null },
        ],
      },
    }]);
  });

  it('requires text behind "Other" and caps it at 2000 characters', () => {
    render(<Harness sessionId="s1" />);
    host.request('q1', { k: 'ask-user', questions: [questions[0]!] });
    fireEvent.click(screen.getByLabelText('Other'));
    expect(button('Submit answers').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'y'.repeat(2500) } });
    fireEvent.click(button('Submit answers'));
    const res = host.answers[0]?.res as { answers: Array<{ selected: string[]; custom: string }> };
    expect(res.answers[0]?.selected).toEqual(['Other']);
    expect(res.answers[0]?.custom).toHaveLength(2000);
  });

  it('"Skip and explain" answers every question with Other plus the explanation', () => {
    render(<Harness sessionId="s1" />);
    host.request('q1', { k: 'ask-user', questions });
    fireEvent.click(button('Skip and explain'));
    fireEvent.change(screen.getByLabelText('Tell the agent what to do instead'), { target: { value: 'Neither fits.' } });
    fireEvent.click(button('Send explanation'));
    expect(host.answers[0]?.res).toEqual({
      k: 'ask-user', cancelled: false,
      answers: [
        { id: 'scope', selected: ['Other'], custom: 'Neither fits.' },
        { id: 'checks', selected: ['Other'], custom: 'Neither fits.' },
      ],
    });
  });

  it('Esc cancels (fail closed) instead of answering', () => {
    render(<Harness sessionId="s1" />);
    host.request('q1', { k: 'ask-user', questions });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(host.answers[0]?.res).toEqual({ k: 'ask-user', cancelled: true, answers: [] });
  });
});

describe('plan review', () => {
  const plan = {
    title: 'Migrate the schema', summary: 'Three steps.', filesTouched: ['db/schema.ts'], risks: ['data loss'],
    openQuestions: [], steps: [{ title: 'Back up', detail: 'dump the db' }, { title: 'Alter', detail: '' }],
  };

  it('approves, with an empty feedback string', () => {
    render(<Harness sessionId="s1" />);
    host.request('p1', { k: 'plan-review', plan });
    expect(screen.getByText('Back up')).toBeTruthy();
    tick(APPROVAL_GUARD_MS);
    fireEvent.click(button('Approve and run'));
    expect(host.answers[0]?.res).toEqual({ k: 'plan-review', decision: 'approved', feedback: '' });
  });

  it('revises with feedback capped at 2000 characters, and needs some text first', () => {
    render(<Harness sessionId="s1" />);
    host.request('p1', { k: 'plan-review', plan });
    fireEvent.click(button('Revise with feedback'));
    expect(button('Send feedback').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'z'.repeat(2400) } });
    fireEvent.click(button('Send feedback'));
    const res = host.answers[0]?.res as { decision: string; feedback: string };
    expect(res.decision).toBe('revise');
    expect(res.feedback).toHaveLength(2000);
  });

  it('Esc dismisses; it can never approve', () => {
    render(<Harness sessionId="s1" />);
    host.request('p1', { k: 'plan-review', plan });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(host.answers[0]?.res).toEqual({ k: 'plan-review', decision: 'dismissed', feedback: '' });
  });

  it('puts the safe choice first in tab order and guards the approve button', () => {
    render(<Harness sessionId="s1" />);
    host.request('p1', { k: 'plan-review', plan });
    fireEvent.click(button('Approve and run'));
    expect(host.answers).toHaveLength(0);
    const order = screen.getAllByRole('button').map((item) => item.textContent);
    expect(order.indexOf('Dismiss')).toBeLessThan(order.indexOf('Approve and run'));
  });
});

describe('skill install', () => {
  const request = { k: 'skill-install', source: 'https://example.com/skill.zip', targetPath: '/home/u/.aragon/skills/x', summary: 'Adds one skill.' } as const;

  it('shows source, target path and summary, and approves explicitly', () => {
    render(<Harness sessionId="s1" />);
    host.request('k1', request);
    expect(screen.getByText('https://example.com/skill.zip')).toBeTruthy();
    expect(screen.getByText('/home/u/.aragon/skills/x')).toBeTruthy();
    tick(APPROVAL_GUARD_MS);
    fireEvent.click(button('Install'));
    expect(host.answers[0]?.res).toEqual({ k: 'skill-install', approved: true });
  });

  it('Esc denies', () => {
    render(<Harness sessionId="s1" />);
    host.request('k1', request);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(host.answers[0]?.res).toEqual({ k: 'skill-install', approved: false });
  });
});
