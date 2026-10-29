/**
 * Release-safety facts about the desktop package that fail silently if broken by hand
 * (spec R12 / RV-P1-4), restated for a repository that does NOT contain the engine: it must never
 * be published, it must take @aragon-agent/{core,tui,cli} from the npm registry (never a
 * workspace:/file: protocol, never a bare "*"), and it must use the same React as the terminal UI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as {
  private?: boolean;
  publishConfig?: unknown;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  main: string;
};

describe('@aragon-agent/desktop package.json', () => {
  it('is private and cannot be published', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
  });

  it('takes the engine from the npm registry as semver ranges', () => {
    for (const name of ['core', 'tui', 'cli']) {
      const range = manifest.dependencies[`@aragon-agent/${name}`];
      expect(range, `@aragon-agent/${name}`).toMatch(/^\^?\d+\.\d+\.\d+$/);
      expect(range, `@aragon-agent/${name}`).not.toMatch(/^(workspace|file|link|portal):/);
    }
  });

  it("declares its own direct runtime dependencies instead of borrowing the CLI's", () => {
    expect(manifest.dependencies).toHaveProperty('tinyglobby');
    expect(manifest.dependencies).toHaveProperty('fflate');
  });

  it('keeps react and react-dom on one range (two copies of React means "Invalid hook call")', () => {
    expect(manifest.devDependencies.react).toMatch(/^\^?\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies['react-dom']).toBe(manifest.devDependencies.react);
  });

  it('pins Electron exactly', () => {
    expect(manifest.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('points main at the compiled entry', () => {
    expect(manifest.main).toBe('dist/main/index.js');
  });

  it('no script reaches for a workspace sibling or a monorepo-root script', () => {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(command, name).not.toMatch(/-w\s+packages\//);
      expect(command, name).not.toMatch(/\.\.\/\.\.\//);
      expect(command, name).not.toMatch(/packages[\\/](core|cli|tui)/);
    }
  });
});
