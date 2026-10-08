/**
 * Structural bounds for the unrestricted-mode prompt-package subsystem.
 *
 * `limits.ts` holds what a package can PHYSICALLY carry, per the repo rule
 * that structural bounds and user-tunable policy live in different files.
 * This branch deliberately ships no `unrestricted.*` config keys: the package
 * DIRECTORY is the only configuration surface (env `ARAGON_UNRESTRICTED_DIR`,
 * default `<aragon home>/unrestricted`).
 *
 * ASCII ONLY in every string literal below. `unrestricted/` is inside the
 * glyph scanner's scope (`glyphs.test.ts`), so a stray ellipsis here fails
 * the build.
 */

/**
 * Byte ceiling for one package body, inherited from the gpt-instruct
 * candidate discipline (every published candidate is at most 8,000 UTF-8
 * bytes). A package over the cap is refused, not truncated: truncating an
 * instruction file changes what the model was told.
 */
export const MAX_PACKAGE_BYTES = 8000;

/** Hard cap on packages declared by one manifest, so a bad dir fails loudly. */
export const MAX_PACKAGES = 20;

/** Bump when the block wording changes, so a transcript can be dated. */
export const UNRESTRICTED_BLOCK_VERSION = 'v1-2026-10';

/** The XML-ish tag the block is wrapped in inside the system prompt. */
export const UNRESTRICTED_BLOCK_TAG = 'unrestricted_mode';

/** Environment override for the package directory. */
export const UNRESTRICTED_DIR_ENV = 'ARAGON_UNRESTRICTED_DIR';
