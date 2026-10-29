import type { HostRequest } from '../../shared/port-protocol.js';
import type { PendingRequest } from '../store/session-store.js';

/** A pending request narrowed to one kind. */
export type RequestOf<K extends HostRequest['k']> = PendingRequest & { req: Extract<HostRequest, { k: K }> };

export function isRequestOf<K extends HostRequest['k']>(request: PendingRequest, kind: K): request is RequestOf<K> {
  return request.req.k === kind;
}
