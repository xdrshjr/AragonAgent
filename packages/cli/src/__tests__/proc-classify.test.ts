/**
 * The long-running classifier and the port hint (§7.1 / AC-1..AC-4).
 *
 * PURE, so this file spawns nothing. The whole value of the classifier being a
 * closed allowlist is that a test can enumerate it and a reviewer can read it;
 * a heuristic would make both impossible.
 */

import { describe, expect, it } from 'vitest';
import {
  extractPortHint,
  hasTopLevelChain,
  looksLongRunning,
  LONG_RUNNING_PATTERNS,
} from '../proc/classify.js';

describe('looksLongRunning (AC-1 / AC-2 / AC-3)', () => {
  it('AC-1: every canonical long-running command matches', () => {
    const canonical = [
      'npm run dev',
      'pnpm dev',
      'yarn start',
      'bun run serve',
      'npm run watch',
      'npm run preview',
      'next dev',
      'next start',
      'vite',
      'vite --port 5173',
      'nuxt dev',
      'astro dev',
      'remix dev',
      'ng serve',
      'webpack serve',
      'nodemon server.js',
      'tsc --watch',
      'tsc -w',
      'serve dist',
      'http-server .',
      'uvicorn main:app --port 8000',
      'gunicorn app:app',
      'hypercorn app:app',
      'flask run',
      'python manage.py runserver',
      'python3 -m http.server 8000',
      'rails server',
      'rails s',
      'php -S 127.0.0.1:8080',
      'cargo watch -x run',
      'docker compose up',
      'docker-compose up',
      'tail -f log.txt',
      'watch ls',
    ];
    for (const command of canonical) {
      expect(looksLongRunning(command), command).toBe(true);
    }
  });

  it('AC-1b: every pattern in the exported table has at least one match above', () => {
    // The table is exported precisely so it can be enumerated. A pattern nothing
    // exercises is a pattern nobody can reason about.
    expect(LONG_RUNNING_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of LONG_RUNNING_PATTERNS) {
      expect(pattern.source.length, pattern.source).toBeGreaterThan(0);
    }
  });

  it('AC-2: ordinary commands do NOT match', () => {
    // THE COST OF A FALSE POSITIVE IS REAL (R-1): a build that is backgrounded
    // returns before it finished, and the model reads a half-empty log as
    // success. So the allowlist has to be tight at exactly these edges.
    const ordinary = [
      'npm run build',
      'npm test',
      'npm install',
      'git status',
      'ls',
      'python script.py',
      'cargo build',
      'docker compose up -d',
      'docker compose up --detach',
      'vitest run',
      'tsc',
      'echo hello',
    ];
    for (const command of ordinary) {
      expect(looksLongRunning(command), command).toBe(false);
    }
  });

  it('AC-3: a chained command never matches, whatever its head', () => {
    // A chain's TAIL is what the model actually wants the result of, so
    // backgrounding on the strength of its head would return before the part it
    // asked about had even started.
    expect(looksLongRunning('npm run dev && npm test')).toBe(false);
    expect(looksLongRunning('npm run dev || echo failed')).toBe(false);
    expect(looksLongRunning('npm run dev; ls')).toBe(false);
    expect(looksLongRunning('npm run dev | tee log.txt')).toBe(false);
    expect(looksLongRunning('npm run dev &')).toBe(false);
  });

  it('hasTopLevelChain ignores operators inside quotes', () => {
    expect(hasTopLevelChain('echo "a && b"')).toBe(false);
    expect(hasTopLevelChain("echo 'a; b'")).toBe(false);
    expect(hasTopLevelChain('echo a && echo b')).toBe(true);
  });

  it('sees through a leading env-assignment run', () => {
    expect(looksLongRunning('PORT=5173 vite')).toBe(true);
    expect(looksLongRunning('NODE_ENV=development npm run dev')).toBe(true);
    expect(looksLongRunning('NODE_ENV=production npm run build')).toBe(false);
  });
});

describe('extractPortHint (AC-4)', () => {
  it('finds a port in every spelling the shipped servers use', () => {
    expect(extractPortHint('uvicorn main:app --port 8000')).toBe(8000);
    expect(extractPortHint('serve -p 3000')).toBe(3000);
    expect(extractPortHint('PORT=5173 vite')).toBe(5173);
    expect(extractPortHint('php -S 127.0.0.1:8080')).toBe(8080);
    expect(extractPortHint('next dev --port=4000')).toBe(4000);
  });

  it('returns undefined for a non-numeric `-p` and for no port at all', () => {
    expect(extractPortHint('npm run dev')).toBeUndefined();
    expect(extractPortHint('docker compose -p myproject up')).toBeUndefined();
  });
});
