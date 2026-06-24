/**
 * MessageManager — manages the conversation message history for an Agent.
 *
 * Provides append, read, clear, and restore operations over a mutable
 * message array.  The `getAll()` method returns a readonly view so
 * consumers cannot accidentally mutate the internal state.
 */

import type { Message } from '../llm/types.js';

export class MessageManager {
  private messages: Message[] = [];

  /** Append a message to the history. */
  push(message: Message): void {
    this.messages.push(message);
  }

  /** Return a readonly snapshot of all messages. */
  getAll(): readonly Message[] {
    return this.messages;
  }

  /** Remove all messages from the history. */
  clear(): void {
    this.messages = [];
  }

  /**
   * Replace the entire message history with an externally provided array.
   * Used when restoring a conversation from persistent storage.
   */
  restore(messages: Message[]): void {
    this.messages = [...messages];
  }

  /** Return the last `n` messages (or fewer if history is shorter). */
  getLast(n: number): Message[] {
    if (n <= 0) return [];
    return this.messages.slice(-n);
  }

  /** The number of messages currently in the history. */
  get length(): number {
    return this.messages.length;
  }
}
