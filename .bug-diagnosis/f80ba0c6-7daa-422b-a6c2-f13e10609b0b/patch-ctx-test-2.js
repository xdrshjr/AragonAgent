// One-shot patcher #2 for context-command.test.ts (LF regions). Fails loudly. Delete after use.
const fs = require('fs');
const path = 'packages/cli/src/__tests__/context-command.test.ts';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`anchor not found: ${label}`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor not unique: ${label}`);
  text = text.slice(0, first) + replacement + text.slice(first + anchor.length);
  console.log(`patched: ${label}`);
}

replaceOnce(
  "    expect(text).toContain('1000000   from contextWindow configuration (overrides API and model table)');",
  "    expect(text)\n      .toContain('1000000   from contextWindow configuration (overrides API, model table, and model-windows.json)');",
  'override assertion',
);

const anchor = "  it('a per-model user file, named as such (model-windows.json)', () => {";
const extra = [
  "  it('an unnamed source is admitted as unverified, not claimed for the table', () => {",
  '    const text = formatContextReport(ctx({ usage: { windowSource: undefined } }));',
  "    expect(text).toContain('200000   source unverified');",
  '  });',
  '',
].join('\n');
replaceOnce(anchor, extra + anchor, 'unverified-source case');

fs.writeFileSync(path, text, 'utf8');
console.log('context-command.test.ts patched OK');
