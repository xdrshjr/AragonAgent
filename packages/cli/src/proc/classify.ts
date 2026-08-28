/**
 * Is this command one that does not exit on its own?
 * (background-service-supervision §3.5.)
 *
 * PURE. No process, no filesystem, no clock — so the whole table below is
 * enumerable by a test and readable by a reviewer in one screen.
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * A CONSERVATIVE ALLOWLIST OVER THE LEADING TOKEN AND SCRIPT NAME, NEVER A VERB
 * HEURISTIC (R-1). The cost of a false positive is real: a build that is
 * backgrounded returns before it finished, and the model reads a half-empty log
 * as success. So `npm run build` and `npm test` must not match, and a chained
 * command must not match at all — a chain's TAIL is what the model actually
 * wants the result of.
 */

/**
 * The classifier's table, exported so `classify.test.ts` can enumerate it and a
 * reviewer can read it whole.
 *
 * Each pattern is anchored at the start of the (trimmed, env-prefix-stripped)
 * command. `\b`-style boundaries are spelled explicitly because a bare `vite`
 * must not match `vitest`.
 */
export const LONG_RUNNING_PATTERNS: readonly RegExp[] = Object.freeze([
  // Package-manager scripts whose NAME says "does not exit".
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)(?:\s|$)/i,
  // Node/JS dev servers and bundlers in watch mode.
  /^next\s+(?:dev|start)(?:\s|$)/i,
  /^vite(?:\s|$)/i,
  /^nuxt\s+dev(?:\s|$)/i,
  /^astro\s+dev(?:\s|$)/i,
  /^remix\s+dev(?:\s|$)/i,
  /^ng\s+serve(?:\s|$)/i,
  /^webpack\s+serve(?:\s|$)/i,
  /^nodemon(?:\s|$)/i,
  /^tsc\s+(?:--watch|-w)(?:\s|$)/i,
  /^(?:serve|http-server)(?:\s|$)/i,
  // Python.
  /^uvicorn(?:\s|$)/i,
  /^gunicorn(?:\s|$)/i,
  /^hypercorn(?:\s|$)/i,
  /^flask\s+run(?:\s|$)/i,
  /^python[0-9.]*\s+(?:\S*[\\/])?manage\.py\s+runserver(?:\s|$)/i,
  /^python[0-9.]*\s+-m\s+http\.server(?:\s|$)/i,
  // Ruby / PHP / Rust.
  /^rails\s+(?:server|s)(?:\s|$)/i,
  /^php\s+-S(?:\s|$)/i,
  /^cargo\s+watch(?:\s|$)/i,
  // Containers. `up` WITHOUT `-d` only; the `-d` form is checked below.
  /^docker(?:\s+compose|-compose)\s+up(?:\s|$)/i,
  // Plain watchers.
  /^tail\s+-f(?:\s|$)/i,
  /^watch\s+/i,
]);

/** `docker compose up -d` returns on its own, so it is a foreground command. */
const DOCKER_DETACHED = /(?:^|\s)(?:-d|--detach)(?:\s|$)/i;

/**
 * A leading `KEY=value ` run of assignments, which POSIX shells accept and which
 * would otherwise hide the real leading token (`PORT=5173 vite`).
 */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** Strip a leading env-assignment run, so the table can anchor on the command. */
function stripEnvPrefix(command: string): string {
  return command.replace(ENV_PREFIX, '');
}

/**
 * Does the command contain a TOP-LEVEL `&&`, `||`, `;` or `|`?
 *
 * "Top level" means outside quotes: `echo "a && b"` is one command. Anything
 * quoted is skipped, which is enough for the judgement being made here — this
 * decides whether to REFUSE to background, so an over-eager reading is the safe
 * direction.
 */
export function hasTopLevelChain(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';') return true;
    // A lone `|` is a pipe and `||` is an or; both disqualify. So does `&`, in
    // BOTH of its readings: `&&` is a chain, and a trailing single `&` is the
    // manual-detach the prompt block bans - whatever it backgrounds, we cannot
    // supervise. One branch each, because the two `&` cases have one answer.
    if (ch === '|' || ch === '&') return true;
  }
  return false;
}

/**
 * Would this command sit there rather than exiting?
 *
 * FALSE FOR ANYTHING CHAINED, unconditionally and before the table is consulted.
 */
export function looksLongRunning(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (hasTopLevelChain(trimmed)) return false;
  const bare = stripEnvPrefix(trimmed);
  if (/^docker(?:\s+compose|-compose)\s+up(?:\s|$)/i.test(bare) && DOCKER_DETACHED.test(bare)) {
    return false;
  }
  return LONG_RUNNING_PATTERNS.some((re) => re.test(bare));
}

/**
 * The port the command asks for, when it names one.
 *
 * Used ONLY to enable the probe detector, so a miss is free (the URL detector
 * still runs) and a wrong hit is bounded by the pre-flight probe: a port that
 * already answers before we spawn disables the detector entirely rather than
 * declaring every launch instantly ready.
 *
 * `--port N`, `--port=N`, `-p N`, `PORT=N`, and a `:N` suffix on a host in the
 * command text (`php -S 127.0.0.1:8080`).
 */
export function extractPortHint(command: string): number | undefined {
  const candidates: RegExp[] = [
    /(?:^|\s)--port[=\s]+(\d{1,5})(?:\s|$)/i,
    /(?:^|\s)-p[=\s]+(\d{1,5})(?:\s|$)/,
    /(?:^|\s)PORT=(\d{1,5})(?:\s|$)/,
    /(?:^|\s)\S*?:(\d{2,5})(?:\s|$)/,
  ];
  for (const re of candidates) {
    const m = re.exec(command);
    if (!m || !m[1]) continue;
    const port = Number.parseInt(m[1], 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) return port;
  }
  return undefined;
}
