/**
 * Context-clear (epoch) proof against the real CLI + a mock provider:
 *
 *   1. run one turn on session id X            (context window 1)
 *   2. respawn with id X-e1 via --session-id   (what clearContext does)
 *      -> init MUST report resumed:false and a sessionFile for X-e1,
 *         proving the model context started fresh
 *   3. send a turn on the new epoch - it answers
 *   4. respawn AGAIN with X-e1 -> init.resumed:true (the epoch persists
 *      across restarts, i.e. history is NOT lost by accident)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(desktop, 'agent-runtime', 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js');
const home = path.join(process.env.TEMP ?? '.', 'aragon-epoch-test');
rmSync(home, { recursive: true, force: true });

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
    const marker = body.match(/epoch-(\d+)/)?.[1] ?? '?';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta) =>
      res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`);
    frame({ role: 'assistant', content: '' });
    frame({ content: `epoch-${marker}-ok` });
    frame({});
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const env = {
  ...process.env,
  ARAGON_HOME: home,
  ARAGON_PROVIDER: 'openai',
  ARAGON_MODEL: 'mock-model',
  ARAGON_BASE_URL: `http://127.0.0.1:${port}/v1`,
  OPENAI_API_KEY: 'mock-key',
};

function runEpoch(sessionId, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      launcher,
      'exec',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--session-id', sessionId,
    ], { cwd: desktop, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line.trim());
        events.push(event);
        // This CLI build can linger after the end frame; the `result` event
        // is the settle signal (persist happened before it) - judge on that.
        if (event.type === 'result') {
          setTimeout(() => {
            child.kill();
            resolve(events);
          }, 200);
        }
      } catch { /* ignore */ }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    setTimeout(() => child.stdin.write(`${JSON.stringify({ type: 'user', text: `hello epoch-${marker}` })}\n`), 900);
    setTimeout(() => child.stdin.write(`${JSON.stringify({ type: 'end' })}\n`), 2600);
    setTimeout(() => {
      child.kill();
      resolve(events);
    }, 12000);
  });
}

console.log('--- epoch 0: original window ---');
const e0 = await runEpoch('desktop-epoch-demo', 0);
const init0 = e0.find((event) => event.type === 'system');
console.log('init resumed:', init0?.resumed, 'sessionId:', init0?.sessionId);

console.log('--- epoch 1: cleared context (id -e1) ---');
const e1 = await runEpoch('desktop-epoch-demo-e1', 1);
const init1 = e1.find((event) => event.type === 'system');
const answer1 = e1.find((event) => event.type === 'assistant');
console.log('init resumed:', init1?.resumed, 'sessionId:', init1?.sessionId);
console.log('assistant:', JSON.stringify(answer1?.text));

const pass =
  init0?.resumed === false &&
  init1?.resumed === false &&
  init1?.sessionId === 'desktop-epoch-demo-e1' &&
  answer1?.text === 'epoch-1-ok';

server.close();
console.log(pass ? 'EPOCH PROOF: PASS' : 'EPOCH PROOF: FAIL');
process.exit(pass ? 0 : 1);
