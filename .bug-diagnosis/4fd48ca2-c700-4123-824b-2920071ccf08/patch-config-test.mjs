// One-shot patch: config.test.ts leaked provider-key env vars into the worker.
// Replaces the three direct assignments with vi.stubEnv (restored by the
// file's afterEach(vi.unstubAllEnvs())), preserving each line's own ending.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'packages/cli/src/__tests__/config.test.ts';
let text = readFileSync(path, 'utf8');

const anth = /process\.env\.ANTHROPIC_API_KEY = 'env-key';/g;
const open = /process\.env\.OPENAI_API_KEY = 'env-openai';/g;
const anthCount = (text.match(anth) ?? []).length;
const openCount = (text.match(open) ?? []).length;
if (anthCount !== 2 || openCount !== 1) {
  console.error(`unexpected match counts: anthropic=${anthCount} openai=${openCount}`);
  process.exit(1);
}

text = text.replace(anth, "vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');");
text = text.replace(open, "vi.stubEnv('OPENAI_API_KEY', 'env-openai');");

// Insert the why-comment above the FIRST stubbed anthropic line, matching that
// line's own ending (the file mixes CRLF and LF lines).
const marker = "vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');";
const idx = text.indexOf(marker);
const lineStart = text.lastIndexOf('\n', idx) + 1;
const eol = text.slice(idx + marker.length).startsWith('\r\n') ? '\r\n' : '\n';
const indent = '      ';
const comment =
  [
    `${indent}// vi.stubEnv, NEVER a direct assignment: afterEach un-stubs these, while`,
    `${indent}// \`process.env.X = ...\` leaks into the worker process for every test file`,
    `${indent}// scheduled after this one. exec-diagnostics.test.ts resolves keys through`,
    `${indent}// the same env layer, and a leaked key turns its "no key resolvable"`,
    `${indent}// premise into an order-dependent release failure.`,
  ].join(eol) + eol;

text = text.slice(0, lineStart) + comment + text.slice(lineStart);
writeFileSync(path, text);
console.log('patched:', path);
