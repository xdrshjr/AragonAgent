# `cli-integration-surface` — manual smoke

The automated suite covers every acceptance criterion it can reach without a
network, a real terminal or a second process. These are the ones it cannot.

**Setup.** Build once and point the CLI at a scratch home so nothing here can
touch your real `~/.aragon-agent`:

```bash
cd packages/cli
npm run build

export ARAGON_HOME="$(mktemp -d)"      # PowerShell: $env:ARAGON_HOME = "$env:TEMP\aragon-smoke"
alias aragon="node $PWD/dist/cli.js"
aragon config set provider anthropic
aragon config set model <a model you have a key for>
export ANTHROPIC_API_KEY=sk-ant-...
```

Every step says what to look for. A step that says **must** is one where the
wrong outcome is silent — the CLI will look like it worked.

---

## 1. Discovery (AC-21 / AC-22)

```bash
aragon info --json | jq .
aragon doctor
aragon doctor --probe
```

- `info --json` parses, and `schemaVersion` is `1`.
- `features` is a flat array of strings, and contains `exec` and `sessions`.
- `doctor` prints one line per check and exits `0`.
- Now remove the key (`unset ANTHROPIC_API_KEY`) and re-run `aragon doctor`: it
  must exit `1` and name the `api-key` check with a remedy.
- `doctor --probe` makes one real API call. On a machine behind a proxy that
  blocks the provider it must report `probe FAIL` with the transport error, not
  hang.

## 2. The three formats, and stdout purity (AC-3 / AC-4 / AC-5)

```bash
aragon exec "say hi in five words"
aragon exec --output-format json "say hi in five words" | jq -r .result
aragon exec --output-format stream-json "read package.json and name the deps"
```

- **The `text` run must be indistinguishable from `aragon -p "say hi in five
  words"`.** Run both and diff them if anything looks off.
- The `json` run must put **exactly one** object on stdout. `jq` accepting it is
  the check; anything else on that stream makes `jq` fail.
- Every line of the `stream-json` run must parse on its own:
  `aragon exec --output-format stream-json "…" | while read -r l; do echo "$l" | jq -e . >/dev/null || echo "BAD: $l"; done`
- The first line must be `system`/`init`; the last must be `result`.

**Then do it again in a directory that triggers a stderr notice** — an untrusted
project skills directory, or a machine whose `config.json` has a stray comma:

```bash
aragon exec --output-format json "hi" > out.json 2> err.txt
jq . out.json          # must still parse
cat err.txt            # the notice must be here
```

This is the one that catches a stray `process.stdout.write` on the exec path,
and it cannot be caught any other way.

## 3. Session continuity across processes (AC-7)

```bash
aragon exec --session-id ci-42 --output-format json "Remember the word: banana. Reply OK."
aragon exec --session-id ci-42 --output-format json "What word did I ask you to remember?"
aragon sessions list
```

- The **second process** must answer `banana`.
- `sessions list` shows `ci-42` with `2 turns` — cumulative across invocations,
  not per run.
- `aragon exec --continue --output-format json "and again?"` in the same
  directory must resume the same conversation.
- Delete the pointer and confirm `--continue` still works (AC-9):
  `rm "$ARAGON_HOME/sessions/.last.json"` then repeat the `--continue` call.

## 4. `prune` must not eat a `/save` file (AC-23) — **do not skip**

This is the step guarding an unrecoverable loss triggered by a command the docs
recommend.

```bash
aragon                                  # start the TUI
# type anything, then: /save my-notes
# then Ctrl-C to leave

aragon exec --session-id throwaway --output-format json "hi"
aragon sessions list                    # shows `throwaway`, NOT `my-notes`
aragon sessions list --all              # shows both
aragon sessions prune --older-than 0 --dry-run
aragon sessions prune --older-than 0 --yes
ls "$ARAGON_HOME/sessions"              # my-notes.json MUST still be there
```

- The dry run must delete nothing.
- After the real prune, `my-notes.json` **must** still exist and
  `throwaway.json` must be gone.
- `aragon sessions show my-notes` must still work — an id you name explicitly is
  always accepted.

## 5. Two runs on one session id (AC-10)

In two terminals, near-simultaneously:

```bash
# terminal A
aragon exec --session-id lockme --output-format json "count slowly to twenty"
# terminal B, while A is still running
aragon exec --session-id lockme --output-format json "hi"
```

- B must exit `2` and print `session_busy` on stderr.
- A must be **unaffected** and finish normally.
- Then kill A with `SIGKILL` mid-run (`kill -9`) and immediately retry B: it
  **must** succeed, because the lock's liveness probe reclaims a lock whose pid
  is dead. If it reports `session_busy` for ten minutes, the probe is broken and
  the symptom is a hang wearing an exit code.

## 6. Permissions, including one level down (AC-11 / AC-12)

```bash
aragon exec --permission-mode strict --allow-tool read_file,grep \
  --output-format stream-json "list the files in this directory" | head -1 | jq .tools
```

