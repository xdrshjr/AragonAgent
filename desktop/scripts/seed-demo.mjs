/**
 * Seed a demo userData directory for screenshots: settings with a configured
 * profile plus one session whose journal replays into a realistic transcript
 * (thinking, tool cards, todo plan, markdown answer, result footer).
 *
 * Usage: node scripts/seed-demo.mjs <userDataDir>
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node seed-demo.mjs <userDataDir>');
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const sessionId = 'desktop-demo-0001';
const sessionsDir = path.join(dir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

// Settings: one configured Anthropic profile + an active key (vault: plain
// base64 placeholder - never a real credential).
writeFileSync(
  path.join(dir, 'settings.json'),
  JSON.stringify(
    {
      version: 1,
      activeProfileId: 'profile-default-anthropic',
      defaultCwd: 'E:\\TAKO-PROJECTS\\AragonAgent',
      profiles: [
        {
          id: 'profile-default-anthropic',
          label: 'Claude (default)',
          mode: 'anthropic',
          model: 'claude-sonnet-4-6',
          baseUrl: '',
          thinking: 'off',
        },
      ],
    },
    null,
    2,
  ),
);
writeFileSync(
  path.join(dir, 'keys.json'),
  JSON.stringify(
    {
      version: 1,
      encryption: 'plain',
      entries: { 'profile-default-anthropic': Buffer.from('sk-ant-demo0000').toString('base64') },
    },
    null,
    2,
  ),
);

// Session index (sorted by updatedAt on load; one entry is enough).
writeFileSync(
  path.join(sessionsDir, 'index.json'),
  JSON.stringify(
    [
      {
        id: sessionId,
        title: 'Add a retry guard to the fetch helper',
        createdAt: Date.now() - 42 * 60 * 1000,
        updatedAt: Date.now() - 3 * 60 * 1000,
        cwd: 'E:\\TAKO-PROJECTS\\AragonAgent',
        profileId: 'profile-default-anthropic',
        sessionFile: null,
        contextEpoch: 0,
        usage: { inputTokens: 38410, outputTokens: 6218, totalTokens: 44628 },
        cost: { amount: 0.71, known: true },
        messageCount: 1,
      },
    ],
    null,
    2,
  ),
);

// Journal: the event stream the fold reducer turns into the transcript.
const events = [];
const push = (event) => events.push(JSON.stringify(event));
const s = sessionId;

push({
  type: 'system', subtype: 'init', schemaVersion: 1, sessionId: s, cli: '0.6.13',
  cwd: 'E:\\TAKO-PROJECTS\\AragonAgent', startedAt: Date.now() - 40 * 60 * 1000,
  model: { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: null },
  permissionMode: 'auto',
  tools: ['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep'],
  resumed: false, sessionFile: null,
});
push({ type: 'turn_state', sessionId: s, requestSeq: 1, phase: 'started' });
push({ type: 'user', sessionId: s, turn: 1, text: 'Add a retry guard to the fetch helper and cover it with a test.', source: 'caller' });

push({
  type: 'thinking', sessionId: s, turn: 1,
  text: 'The fetch helper lives in packages/core/src/llm/stream-utils.ts. I will read it, add an exponential backoff wrapper keyed off the existing retry policy, then add a Vitest case with a stubbed fetch. The helper is used by three call sites, so the guard should be opt-in to avoid changing behavior for callers that already retry.',
});

push({ type: 'tool_call', sessionId: s, turn: 1, id: 't1', name: 'read_file', input: { path: 'packages/core/src/llm/stream-utils.ts' } });
push({
  type: 'tool_result', sessionId: s, turn: 1, id: 't1', name: 'read_file', isError: false, durationMs: 420,
  output: '  1  /** Streaming helpers shared by all three provider adapters. */\n  2  export async function consumeStream<T>(iter, onEvent) {\n  3    for await (const event of iter) onEvent(event);\n  4  }\n  5  \n  6  export function withTimeout(promise, ms) {\n  7    return Promise.race([promise, rejectAfter(ms)]);\n  8  }',
});
push({ type: 'tool_call', sessionId: s, turn: 1, id: 't2', name: 'edit_file', input: { path: 'packages/core/src/llm/stream-utils.ts' } });
push({ type: 'tool_result', sessionId: s, turn: 1, id: 't2', name: 'edit_file', isError: false, durationMs: 310, output: 'Applied edit to packages/core/src/llm/stream-utils.ts (+26 lines)' });
push({ type: 'tool_call', sessionId: s, turn: 1, id: 't3', name: 'bash', input: { command: 'npm test -w packages/core -- stream-utils' } });
push({
  type: 'tool_result', sessionId: s, turn: 1, id: 't3', name: 'bash', isError: false, durationMs: 8640,
  output: 'RUN  v4.1.0 E:/TAKO-PROJECTS/AragonAgent/packages/core\n\n \u2713 tests/stream-utils.test.ts (4 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)',
});

push({
  type: 'todo', sessionId: s, total: 3, done: 3, activeIndex: -1,
  items: [
    { content: 'Read the existing fetch helper', status: 'completed' },
    { content: 'Add retry guard with exponential backoff', status: 'completed' },
    { content: 'Cover with Vitest and run the suite', status: 'completed' },
  ],
});

const answer = [
  'Done - the fetch helper now has an opt-in retry guard.',
  '',
  '**What changed**',
  '',
  '- `withRetries(fn, opts)` wraps any promise factory with exponential backoff and honors `AbortSignal` cancellation',
  '- Callers opt in explicitly, so the three existing call sites keep their current behavior',
  '- The backoff ceiling and attempt count come from the existing `DEFAULT_RETRY_POLICY` table',
  '',
  '```ts',
  'export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {',
  '  const policy = { ...DEFAULT_RETRY_POLICY, ...opts };',
  '  for (let attempt = 1; ; attempt++) {',
  '    try {',
  '      return await fn();',
  '    } catch (error) {',
  '      if (!isRetryableError(error) || attempt >= policy.maxRetries) throw error;',
  '      await sleep(computeBackoffDelay(attempt, policy), opts.signal);',
  '    }',
  '  }',
  '}',
  '```',
  '',
  'All 4 tests pass, including the new cancellation case.',
].join('\n');

for (const chunk of answer.match(/[\s\S]{1,90}/g) ?? []) {
  push({ type: 'text_delta', sessionId: s, turn: 1, delta: chunk });
}
push({ type: 'assistant', sessionId: s, turn: 1, text: answer });
push({ type: 'turn_state', sessionId: s, requestSeq: 1, phase: 'completed' });

mkdirSync(path.join(sessionsDir, sessionId), { recursive: true });
writeFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), events.join('\n') + '\n');

console.log(`seeded demo userData at ${dir}`);
