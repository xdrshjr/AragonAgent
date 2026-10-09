// One-shot patcher for context-command.ts (CRLF file). Fails loudly. Delete after use.
const fs = require('fs');
const path = 'packages/cli/src/compaction/context-command.ts';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`anchor not found: ${label}`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor not unique: ${label}`);
  text = text.slice(0, first) + replacement + text.slice(first + anchor.length);
  console.log(`patched: ${label}`);
}

replaceOnce(
  " * Where the denominator came from. THREE SOURCES, ALL NAMED.",
  " * Where the denominator came from. FOUR SOURCES, ALL NAMED - the fourth\n" +
    " * being the user's own model-windows.json, which exists precisely because\n" +
    " * the other three cannot know a gateway alias released last week.",
  'windowLine doc',
);

replaceOnce(
  "      'set contextWindow to correct it'",
  "      'set contextWindow or list the model in model-windows.json to correct it'",
  'unknown hint',
);

replaceOnce(
  "  return `${usage.window}   from ${usage.windowSource === 'api' ? 'the model API' : 'the model table'}`;",
  "  if (usage.windowSource === 'user') {\n" +
    "    return `${usage.window}   from model-windows.json (your per-model table)`;\n" +
    "  }\n" +
    "  return `${usage.window}   from ${usage.windowSource === 'api' ? 'the model API' : 'the model table'}`;",
  'user branch',
);

fs.writeFileSync(path, text, 'utf8');
console.log('context-command.ts patched OK');
