'use client';

/**
 * The AragonAgent brand mark, ported from the TUI (`packages/cli/src/ui/Logo.tsx`
 * + `palettes.ts`): the block-art wordmark with the per-row rotated gradient
 * sheen, and the small `◇ AragonAgent` header wordmark.
 *
 * Same art, same stops (#d08c60 / #c9a227 / #b0916a), same diagonal rotation
 * (shift by one stop per row) - rendered with CSS gradients instead of ANSI.
 */

const LOGO_ART: readonly string[] = [
  ' █████╗ ██████╗  █████╗  ██████╗  ██████╗ ███╗   ██╗',
  '██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔═══██╗████╗  ██║',
  '███████║██████╔╝███████║██║  ███╗██║   ██║██╔██╗ ██║',
  '██╔══██║██╔══██╗██╔══██║██║   ██║██║   ██║██║╚██╗██║',
  '██║  ██║██║  ██║██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║',
  '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝',
];

/** TUI light-theme brand colors (palettes.ts). */
export const BRAND = {
  primary: '#d08c60',
  gradient: ['#d08c60', '#c9a227', '#b0916a'] as const,
};

/** Rotate the stops by one per row - the TUI's diagonal sheen (shiftStops). */
function shifted(stops: readonly string[], row: number): string[] {
  const at = row % stops.length;
  return [...stops.slice(at), ...stops.slice(0, at)];
}

export function AragonArtLogo({ scale = 1 }: { scale?: number }) {
  return (
    <div
      aria-label="AragonAgent"
      style={{
        display: 'inline-block',
        fontFamily: 'var(--font-mono)',
        fontSize: 10 * scale,
        lineHeight: 1.15,
        userSelect: 'none',
        whiteSpace: 'pre',
      }}
    >
      {LOGO_ART.map((line, row) => (
        <div
          key={row}
          style={{
            background: `linear-gradient(90deg, ${shifted(BRAND.gradient, row).join(', ')})`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

export function AragonWordmark({ size = 15 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 7,
        color: BRAND.primary,
        fontWeight: 600,
        fontSize: size,
        letterSpacing: '-0.01em',
      }}
    >
      <span style={{ fontSize: size * 1.05, lineHeight: 1 }}>◇</span>AragonAgent
    </span>
  );
}
