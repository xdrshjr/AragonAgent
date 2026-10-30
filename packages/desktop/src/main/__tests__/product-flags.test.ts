import { describe, expect, it } from 'vitest';
import { attachmentsEnabledFrom } from '../product-flags.js';

describe('ARAGON_DESKTOP_ATTACHMENTS', () => {
  it('is on when unset', () => {
    expect(attachmentsEnabledFrom({})).toBe(true);
  });

  it("turns off only for the exact string '0'", () => {
    expect(attachmentsEnabledFrom({ ARAGON_DESKTOP_ATTACHMENTS: '0' })).toBe(false);
  });

  it.each(['', '1', 'false', 'off', 'no', ' 0', '00'])('stays on for %j (no guessing at intent)', (value) => {
    expect(attachmentsEnabledFrom({ ARAGON_DESKTOP_ATTACHMENTS: value })).toBe(true);
  });
});
