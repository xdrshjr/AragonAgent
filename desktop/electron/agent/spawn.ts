/**
 * One supervised `aragon exec` child: spawn, NDJSON event parsing, frame writes,
 * and exit handling.
 *
 * The child runs the bundled CLI under Electron's own binary via
 * `ELECTRON_RUN_AS_NODE=1`, so the packaged app needs no system Node install.
 *
 * Output contract: stream-json mode writes exactly one JSON object per stdout
 * line; malformed lines are skipped, never fatal (the child also prints the
 * occasional banner to stderr, which is captured separately).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isExecEvent, type ExecEvent, type ExecInputFrame } from '../../shared/exec-events.js';

export interface ExecSpawnOptions {
  /** Absolute path of the CLI launcher (dist/launcher.js). */
  launcherPath: string;
  /** `exec` subcommand flags, e.g. ['exec', '--output-format', 'stream-json', ...]. */
  args: string[];
  cwd: string;
  /** Environment variables to layer over this process's env (ELECTRON_RUN_AS_NODE is added here). */
  envOverrides: Record<string, string>;
  /** Electron binary (process.execPath in main). */
  execPath: string;
  onEvent: (event: ExecEvent) => void;
  onStderrLine: (line: string) => void;
  onExit: (code: number | null) => void;
}

const STDERR_TAIL_LINES = 12;

export class ExecChild {
  private process: ChildProcess | null = null;

  private stderrTail: string[] = [];

  private ended = false;

  /** Resolved when a `result` event arrives - the run has settled and persisted. */
  private settleWaiters: (() => void)[] = [];

  private readonly options: ExecSpawnOptions;

  constructor(options: ExecSpawnOptions) {
    this.options = options;
  }

  start(): void {
    this.process = spawn(
      this.options.execPath,
      [this.options.launcherPath, ...this.options.args],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...this.options.envOverrides },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const child = this.process;
    if (!child.stdout || !child.stderr || !child.stdin) {
      this.options.onExit(null);
      return;
    }
    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isExecEvent(parsed)) {
          // `result` is emitted after the CLI persisted the session, so a
          // graceful close can stop waiting once it arrives.
          if (parsed.type === 'result') {
            const waiters = this.settleWaiters;
            this.settleWaiters = [];
            for (const resolve of waiters) resolve();
          }
          this.options.onEvent(parsed);
        }
      } catch {
        // Not JSON: stream-json mode should not produce this; drop it rather
        // than corrupting the event stream for the renderer.
      }
    });
    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line: string) => {
      if (line.trim().length === 0) return;
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      this.options.onStderrLine(line);
    });
    child.on('error', (error: Error) => {
      this.pushSyntheticError(`Failed to start the agent process: ${error.message}`);
      this.options.onExit(null);
    });
    child.on('exit', (code) => {
      this.options.onExit(code);
    });
  }

  /** Write one input frame. Safe before init: the child's stdin reader queues turns. */
  writeFrame(frame: ExecInputFrame): boolean {
    if (!this.process?.stdin || this.ended) return false;
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  }

  /** Ask the child to settle and exit (graceful close). */
  requestEnd(): void {
    this.writeFrame({ type: 'end' });
  }

  /**
   * Resolves when the child has settled (a `result` event arrived - the CLI
   * persists BEFORE announcing), so a graceful close can finish early instead
   * of waiting out the kill grace on a lingering process.
   */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  /** Hard stop. `requestEnd` is the preferred path; this is the fallback. */
  kill(): void {
    this.process?.kill();
  }

  get stderrRecent(): string[] {
    return [...this.stderrTail];
  }

  private pushSyntheticError(message: string): void {
    this.options.onEvent({
      type: 'error',
      sessionId: '',
      fatal: true,
      code: 'desktop_spawn_error',
      message,
    });
  }
}

/** Standard `exec` flags for an interactive desktop session.
 *
 * `--session-id` (never `--resume`): it has upsert semantics - resume the
 * session file if it exists, create it otherwise - which is exactly what a
 * lazily (re)spawned desktop child needs, and it is how context clears work:
 * a new epoch id means a fresh model context.
 */
export function interactiveExecArgs(sessionId: string): string[] {
  return [
    'exec',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-thinking',
    '--partial-messages',
    '--session-id',
    sessionId,
  ];
}
