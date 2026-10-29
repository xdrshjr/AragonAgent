/**
 * Persona names for subagents (tui-subagent-persona-and-developer-mode §3.1).
 *
 * A name is a DISPLAY NICKNAME and nothing else: it is never stored on a run, never
 * written to a session file or a log, never put in a prompt, and never an address
 * (`team_send` still takes the label). It lives only in a session-scoped
 * `PersonaBook` held by `App`.
 *
 * WHY A BOOK AND NOT A PURE FUNCTION OF THE ROSTER. A pure `assign(seed, labels)`
 * depends on WHICH labels it was handed and in what order (linear probing), and the
 * same subagent is drawn by several surfaces with different label sets - the
 * governance roster (whole run) and each stage's settlement card (that stage only).
 * With ten labels in a 64-slot pool a collision is more likely than not, so the two
 * surfaces would name the same `dev1-r1` differently. The book remembers the first
 * assignment per `(scope, label)` and never changes it, which makes cross-surface
 * agreement a property of the structure rather than of luck. Uniqueness inside a
 * scope comes from probing, not from collision probability.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan.
 */

/** 64 names, ASCII, `^[A-Z][a-z]{1,5}$`, case-insensitively unique, no reserved words. */
export const PERSONA_POOL: readonly string[] = [
  'Ada', 'Aki', 'Bea', 'Bo', 'Cleo', 'Cy', 'Dara', 'Dex', 'Edie', 'Eli', 'Fay', 'Finn',
  'Gus', 'Hal', 'Hana', 'Ida', 'Ivy', 'Jax', 'Jo', 'Juno', 'Kai', 'Kit', 'Lena', 'Lux',
  'Mara', 'Max', 'Mika', 'Nell', 'Nico', 'Noor', 'Nova', 'Odie', 'Olu', 'Orin', 'Pax', 'Pia',
  'Quin', 'Remy', 'Rhea', 'Rio', 'Sage', 'Sol', 'Tess', 'Theo', 'Uma', 'Vera', 'Vic', 'Wren',
  'Xan', 'Yara', 'Yuki', 'Zed', 'Zoe', 'Alma', 'Bram', 'Cass', 'Dune', 'Echo', 'Flint', 'Gwen',
  'Heath', 'Indi', 'Joss', 'Leif',
];

/** The longest pool name is 5; one cell of headroom for the `2`, `3`... overflow suffix. */
export const PERSONA_NAME_MAX_CHARS = 6;

/** Entries kept across scopes before the oldest scope is evicted. */
export const PERSONA_BOOK_MAX_ENTRIES = 256;

/** FNV-1a over UTF-16 code units. Total: any string, deterministic, unsigned 32-bit. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PersonaBook {
  /**
   * The name for `(scope, label)`: assigned on first sight and returned unchanged
   * ever after. Total - never throws, always returns a non-empty name.
   */
  nameFor(scope: string, label: string): string;
  /**
   * Make `scope` resolve inside `to`'s namespace (a governance stage dispatch id ->
   * the run id). Idempotent. Registering AFTER names were already handed out for
   * `scope` discards them and re-resolves under `to` (R-14); aliases follow one hop
   * only, so a cycle cannot loop.
   */
  alias(scope: string, to: string): void;
  /** Forget everything (`/clear`, resume). */
  reset(): void;
}

interface Space {
  names: Map<string, string>;
  taken: Set<number>;
  /** Overflow counter for the (N+1)th label onward in this space. */
  overflow: number;
}

function newSpace(): Space {
  return { names: new Map(), taken: new Set(), overflow: 0 };
}

export function createPersonaBook(): PersonaBook {
  /** Insertion-ordered, so the first key is always the oldest scope. */
  const spaces = new Map<string, Space>();
  const aliases = new Map<string, string>();

  const resolve = (scope: string): string => aliases.get(scope) ?? scope;
  const entryCount = (): number => {
    let total = 0;
    for (const space of spaces.values()) total += space.names.size;
    return total;
  };
  const evictOldest = (keep: string): void => {
    while (entryCount() >= PERSONA_BOOK_MAX_ENTRIES) {
      const oldest = spaces.keys().next();
      if (oldest.done === true || oldest.value === keep) return;
      spaces.delete(oldest.value);
    }
  };

  return {
    nameFor(scope, label) {
      const key = resolve(scope);
      let space = spaces.get(key);
      const known = space?.names.get(label);
      if (known !== undefined) return known;
      if (space === undefined) {
        evictOldest(key);
        space = newSpace();
        spaces.set(key, space);
      }
      const n = PERSONA_POOL.length;
      let name: string;
      if (space.taken.size < n) {
        let i = hash32(`${key}\u0000${label}`) % n;
        while (space.taken.has(i)) i = (i + 1) % n;
        space.taken.add(i);
        name = PERSONA_POOL[i]!;
      } else {
        // Past the pool: still unique, still short (`Ada2`).
        const i = hash32(`${key}\u0000${label}`) % n;
        space.overflow += 1;
        name = `${PERSONA_POOL[i]!}${space.overflow + 1}`;
      }
      space.names.set(label, name);
      return name;
    },
    alias(scope, to) {
      const target = resolve(to);
      if (scope === target || aliases.get(scope) === target) return;
      aliases.set(scope, target);
      // Names already handed out under the raw `scope` are superseded.
      spaces.delete(scope);
    },
    reset() {
      spaces.clear();
      aliases.clear();
    },
  };
}
