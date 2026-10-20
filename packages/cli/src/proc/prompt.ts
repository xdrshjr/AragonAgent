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

/**
 * The `<background_jobs>` system-prompt block (long-task-jobs §12).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope, and this string
 * also reaches a model running in a `cmd.exe` terminal.
 *
 * SPLICED CONDITIONALLY by `buildSystemPrompt`, which is what preserves I-3: with
 * `jobs.enabled: false` the prompt is BYTE-IDENTICAL to the pre-feature output.
 *
 * EVERY SENTENCE HERE ANSWERS A DECISION THE MODEL ACTUALLY HAS TO MAKE:
 *  - "do not poll" is the behaviour this feature exists to replace (six
 *    `bash_output` calls per 30 seconds, six LLM turns, six 200-row tails);
 *  - "a bounded wait is the only thing that tells you it finished" prevents the
 *    opposite failure, a model that starts a job and then guesses;
 *  - "`<job_notices>` is the notification, not an error" stops it apologising for
 *    a block that is good news;
 *  - "`[stalled]` is not a failure" stops it killing a job that is merely quiet.
 *
 * `JOBS_BLOCK_VERSION` exists so a change to this wording is greppable from a
 * behaviour report.
 */

import { JOBS_BLOCK_VERSION } from './limits.js';

export { JOBS_BLOCK_VERSION };

export function buildBackgroundJobsBlock(): string {
  return [
    '<background_jobs>',
    'Some commands finish on their own but take far longer than one tool call:',
    'training runs, model downloads, big installs, release builds. Do not poll them',
    'and do not let the tool ceiling kill them.',
    '',
    'Rules:',
    '- Start one with bash({ command, background: true }). You get a job id: `t1` for a',
    '  task (it will finish) or `s1` for a service (it will not). The call returns in a',
    '  few seconds with the first lines of output.',
    '- Wait with job_wait({ job: "t1" }). Every wait is bounded (default 30s, at most',
    '  60s) and returns one status line, one progress line, and only the output since',
    '  your last cursor. Call it again only after deciding something; do other work in',
    '  between if you have any.',
    '- Nothing but a bounded wait tells you a job finished. When one finishes while you',
    '  are busy, a <job_notices> block appears at the end of a tool result - that is the',
    '  notification, not an error.',
    '- `[stalled]` means the job has printed nothing for a while. It has not failed.',
    '  Choose: keep waiting, stop it, or read the tail.',
    '- Full output lives in the service log (`bash_output`) and, past the ring, in a',
    '  file whose path the truncation note names. Read that file with grep/read_file',
    '  instead of asking for the whole log.',
    '- Stop a job with bash_kill({ service: "t1" }) when you are done with it, unless the',
    '  user asked for it to stay up. Jobs do not survive this session.',
    '</background_jobs>',
  ].join('\n');
}

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
