/**
 * CodeAct Sandbox — Console Capture
 *
 * Captures console.log/warn/error/info calls from inside the isolated-vm
 * sandbox and buffers them on the host side. Uses synchronous ivm.Reference
 * callbacks (applySync) so console calls behave naturally in sandbox code.
 */

import ivm from 'isolated-vm';
import type { ConsoleEntry } from './types.js';

/** Maximum number of console entries to buffer before discarding oldest. */
const MAX_BUFFER_SIZE = 1000;

/**
 * ConsoleCapture intercepts console method calls inside an isolated-vm
 * Context and stores them as ConsoleEntry records on the host.
 */
export class ConsoleCapture {
  private entries: ConsoleEntry[] = [];

  /**
   * Inject console overrides into the given isolated-vm context.
   *
   * Replaces globalThis.console with an object whose log/warn/error/info
   * methods forward arguments (stringified) to the host via a synchronous
   * ivm.Reference callback.
   */
  async inject(context: ivm.Context): Promise<void> {
    const captureRef = new ivm.Reference(
      (level: string, message: string) => {
        const entry: ConsoleEntry = {
          level: level as ConsoleEntry['level'],
          args: [message],
          timestamp: Date.now(),
        };

        if (this.entries.length >= MAX_BUFFER_SIZE) {
          // Discard the oldest entry to stay within the buffer limit.
          this.entries.shift();
        }
        this.entries.push(entry);
      },
    );

    await context.evalClosure(
      `
      const _capture = $0;
      globalThis.console = {
        log:   (...args) => _capture.applySync(undefined, ['log',   args.map(String).join(' ')]),
        warn:  (...args) => _capture.applySync(undefined, ['warn',  args.map(String).join(' ')]),
        error: (...args) => _capture.applySync(undefined, ['error', args.map(String).join(' ')]),
        info:  (...args) => _capture.applySync(undefined, ['info',  args.map(String).join(' ')]),
      };
      `,
      [captureRef],
      { arguments: { reference: true } },
    );
  }

  /**
   * Return all captured console entries and clear the internal buffer.
   * Typically called after each execute() to collect output.
   */
  drain(): ConsoleEntry[] {
    const result = this.entries;
    this.entries = [];
    return result;
  }
}
