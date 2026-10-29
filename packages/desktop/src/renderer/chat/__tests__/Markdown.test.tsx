import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../Markdown.js';

const invoke = vi.fn(async () => ({ ok: true, value: { opened: true } }));

beforeEach(() => {
  invoke.mockClear();
  window.aragon = { platform: 'win32', on: () => () => undefined, invoke } as unknown as Window['aragon'];
});
afterEach(() => cleanup());

function renderMarkdown(text: string): HTMLElement {
  return render(<Markdown text={text} />).container;
}

const LIVE_TAGS = 'script, iframe, object, embed, svg, style, form, base, meta, link, video, audio';

function attackSurface(root: HTMLElement): string[] {
  const findings: string[] = [];
  if (root.querySelector(LIVE_TAGS)) findings.push('a live tag reached the DOM');
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      if (attribute.toLowerCase().startsWith('on')) findings.push(`event handler ${attribute} on <${element.tagName}>`);
    }
  }
  for (const link of root.querySelectorAll('[href], [src], [xlink\\:href], [action], [formaction]')) {
    for (const name of ['href', 'src', 'action', 'formaction']) {
      const value = (link.getAttribute(name) ?? '').replace(/[\u0000- ]/g, '').toLowerCase();
      if (/^(javascript|data|vbscript):/.test(value)) findings.push(`${name}="${value.slice(0, 30)}" on <${link.tagName}>`);
    }
  }
  return findings;
}

describe('Markdown sanitisation (model output is untrusted)', () => {
  const vectors: Record<string, string> = {
    'img onerror': '<img src=x onerror=alert(1)>',
    'script tag': '<script>alert(1)</script>',
    'javascript link': '[click me](javascript:alert(1))',
    'mixed-case javascript link': '[click me](JaVaScRiPt:alert(1))',
    'whitespace-obfuscated javascript link': '[click me](  javascript:alert(1))',
    'data link': '[open](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    'vbscript link': '[vb](vbscript:msgbox(1))',
    'svg with script': '<svg onload=alert(1)><script>alert(2)</script></svg>',
    'svg data image': '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    'javascript image': '![x](javascript:alert(1))',
    'raw anchor': '<a href="javascript:alert(1)" onclick="alert(2)">x</a>',
    'iframe': '<iframe src="https://evil.example"></iframe>',
    'style block': '<style>body{display:none}</style>',
    'form': '<form action="https://evil.example"><input name=x></form>',
    'nested in a table': '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
    'inside a list': '- item <script>alert(1)</script>\n- [x](javascript:alert(1))',
    'inside a blockquote': '> <img src=x onerror=alert(1)>',
  };

  for (const [name, source] of Object.entries(vectors)) {
    it(`neutralises: ${name}`, () => {
      expect(attackSurface(renderMarkdown(source))).toEqual([]);
    });
  }

  it('shows hostile HTML as inert text rather than dropping the user\'s view of it silently', () => {
    const root = renderMarkdown('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
  });

  it('does not load a remote image until asked, then loads it without a referrer', () => {
    const root = renderMarkdown('![tracking pixel](https://evil.example/p.png)');
    expect(root.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load image' }));
    const image = root.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://evil.example/p.png');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('opens http(s) links through the main process and never navigates the window', () => {
    const root = renderMarkdown('[docs](https://example.com/docs)');
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(invoke).toHaveBeenCalledWith('native:open-external', { url: 'https://example.com/docs' });
  });

  it('renders a link with a scheme we do not open as plain text', () => {
    const root = renderMarkdown('[call](tel:+123456)');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('call');
  });
});

describe('Markdown rendering', () => {
  it('renders GFM tables, lists and inline code', () => {
    const root = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\nuse `npm test`');
    expect(root.querySelector('table')).not.toBeNull();
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelector('code')?.textContent).toBe('npm test');
  });

  it('renders a fenced block with a language label, a copy button and token spans', () => {
    const root = renderMarkdown('```ts\nconst answer = 42; // note\n```');
    expect(root.querySelector('.code-lang')?.textContent).toBe('ts');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(root.querySelector('.tok-keyword')?.textContent).toBe('const');
    expect(root.querySelector('.tok-comment')).not.toBeNull();
    expect(root.querySelector('pre')?.textContent).toBe('const answer = 42; // note');
  });

  it('copies exactly the code of the block', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderMarkdown('```py\nprint("hi")\n```');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('print("hi")'));
  });

  it('falls back to plain text for a block over 2,000 lines', () => {
    const body = Array.from({ length: 2100 }, () => 'const a = 1;').join('\n');
    const root = renderMarkdown(`\`\`\`ts\n${body}\n\`\`\``);
    expect(root.querySelector('.tok-keyword')).toBeNull();
    expect(root.querySelector('.code-note')).not.toBeNull();
  });

  it('renders an unfinished fence mid-stream without throwing', () => {
    expect(() => renderMarkdown('text\n\n```ts\nconst a =')).not.toThrow();
  });
});

describe('Markdown workspace images', () => {
  const src = (container: HTMLElement) => container.querySelector('img')?.getAttribute('src');

  it('routes a relative image through the asset protocol, keyed by session', () => {
    const { container } = render(<Markdown text="![shot](docs/my%20shot.png)" sessionId="s1" />);
    expect(src(container)).toBe('aragon-asset://s1/docs/my%20shot.png');
  });

  it('never routes an absolute, scheme-relative, file: or remote URL to the asset protocol', () => {
    for (const bad of ['/etc/x.png', '//evil/x.png', 'file:///c:/x.png', 'C:/x.png']) {
      const { container } = render(<Markdown text={`![x](${bad})`} sessionId="s1" />);
      expect(src(container) ?? '').not.toContain('aragon-asset:');
    }
  });

  it('keeps remote images behind the click-to-load placeholder', () => {
    const { container } = render(<Markdown text="![x](https://example.com/x.png)" sessionId="s1" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.remote-image')).not.toBeNull();
  });

  it('falls back to the alt text when the file cannot be served', () => {
    const { container } = render(<Markdown text="![fallback text](gone.png)" sessionId="s1" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('fallback text');
  });
});
