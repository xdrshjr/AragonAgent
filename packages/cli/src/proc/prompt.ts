/**
 * The `<background_services>` system-prompt block
 * (background-service-supervision §5.2).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope, and this string
 * also reaches a model that may be running in a `cmd.exe` terminal.
 *
 * SPLICED CONDITIONALLY by `buildSystemPrompt`, which is what preserves I-2:
 * with `bash.background: false` the prompt is BYTE-IDENTICAL to the pre-feature
 * output for a fixed tool array. An unconditional guidance line anywhere here
 * would quietly break that, `--no-todo`, `--no-team` and `--no-skills` all at
 * once.
 *
 * IT NAMES THE `[note]` SENTENCE VERBATIM. That line is the whole of defence 1
 * as the model experiences it, and telling it what the words mean is the
 * difference between "re-run with background: true" and reaching for
 * `Start-Process` - which is exactly what produced the reported screenshot.
 *
 * `BACKGROUND_SERVICES_BLOCK_VERSION` exists so a change to this wording is
 * greppable from a behaviour report.
 */

import { BACKGROUND_SERVICES_BLOCK_VERSION } from './limits.js';

export { BACKGROUND_SERVICES_BLOCK_VERSION };

export function buildBackgroundServicesBlock(): string {
  return [
    '<background_services>',
    'Some commands never exit on their own: dev servers, watchers, `docker compose up`,',
    '`tail -f`. Running one in the foreground stalls the turn until the tool timeout',
    'kills it, and you learn nothing.',
    '',
    'Rules:',
    '- Set `background: true` on `bash` for anything that does not exit on its own.',
    '  The call returns within a few seconds with a service id, a status, and a log tail.',
    '- NEVER detach a command yourself with `Start-Process`, `&`, `nohup` or `screen`.',
    '  A self-detached process cannot be reported on, read from, or stopped.',
    '- A background result is PROVISIONAL. `ready` means a port answered or a URL was',
    '  printed - it does not mean the app works. Verify with `bash_output({ service })`',
    '  AND with an actual request against the URL (for example `curl -s <url>`).',
    '- Read more output at any time with `bash_output({ service, since })`; `since` is the',
    '  cursor returned by the previous call.',
    '- Stop a service with `bash_kill({ service })`, or `bash_kill({ service: "all" })`,',
    '  when you are finished with it - unless the user asked for it to stay up.',
    '- If a foreground result ends with',
    '  `[note] the command exited but a background child is still holding its output stream.`',
    '  then the command detached something. Re-run it with `background: true`.',
    '- Services are stopped when this CLI exits. They do not survive the session.',
    '</background_services>',
  ].join('\n');
}
