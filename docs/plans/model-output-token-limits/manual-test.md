# Model Output Token Limits — Manual Acceptance

> Companion to `spec.md` §9. The automated suite covers everything that can be
> asserted without a provider key; what is left here needs a real API key, a real
> terminal, or both.
>
> Config file on the reference machine: `C:\Users\jdqqj\.aragon-agent\config.json`
> (`aragon config path` prints it; `$ARAGON_HOME` overrides the directory).

## Preconditions

```powershell
cd M:/takoAI/JRAgentMesh/aragon-agent-core
npm run build
```

Back up the config file before M1 and M3, which delete or overwrite it:

```powershell
Copy-Item "$env:USERPROFILE\.aragon-agent\config.json" "$env:USERPROFILE\.aragon-agent\config.json.bak"
```

---

## M1 — A fresh install shows the default, and says it is the default

1. Delete `config.json`.
2. Run `aragon`.
3. `/settings`.

**Expected:** `Max tokens` reads `64000`, and the row under the field list reads
`Effective: 64000` (the model is `claude-sonnet-4-5-20250929`, whose ceiling is
also 64000, so there is no clamp note).

**Result:** ☐ pass ☐ fail — notes:

---

## M2 — A small model completes instead of returning a 400

```powershell
aragon --model gpt-4o --provider openai -p "write 100 words about the sea"
```

**Expected:** the run completes and prints an answer. No `400`, no
`invalid_request_error`, and no "output cap adjusted" warning — `gpt-4o` is in the
static table, so the clamp to 16384 happens before the request leaves.

**Result:** ☐ pass ☐ fail — notes:

---

## M3 — A hand-edited config file is picked up by `/reload`

1. With `aragon` running, edit `config.json` in another window and set
   `"maxTokens": 4096`.
2. In the TUI: `/reload`, then `/max-tokens`.

**Expected:** `/max-tokens` reports `Max tokens: 4096.` and an effective cap of
`4096`.

**Result:** ☐ pass ☐ fail — notes:

---

## M4 — `--thinking xhigh` no longer fails on every request

```powershell
aragon --thinking xhigh -p "hello"
```

**Expected:** the run completes. Before this change the request carried
`max_tokens: 64000` alongside `budget_tokens: 65536`, and Anthropic requires the
first to be strictly greater than the second — every single `xhigh` request was
rejected. The resolver now lowers the budget to 59904.

**Result:** ☐ pass ☐ fail — notes:

---

## M5 — An unknown model self-heals once and then stays quiet

Point `--base-url` at a proxy serving a model with a ceiling below 64000 (LiteLLM,
OpenRouter, Ollama, or an Azure deployment will do).

```powershell
aragon --base-url http://localhost:4000 --model <small-model> --provider openai
```

1. Send a first message.
2. Send a second message.

**Expected:** the first turn shows exactly one warning line of the form
`[Openai] output cap adjusted 64000 -> <n> (exceeds_ceiling) for <model>` and then
completes normally. The second turn shows no warning at all — the ceiling was
learned from the provider's own error and is remembered for the rest of the
session.

**Result:** ☐ pass ☐ fail — notes:

---

## M6 — AUTO tracks the selected model

1. `aragon config set maxTokens auto` (expect `Set maxTokens = auto`).
2. `aragon config get maxTokens` (expect `auto`, not `null`).
3. Start `aragon`, run `/max-tokens`.
4. `/model`, switch to `gpt-4o`, then `/max-tokens` again.

**Expected:** step 3 reports `Max tokens: auto.` with an effective cap of 64000;
step 4 reports `Max tokens: auto.` with an effective cap of 16384 and names the
`gpt-4o` ceiling.

**Result:** ☐ pass ☐ fail — notes:

---

## M7 — The clamp is honest in both directions

```powershell
aragon config set maxTokens 900000
aragon config get maxTokens
aragon config set maxTokens abc
aragon config set maxTokens default
```

**Expected:** the first prints `Set maxTokens = 200000` (the value that was
actually stored, not the one typed), `get` confirms `200000`, `abc` is refused on
stderr with a non-zero exit code and changes nothing, and `default` restores
`64000`.

**Result:** ☐ pass ☐ fail — notes:

---

## M8 — A bad `Max tokens` field does not discard the rest of the form

1. `/settings`, paste an API key into the `API key` field.
2. Set `Max tokens` to `abc`.
3. Press Enter.

**Expected:** a `warn` toast reading `Max tokens must be a number or "auto".`, the
overlay closes, the API key IS saved, and `maxTokens` in `config.json` is
unchanged from what it was before.

**Result:** ☐ pass ☐ fail — notes:

---

## Cleanup

```powershell
Move-Item -Force "$env:USERPROFILE\.aragon-agent\config.json.bak" "$env:USERPROFILE\.aragon-agent\config.json"
```
