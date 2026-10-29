/**
 * Contrast is COMPUTED, not eyeballed (spec 3.9.8 / AC-28): every foreground/background pair
 * the UI uses must meet its threshold in every theme, read straight from `tokens.css` so a
 * future colour edit that breaks accessibility fails here instead of shipping.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const dark = block(":root,\n:root[data-theme='dark']");
const themes: Record<string, Record<string, string>> = {
  dark,
  light: { ...dark, ...block(":root[data-theme='light']") },
  warm: { ...dark, ...block(":root[data-theme='warm']") },
};

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['bg-default', 'bg-surface-100', 'bg-surface-200', 'bg-surface-300'];

describe.each(Object.entries(themes))('%s theme', (_name, tokens) => {
  it.each(SURFACES)('body text is at least 7:1 on %s', (surface) => {
    expect(ratio(tokens['fg-default']!, tokens[surface]!)).toBeGreaterThanOrEqual(7);
  });

  it.each(SURFACES)('secondary text is at least 4.5:1 on %s', (surface) => {
    expect(ratio(tokens['fg-light']!, tokens[surface]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tokens['fg-lighter']!, tokens[surface]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)('control borders are at least 3:1 on %s', (surface) => {
    expect(ratio(tokens['border-strong']!, tokens[surface]!)).toBeGreaterThanOrEqual(3);
  });

  it('text on the brand colour is at least 4.5:1', () => {
    expect(ratio(tokens['brand-fg']!, tokens.brand!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['brand', 'destructive', 'warning', 'info'])('%s as text is at least 4.5:1 on the default surface', (name) => {
    expect(ratio(tokens[name]!, tokens['bg-default']!)).toBeGreaterThanOrEqual(4.5);
  });
});
