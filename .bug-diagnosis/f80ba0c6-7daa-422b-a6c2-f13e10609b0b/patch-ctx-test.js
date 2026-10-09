// One-shot patcher for context-command.test.ts. Fails loudly. Delete after use.
const fs = require('fs');
const path = 'packages/cli/src/__tests__/context-command.test.ts';
let text = fs.readFileSync(path, 'utf8');

const anchor = "    expect(text).toContain('set contextWindow to correct it');";
if (text.split(anchor).length - 1 !== 1) throw new Error('anchor not unique');
const replacement = [
  "      expect(text)",
  "        .toContain('set contextWindow or list the model in model-windows.json to correct it');",
  '  });',
  '',
  "  it('a per-model user file, named as such (model-windows.json)', () => {",
  '    const text = formatContextReport(',
  "      ctx({ usage: { window: 1_048_576, windowSource: 'user' } }),",
  '    );',
  "    expect(text).toContain('1048576   from model-windows.json (your per-model table)');",
].join('\n');

text = text.replace(anchor, replacement);
fs.writeFileSync(path, text, 'utf8');
console.log('context-command.test.ts patched');
