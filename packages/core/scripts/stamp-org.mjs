#!/usr/bin/env node
/**
 * One-shot `<ORG>` stamper (D5).
 *
 * Replaces the `<ORG>` placeholder with the real GitHub org / npm scope across:
 *   - `package.json` → `repository.url` / `homepage` / `bugs.url` (the publish
 *     metadata that the publish guard hard-checks),
 *   - `README.md`    → rewrites the "Replace the `<ORG>` ..." reminder bullet
 *     into a stamped-confirmation bullet (RV-4: keeps the docs placeholder-free
 *     so the publish guard never gets stuck on README prose).
 *
 * Usage:
 *   node scripts/stamp-org.mjs <org>
 *   ARGON_REPO_ORG=<org> node scripts/stamp-org.mjs
 *
 * No org argument → error exit (never stamps a bogus / empty value silently).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const pkgPath = join(pkgDir, 'package.json');
const readmePath = join(pkgDir, 'README.md');

const org = (process.argv[2] ?? process.env.ARGON_REPO_ORG ?? '').trim();

if (!org) {
  console.error('[stamp-org] ERROR: no org provided.');
  console.error('Usage:  node scripts/stamp-org.mjs <org>');
  console.error('   or:  ARGON_REPO_ORG=<org> node scripts/stamp-org.mjs');
  process.exit(1);
}

// A GitHub org / npm scope is a single path segment.
if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) {
  console.error(`[stamp-org] ERROR: "${org}" is not a valid org / scope name (expected [A-Za-z0-9-]).`);
  process.exit(1);
}

// --- package.json -----------------------------------------------------------
const pkgRaw = readFileSync(pkgPath, 'utf8');
const pkgStamped = pkgRaw.replaceAll('<ORG>', org);
if (pkgStamped !== pkgRaw) {
  writeFileSync(pkgPath, pkgStamped);
  console.log(`[stamp-org] package.json: <ORG> -> ${org}`);
} else {
  console.log('[stamp-org] package.json: no <ORG> placeholder (already stamped).');
}

// --- README.md --------------------------------------------------------------
const readmeRaw = readFileSync(readmePath, 'utf8');

// The L104-105 reminder bullet (matched by content, not line number, so adding
// new README sections above it does not break the match).
const REMINDER_RE =
  /- Replace the `<ORG>` placeholders in `repository` \/ `homepage` \/ `bugs` with\r?\n {2}the real repository URL before the first publish\./;

const confirmation =
  `- The \`repository\` / \`homepage\` / \`bugs\` URLs are stamped to the \`${org}\`\n` +
  `  GitHub org / npm scope (re-run \`scripts/stamp-org.mjs\` to change).`;

let readmeStamped = readmeRaw.replace(REMINDER_RE, confirmation);
// Safety net: if the reminder bullet drifted and the targeted swap missed, still
// strip any remaining literal `<ORG>` from the docs.
if (readmeStamped.includes('<ORG>')) {
  readmeStamped = readmeStamped.replaceAll('<ORG>', org);
}

if (readmeStamped !== readmeRaw) {
  writeFileSync(readmePath, readmeStamped);
  console.log(`[stamp-org] README.md: reminder -> stamped confirmation (${org}).`);
} else {
  console.log('[stamp-org] README.md: nothing to stamp (already reconciled).');
}

console.log('[stamp-org] done. Run `node scripts/check-publishable.mjs` to verify.');
