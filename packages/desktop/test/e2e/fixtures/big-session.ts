/**
 * A saved session with many transcript entries, in the exact shape the app itself writes
 * (captured from a real run: `version, savedAt, model, messages, entries, todos, meta`).
 * `live: false` and `origin: 'tui'` make it an ordinary saved terminal session the desktop lists.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeBigSession(
  home: string, id: string, entryCount: number, cwd: string = home, needle?: { index: number; text: string },
): string {
  const entries = Array.from({ length: entryCount }, (_unused, index) => (index % 2 === 0
    ? { id: `e${index + 1}`, kind: 'user', text: needle?.index === index ? needle.text : `question number ${index / 2 + 1}` }
    : { id: `e${index + 1}`, kind: 'assistant', text: `answer number ${(index - 1) / 2 + 1}, with a little more text so that some of these wrap onto a second line`, thinkingOpen: false, streaming: false }));
  const now = Date.now();
  const path = join(home, 'sessions', `${id}.json`);
  writeFileSync(path, JSON.stringify({
    version: 1, savedAt: now,
    model: { providerId: 'openai', modelId: 'mock-1' },
    messages: [], entries, todos: [],
    meta: { id, cwd, createdAt: now, updatedAt: now, turns: entryCount / 2, cli: '0.0.0', provider: 'openai', model: 'mock-1', usage: { inputTokens: 0, outputTokens: 0 }, origin: 'tui', live: false },
  }));
  return path;
}
