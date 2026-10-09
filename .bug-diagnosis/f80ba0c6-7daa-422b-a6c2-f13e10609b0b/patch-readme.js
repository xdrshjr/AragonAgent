// One-shot patcher for packages/cli/README.md (CRLF). Fails loudly. Delete after use.
const fs = require('fs');
const path = 'packages/cli/README.md';
let text = fs.readFileSync(path, 'utf8');
const CRLF = '\r\n';

function replaceOnce(anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`anchor not found: ${label}`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor not unique: ${label}`);
  text = text.slice(0, first) + replacement + text.slice(first + anchor.length);
  console.log(`patched: ${label}`);
}

replaceOnce(
  'came from — the model API, the model table, your own `contextWindow`, or the invented' + CRLF +
    'placeholder — because those are indistinguishable everywhere else.',
  'came from — the model API, the model table, your own `contextWindow`, a' + CRLF +
    '`model-windows.json` entry, or the invented' + CRLF +
    'placeholder — because those are indistinguishable everywhere else.',
  '/context Window line',
);

replaceOnce(
  'Window resolution uses your explicit override first, then API metadata from the' + CRLF +
    'configured endpoint, then the built-in catalog',
  'Window resolution uses your explicit override first, then per-model declarations' + CRLF +
    'in `model-windows.json`, then API metadata from the configured endpoint, then the' + CRLF +
    'built-in catalog',
  'resolution order sentence',
);

replaceOnce(
  'Values are clamped to `[8000, 5000000]`; `auto` (the default) is stored as' + CRLF +
    '`null`. Setting it removes the `?` marker, because you have asserted the number —' + CRLF +
    'and `/context` still shows that it came from you, which is what makes a wrong' + CRLF +
    'value findable.',
  'Values are clamped to `[8000, 5000000]`; `auto` (the default) is stored as' + CRLF +
    '`null`. Setting it removes the `?` marker, because you have asserted the number —' + CRLF +
    'and `/context` still shows that it came from you, which is what makes a wrong' + CRLF +
    'value findable.' + CRLF +
    '' + CRLF +
    '#### `model-windows.json` — one window per model' + CRLF +
    '' + CRLF +
    '`contextWindow` describes ONE model: the active one. To pin several at once — a' + CRLF +
    'main model plus a fast tier plus a gateway alias — declare them by id in' + CRLF +
    '`~/.aragon-agent/model-windows.json`:' + CRLF +
    '' + CRLF +
    '```json' + CRLF +
    '{' + CRLF +
    '  "version": 1,' + CRLF +
    '  "windows": {' + CRLF +
    '    "kimi-k3": 1048576,' + CRLF +
    '    "glm-5.3": 1048576,' + CRLF +
    '    "glm-5.3-flash": 1048576' + CRLF +
    '  }' + CRLF +
    '}' + CRLF +
    '```' + CRLF +
    '' + CRLF +
    'A bare map without the wrapper works too. Keys are matched case-insensitively' + CRLF +
    'after stripping a `models/`-style prefix and a dated snapshot suffix, so' + CRLF +
    '`Kimi-K3-20260716` still resolves. Entries must be whole tokens between 1024 and' + CRLF +
    '1e9; at most 512 are kept. The file is read live (mtime-cached), never written' + CRLF +
    'by the CLI, and outranks API discovery and the catalog while still losing to the' + CRLF +
    'active model\'s `contextWindow` override. `/context` reports these windows as' + CRLF +
    '`from model-windows.json`, and a file that cannot be parsed is ignored with one' + CRLF +
    'log line rather than trusted. UTF-8 (with or without BOM) and UTF-16 saves are' + CRLF +
    'both accepted.',
  'model-windows.json subsection',
);

replaceOnce(
  '├── config.json.bak                 written by `aragon config edit` before it opens' + CRLF +
    '├── prompt-history.jsonl',
  '├── config.json.bak                 written by `aragon config edit` before it opens' + CRLF +
    '├── model-windows.json              per-model context windows you declare by hand;' + CRLF +
    '│                                   read live, never written by the CLI' + CRLF +
    '├── prompt-history.jsonl',
  'files tree',
);

fs.writeFileSync(path, text, 'utf8');
console.log('cli README patched OK');
