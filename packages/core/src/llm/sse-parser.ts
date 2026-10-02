import type { SSEEvent } from './stream-utils.js';

export const SSE_FRAME_LIMIT = 1_048_576;

/** A single SSE frame exceeded its UTF-16 capacity; retrying cannot repair it. */
export class SseFrameLimitError extends Error {
  constructor() {
    super(`SSE frame exceeds ${SSE_FRAME_LIMIT} UTF-16 code units`);
    this.name = 'SseFrameLimitError';
  }
}

/** Incremental model-stream parser; IDs are local to each event, not reconnect state. */
export class SseParser {
  private line = '';
  private dataLines: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private frameUnits = 0;
  private skipNextLf = false;
  private atStart = true;

  /** Consume decoded text lazily, throwing SseFrameLimitError on an oversized frame. */
  *push(text: string): IterableIterator<SSEEvent> {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (this.atStart) {
        this.atStart = false;
        if (char === '\uFEFF') continue;
      }
      if (this.skipNextLf) {
        this.skipNextLf = false;
        if (char === '\n') {
          // A blank CR already dispatched/reset the frame. Its optional LF
          // belongs to that delimiter, never to the next frame's budget.
          if (this.frameUnits > 0) this.countUnit();
          continue;
        }
      }
      this.countUnit();
      if (char !== '\r' && char !== '\n') {
        this.line += char;
        continue;
      }
      this.skipNextLf = char === '\r';
      const event = this.finishLine();
      if (event) yield event;
    }
  }

  /** Preserve the model adapters' complete-last-line compatibility at normal EOF. */
  *finish(): IterableIterator<SSEEvent> {
    if (this.line.length > 0) this.finishLine();
    const event = this.dispatch();
    if (event) yield event;
  }

  /** Discard uncommitted input without dispatching it, including on cancellation. */
  clear(): void {
    this.line = '';
    this.dataLines = [];
    this.event = undefined;
    this.id = undefined;
    this.frameUnits = 0;
  }

  private countUnit(): void {
    this.frameUnits++;
    if (this.frameUnits <= SSE_FRAME_LIMIT) return;
    this.clear();
    throw new SseFrameLimitError();
  }

  private finishLine(): SSEEvent | undefined {
    const line = this.line;
    this.line = '';
    if (line.length === 0) return this.dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data': this.dataLines.push(value); break;
      case 'event': this.event = value; break;
      case 'id': if (!value.includes('\0')) this.id = value; break;
    }
  }

  private dispatch(): SSEEvent | undefined {
    const event = this.dataLines.length > 0 || this.event !== undefined
      ? { event: this.event, data: this.dataLines.join('\n'), id: this.id }
      : undefined;
    this.clear();
    return event;
  }
}
