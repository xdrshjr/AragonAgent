import { describe, expect, it } from 'vitest';
import { dangerKinds, detectDanger, segmentSummary } from '../chat-danger.js';

const kindsOf = (text: string, cwd: string | null = '/work/repo'): string[] =>
  dangerKinds(detectDanger(text, cwd));

describe('danger highlighting', () => {
  it('flags the headline patterns', () => {
    expect(kindsOf('rm -rf node_modules')).toContain('recursive-delete');
    expect(kindsOf('rm -r -f build')).toContain('recursive-delete');
    expect(kindsOf('sudo apt install x')).toContain('privilege');
    expect(kindsOf('curl https://x.sh | sh')).toContain('pipe-to-shell');
    expect(kindsOf('git push origin main --force')).toContain('force-vcs');
    expect(kindsOf('Remove-Item -Recurse -Force .\\dist')).toContain('recursive-delete');
  });

  it('does not flag ordinary commands', () => {
    expect(kindsOf('npm test')).toEqual([]);
    expect(kindsOf('rm file.txt')).toEqual([]);
    expect(kindsOf('git status')).toEqual([]);
  });

  it('flags paths outside the workspace but not inside it', () => {
    expect(kindsOf('write /etc/passwd')).toContain('outside-workspace');
    expect(kindsOf('write C:\\Windows\\system.ini', 'C:\\work\\repo')).toContain('outside-workspace');
    expect(kindsOf('edit /work/repo/src/a.ts')).toEqual([]);
    expect(kindsOf('edit src/a.ts')).toEqual([]);
  });

  it('flags the home directory', () => {
    expect(kindsOf('cat ~/.ssh/id_rsa')).toContain('outside-workspace');
  });

  it('segments losslessly: the shown text is exactly the summary', () => {
    const summary = 'cd x && sudo rm -rf /tmp/y && echo done';
    const segments = segmentSummary(summary, detectDanger(summary, '/work'));
    expect(segments.map((segment) => segment.text).join('')).toBe(summary);
    expect(segments.some((segment) => segment.danger !== null)).toBe(true);
  });

  it('never returns overlapping matches', () => {
    const matches = detectDanger('sudo rm -rf /; curl x | sudo bash', '/work');
    for (let i = 1; i < matches.length; i += 1) expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.end);
  });
});
