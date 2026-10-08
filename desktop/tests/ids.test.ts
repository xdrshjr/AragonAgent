import { describe, expect, it } from 'vitest';
import { maskKey, titleFromMessage, hashString } from '../shared/ids';

describe('titleFromMessage', () => {
  it('collapses whitespace', () => {
    expect(titleFromMessage('fix   the\n  login   bug')).toBe('fix the login bug');
  });

  it('truncates long messages with an ellipsis', () => {
    const title = titleFromMessage('a'.repeat(80));
    expect(title.length).toBe(48);
    expect(title.endsWith('...')).toBe(true);
  });

  it('keeps short messages intact', () => {
    expect(titleFromMessage('hello')).toBe('hello');
  });
});

describe('maskKey', () => {
  it('masks everything for short keys', () => {
    expect(maskKey('short')).toBe('****');
  });

  it('keeps head and tail for long keys', () => {
    expect(maskKey('sk-ant-abc123-def456')).toBe('sk...f456');
  });
});

describe('hashString', () => {
  it('is deterministic and discrimination-capable', () => {
    expect(hashString('{"a":1}')).toBe(hashString('{"a":1}'));
    expect(hashString('{"a":1}')).not.toBe(hashString('{"a":2}'));
  });
});
