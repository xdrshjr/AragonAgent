/** A structured file patch as a unified or side-by-side diff. Rows are text nodes, never HTML. */

import { Columns2, Rows2 } from 'lucide-react';
import { Fragment, memo, useState } from 'react';
import type { FilePatch, PatchLine } from '@aragon-agent/tui/model/tools/patch';
import { useT } from '../../i18n/index.js';
import { pairHunkRows } from '../../lib/chat-diff.js';
import { IconButton } from '../../ui/primitives.js';

const SIGN = { ctx: ' ', add: '+', del: '−' } as const;

function Cell({ line }: { line: PatchLine | null }) {
  if (!line) return <div className="diff-cell" data-kind="empty" />;
  return (
    <div className="diff-cell" data-kind={line.kind}>
      <span className="diff-num">{line.kind === 'add' ? line.newLine : line.oldLine ?? line.newLine}</span>
      <span className="diff-sign" aria-hidden="true">{SIGN[line.kind]}</span>
      <span className="diff-text">{line.text}</span>
    </div>
  );
}

function Unified({ patch }: { patch: FilePatch }) {
  return (
    <div className="diff diff-unified" role="table">
      {patch.hunks.map((hunk, index) => (
        <Fragment key={index}>
          {index > 0 ? <div className="diff-gap" aria-hidden="true">{'⋯'}</div> : null}
          {hunk.lines.map((line, row) => <Cell key={row} line={line} />)}
        </Fragment>
      ))}
    </div>
  );
}

function Split({ patch }: { patch: FilePatch }) {
  return (
    <div className="diff diff-split" role="table">
      {patch.hunks.map((hunk, index) => (
        <Fragment key={index}>
          {index > 0 ? <div className="diff-gap diff-gap-wide" aria-hidden="true">{'⋯'}</div> : null}
          {pairHunkRows(hunk.lines).map((pair, row) => (
            <div key={row} className="diff-pair">
              <Cell line={pair.left} />
              <Cell line={pair.right} />
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

export const DiffView = memo(function DiffView({ patch }: { patch: FilePatch }) {
  const t = useT();
  const [split, setSplit] = useState(false);
  return (
    <div className="diff-wrap">
      <div className="diff-bar">
        <span className="diff-kind">{patch.kind === 'create' ? t('chat.diff.created') : t('chat.diff.updated')}</span>
        <IconButton size="sm" active={split} label={split ? t('chat.diff.unified') : t('chat.diff.split')}
          onClick={() => setSplit((value) => !value)}>
          {split ? <Rows2 size={14} strokeWidth={1.5} /> : <Columns2 size={14} strokeWidth={1.5} />}
        </IconButton>
      </div>
      {patch.degraded ? <div className="diff-note">{t(`chat.diff.degraded.${patch.degraded}` as const)}</div> : null}
      <div className="diff-scroll selectable">{split ? <Split patch={patch} /> : <Unified patch={patch} />}</div>
      {patch.truncated ? <div className="diff-note">{t('chat.diff.truncated')}</div> : null}
    </div>
  );
});
