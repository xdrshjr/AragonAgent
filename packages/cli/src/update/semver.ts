/**
 * Semver comparison and the update decision (cli-auto-update section 3.4).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * HAND-WRITTEN AND NOT `semver`. The package has no such dependency
 * (`package.json`), and this feature needs three questions answered - "is B
 * newer than A", "is B a prerelease", "does this Node satisfy that range" - on a
 * document the registry writes and npm itself only warns about. Adding a
 * transitive dependency to an auto-updater, of all things, is the one place the
 * supply-chain argument in R-1 cuts hardest.
 *
 * PURE: no I/O, no clock, no process. Every function here is total and none of
 * them throws.
 */

import type { LatestManifest } from './types.js';

/**
 * The form a version must have before it is interpolated into `npm install`'s
 * argv (section 3.5 / AC-24).
 *
 * ANCHORED AND WITHOUT `v`: a registry that answered `"1.0.0; rm -rf /"` must
 * never reach `execFile`. With `shell: false` this is not an injection surface
 * to begin with, but the rejection is what makes that claim checkable rather
 * than reasoned, and it also satisfies `fetch-source.ts` rule 3 (no leading `-`)
 * by construction.
 */
export const STRICT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or `[]` for a release. */
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string, or `null` when it is not one. Never throws. */
export function parseSemver(raw: unknown): Semver | null {
  if (typeof raw !== 'string') return null;
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return {
    major: Number.parseInt(major as string, 10),
    minor: Number.parseInt(minor as string, 10),
    patch: Number.parseInt(patch as string, 10),
    prerelease: pre ? pre.split('.') : [],
  };
}

export function isPrerelease(raw: string): boolean {
  return (parseSemver(raw)?.prerelease.length ?? 0) > 0;
}

/**
 * Compare prerelease identifier lists per semver section 11.
 *
 * THE EMPTY LIST SORTS HIGHEST, which is the rule that keeps `1.0.0-rc.1` below
 * `1.0.0`. Getting this backwards would let a `latest` tag pointing at a release
 * candidate read as newer than the release it precedes.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number.parseInt(x, 10) - Number.parseInt(y, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * `-1 | 0 | 1`. An UNPARSEABLE version sorts BELOW a parseable one and equal to
 * another unparseable one, so a garbage registry answer can never read as newer
 * than what is installed.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** One comparator clause of an `engines.node` range, already understood. */
interface RangeClause {
  op: '>=' | '>' | '<=' | '<' | '=' | '^' | '~';
  version: Semver;
  /**
   * How many leading components the clause actually NAMED, before a wildcard or
   * the end of the string: `18` and `18.x` name one, `18.19` two, `18.19.0`
   * three.
   *
   * IT IS ONLY MEANINGFUL FOR `=`, AND WITHOUT IT `18.x` IS A BUG. A bare
   * partial has no operator, so it lands on `=`; padding it with zeros and
   * comparing for equality turns "any 18.y.z" into "exactly 18.0.0", and the
   * consequence is the wrong direction - a Node that DOES satisfy the range is
   * told it does not, and the user is sent to upgrade a Node that was already
   * fine. Every other operator wants the zero-padded reading (`>=18` really is
   * `>=18.0.0`), which is why this is a separate field rather than a different
   * parse.
   */
  specified: number;
}

function parseClause(raw: string): RangeClause | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const ops: [string, RangeClause['op']][] = [
    ['>=', '>='],
    ['<=', '<='],
    ['>', '>'],
    ['<', '<'],
    ['^', '^'],
    ['~', '~'],
    ['=', '='],
  ];
  for (const [prefix, op] of ops) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length).trim();
      const parsed = parsePartial(rest);
      return parsed ? { op, ...parsed } : null;
    }
  }
  const parsed = parsePartial(text);
  return parsed ? { op: '=', ...parsed } : null;
}

/**
 * `18`, `18.x`, `18.19`, `18.19.0` - the partial forms `engines.node` uses in
 * practice. Missing components read as `0`, which is what makes `>=18` mean
 * `>=18.0.0`, and `specified` records how many were really named.
 */
function parsePartial(raw: string): { version: Semver; specified: number } | null {
  const text = raw.trim().replace(/^v/, '');
  if (text.length === 0) return null;
  const parts = text.split('.');
  if (parts.length > 3) return null;
  const nums: number[] = [];
  let specified = 0;
  let sawWildcard = false;
  for (const part of parts) {
    if (part === 'x' || part === 'X' || part === '*') {
      sawWildcard = true;
      nums.push(0);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number.parseInt(part, 10));
    // A concrete component AFTER a wildcard (`18.x.3`) names nothing further:
    // the wildcard has already made everything below it free.
    if (!sawWildcard) specified += 1;
  }
  return {
    version: {
      major: nums[0] ?? 0,
      minor: nums[1] ?? 0,
      patch: nums[2] ?? 0,
      prerelease: [],
    },
    specified,
  };
}

