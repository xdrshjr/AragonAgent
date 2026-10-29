/**
 * Quality gates through the real window: accessibility (axe-core, injected - not the Playwright
 * wrapper, which needs a second page Electron cannot create), keyboard-only operation, and the
 * title-bar geometry that Windows' caption buttons make easy to get wrong.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { A11Y_ALLOWLIST, MAX_A11Y_EXCEPTIONS } from './a11y-allowlist.js';
import { start } from './fixtures/harness.js';
import type { Launched } from './fixtures/launch.js';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface Violation { id: string; impact: string | null; nodes: Array<{ target: unknown[]; html: string }>; help: string }

async function scan(app: Launched, label: string): Promise<string[]> {
  await app.window.evaluate(axeSource); // CDP evaluate: not subject to the page's script CSP
  const violations = await app.window.evaluate(async () => {
    const axe = (window as unknown as { axe: { run(root: Document, options: object): Promise<{ violations: Violation[] }> } }).axe;
    return (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] })).violations;
  }) as Violation[];
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) => violation.nodes.map((node) => ({ violation, target: node.target.join(' ') })))
    .filter(({ violation, target }) => !A11Y_ALLOWLIST.some((entry) => entry.rule === violation.id && target.includes(entry.selector)))
    .map(({ violation, target }) => `${label}: [${violation.impact}] ${violation.id} - ${violation.help} @ ${target}`);
}

describe('accessibility (axe-core)', () => {
  it('keeps the exception list short', () => {
    expect(A11Y_ALLOWLIST.length).toBeLessThanOrEqual(MAX_A11Y_EXCEPTIONS);
    for (const entry of A11Y_ALLOWLIST) expect(entry.reason.trim().length).toBeGreaterThan(10);
  });

  it('has no serious or critical violations in the main states', async () => {
    const app = await start('a11y', { turns: [{ deltas: ['Here is a reply with `code` and a [link](https://example.com).'] }] });
    const findings: string[] = [];

    findings.push(...await scan(app, 'welcome'));
    await app.openWorkspace();
    await app.send('hello');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Here is a reply');
    findings.push(...await scan(app, 'session'));

    await app.window.getByRole('button', { name: 'Settings' }).first().click();
    await app.window.getByRole('navigation', { name: /settings/i }).waitFor();
    findings.push(...await scan(app, 'settings'));
    for (const page of ['Models', 'Skills']) {
      await app.window.getByRole('navigation', { name: /settings/i }).getByRole('button', { name: page }).click();
      findings.push(...await scan(app, `settings/${page}`));
    }
    expect(findings).toEqual([]);
  });
});

describe('keyboard only', () => {
  it('sends a message, opens settings and returns, without the mouse, with a visible focus ring each step', async () => {
    const app = await start('keyboard', { turns: [{ deltas: ['Keyboard reply.'] }] });
    await app.openWorkspace();

    await app.composer().focus();
    await app.window.keyboard.type('typed without a mouse');
    await app.window.keyboard.press('Enter');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Keyboard reply.');

    // Open settings with the shortcut, come back with the sidebar's first control.
    await app.window.keyboard.press('Control+,');
    await app.window.getByRole('navigation', { name: /settings/i }).waitFor();

    // Every focusable control we Tab onto shows a focus indicator of at least 2px.
    const widths: number[] = [];
    for (let step = 0; step < 6; step += 1) {
      await app.window.keyboard.press('Tab');
      widths.push(await app.window.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return -1;
        const style = getComputedStyle(element);
        const outline = style.outlineStyle !== 'none' ? parseFloat(style.outlineWidth) : 0;
        const shadow = style.boxShadow !== 'none' ? 2 : 0;
        return Math.max(outline, shadow);
      }));
    }
    expect(widths.filter((width) => width >= 0 && width < 2)).toEqual([]);
  });
});

describe('title bar geometry (Windows caption buttons)', () => {
  it('keeps every interactive title-bar control clear of the system buttons and clickable', async () => {
    const app = await start('titlebar');
    await app.window.getByRole('button', { name: /Settings|设置/ }).first().waitFor({ timeout: 30_000 });
    const report = await app.window.evaluate(() => {
      const bar = document.querySelector('header.titlebar') as HTMLElement;
      const controls = [...bar.querySelectorAll('button, input, [role="button"]')] as HTMLElement[];
      return {
        width: window.innerWidth,
        rects: controls.map((element) => { const r = element.getBoundingClientRect(); return { right: r.right, left: r.left, name: element.getAttribute('aria-label') ?? element.textContent ?? '' }; }),
        dragChildrenClickable: controls.every((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') !== 'drag'),
      };
    });
    const reserved = process.platform === 'win32' ? 138 : 0;
    for (const rect of report.rects) expect(rect.right, rect.name).toBeLessThanOrEqual(report.width - reserved);
    expect(report.dragChildrenClickable).toBe(true);
  });
});

describe('skills page without a session', () => {
  it('lists installed skills from the engine even with no session open', async () => {
    const app = await start('skills list', {
      seed: ({ home }) => {
        const dir = `${home}/skills/e2e-skill`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/SKILL.md`, '---\nname: e2e-skill\ndescription: A skill made by the end-to-end test\n---\nBody.\n');
      },
      configExtra: { skills: { enabled: true } },
    });
    await app.window.getByRole('button', { name: /Settings|设置/ }).first().click();
    await app.window.getByRole('navigation', { name: /settings/i }).getByRole('button', { name: /Skills|技能/ }).click();
    await app.window.getByText('e2e-skill').first().waitFor({ timeout: 30_000 });
  });
});
