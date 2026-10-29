import { describe, expect, it } from 'vitest';
import { describeDroppedPath } from '../drop-paths.js';

describe('describeDroppedPath', () => {
  it('uses the relative, forward-slash form for a file inside the working directory', () => {
    expect(describeDroppedPath('C:\\work\\repo\\src\\a.ts', 'C:\\work\\repo', 'win32'))
      .toEqual({ text: 'src/a.ts', outside: false });
    expect(describeDroppedPath('/home/u/repo/docs/x.md', '/home/u/repo/', 'linux'))
      .toEqual({ text: 'docs/x.md', outside: false });
  });

  it('quotes a relative path that contains whitespace', () => {
    expect(describeDroppedPath('/r/my docs/a b.md', '/r', 'linux'))
      .toEqual({ text: '"my docs/a b.md"', outside: false });
  });

  it('keeps an outside file absolute, quoted, and says it is outside', () => {
    expect(describeDroppedPath('D:\\other\\secret.txt', 'C:\\work\\repo', 'win32'))
      .toEqual({ text: '"D:/other/secret.txt"', outside: true });
  });

  it('does not treat a sibling that shares a prefix as inside', () => {
    expect(describeDroppedPath('/home/u/repo-evil/a.ts', '/home/u/repo', 'linux').outside).toBe(true);
  });

  it('ignores case on Windows and macOS only', () => {
    expect(describeDroppedPath('C:\\WORK\\Repo\\a.ts', 'c:\\work\\repo', 'win32').outside).toBe(false);
    expect(describeDroppedPath('/Home/u/repo/a.ts', '/home/u/repo', 'linux').outside).toBe(true);
  });

  it('treats the directory itself as outside (there is nothing to mention)', () => {
    expect(describeDroppedPath('/r', '/r', 'linux').outside).toBe(true);
  });

  it('escapes a double quote inside an outside path so the quoting stays balanced', () => {
    expect(describeDroppedPath('/x/a"b.txt', '/r', 'linux').text).toBe('"/x/a\\"b.txt"');
  });
});
