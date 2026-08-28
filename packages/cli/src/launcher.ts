/**
 * The bin entry (cli-auto-update-hardening section 5.1.1).
 *
 * ASCII ONLY - this file is inside the glyph scanner's scope (C-19).
 *
 * KEEP IT THIS SMALL. Every import here is a module that can crash before the
 * guard that exists to survive crashes. `node:process` is the only static one,
 * and `__tests__/update-wiring.test.ts` asserts that on the source text.
 *
 * `dist/cli.js` IS UNCHANGED AND KEEPS ITS SHEBANG (R-17 / AC-50). Only the
 * `bin` mapping moves; `npm start` (`node dist/cli.js`) and any user script that
 * invokes `dist/cli.js` directly keep working byte for byte.
 */

import process from 'node:process';

try {
  // DYNAMIC, AND THAT IS THE WHOLE POINT (P1-2 / R-22). A STATIC import of the
  // guard would put `boot/guard -> update/state -> config/app-paths ->
  // env-paths` in the bin entry's OWN module graph, and a resolution failure
  // anywhere in that chain throws during THIS module's evaluation - outside the
  // `try`, before any line of it runs. "An undeclared dependency" is the first
  // way section 1.1 says a release bricks itself; a guard whose own import fails
  // in that exact case has to degrade to "no guard", never to "no CLI".
  const { runBootGuard } = await import('./boot/guard.js');
  runBootGuard();
} catch {
  // A guard that throws must never be the reason the CLI will not start. This is
  // the one catch in the package that is allowed to be empty: there is no logger
  // yet, and there is nothing the user could do with the message.
}

// The `.catch` is for the IMPORT rejecting, which is precisely the import-time
// crash H1 exists for and which today produces an unhandled rejection with a
// stack the user cannot act on. `cli.js` runs `main()` at module scope and
// installs its own `.catch` for everything after that point.
//
// EXITING NON-ZERO HERE IS WHAT FEEDS THE GUARD'S COUNTER (D-30a): the exit hook
// the guard installed counts non-zero exits, and a module that will not import
// raises, so it arrives here.
await import('./cli.js').catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
