/**
 * Interactive-sequence proof: drive a real `aragon exec` child against a local
 * mock OpenAI-compatible endpoint, send two user frames, then end.
 *
 * Asserts the exact contract the phase fix relies on:
 *   1. per user frame: turn_state started ... turn_state completed
 *   2. NO result event between frames (result is run-level only)
 *   3. result arrives once, after the end frame
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(desktop, 'agent-runtime', 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js');

// ---- mock OpenAI-compatible endpoint ----
const server = createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const turns = Number(body.match(/"turn-(\d+)"/)?.[1] ?? 0);
    const reply = `answer-${turns}`;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    const frame = (delta) =>
      res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`);
    frame({ role: 'assistant', content: '' });
    frame({ content: reply });
    frame({});
    res.write('data: [DONE]\n\n');
    // minimal usage so the CLI's accounting stays happy
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const child = spawn(process.execPath, [
  launcher,
  'exec',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-thinking',
  '--partial-messages',
  '--no-save-session',
  '--session-id', 'desktop-seq-test',
], {
  cwd: desktop,
  env: {
    ...process.env,
    ARAGON_HOME: path.join(process.env.TEMP ?? '.', 'aragon-seq-test'),
    ARAGON_PROVIDER: 'openai',
    ARAGON_MODEL: 'mock-model',
    ARAGON_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENAI_API_KEY: 'mock-key',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const events = [];
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  try {
    const event = JSON.parse(line.trim());
    events.push(event);
    console.log('[evt]', event.type, event.subtype ?? event.phase ?? '', event.turn !== undefined ? `turn=${event.turn}` : '');
  } catch {
    console.log('[non-json]', line.slice(0, 80));
  }
});
const rlErr = createInterface({ input: child.stderr });
rlErr.on('line', (line) => console.log('[stderr]', line.slice(0, 140)));

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);

await new Promise((resolve) => setTimeout(resolve, 1200));
console.log('--- sending user frame 1 ---');
send({ type: 'user', text: 'go turn-1' });
await new Promise((resolve) => setTimeout(resolve, 2500));
const sawResultEarly = events.some((event) => event.type === 'result');
console.log('result before frame 2?', sawResultEarly ? 'YES (unexpected)' : 'no (as designed)');

console.log('--- sending user frame 2 ---');
send({ type: 'user', text: 'go turn-2' });
await new Promise((resolve) => setTimeout(resolve, 2500));
const results = events.filter((event) => event.type === 'result');
console.log('result count before end:', results.length);

console.log('--- sending end ---');
send({ type: 'end' });
await new Promise((resolve) => setTimeout(resolve, 1500));

const started = events.filter((event) => event.type === 'turn_state' && event.phase === 'started').length;
const completed = events.filter((event) => event.type === 'turn_state' && event.phase === 'completed').length;
const finalResults = events.filter((event) => event.type === 'result');
const assistants = events.filter((event) => event.type === 'assistant');

console.log('--- summary ---');
console.log('turn_state started:', started, 'completed:', completed);
console.log('assistant messages:', assistants.length, assistants.map((event) => JSON.stringify(event.text)));
console.log('result events (total, incl. after end):', finalResults.length);

const pass =
  started === 2 &&
  completed === 2 &&
  !sawResultEarly &&
  results.length === 0 &&
  finalResults.length === 1 &&
  assistants.length === 2;

server.close();
child.kill();
console.log(pass ? 'SEQUENCE PROOF: PASS' : 'SEQUENCE PROOF: FAIL');
process.exit(pass ? 0 : 1);
