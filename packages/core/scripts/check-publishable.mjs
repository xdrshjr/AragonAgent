#!/usr/bin/env node
/**
 * Publish guard (D5).
 *
 * Hard-blocks `npm publish` while the `<ORG>` placeholder still lives in the
 * package's PUBLISH METADATA (`package.json` `repository.url` / `homepage` /
 * `bugs.url`). A scoped package published with a placeholder URL would ship
 * broken links and (worse) imply ownership of an unowned scope.
 *
 * RV-4: this guard scans ONLY `package.json` (the metadata that actually ships
 * and is consumed by the registry). `README.md` is repo-internal docs, NOT in
 * the `files` whitelist, so it is intentionally not a hard-block target — its
 * `<ORG>` mention is reconciled by `stamp-org.mjs`.
 *
 * Wired into `prepublishOnly` ahead of the build, so ANY publish attempt is
 * intercepted when a placeholder remains.
 *
 * Exit 0 = publishable; exit 1 = placeholder remains.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const fields = [
  ['repository.url', pkg.repository?.url],
  ['homepage', pkg.homepage],
  ['bugs.url', pkg.bugs?.url],
];

const offenders = fields.filter(
  ([, value]) => typeof value === 'string' && value.includes('<ORG>'),
);

if (offenders.length > 0) {
  console.error('[check-publishable] BLOCKED: <ORG> placeholder still present in package.json:');
  for (const [field, value] of offenders) {
    console.error(`  - ${field}: ${value}`);
  }
  console.error('');
  console.error('Run:  node scripts/stamp-org.mjs <org>');
  console.error('  or: ARGON_REPO_ORG=<org> node scripts/stamp-org.mjs');
  console.error('to replace <ORG> with the real GitHub org / npm scope before publishing.');
  process.exit(1);
}

console.log('[check-publishable] OK — no <ORG> placeholders in package.json metadata.');
process.exit(0);
