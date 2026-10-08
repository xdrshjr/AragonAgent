/** Live diagnostic: print each exec event as it arrives, 35s budget. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

const launcher = path.join('agent-runtime', 'node_modules', '@aragon-agent', 'cli', 'dist', 'launcher.js');
const child = spawn(process.execPath, [
  launcher, 'exec',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--no-save-session',
  '--max-turns', '1',
  '--session-id', 'desktop-smoke-diag',
  'Reply with exactly: OK',
], {
  cwd: '.',
  env: {
    ...process.env,
    ARAGON_HOME: path.join(process.env.TEMP ?? '.', 'aragon-desktop-smoke'),
    ARAGON_PROVIDER: 'anthropic',
    ARAGON_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_API_KEY: 'sk-ant-invalid-smoke-test',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

console.log('spawned pid', child.pid);
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  try {
    const event = JSON.parse(line.trim());
    console.log(`[evt ${Date.now() % 100000}]`, event.type + (event.subtype ? ':' + event.subtype : ''),
      event.type === 'error' ? event.code + ' ' + event.message.slice(0, 100) : '',
      event.type === 'retry' ? `attempt ${event.attempt}/${event.maxRetries} delay ${event.delayMs}ms ${event.errorType}` : '',
      event.type === 'result' ? `isError=${event.isError} stop=${event.stopReason} err=${event.error?.code ?? 'none'}` : '');
  } catch {
    console.log('[non-json stdout]', line.slice(0, 100));
  }
});
const rlErr = createInterface({ input: child.stderr });
rlErr.on('line', (line) => console.log('[stderr]', line.slice(0, 160)));
child.on('exit', (code) => {
  console.log('exit', code);
  process.exit(0);
});

setTimeout(() => {
  console.log('--- 35s budget reached, killing ---');
  child.kill();
  setTimeout(() => process.exit(2), 1000);
}, 35000);
