import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands/registry.js';
import { BUILTIN_COMMAND_NAMES, registerBuiltinCommands } from '../commands/builtins.js';
import { makeSkillsCommand, registerSkillCommands } from '../commands/skills.js';
import { slashSuggestions } from '../ui/PromptInput.js';
import type { CommandContext } from '../commands/registry.js';
import type { SkillService } from '../skills/service.js';
import type { SkillRecord } from '@aragon-agent/core';
import { normalizeFrontmatter } from '@aragon-agent/core/skills';

function record(input: {
  name: string;
  description?: string;
  activation?: string;
  disabled?: boolean;
  invalid?: boolean;
  scope?: SkillRecord['scope'];
  writable?: boolean;
  allowedTools?: string[];
}): SkillRecord {
  const description = input.description ?? `Does ${input.name}. Use when asked about ${input.name}.`;
  const frontmatter = normalizeFrontmatter(
    {
      name: input.name,
      description,
      version: '1.0.0',
      ...(input.activation ? { activation: input.activation } : {}),
      ...(input.allowedTools ? { 'allowed-tools': input.allowedTools } : {}),
    },
    input.name,
  );
  return {
    name: input.name,
    description,
    scope: input.scope ?? 'user',
    dir: `/skills/${input.name}`,
    entryPath: `/skills/${input.name}/SKILL.md`,
    frontmatter,
    body: null,
    files: null,
    bytes: 10,
    disabled: input.disabled ?? false,
    issues: [],
    invalid: input.invalid ?? false,
    shadowed: [],
    manifest: null,
    writable: input.writable ?? true,
    // `manifest: null` above is what makes `'unverified'` the only consistent
    // value: there is nothing to verify SKILL.md against (W3).
    integrity: 'unverified',
  };
}

interface FakeServiceOptions {
  toolPolicy?: 'off' | 'warn' | 'enforce';
  /** Where `effectiveToolPolicy()` says the mode came from — drives the P1-1 copy. */
  from?: 'session' | 'flag' | 'config';
}

