'use client';

/**
 * Markdown rendering for assistant messages: react-markdown + GFM, highlight.js
 * for fenced code with a copy button, warm code surfaces.
 */

import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { CheckIcon, CopyIcon } from './Icons';

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (rare in Electron); the button simply no-ops.
    }
  };
  let html = code;
  try {
    html =
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;
  } catch {
    html = escapeHtml(code);
  }
  return (
    <div style={{ position: 'relative', margin: '0 0 12px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 14px 0',
        }}
      >
        <span style={{ fontSize: 11, color: '#97918a', fontFamily: 'var(--font-mono)' }}>
          {language || 'text'}
        </span>
        <button
          onClick={() => void copy()}
          style={{
            color: '#97918a',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
          }}
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre style={{ marginTop: 4, marginBottom: 0 }}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
          code: ({
            inline,
            className,
            children,
            ...props
          }: {
            inline?: boolean;
            className?: string;
            children?: ReactNode;
          }) => {
            const raw = String(children ?? '').replace(/\n$/, '');
            const match = /language-(\w+)/.exec(className ?? '');
            if (inline || (!match && !raw.includes('\n'))) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock code={raw} language={match?.[1] ?? ''} />;
          },
          a: ({ href, children }: { href?: string; children?: ReactNode }) => (
            <a href={href} onClick={(event) => event.preventDefault()}>
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
