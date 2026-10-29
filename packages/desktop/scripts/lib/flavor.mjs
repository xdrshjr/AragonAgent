// Baking the build flavor into the COMPILED main-process bundle.
//
// The source file `src/main/build-flavor.ts` keeps `BAKED_FLAVOR = null` forever; only the build
// output is rewritten, so a checkout can never contain a baked value and there is nothing to
// restore. The replacement must match exactly once: if the compiler ever formats the constant
// differently this THROWS rather than quietly producing an unflavored (and so, once packaged,
// `release`) build that was meant to be `e2e` - or the reverse.
import { readFileSync, writeFileSync } from 'node:fs';

export const FLAVORS = ['dev', 'e2e', 'release'];

const PLACEHOLDER = /export const BAKED_FLAVOR = null;/g;

export function bakeFlavorText(text, flavor) {
  if (!FLAVORS.includes(flavor)) throw new Error(`unknown build flavor "${flavor}" (expected ${FLAVORS.join(' | ')})`);
  const hits = text.match(PLACEHOLDER)?.length ?? 0;
  if (hits !== 1) throw new Error(`expected exactly one BAKED_FLAVOR placeholder, found ${hits}`);
  return text.replace(PLACEHOLDER, `export const BAKED_FLAVOR = ${JSON.stringify(flavor)};`);
}

export function bakeFlavorFile(file, flavor) {
  writeFileSync(file, bakeFlavorText(readFileSync(file, 'utf8'), flavor));
}

/** The flavor a compiled build-flavor.js carries, or null when it is still the placeholder. */
export function readBakedFlavor(text) {
  const match = /export const BAKED_FLAVOR = (null|"(dev|e2e|release)");/.exec(text);
  if (!match) return undefined;
  return match[2] ?? null;
}

/** Which flavor a build is for: an explicit `--flavor=`, else `ARAGON_E2E_BUILD=1` means e2e. */
export function chooseFlavor(argv, env) {
  const flag = argv.find((arg) => arg.startsWith('--flavor='));
  if (flag) return flag.slice('--flavor='.length);
  return env.ARAGON_E2E_BUILD === '1' ? 'e2e' : null;
}
