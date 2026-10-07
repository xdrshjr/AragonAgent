import type { CommandRegistry } from './registry.js';

/** Read-only access to the live receipt-backed queue through the standard overlay port. */
export function registerQueueCommand(registry: CommandRegistry): void {
  registry.register({ name: 'queue', description: '\u67e5\u770b\u5f85\u5904\u7406\u6d88\u606f\u5168\u6587',
    run: (ctx) => { ctx.setOverlay('queue'); } });
}