- `tools` must be exactly `["read_file","grep"]`.
- The model must report that it cannot list directories rather than calling a
  tool that is not there.

```bash
aragon exec --deny-tool bash --output-format stream-json \
  "use a subagent to run 'echo hi' in a shell"
```

- No `tool_call` with `"name":"bash"` may appear anywhere in the stream —
  **including inside a `task` dispatch**. That is the case where the control
  silently would not hold.

```bash
aragon exec --permission-mode plan --output-format stream-json "how would you add OAuth?" | head -1 | jq .tools
aragon -p --plan "how would you add OAuth?"
```

- The `tools` list from the first must include `write_file`, `edit_file` and
  `bash`: plan mode keeps them registered and refuses at call time. A list
  missing them means plan mode was reimplemented as an unregister, and the model
  loses the refusal text that steers it to `submit_plan`.

**And then the half the tools list cannot show you (IF-6) — do not skip.**

```bash
aragon exec --permission-mode plan --output-format stream-json \
  "create a file called plan-probe.txt containing the word hello" \
  | jq -r 'select(.type=="tool_result") | "\(.name) isError=\(.isError)"'
ls plan-probe.txt   # must NOT exist
```

- Any `write_file` / `edit_file` / `bash` result must come back `isError=true`
  with the plan refusal, and **no file may be created**.
- This is the check that matters, because the tools list is **identical whether
  plan mode is armed or not**: the gate WRAPS rather than removes. The flag
  shipped as a silent no-op precisely because every assertion anyone had written
  — AC-15 included — looked at the list. If the file appears, `flags.plan` is
  not being set and `system/init` is reporting a `permissionMode` the run is not
  in.

## 7. Budgets (AC-16 / AC-17)

```bash
aragon exec --max-turns 2 --output-format json "read every file in src/ one at a time and summarize each"
echo "exit=$?"
```

- Exit `3`, `stopReason: "max_turns"`, `isError: false`, and `result` holds the
  partial answer.

```bash
aragon exec --max-duration 5000 --output-format json "count to one thousand slowly"
echo "exit=$?"
```

- Exit `3`, `stopReason: "timeout"`, and the **process exits within a couple of
  seconds** of the abort — a lingering process means the timer was not cleared.

```bash
aragon exec --max-turns 20 --output-format json "say hi"
echo "exit=$?"
```

- Exit **`0`**, `stopReason: "end_turn"`. A run that finishes well inside its
  ceiling must not report the ceiling. (Try `--max-turns 1` on a one-turn task
  too: still `0`.)

## 8. Interrupts — **do not skip, and do it on both platforms** (AC-18)

POSIX:

```bash
aragon exec --output-format stream-json "run 'sleep 60' with bash" &
sleep 3; kill -INT %1; wait
```

- A final `result` line with `stopReason: "interrupted"` must reach stdout.
- Exit code **130**.
- Repeat with `kill -TERM`: `stopReason: "interrupted"`, exit **143** (not 130).
- Repeat with `kill -HUP`: exit **129**.
- Press Ctrl-C **twice quickly** during a run: the second must end the process
  immediately.

Windows (PowerShell), and write down what you see:

- Ctrl-C during a run **must** produce a `result` line and exit 130.
- `taskkill /PID <pid> /F` **must not** — Node does not deliver `SIGTERM` to
  listeners there, so the process dies with no `result`. That is the documented
  behaviour, and the point of the step is to confirm the **wrapper survives it**:
  a consumer that waits only for `result` hangs here, which is why the README
  tells you to resolve on process exit as well.

## 9. Several turns from one process (AC-20)

```bash
printf '%s\n' \
  '{"type":"user","text":"reply with the number 1"}' \
  '{"type":"nonsense"}' \
  'not json at all' \
  '{"type":"user","text":"now reply with the number 2"}' \
  '{"type":"end"}' \
  '{"type":"user","text":"you must NOT answer this"}' \
| aragon exec --input-format stream-json --output-format stream-json
```

- Two assistant turns, answering 1 and 2.
- The unknown type is ignored silently; the bad line produces one stderr note.
- The message **after** `end` must never be answered.

## 10. Interop with the TUI (AC-30)

```bash
aragon exec --session-id interop --output-format json "remember: the sky is green"
aragon --resume interop            # or /resume interop inside the TUI
```

- The model must still know the sky is green (full memory).
- The transcript must be **empty** — this is the documented, deliberate outcome,
  not a bug. If you see a populated scrollback, something now writes `entries`
  and the README's Limits section is out of date.

Then the other direction, which is fully faithful:

```bash
# in the TUI: have a short conversation, then /save handover
aragon exec --resume handover --output-format json "what did we just discuss?"
```

## 11. Position of global flags

```bash
aragon --model <id> exec --output-format json "hi"
aragon exec --model <id> --output-format json "hi"
```

Both must run against the named model. The README hands callers one flat argv
array, so a rule like "globals before the subcommand" would be a footgun on the
most common invocation there is.
