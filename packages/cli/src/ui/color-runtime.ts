import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import type { TermCapabilities } from './capabilities.js';

const require = createRequire(import.meta.url);

/** Resolve the actual dependency instance even when npm nests its Chalk. */
async function dependencyChalk(packageName: string): Promise<typeof chalk> {
  const dependency = createRequire(require.resolve(packageName));
  return (await import(pathToFileURL(dependency.resolve('chalk')).href)).default;
}

const [inkChalk, highlightChalk] = await Promise.all([
  dependencyChalk('ink'), dependencyChalk('cli-highlight'),
]);

/** Highlight cache entries must not cross color preferences between sessions. */
export function syntaxColorLevel(): number { return highlightChalk.level; }

/** Apply session colors without changing environment inherited by agent tools. */
export function useTuiColors(level: TermCapabilities['colorLevel']): () => void {
  const renderers = new Set([chalk, inkChalk, highlightChalk]);
  const previous = new Map([...renderers].map(renderer => [renderer, renderer.level]));
  for (const renderer of renderers) renderer.level = level;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [renderer, original] of previous) renderer.level = original;
  };
}
