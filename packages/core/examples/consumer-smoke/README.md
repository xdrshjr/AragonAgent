# consumer-smoke — run the built artifact like an external consumer

This directory holds `run.mjs`, the **reuse-verification** smoke (deliverable D1
+ D2). It answers the one question `examples/minimal.ts` (compile-only) cannot:

> Can another project that does `npm install @aragon-agent/core` actually **run**
> the engine from the built `dist/`?

## How it works

`run.mjs` is plain Node ESM (`.mjs`). It imports the package **by its own name**
(`@aragon-agent/core`) using Node's *package self-referencing* feature, so Node
resolves the import through `package.json#exports` → `./dist/index.js` — the
exact `(exports map + NodeNext + .js extension)` path an external consumer hits,
**without** the package ever being placed in `node_modules`.

It then injects a **stub `LLMProvider`** (a fixed, offline `StreamEvent` stream)
through the public DI seam (`ProviderRegistry`), constructs an `AragonAgent`, and
runs one `prompt()` turn end-to-end. The assertions require **success-only
signals** (`turn_end` + an assistant message carrying the stub text), not just
`agent_start` / `agent_end` — because the engine swallows loop errors and always
emits `agent_end` in `finally`, so lifecycle events alone would admit a false
green (see spec §4.1.1).

Finally it dynamically `import()`s every `exports` subpath (`./llm/types`,
`./llm/providers`, `./tools/types`, `./tools/helpers`) to assert the subpath map
resolves at runtime (D2).

Everything runs **offline** — no network request is ever made.

## Run it

From the package directory (`packages/core/`):

```bash
npm run verify:dist
```

That builds `dist/` first, then runs this script. Success prints
`[consumer-smoke] OK` and exits 0; any failure exits non-zero.

To run the script alone against an already-built `dist/`:

```bash
node examples/consumer-smoke/run.mjs
```

## Scope (RV-3)

`verify:dist` runs **inside** the package, where `ajv` and `isolated-vm` are
present as `devDependencies`, and this smoke deliberately avoids exercising them
(the stub tool is registered but never executed, and `sandbox/*` is never
imported). So it does **not** prove the "optional dependency missing" branch.
That branch is covered by the golden check below.

## Optional golden verification (manual — true `npm install` reuse)

The self-reference smoke covers `exports` / NodeNext / `.js` resolution. To prove
reuse with **zero dev-dependencies present** (the real downstream condition), pack
the package and install the tarball into a throwaway project:

```bash
# from packages/core/
npm run build
npm pack                      # produces aragon-agent-core-<version>.tgz

# in a fresh temp directory:
npm init -y
npm i /absolute/path/to/aragon-agent-core-<version>.tgz
node --input-type=module -e "import('@aragon-agent/core').then(m => console.log('OK', typeof m.AragonAgent))"
# expect: OK function
```

This is the unambiguous "another project reuses it" proof. It is kept manual
(not part of the automatic gate) because the pack-install round trip is heavier
and occasionally flaky on Windows; `npm run verify:dist` is the everyday gate.
