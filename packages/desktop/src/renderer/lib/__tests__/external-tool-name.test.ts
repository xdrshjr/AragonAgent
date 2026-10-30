import { describe, expect, it } from 'vitest';
import { SERVER_LABEL_MAX, parseExternalToolName, serverLabel } from '../external-tool-name.js';

describe('parseExternalToolName (AC-M1)', () => {
  it('splits the one convention we have evidence for', () => {
    expect(parseExternalToolName('mcp__playwright__browser_navigate')).toEqual({ server: 'playwright', tool: 'browser_navigate' });
    expect(parseExternalToolName('mcp__my-server__do__thing')).toEqual({ server: 'my-server', tool: 'do__thing' });
  });

  it('leaves everything else alone, built-ins included', () => {
    for (const name of ['read_file', 'bash', 'github__create_issue', 'mcp.server:do-thing', 'mcp_x_y']) {
      expect(parseExternalToolName(name), name).toBeNull();
    }
  });

  it('answers null (and never throws) for malformed input', () => {
    const control = `mcp__a__b${String.fromCharCode(7)}`;
    const cases = ['', 'mcp__', 'mcp____', 'mcp__server', 'mcp__server__', 'mcp____tool', control, `mcp__${'a'.repeat(65)}__t`,
      `mcp__s__${'t'.repeat(129)}`, 'x'.repeat(300), `mcp__s__t\n`];
    for (const name of cases) expect(() => parseExternalToolName(name), name).not.toThrow();
    for (const name of cases) expect(parseExternalToolName(name), JSON.stringify(name)).toBeNull();
    expect(parseExternalToolName(undefined as unknown as string)).toBeNull();
  });
});

describe('serverLabel', () => {
  it('reads as words and is short', () => {
    expect(serverLabel('my_server-name')).toBe('my server name');
    expect(serverLabel('a'.repeat(100)).length).toBeLessThanOrEqual(SERVER_LABEL_MAX);
  });
});
