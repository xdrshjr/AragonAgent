---
name: skill-creator
description: Author a new AragonAgent skill. Use when the user asks to save a procedure as a skill, or when you notice you have re-derived the same multi-step process twice in a session.
version: 1.1.0
license: MIT
activation: auto
keywords: [meta, authoring, skills]
# Enforced as a per-turn tool ceiling. `edit_file` is here because revising an
# existing skill is the single most common thing this skill is asked to do —
# without it, "fix the description on my deploy skill" fails on the first edit.
allowed-tools:
  - read_file
  - write_file
  - edit_file
  - list_dir
  - skill_create
---

# Skill Creator

Write a skill that another model instance will actually reach for at the right
moment. Most bad skills are not badly written; they are badly *described* and
badly *scoped*.

## When to use

- The user says "remember how to do this", "save this as a skill", or similar.
- You have worked out a non-obvious, repeatable procedure and expect to need it
  again.
- You notice you have rediscovered the same steps twice in one session.

Do **not** create a skill for a one-off task, for something the tools already do
directly, or for general knowledge the model already has.

## The one rule that matters most

`description` is the only text a future model sees before deciding whether to
load your skill. Everything else is invisible until then. So it must answer two
questions in one or two sentences:

1. **What does this do?**
2. **When should it be used?** — in the words a user would actually type.

Compare:

- Weak: `Helps with PDFs.`
- Strong: `Fill, flatten and validate AcroForm PDFs. Use when the task mentions
  PDF forms, field filling, or flattening a fillable PDF.`

The second one will be picked up on a task that says "flatten this fillable
invoice". The first one will not.

## Writing the body

- Use imperative steps, not background prose. The reader is an agent about to
  act, not a student.
- Keep the body under about 5 000 characters. It is loaded whole, every time the
  skill is used, so length is a recurring cost paid by every future run.
- Push long reference material into `reference/*.md` and executable steps into
  `scripts/*`. Those are NOT preloaded — the model reads them on demand with
  `read_file` or runs them with `bash`. That is the whole point of the three
  levels, and it is what makes fifty installed skills cost a few thousand
  characters instead of hundreds of thousands.
- Say what "done" looks like, and what to do when a step fails.

## Things that do not belong in a skill

- Hostnames, IP addresses, repository URLs, absolute paths from your machine.
- API keys, tokens, or anything else secret. Skills are plain files that get
  copied between machines and committed to repositories.
- Anything that only made sense in the conversation you are in right now.

## Steps

1. Confirm the scope with the user in one sentence: what the skill does and when
   it fires.
2. Draft the `description` first and read it back critically. Would a model
   with only that line pick this skill for the task you have in mind?
3. Write the body as numbered imperative steps.
4. Split anything long or reusable into `reference/` and `scripts/` entries and
   pass them as `files`.
5. Call `skill_create` with `name`, `description`, `body`, and any `files`.
6. Immediately call `skill(name="<your-new-skill>")` to read back what you
   actually wrote. This catches truncated bodies and mangled frontmatter while
   you can still fix them.

## Naming

Lowercase kebab-case, at most 64 characters: `pdf-forms`, `release-notes`,
`db-migration-review`. The name becomes a slash command (`/pdf-forms`), so it
should read as a thing, not as a sentence.

If the name collides with a built-in command, the built-in wins and your skill
is reachable as `/skill:<name>` instead — so avoid `help`, `model`, `settings`,
`tools`, `clear`, `reset`, `cwd`, `save`, `resume`, `copy`, `theme`, `thinking`,
`expand`, `skills`, `exit` and `quit`.
