/**
 * The product mark: a rounded square with a `>` prompt and the brand dot. Drawn from tokens only, so
 * it is correct in every theme. One geometry, shared by the title bar and the empty state.
 */

import { useT } from '../i18n/index.js';

export function BrandMark({ size = 20, className }: { size?: number; className?: string }) {
  const t = useT();
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 56 56" role="img" aria-label={t('shell.app')}>
      <rect width="56" height="56" rx="14" fill="var(--bg-surface-200)" stroke="var(--border-default)" />
      <path d="M19 19l12 9-12 9" fill="none" stroke="var(--fg-default)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="38" cy="38" r="4" fill="var(--brand)" />
    </svg>
  );
}
