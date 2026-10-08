/** Small pure helpers shared across main-process and renderer modules. */

function uuid(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID();
  // Fallback: timestamp + counter + Math.random. Only used where WebCrypto is absent.
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Session ids the desktop owns are namespaced so `aragon sessions` can tell them apart. */
export function newDesktopSessionId(): string {
  return `desktop-${uuid()}`;
}

export function newProfileId(): string {
  return `profile-${uuid().slice(0, 8)}`;
}

/** First N chars of a message, whitespace-collapsed, for an auto session title. */
export function titleFromMessage(text: string, max = 48): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 3).trimEnd()}...`;
}

/** Mask a credential for display: keep 2 head chars and 4 tail chars. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 2)}...${key.slice(-4)}`;
}

/** Stable string hash (FNV-1a) for comparing env snapshots cheaply. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
