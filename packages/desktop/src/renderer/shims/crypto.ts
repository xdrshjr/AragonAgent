/** `node:crypto` for the renderer: only `randomUUID` is used by the view model. */
export const randomUUID = (): string => globalThis.crypto.randomUUID();
export default { randomUUID };