function fakeService(records: SkillRecord[], opts: FakeServiceOptions = {}): SkillService {
  const activeNames: string[] = [];
  const pendingFrames: string[] = [];
  const activeFrames: string[] = [];
  let mode = opts.toolPolicy ?? 'enforce';
  let from = opts.from ?? 'config';
  const service = {
    list: () => records,
    get: (name: string) => records.find((r) => r.name === name),
    untrustedDirs: () => [],
    errors: () => [],
    loadBody: (name: string) => ({
      body: `# ${name}\n\nUse $1 and $ARGUMENTS.`,
      files: [{ path: 'reference/a.md', bytes: 10 }],
    }),
    getRegistry: () => ({
      activeNames,
      activate: (n: string) => {
        activeNames.push(n);
        return false;
      },
      isActive: (n: string) => activeNames.includes(n),
    }),
    setDisabled: vi.fn(),
    reload: vi.fn(),
    // ── Tool ceiling surface (§5) ────────────────────────────────────────
    queueFrame: (n: string) => pendingFrames.push(n),
    frameNames: () => [...activeFrames],
    clearFrames: () => {
      activeFrames.length = 0;
      pendingFrames.length = 0;
    },
    bodyMaxBytes: () => 30_000,
    effectiveToolPolicy: () => ({ mode, from }),
    setSessionToolPolicy: (m: typeof mode) => {
      mode = m;
      from = 'session';
    },
    persistToolPolicy: vi.fn(),
    pendingToolPolicyView: () => undefined,
    getApproval: () => ({ canPrompt: () => false, request: async () => false }),
  };
  // Exposed so a test can put a skill INTO the frame without going through the
  // real registry, which this fake deliberately does not implement.
  (service as unknown as { __enterFrame: (n: string) => void }).__enterFrame = (n: string) => {
    activeFrames.push(n);
  };
  return service as unknown as SkillService;
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext & {
  notices: Array<[string, string]>;
  submitted: string[];
} {
  const notices: Array<[string, string]> = [];
  const submitted: string[] = [];
  return {
    args: '',
    controller: {
      getConfig: () => ({ colorLevel: 3, unicode: true }),
      getCwd: () => '/work',
      listTools: () => [{ name: 'read_file' }, { name: 'write_file' }, { name: 'bash' }],
    },
    state: { entries: [] },
    dispatch: vi.fn(),
    setOverlay: vi.fn(),
    notify: (level: string, text: string) => notices.push([level, text]),
    toast: (level: string, text: string) => notices.push([`toast:${level}`, text]),
    persistConfig: vi.fn(),
    exit: vi.fn(),
    submit: (text: string) => submitted.push(text),
    refreshSkills: vi.fn(),
    notices,
    submitted,
    ...overrides,
  } as unknown as CommandContext & { notices: Array<[string, string]>; submitted: string[] };
}

describe('registerSkillCommands — dynamic registration (§7.1)', () => {
  it('registers both the bare and the namespaced form for a free name', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    registerSkillCommands(registry, fakeService([record({ name: 'pdf-forms' })]));

    expect(registry.get('pdf-forms')).toBeDefined();
    expect(registry.get('skill:pdf-forms')).toBeDefined();
  });

  it('uses the skill description as the completion hint, truncated', () => {
    const registry = new CommandRegistry();
    registerSkillCommands(
      registry,
      fakeService([record({ name: 'x', description: 'y'.repeat(200) })]),
    );
    expect(registry.get('x')!.description.length).toBeLessThanOrEqual(60);
  });

  it('skips disabled, invalid and manual skills', () => {
    const registry = new CommandRegistry();
    registerSkillCommands(
      registry,
      fakeService([
        record({ name: 'off', disabled: true }),
        record({ name: 'broken', invalid: true }),
        record({ name: 'hidden', activation: 'manual' }),
      ]),
    );
    for (const name of ['off', 'broken', 'hidden']) {
      expect(registry.get(name)).toBeUndefined();
      expect(registry.get(`skill:${name}`)).toBeUndefined();
    }
  });

  it('D6: a skill cannot displace a built-in PRIMARY name', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const builtinHelp = registry.get('help');
    registerSkillCommands(registry, fakeService([record({ name: 'help' })]));

    expect(registry.get('help')).toBe(builtinHelp);
    expect(registry.get('skill:help')).toBeDefined();
  });

  it('AC-18: a skill cannot displace a built-in ALIAS either', () => {
    // The regression this pins: `all()` de-dupes by command object and returns
    // primary names only, so an alias-based conflict check silently passes and
    // `/quit` gets hijacked. `registry.get()` is the only probe that sees it.
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const builtinExit = registry.get('exit');
    expect(registry.get('quit')).toBe(builtinExit);
    expect(registry.all().map((c) => c.name)).not.toContain('quit');

    registerSkillCommands(registry, fakeService([record({ name: 'quit' })]));

    expect(registry.get('quit')).toBe(builtinExit);
    expect(registry.get('skill:quit')).toBeDefined();
    expect(registry.get('skill:quit')).not.toBe(builtinExit);
  });

  it('BUILTIN_COMMAND_NAMES includes aliases', () => {
    expect(BUILTIN_COMMAND_NAMES).toContain('exit');
    expect(BUILTIN_COMMAND_NAMES).toContain('quit');
  });
});

describe('a dynamic skill command submits a user message (§7.1 / AC-4)', () => {
  it('notifies, then submits an invocation containing the substituted body', async () => {
    const registry = new CommandRegistry();
    const service = fakeService([record({ name: 'pdf-forms' })]);
    registerSkillCommands(registry, service);

    const ctx = makeCtx({ args: 'invoice.pdf --flatten' });
    await registry.get('pdf-forms')!.run(ctx);

    expect(ctx.notices.some(([, text]) => text.includes('Skill "pdf-forms" loaded'))).toBe(true);
    expect(ctx.submitted).toHaveLength(1);
    const message = ctx.submitted[0]!;
    expect(message).toContain('<skill name="pdf-forms"');
    expect(message).toContain('Use invoice.pdf and invoice.pdf --flatten.');
    expect(message).toContain('The user invoked this skill directly.');
  });

  it('reports a load failure instead of submitting a broken message', async () => {
    const registry = new CommandRegistry();
    const service = fakeService([record({ name: 'x' })]);
    (service as unknown as { loadBody: () => never }).loadBody = () => {
      throw new Error('EACCES');
    };
    registerSkillCommands(registry, service);

    const ctx = makeCtx();
    await registry.get('x')!.run(ctx);
    expect(ctx.submitted).toHaveLength(0);
    expect(ctx.notices.some(([level, text]) => level === 'error' && text.includes('EACCES'))).toBe(true);
  });
});

