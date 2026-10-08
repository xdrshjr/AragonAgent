/** Quick diagnostic for the --no-save-session interactive hang. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(desktop, 'agent-runtime', 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js');

const server = createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('[mock] request received, url:', req.url);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta) =>
      res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`);
    frame({ role: 'assistant', content: '' });
    frame({ content: 'diag-ok' });
    frame({});
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log('mock on', port);

const args = process.argv.includes('--save')
  ? ['--session-id', 'desktop-diag-save']
  : ['--no-save-session', '--session-id', 'desktop-diag-nosave'];

const child = spawn(process.execPath, [
  launcher, 'exec',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  ...args,
], {
  cwd: desktop,
  env: {
    ...process.env,
    ARAGON_HOME: path.join(process.env.TEMP ?? '.', 'aragon-diag'),
    ARAGON_PROVIDER: 'openai',
    ARAGON_MODEL: 'mock-model',
    ARAGON_BASE_URL: `http://127.0.0.1:${port}/v1`,
    OPENAI_API_KEY: 'mock-key',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  try {
    const event = JSON.parse(line.trim());
    console.log('[evt]', event.type, event.subtype ?? event.phase ?? '', event.text ? String(event.text).slice(0, 30) : '');
  } catch { console.log('[raw]', line.slice(0, 80)); }
});
const rle = createInterface({ input: child.stderr });
rle.on('line', (line) => console.log('[stderr]', line.slice(0, 160)));
child.on('exit', (code) => { console.log('exit', code); process.exit(0); });

setTimeout(() => { console.log('--- send user ---'); child.stdin.write(`${JSON.stringify({ type: 'user', text: 'hi' })}\n`); }, 900);
setTimeout(() => { console.log('--- send end ---'); child.stdin.write(`${JSON.stringify({ type: 'end' })}\n`); }, 2400);
setTimeout(() => { console.log('--- TIMEOUT 15s, killing ---'); child.kill(); setTimeout(() => process.exit(2), 800); }, 15000);
