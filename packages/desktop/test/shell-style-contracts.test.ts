/**
 * Layout invariants of the v1.3 shell polish, asserted on the stylesheet text.
 *
 * jsdom does not lay anything out, so `getComputedStyle` cannot prove "a long title cannot widen the
 * sidebar". What CAN be proved cheaply is that the rules that make it true are present and have not
 * been edited away; the real geometry is checked by the real-window E2E (`shell-layout.e2e.ts`).
 * Each assertion names the failure it guards, because a layout regression here is silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (file: string): string => readFileSync(join(renderer, file), 'utf8');

const layout = read('layout/layout.css');
const ui = read('ui/ui.css');
const settings = read('settings/settings.css');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('P1: a long session title cannot widen the sidebar', () => {
  it('the sidebar fills its slot instead of sizing to its content', () => {
    const sidebar = rule(layout, '.sidebar');
    expect(sidebar).toMatch(/flex:\s*1 1 0/);
    expect(sidebar).toMatch(/width:\s*100%/);
    expect(sidebar).toMatch(/min-width:\s*0/);
    expect(sidebar).toMatch(/overflow:\s*hidden/);
  });

  it('the slot clips whatever is inside it, so nothing can paint over the main pane', () => {
    const slot = rule(layout, '.sidebar-slot');
    expect(slot).toMatch(/overflow:\s*hidden/);
    expect(slot).toMatch(/min-width:\s*0/);
  });

  it('rows and the scroller may shrink, and the title ellipsizes while time / pin / status keep their size', () => {
    expect(rule(layout, '.sidebar-scroll')).toMatch(/overflow-x:\s*hidden/);
    expect(rule(layout, '.slist')).toMatch(/min-width:\s*0/);
    expect(rule(layout, '.srow')).toMatch(/min-width:\s*0/);
    expect(rule(layout, '.srow-main')).toMatch(/min-width:\s*0/);
    const title = rule(layout, '.srow-title');
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/min-width:\s*0/);
    expect(rule(layout, '.srow-time')).toMatch(/flex:\s*none/);
    expect(rule(layout, '.srow-pin')).toMatch(/flex:\s*none/);
  });

  it('the hover actions fade the title out to their left instead of cutting it (AC-94)', () => {
    const fade = rule(layout, '.srow-actions::before');
    expect(fade).toMatch(/right:\s*100%/);
    expect(fade).toMatch(/linear-gradient/);
    expect(fade).toMatch(/pointer-events:\s*none/);
  });
});

describe('P2 / P3: title bar', () => {
  it('the caption-button gutter comes from the native strip, with the old 150px as the fallback', () => {
    // 142px fallback + the 8px gap = the old 150px when the environment variables are unavailable.
    expect(layout).toMatch(/env\(titlebar-area-width, calc\(100vw - 142px\)\) \+ var\(--space-2\)/);
    expect(layout).not.toMatch(/padding-right:\s*150px/);
  });
});

describe('P4: inspector', () => {
  it('the main pane keeps a floor and the inspector cannot take it back', () => {
    expect(rule(layout, '.main')).toMatch(/min-width:\s*360px/);
    const inspector = rule(layout, '.inspector');
    expect(inspector).toMatch(/min-width:\s*320px/);
    expect(inspector).toMatch(/max-width:\s*calc\(100% - var\(--rail-w\) - var\(--sidebar-slot-w, 0px\) - 360px\)/);
  });

  it('the title bar cannot widen the grid (a 694px bar in a 534px window pushed the whole layout sideways)', () => {
    expect(rule(layout, '.app')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule(layout, '.crumbs')).toMatch(/overflow:\s*hidden/);
    expect(rule(layout, '.search-trigger')).toMatch(/min-width:\s*0/);
  });

  it('the inspector resizer takes no layout width, so the inspector max-width calc stays exact', () => {
    expect(rule(layout, '.inspector-resizer')).toMatch(/margin-left:\s*-3px;\s*margin-right:\s*-2px/);
  });

  it('the tightest tier relaxes the floors rather than scrolling the page sideways', () => {
    expect(layout).toMatch(/\.body\[data-tier='3'\] \.main \{ min-width: 240px; \}/);
    expect(layout).toMatch(/\.body\[data-tier='3'\] \.inspector \{ min-width: 0;/);
  });

  it('the tab strip never wraps, shrinks or clips its own divider', () => {
    expect(rule(ui, '.tab')).toMatch(/flex:\s*none/);
    expect(rule(ui, '.tab')).toMatch(/white-space:\s*nowrap/);
    const list = rule(ui, '.tabs-list');
    expect(list).toMatch(/flex-wrap:\s*nowrap/);
    expect(list).toMatch(/overflow-x:\s*auto/);
    // Without this a tab's offsetLeft is measured from an ancestor and the reveal scrolls the strip to its end.
    expect(list).toMatch(/position:\s*relative/);
    expect(list).toMatch(/box-shadow:\s*inset 0 -1px/);
    expect(list).not.toMatch(/border-bottom/);
    expect(rule(ui, '.tab')).not.toMatch(/margin-bottom:\s*-1px/);
    expect(ui).toMatch(/\.tab\[data-state='active'\][^}]*inset 0 -2px 0 var\(--brand\)/);
  });

  it('the fade mask is dropped under forced colours', () => {
    expect(ui).toMatch(/@media \(forced-colors: active\)[^}]*mask-image:\s*none/);
  });
});

describe('P5: settings are one centred column (AC-102)', () => {
  it('the column is centred, and the wide variant is a bounded width, not a left-aligned override', () => {
    const col = rule(settings, '.settings-col');
    expect(col).toMatch(/width:\s*min\(100%, 760px\)/);
    expect(col).toMatch(/margin-inline:\s*auto/);
    const wide = rule(settings, '.settings-col[data-wide]');
    expect(wide).toMatch(/width:\s*min\(100%, 920px\)/);
    expect(wide).not.toMatch(/margin-left:\s*0/);
  });

  it('pages no longer cap themselves at a left-aligned max-width', () => {
    expect(rule(settings, '.set-page')).not.toMatch(/max-width/);
  });

  it('all four bands reserve the same scrollbar gutter, so the column edges line up (RV-12)', () => {
    expect(rule(settings, '.settings-scroll')).toMatch(/scrollbar-gutter:\s*stable both-edges/);
    expect(rule(settings, '.settings-head, .settings-stale-slot, .set-footer')).toMatch(/scrollbar-gutter:\s*stable both-edges/);
    expect(rule(settings, '.settings-head, .settings-stale-slot, .set-footer')).toMatch(/overflow:\s*hidden/);
  });
});

describe('no new raw colours in the shell stylesheets (AC-104)', () => {
  it('layout / ui / settings css use tokens only', () => {
    // The modal backdrop's translucent black predates v1.3 and is the one deliberate exception.
    const withoutBackdrop = (css: string): string => css.replace(/^\.overlay-backdrop .*$/m, '');
    for (const [name, css] of [['layout.css', layout], ['ui.css', ui], ['settings.css', settings]] as const) {
      expect(withoutBackdrop(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], name).toEqual([]);
      expect(withoutBackdrop(css).match(/\brgba?\(/g) ?? [], name).toEqual([]);
    }
  });
});