function compareParsed(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function satisfiesClause(actual: Semver, clause: RangeClause): boolean {
  const cmp = compareParsed(actual, clause.version);
  switch (clause.op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    case '=':
      // A BARE PARTIAL IS A RANGE, NOT AN EQUALITY. `18` and `18.x` mean "any
      // 18.y.z"; only a fully-specified `18.19.0` means that exact version.
      if (clause.specified === 0) return true;
      if (actual.major !== clause.version.major) return false;
      if (clause.specified === 1) return true;
      if (actual.minor !== clause.version.minor) return false;
      if (clause.specified === 2) return true;
      return actual.patch === clause.version.patch;
    case '^':
      return cmp >= 0 && actual.major === clause.version.major;
    case '~':
      return (
        cmp >= 0 &&
        actual.major === clause.version.major &&
        actual.minor === clause.version.minor
      );
    default:
      return true;
  }
}

/**
 * Does `nodeVersion` satisfy `engines.node`?
 *
 * FAILS OPEN, and that is a decision rather than an oversight (D-15). Handled
 * forms are `>=X`, `>=X.Y.Z`, `>X`, `<X`, `<=X`, `=X`, `^X`, `~X`, `X.x`, and
 * `||`-joined unions of those, with space-separated clauses inside a union
 * ANDed together. Anything this cannot parse returns `true`, matching npm's own
 * default of warning rather than refusing.
 *
 * Failing CLOSED here would mean a syntax we did not anticipate silently freezes
 * every user's updates forever, with no message and no way to find out - the
 * worse of the two errors by a wide margin. A range we DID understand and that
 * genuinely excludes this Node yields `false`, and the caller turns that into a
 * `node-too-old` notice so the user is told to upgrade Node rather than left
 * wondering.
 */
export function satisfiesNodeRange(range: string | undefined, nodeVersion: string): boolean {
  if (range === undefined) return true;
  const text = range.trim();
  if (text.length === 0 || text === '*') return true;
  const actual = parseSemver(nodeVersion);
  if (!actual) return true;

  for (const union of text.split('||')) {
    const clauses = union.trim().split(/\s+/).filter((c) => c.length > 0);
    if (clauses.length === 0) continue;
    let allParsed = true;
    let allSatisfied = true;
    for (const raw of clauses) {
      const clause = parseClause(raw);
      if (!clause) {
        allParsed = false;
        break;
      }
      if (!satisfiesClause(actual, clause)) allSatisfied = false;
    }
    // An unparseable clause makes the WHOLE range unknown, not just this union:
    // a partially-understood range is exactly the input that would make a
    // fail-open guard silently strict.
    if (!allParsed) return true;
    if (allSatisfied) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type UpdateAction = 'install' | 'notify' | 'none';

export interface UpdateDecision {
  action: UpdateAction;
  reason:
    | 'up-to-date'
    | 'prerelease'
    | 'deprecated'
    | 'node-too-old'
    | 'skipped'
    | 'newer-available';
}

export interface DecideUpdateInput {
  /** The version this process is running. */
  local: string;
  manifest: Pick<LatestManifest, 'version' | 'engines' | 'deprecated'>;
  /** `process.versions.node`, injected so the decision is testable offline. */
  nodeVersion: string;
  /** `state.skippedVersion`; `''` when the user has skipped nothing. */
  skippedVersion: string;
}

/**
 * Should we install, merely report, or say nothing? (section 3.4)
 *
 * ORDER IS SEMANTIC. `up-to-date` is answered first because it is the
 * overwhelmingly common case and the cheapest; `skipped` comes before the
 * quality gates so a user who typed `/update skip` is not told about a
 * prerelease they already declined. Only a range we UNDERSTOOD and that excludes
 * this Node produces `notify`; every other rejection is silent (`none`).
 *
 * The SOURCE and the MODE are deliberately NOT inputs here. This function
 * answers "is that version worth having"; whether this machine may install it is
 * the service's question, and folding the two would make a pure decision depend
 * on the filesystem.
 */
export function decideUpdate(input: DecideUpdateInput): UpdateDecision {
  const { local, manifest, nodeVersion, skippedVersion } = input;
  const remote = manifest.version;

  if (compareSemver(remote, local) <= 0) return { action: 'none', reason: 'up-to-date' };
  if (skippedVersion.length > 0 && remote === skippedVersion) {
    return { action: 'none', reason: 'skipped' };
  }
  // A stable install is never moved onto a prerelease, even if someone points
  // `latest` at one. A local prerelease is already opted in, so it may move.
  if (isPrerelease(remote) && !isPrerelease(local)) {
    return { action: 'none', reason: 'prerelease' };
  }
  if (manifest.deprecated !== undefined) return { action: 'none', reason: 'deprecated' };
  if (!satisfiesNodeRange(manifest.engines?.node, nodeVersion)) {
    return { action: 'notify', reason: 'node-too-old' };
  }
  return { action: 'install', reason: 'newer-available' };
}
