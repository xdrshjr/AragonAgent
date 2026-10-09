// One-shot patcher for controller.ts (CRLF file; edit_file cannot match it).
// Fails loudly if any anchor is missing. Delete after use.
const fs = require('fs');
const path = 'packages/cli/src/agent/controller.ts';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`anchor not found: ${label}`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`anchor not unique: ${label}`);
  text = text.slice(0, first) + replacement + text.slice(first + anchor.length);
  console.log(`patched: ${label}`);
}

const CRLF = '\r\n';

replaceOnce(
  "import { updatePersistedConfig } from '../config/store.js';",
  "import { updatePersistedConfig } from '../config/store.js';" + CRLF +
    "import { ModelWindows } from '../config/model-windows.js';",
  'import',
);

replaceOnce(
  '  private readonly modelRegistry: ModelRegistry;',
  '  private readonly modelRegistry: ModelRegistry;' + CRLF +
    '  /** Per-model user-declared context windows; see `config/model-windows.ts`. */' + CRLF +
    '  private readonly modelWindows: ModelWindows;',
  'class field',
);

replaceOnce(
  '    this.modelRegistry = new ModelRegistry(this.providerRegistry);',
  '    this.modelRegistry = new ModelRegistry(this.providerRegistry);' + CRLF +
    '    this.modelWindows = deps.modelWindows ?? new ModelWindows();',
  'constructor init',
);

replaceOnce(
  '    return {\n' +
    '      ...(found ?? this.modelRegistry.buildRuntimeModel(ref.providerId, ref.modelId)),\n' +
    '      ...this.modelRegistry.getContextWindow(ref.providerId, ref.modelId, baseUrl),\n' +
    '    };',
  '    const userWindow = this.modelWindows.lookup(ref.modelId);\n' +
    '    return {\n' +
    '      ...(found ?? this.modelRegistry.buildRuntimeModel(ref.providerId, ref.modelId)),\n' +
    '      ...this.modelRegistry.getContextWindow(ref.providerId, ref.modelId, baseUrl),\n' +
    '      // A USER-DECLARED WINDOW OUTRANKS EVERY TABLE (model-windows.json): the\n' +
    '      // user asserted the number for exactly this id, while api/catalog are\n' +
    '      // what this process managed to look up about it. It still LOSES to\n' +
    "      // config.json's `contextWindow`, which `ContextMeter.resolveWindow`\n" +
    '      // consults before it ever reaches here.\n' +
    '      ...(userWindow !== undefined\n' +
    "        ? { contextWindow: userWindow, contextWindowSource: 'user' as const }\n" +
    '        : {}),\n' +
    '    };',
  'getModelInfoFor override',
);

fs.writeFileSync(path, text, 'utf8');
console.log('controller.ts patched OK');
