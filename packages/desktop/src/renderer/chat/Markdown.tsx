/**
 * Markdown for assistant text. Model output is untrusted, so:
 *   - raw HTML is never parsed (react-markdown escapes it) and the tree is ALSO passed through
 *     `rehype-sanitize`, which drops scripts, event handlers and `javascript:`/`data:` URLs;
 *   - links open through the main process (`native:open-external`), never in this window;
 *   - remote images are not fetched until the user asks (a placeholder with a button); a RELATIVE
 *     image path is a file in the session's working directory and is served by the main
 *     process through `aragon-asset://`, which resolves it under the same containment rules the
 *     file tools use (see `main/asset-resolver.ts`).
 *
 * Streaming cost: the text is split into top-level blocks and each block is a memoised
 * component keyed by its text, so a token appended to the last block re-parses only that block.
 */

import { Children, isValidElement, memo, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { splitMarkdownBlocks } from '../lib/chat-markdown-blocks.js';
import { CodeBlock } from './CodeBlock.js';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize];

const OPENABLE = /^(?:https?:|mailto:)/i;

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !OPENABLE.test(href)) return <span>{children}</span>;
  return (
    <a href={href} rel="noreferrer noopener" onClick={(event) => {
      event.preventDefault();
      void ipc('native:open-external', { url: href });
    }}>{children}</a>
  );
}

function RemoteImage({ src, alt }: { src?: string; alt?: string }) {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  if (!src || !/^https?:/i.test(src)) return <span>{alt ?? ''}</span>;
  if (loaded) return <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" />;
  return (
    <span className="remote-image">
      <span>{alt || t('chat.image.remote')}</span>
      <button type="button" onClick={() => setLoaded(true)}>{t('chat.image.load')}</button>
    </span>
  );
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `aragon-asset://<session>/<path>` for a plain relative path; null for anything else. */
export function workspaceAssetUrl(sessionId: string | undefined, src: string | undefined): string | null {
  if (!sessionId || !src || SCHEME.test(src) || src.startsWith('//') || src.startsWith('/')) return null;
  // Markdown hands us an already percent-encoded URL; decode each segment before encoding it again
  // so the main process (which decodes exactly once) sees the real file name, not `%2520`.
  const path = src.split('?')[0]!.split('#')[0]!.split('/').map((part) => {
    try { return encodeURIComponent(decodeURIComponent(part)); } catch { return encodeURIComponent(part); }
  }).join('/');
  return `aragon-asset://${sessionId}/${path}`;
}

function WorkspaceImage({ src, alt }: { src: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>{alt ?? ''}</span>;
  return <img src={src} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} />;
}

function Pre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  if (!isValidElement(child)) return <pre>{children}</pre>;
  const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
  const text = Children.toArray(props.children).filter((part) => typeof part === 'string').join('');
  const lang = /language-([^\s]+)/.exec(props.className ?? '')?.[1];
  return <CodeBlock code={text.replace(/\n$/, '')} {...(lang ? { lang } : {})} />;
}

function componentsFor(sessionId: string | undefined): Components {
  return {
    a: ({ href, children }) => <Link {...(href ? { href } : {})}>{children}</Link>,
    img: ({ src, alt }) => {
      const local = workspaceAssetUrl(sessionId, typeof src === 'string' ? src : undefined);
      if (local) return <WorkspaceImage src={local} {...(alt ? { alt } : {})} />;
      return <RemoteImage {...(typeof src === 'string' ? { src } : {})} {...(alt ? { alt } : {})} />;
    },
    pre: ({ children }) => <Pre>{children}</Pre>,
  };
}

const MarkdownBlock = memo(function MarkdownBlock({ text, sessionId }: { text: string; sessionId?: string }) {
  const components = useMemo(() => componentsFor(sessionId), [sessionId]);
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({ text, sessionId }: { text: string; sessionId?: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className="prose selectable">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} {...(sessionId ? { sessionId } : {})} />
      ))}
    </div>
  );
});
