/** A fenced code block: language label, copy button, tokens rendered as React nodes. */

import { Check, Copy } from 'lucide-react';
import { memo, useMemo } from 'react';
import { countLines, HIGHLIGHT_MAX_LINES, tokenize } from '../lib/chat-tokenize.js';
import { useT } from '../i18n/index.js';
import { IconButton } from '../ui/primitives.js';
import { useCopy } from './hooks.js';
import './chat.css';

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useT();
  const { copied, copy } = useCopy();
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  const plain = countLines(code) > HIGHLIGHT_MAX_LINES;
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || t('chat.code.plain')}</span>
        {plain ? <span className="code-note">{t('chat.code.plainLarge')}</span> : null}
        <IconButton size="sm" label={copied ? t('common.copied') : t('chat.code.copy')} onClick={() => copy(code)}>
          {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
        </IconButton>
      </div>
      <pre className="code-body selectable" tabIndex={0}>
        <code>
          {tokens.map((token, index) => (
            token.type === 'plain'
              ? token.text
              : <span key={index} className={`tok tok-${token.type}`}>{token.text}</span>
          ))}
        </code>
      </pre>
    </div>
  );
});