describe('/skills listing (§7.2)', () => {
  it('says so plainly when nothing is installed', async () => {
    const ctx = makeCtx();
    await makeSkillsCommand(fakeService([]), '0.0.0').run(ctx);
    expect(ctx.notices[0]![1]).toContain('No skills installed.');
  });

  it('marks active, disabled, invalid and shadowed entries', async () => {
    const shadowed = record({ name: 'shady' });
    shadowed.shadowed = [{ scope: 'user', dir: '/user/shady' }];
    const ctx = makeCtx();
    await makeSkillsCommand(
      fakeService([
        record({ name: 'good' }),
        record({ name: 'off', disabled: true }),
        record({ name: 'broken', invalid: true }),
        shadowed,
      ]),
      '0.0.0',
    ).run(ctx);

    const output = ctx.notices[0]![1];
    expect(output).toContain('good');
    expect(output).toContain('off');
    expect(output).toContain('broken');
    expect(output).toContain('~shadowed by user');
    expect(output).toContain('4 skills');
  });

  it('/skills info reports the identity and the source', async () => {
    const ctx = makeCtx({ args: 'info good' });
    await makeSkillsCommand(fakeService([record({ name: 'good' })]), '0.0.0').run(ctx);
    const output = ctx.notices[0]![1];
    expect(output).toContain('good v1.0.0 (user)');
    expect(output).toContain('Source: hand-authored');
  });

  it('/skills remove refuses a read-only scope', async () => {
    const ctx = makeCtx({ args: 'remove builtin' });
    await makeSkillsCommand(
      fakeService([record({ name: 'builtin', scope: 'bundled', writable: false })]),
      '0.0.0',
    ).run(ctx);
    expect(ctx.notices.some(([, text]) => text.includes('Cannot remove a bundled skill.'))).toBe(true);
  });

  it('an unknown subcommand lists the valid ones', async () => {
    const ctx = makeCtx({ args: 'frobnicate' });
    await makeSkillsCommand(fakeService([]), '0.0.0').run(ctx);
    expect(ctx.notices[0]![1]).toContain('Unknown subcommand');
  });
});

