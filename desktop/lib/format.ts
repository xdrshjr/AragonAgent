/** Pure display helpers: durations, token counts, sizes, model suggestions. */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function formatCost(amount: number, known: boolean): string {
  if (!known || amount <= 0) return '';
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

/** Shorten a directory for chip display: keep drive/root + last two segments. */
export function shortenDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-2).join('/')}`;
}

/** Common model ids per mode, offered as datalist suggestions (editable free text). */
export const MODEL_SUGGESTIONS: Record<'anthropic' | 'openai' | 'custom', string[]> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'claude-3-7-sonnet-latest',
  ],
  openai: ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1', 'o4-mini'],
  custom: ['deepseek-chat', 'deepseek-reasoner', 'qwen-max', 'glm-4.6', 'kimi-k2'],
};

export const MODE_META: Record<
  'anthropic' | 'openai' | 'custom',
  { label: string; blurb: string; keyHint: string }
> = {
  anthropic: {
    label: 'Anthropic',
    blurb: 'Claude models over the Anthropic API.',
    keyHint: 'ANTHROPIC_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    blurb: 'GPT models over the OpenAI API.',
    keyHint: 'OPENAI_API_KEY',
  },
  custom: {
    label: 'Custom',
    blurb: 'Any OpenAI-compatible endpoint: DeepSeek, Qwen, local gateways...',
    keyHint: 'OPENAI_API_KEY',
  },
};

export function isRunning(phase: string): boolean {
  return phase === 'running' || phase === 'starting';
}
