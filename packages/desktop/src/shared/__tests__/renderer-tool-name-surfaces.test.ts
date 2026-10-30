/**
 * Source scan (AC-T9): a raw tool identifier may only reach the screen from a place that has been
 * looked at and justified. New code that reads `entry.name`, `entry.label`, `.toolName` or
 * `.lastTool` fails here until someone decides which voice it speaks and lists it below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs in the node project (it only reads files); the renderer's own jsdom setup is not needed.
const ROOT = join(__dirname, '..', '..', 'renderer');
// Settings screens list model profiles and kits, which have `entry.name` too: not tools.
const NOT_TOOLS = /^(?:settings\/|ui\/|lib\/settings-)/;
const PATTERN = /\.lastTool\b|\.toolName\b|\bentry\.label\b|\b(?:entry|lead)\.name\b/;

/** file -> why a raw identifier is allowed there. Keep the reasons honest. */
const ALLOWED: Record<string, string> = {
  'chat/tools/ToolCard.tsx': 'developer voice renders entry.label/name by design; friendly goes through voiceTitle/voicePhrase',
  'chat/ActivityRow.tsx': 'passes entry.name to the voice tables only; friendly text is what is rendered',
  'lib/chat-export.ts': 'an export is a record: it keeps the original identifiers so it can be searched and reproduced',
  'lib/chat-format.ts': 'toolFamily() classifies by name; nothing is displayed',
  'lib/chat-tool-groups.ts': 'classifies finished read-only calls by name via toolFamily() to decide what folds; the group header shows counts, never a name',
  'lib/chat-find.ts': 'find matches against the name so a developer can search for it; it displays the matched row, not the name',
  'lib/panels-changes.ts': 'classifies write tools by name to list changed files; nothing is displayed',
};

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue;
      yield* sources(path);
    } else if (/\.tsx?$/.test(name)) yield path;
  }
}

describe('raw tool identifiers on screen', () => {
  const found = [...sources(ROOT)].map((path) => ({
    rel: relative(ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('scans a believable number of files (a scanner that sees half a tree proves nothing)', () => {
    expect(found.length).toBeGreaterThan(60);
  });

  it('only allow-listed files reference an identifier-bearing field', () => {
    const offenders = found.filter(({ rel, text }) => !NOT_TOOLS.test(rel) && PATTERN.test(text) && !(rel in ALLOWED)).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('every allow-list entry still exists (stale entries hide future drift)', () => {
    for (const rel of Object.keys(ALLOWED)) expect(found.some((entry) => entry.rel === rel), rel).toBe(true);
  });
});
