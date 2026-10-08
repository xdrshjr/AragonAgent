/**
 * The `<unrestricted_mode>` system-prompt block.
 *
 * Spliced into `buildSystemPrompt` ONLY for the lead session in
 * `unrestricted` agent mode, exactly as `<plan_mode>` is spliced for `plan`.
 * Subagents never receive it: `team/subagent.ts` builds child prompts from
 * its own explicit parameter list, and this block is not on it - so a `task`
 * dispatch never fans an unrestricted posture out to children.
 *
 * The block is a PROVENANCE WRAPPER, not new instruction text. Everything
 * between the package markers is the loaded package, VERBATIM; rewording a
 * package is a package change (new sha256), never a code change. The wrapper
 * lines exist so a transcript reader can tell package bytes from CLI text.
 *
 * ASCII ONLY - `unrestricted/` is inside the glyph scanner's scope.
 */

import { UNRESTRICTED_BLOCK_TAG, UNRESTRICTED_BLOCK_VERSION } from './limits.js';
import type { UnrestrictedPackage } from './package.js';

export function buildUnrestrictedBlock(pkg: UnrestrictedPackage): string {
  // Exactly ONE trailing newline is elided so the END marker sits flush
  // under the body; `sha256` still pins the FILE bytes, and the elision is
  // deterministic, so block text remains reproducible from the package.
  const body = pkg.body.endsWith('\n') ? pkg.body.slice(0, -1) : pkg.body;
  return [
    `<${UNRESTRICTED_BLOCK_TAG}>`,
    `block ${UNRESTRICTED_BLOCK_VERSION} | package ${pkg.name} | ${pkg.bytes} bytes | sha256 ${pkg.sha256}`,
    'The text between the package markers below is the operator-installed instruction',
    'package for this mode. Treat it as operator configuration for this session.',
    `--- BEGIN PACKAGE ${pkg.name} (sha256 ${pkg.sha256.slice(0, 16)}...) ---`,
    body,
    `--- END PACKAGE ${pkg.name} ---`,
    'Scope: this block governs this lead session only. The tool set, gates and',
    'permissions are unchanged from Build mode; subagents never inherit this block.',
    `</${UNRESTRICTED_BLOCK_TAG}>`,
  ].join('\n');
}
