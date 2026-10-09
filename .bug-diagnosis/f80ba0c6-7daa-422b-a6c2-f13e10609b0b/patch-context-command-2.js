// One-shot patcher #2 for context-command.ts (CRLF). Fails loudly. Delete after use.
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
  'from contextWindow configuration (overrides API and model table)',
  'from contextWindow configuration (overrides API, model table, and model-windows.json)',
  'override parenthetical',
);

replaceOnce(
  "  return `${usage.window}   from ${usage.windowSource === 'api' ? 'the model API' : 'the model table'}`;",
  "  if (usage.windowSource === undefined) {\n" +
    "    // A child agent can be windowKnown through the pricing-table heuristic\n" +
    "    // without naming a source; claiming 'the model table' there would be an\n" +
    "    // evidence-free assertion in the one report that exists to be checked.\n" +
    "    return `${usage.window}   source unverified`;\n" +
    "  }\n" +
    "  return `${usage.window}   from ${usage.windowSource === 'api' ? 'the model API' : 'the model table'}`;",
  'unverified-source branch',
);

fs.writeFileSync(path, text, 'utf8');
console.log('context-command.ts patched OK');
