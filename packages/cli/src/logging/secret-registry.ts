/**
 * The live set of secret literals the redactor must never let reach disk.
 *
 * WHY A REGISTRY AND NOT A SNAPSHOT (aragon-home-config-and-logging P0-3):
 *
 * The format regexes in `redact.ts` catch the three vendors we know about. This
 * registry is the backstop for everything else — a custom endpoint whose key
 * looks like nothing in particular. That backstop only works if it holds the
 * keys we ACTUALLY have, which is a moving target: `installLogging()` runs
 * before commander has parsed `--api-key`, and a key the user types into the
 * settings screen mid-session arrives later still. A set captured at startup
 * would miss the single most common path by which a key enters the process, and
 * would miss it silently, because the vendor regexes happen to cover the keys
 * we test with.
 *
 * Process-lifetime, append-only, never serialised, never written anywhere.
 */

const secrets = new Set<string>();

/**
 * Minimum length for a value to count as a secret.
 *
 * Registering `"1"` or `"off"` would blank out every occurrence of that
 * substring in ordinary log text, which destroys the log's usefulness while
 * protecting nothing.
 */
const MIN_SECRET_LENGTH = 8;

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  secrets.add(trimmed);
}

/** Convenience for the `apiKeys` maps every registration site happens to hold. */
export function registerSecretsFrom(
  keys: Record<string, string | null | undefined> | undefined,
): void {
  if (!keys) return;
  for (const value of Object.values(keys)) registerSecret(value);
}

/**
 * Every known secret, LONGEST FIRST.
 *
 * Order matters: when one key is a prefix of another, replacing the short one
 * first leaves the remainder of the long one in the file — a partial key is
 * still a leak, and a more convincing one for being partial.
 */
export function getSecrets(): readonly string[] {
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Tests only. Production code has no reason to forget a secret. */
export function clearSecretsForTest(): void {
  secrets.clear();
}
