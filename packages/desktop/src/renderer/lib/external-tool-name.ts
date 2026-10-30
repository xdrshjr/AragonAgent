/**
 * Which tools come from outside the app, and from whom.
 *
 * A tool served by another program (an MCP server) arrives named by that program, so it reads like
 * a built-in unless something says otherwise. This recognises the naming conventions we have
 * EVIDENCE for and nothing else: a pattern is added together with a test vector and the place it
 * was seen. Anything unrecognised returns `null` and is shown exactly as before (humanised), so
 * a wrong guess cannot rename a tool, only a missing one can fail to label it.
 *
 * Display only. It changes no permission, approval or execution path.
 */

import { sanitizeActivity } from '@aragon-agent/tui/model/team/activity';

export interface ExternalToolName {
  server: string;
  tool: string;
}

interface Convention {
  /** Where this spelling was observed, so the table cannot fill up with guesses. */
  evidence: string;
  pattern: RegExp;
}

/** Longest name of a server shown in the label. */
export const SERVER_LABEL_MAX = 24;

const CONVENTIONS: readonly Convention[] = [
  {
    evidence: 'mcp__<server>__<tool> as in tui run-status-row.test.ts (mcp__playwright__browser_navigate)',
    // The server may not contain `__` itself: the FIRST double underscore after the prefix ends it.
    pattern: /^mcp__((?:(?!__)[A-Za-z0-9_-]){1,64})__(.{1,128})$/,
  },
];

const hasControl = (text: string): boolean => {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

export function parseExternalToolName(name: string): ExternalToolName | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256 || hasControl(name)) return null;
  for (const { pattern } of CONVENTIONS) {
    const hit = pattern.exec(name);
    if (hit) return { server: hit[1]!, tool: hit[2]! };
  }
  return null;
}

/** The server as shown: cleaned like any other model-supplied string, and short. */
export function serverLabel(server: string): string {
  return sanitizeActivity(server.replace(/[_-]+/g, ' '), SERVER_LABEL_MAX);
}
