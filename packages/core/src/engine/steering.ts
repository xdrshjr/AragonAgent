/**
 * MessageQueueManager — manages steering and follow-up message queues.
 *
 * Steering messages have high priority: they interrupt the current tool
 * execution batch and are injected before the next LLM turn.
 *
 * Follow-up messages have low priority: they are consumed only when the
 * Agent loop would otherwise exit (end_turn with no pending work).
 */

/** Queued text with an optional host-supplied opaque receipt identifier. */
export interface SteeringMessage {
  readonly text: string;
  readonly id?: string;
}

export class MessageQueueManager {
  private readonly steeringQueue: SteeringMessage[] = [];
  private readonly followUpQueue: string[] = [];

  // -----------------------------------------------------------------------
  // Steering
  // -----------------------------------------------------------------------

  /** Enqueue a high-priority steering message. */
  pushSteering(message: string, id?: string): void {
    this.steeringQueue.push({ text: message, ...(id !== undefined ? { id } : {}) });
  }

  /** Drain and return all pending steering messages (empties the queue). */
  drainSteering(): string[] {
    return this.drainSteeringItems().map((item) => item.text);
  }

  /** Drain all pending envelopes in FIFO order (empties the same queue). */
  drainSteeringItems(): SteeringMessage[] {
    return this.steeringQueue.splice(0);
  }

  /** Whether there are pending steering messages. */
  hasSteering(): boolean {
    return this.steeringQueue.length > 0;
  }

  // -----------------------------------------------------------------------
  // Follow-up
  // -----------------------------------------------------------------------

  /** Enqueue a low-priority follow-up message. */
  pushFollowUp(message: string): void {
    this.followUpQueue.push(message);
  }

  /** Drain and return all pending follow-up messages (empties the queue). */
  drainFollowUp(): string[] {
    return this.followUpQueue.splice(0);
  }

  /** Whether there are pending follow-up messages. */
  hasFollowUp(): boolean {
    return this.followUpQueue.length > 0;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Clear both queues. */
  clearAll(): void {
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
  }
}