describe('D16 — slash suggestions reach kebab-case and namespaced skills', () => {
  const commands = [
    { name: 'help', description: 'Show help' },
    { name: 'my-skill', description: 'A skill' },
    { name: 'skill:my-skill', description: 'A skill' },
  ];

  it('matches a hyphenated prefix (the old \\w-only regex returned null)', () => {
    expect(slashSuggestions('/my-sk', commands)?.map((s) => s.label)).toEqual(['/my-skill']);
  });

  it('matches the skill: namespace prefix', () => {
    expect(slashSuggestions('/skill:', commands)?.map((s) => s.label)).toEqual(['/skill:my-skill']);
  });

  it('still refuses once a space is typed', () => {
    expect(slashSuggestions('/my-skill arg', commands)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /skills policy · unload · usage  (§5.5 / §5.6 / §9)
// ---------------------------------------------------------------------------

/** Pull the last notice body out of a context. */
const lastNotice = (ctx: { notices: Array<[string, string]> }): string =>
  ctx.notices[ctx.notices.length - 1]?.[1] ?? '';

describe('/skills policy (§5.5 / P1-1)', () => {
  it('with no argument it reports the mode AND where it came from', () => {
    // "Where from" is the part that matters: a user staring at an unexpected
    // refusal needs to know whether a flag, a config file or this session set it.
    const service = fakeService([record({ name: 'a' })], { toolPolicy: 'warn', from: 'flag' });
    const ctx = makeCtx({ args: 'policy' });
    void makeSkillsCommand(service, '0.0.0').run(ctx);
    expect(lastNotice(ctx)).toContain('Tool policy: warn (from flag)');
    expect(lastNotice(ctx)).toContain('No tool ceiling in effect this turn');
  });

  it('setting a mode writes the SESSION slot as well as the file', async () => {
    // Persisting only is P1-1 exactly: the refusal text tells the user to run
    // this command, and with a flag in play nothing would happen and nothing
    // would be said.
    const service = fakeService([record({ name: 'a' })], { toolPolicy: 'enforce', from: 'flag' });
    const ctx = makeCtx({ args: 'policy off' });
    await makeSkillsCommand(service, '0.0.0').run(ctx);
    expect(service.effectiveToolPolicy()).toEqual({ mode: 'off', from: 'session' });
    expect(service.persistToolPolicy).toHaveBeenCalledWith('off');
    expect(lastNotice(ctx)).toContain('enforce -> off');
    expect(lastNotice(ctx)).toContain('overriding --skill-tool-policy');
  });

  it('does not claim to override a flag when there was none', async () => {
    const service = fakeService([record({ name: 'a' })], { toolPolicy: 'enforce', from: 'config' });
    const ctx = makeCtx({ args: 'policy warn' });
    await makeSkillsCommand(service, '0.0.0').run(ctx);
    expect(lastNotice(ctx)).not.toContain('overriding');
  });

  it('rejects an unknown mode and lists the real ones', async () => {
    const ctx = makeCtx({ args: 'policy strict' });
    await makeSkillsCommand(fakeService([]), '0.0.0').run(ctx);
    expect(lastNotice(ctx)).toContain('Unknown policy "strict"');
    expect(lastNotice(ctx)).toContain('off, warn, enforce');
  });
});

describe('/skills unload (§5.1 / P2-8)', () => {
  it('says outright that it does not reclaim context', async () => {
    // The name reads like "take this skill back out of my context", which is not
    // something anything can do — the body is already in the history. Renaming
    // would strand every reader of the current README, so the text carries it.
    const service = fakeService([record({ name: 'a' })]);
    (service as unknown as { __enterFrame: (n: string) => void }).__enterFrame('a');
    const ctx = makeCtx({ args: 'unload' });
    await makeSkillsCommand(service, '0.0.0').run(ctx);
    expect(lastNotice(ctx)).toContain('Tool ceiling cleared (was: a)');
    expect(lastNotice(ctx)).toContain('does NOT remove the skill text');
  });

  it('is a no-op with a clear message when nothing was in force', async () => {
    const ctx = makeCtx({ args: 'unload' });
    await makeSkillsCommand(fakeService([]), '0.0.0').run(ctx);
    expect(lastNotice(ctx)).toContain('No skill was constraining this turn');
  });
});

describe('/skills info declared-tools states (§5.6b / P0-3)', () => {
  function infoFor(rec: SkillRecord, opts: FakeServiceOptions = {}): string {
    const ctx = makeCtx({ args: `info ${rec.name}` });
    void makeSkillsCommand(fakeService([rec], opts), '0.0.0').run(ctx);
    return ctx.notices.map(([, t]) => t).join('\n');
  }

  it('never says the bare word "enforced", and never says "advisory"', () => {
    // The scope is a TURN and the ceiling is a UNION that a second skill can
    // widen (D-G17). A flat "enforced" would be this iteration re-committing the
    // overclaim it exists to retire; "advisory" is the word that caused it.
    const out = infoFor(record({ name: 'a', allowedTools: ['read_file'] }));
    expect(out).toContain('Declared tools (enforced this turn, union with other loaded skills)');
    expect(out).not.toContain('advisory');
  });

  it('off says plainly that nothing is enforced', () => {
    const out = infoFor(record({ name: 'a', allowedTools: ['read_file'] }), { toolPolicy: 'off' });
    expect(out).toContain('not enforced - skills.toolPolicy=off');
  });

  it('an unknown tool name is called out as NOT ENFORCEABLE', () => {
    const out = infoFor(record({ name: 'a', allowedTools: ['Reed'] }));
    expect(out).toContain('NOT ENFORCEABLE');
    expect(out).toContain('"Reed"');
    expect(out).toContain('imposes no ceiling');
  });

  it('a tool this host lacks is reported as ignored, not as a failure', () => {
    const out = infoFor(record({ name: 'a', allowedTools: ['read_file', 'WebFetch'] }));
    expect(out).toContain('enforced this turn');
    expect(out).toContain('WebFetch is not a tool on this host');
  });

  it('an activation: always skill is told its declaration never applies (D-G9)', () => {
    // The author wrote a permission intent that the system ignores wholesale.
    // Nothing else in the UI would say so.
    const out = infoFor(
      record({ name: 'ambient', allowedTools: ['read_file'], activation: 'always' }),
    );
    expect(out).toContain('never enforced - activation: always is exempt');
  });
});

describe('/skills footer ceiling line (§5.6c)', () => {
  /** Frame a skill without going through the real registry, which the fake omits. */
  const frame = (service: SkillService, name: string): void =>
    (service as unknown as { __enterFrame: (n: string) => void }).__enterFrame(name);

  const footerFor = (service: SkillService): string => {
    const ctx = makeCtx({ args: '' });
    void makeSkillsCommand(service, '0.0.0').run(ctx);
    return lastNotice(ctx);
  };

  it('appears only when a framed skill actually declares something', () => {
    const service = fakeService([record({ name: 'pdf-forms', allowedTools: ['read_file'] })]);
    expect(footerFor(service)).not.toContain('Tool ceiling this turn');

    frame(service, 'pdf-forms');
    expect(footerFor(service)).toContain(
      'Tool ceiling this turn: read_file (+ read-only) - from pdf-forms',
    );
  });

  it('says nothing while the policy is off — there is no ceiling to report', () => {
    // Reading `allowedTools` straight off the record would announce a ceiling
    // here, in the tier whose entire definition is that nothing is enforced, and
    // in the same breath as `/skills info`'s "not enforced - skills.toolPolicy=off".
    const service = fakeService([record({ name: 'pdf-forms', allowedTools: ['read_file'] })], {
      toolPolicy: 'off',
    });
    frame(service, 'pdf-forms');
    expect(footerFor(service)).not.toContain('Tool ceiling this turn');
  });

  it('says nothing for a declaration D-G4 waived, and /skills policy explains why', () => {
    // One unresolvable name waives the whole skill, so this frame constrains
    // nothing. Reporting a ceiling of `Reed` would contradict the NOT ENFORCEABLE
    // line `info` and `doctor` print for the same skill (RG3).
    const service = fakeService([record({ name: 'typo', allowedTools: ['Reed'] })]);
    frame(service, 'typo');
    expect(footerFor(service)).not.toContain('Tool ceiling this turn');

    const ctx = makeCtx({ args: 'policy' });
    void makeSkillsCommand(service, '0.0.0').run(ctx);
    expect(lastNotice(ctx)).toContain('No tool ceiling in effect this turn.');
    expect(lastNotice(ctx)).toContain('Not enforceable: "typo" declares unknown tools (Reed).');
  });

  it('reports Claude Code names as the local tools they map to', () => {
    // The frontmatter says `Read`; the ceiling is on `read_file`. Echoing the
    // declaration would name a tool that does not exist on this host.
    const service = fakeService([record({ name: 'community', allowedTools: ['Read', 'Bash'] })]);
    frame(service, 'community');
    expect(footerFor(service)).toContain('Tool ceiling this turn: bash, read_file (+ read-only)');
  });
});

describe('the dynamic /<skill-name> command (§6 / D-G2)', () => {
  it('queues the frame instead of entering it', () => {
    // `ctx.submit()` becomes the user message that OPENS the turn this skill
    // should constrain, and `prompt()` clears the frame on the way in. Entering
    // here would leave that one turn — the one the user explicitly asked for —
    // as the only unconstrained one.
    const service = fakeService([record({ name: 'pdf-forms' })]);
    const registry = new CommandRegistry();
    registerSkillCommands(registry, service);
    void registry.get('pdf-forms')!.run(makeCtx({ args: 'invoice.pdf' }));
    expect(service.frameNames()).toEqual([]);
    expect(service.queueFrame).toBeDefined();
  });

  it('reports the SUBMITTED byte count, not the file size (§6)', () => {
    // Saying "loaded 480 KB" while submitting 30 KB is how a user concludes the
    // truncation marker is a rendering glitch.
    const service = fakeService([record({ name: 'pdf-forms' })]);
    const registry = new CommandRegistry();
    registerSkillCommands(registry, service);
    const ctx = makeCtx({ args: '' });
    void registry.get('pdf-forms')!.run(ctx);
    expect(ctx.notices.some(([, t]) => t.includes('KB submitted'))).toBe(true);
  });
});
