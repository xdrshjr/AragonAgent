import type { AgentLoopContext } from './agent-loop.js';

/** Accept one batch atomically with respect to async work and receipt listeners. */
export function acceptSteering(ctx: AgentLoopContext): void {
  if (ctx.signal.aborted) return;

  const items = ctx.messageQueueManager.drainSteeringItems();
  const ids: string[] = [];
  for (const item of items) {
    ctx.messageManager.push({ role: 'user', content: item.text, timestamp: Date.now() });
    if (item.id !== undefined) ids.push(item.id);
  }
  // The entire batch must be in history before listeners can abort or enqueue more work.
  if (ids.length > 0) ctx.emit({ type: 'steering_accepted', ids });
}
