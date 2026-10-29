/**
 * A read-only unified diff. Added and removed lines carry a `+` / `-` prefix as well as a
 * background, so the change survives forced-colors and colour blindness. Text is rendered as
 * plain React text: a file's contents are untrusted and never become markup.
 */

import { memo } from 'react';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';
import { useT } from '../i18n/index.js';

const PREFIX = { add: '+', del: '-', ctx: ' ' } as const;
/** A pathological patch is cut here rather than mounting thousands of rows. */
const MAX_ROWS = 600;

export const PatchView = memo(function PatchView({ patch }: { patch: FilePatch }) {
  const t = useT();
  if (patch.degraded) return <p className="panel-note">{t(`workspace.changes.degraded.${patch.degraded}` as const)}</p>;
  let shown = 0;
  let cut = false;
  return (
    <div className="patch selectable" role="group" aria-label={patch.path}>
      {patch.hunks.map((hunk, index) => {
        if (cut) return null;
        const rows = hunk.lines.slice(0, Math.max(0, MAX_ROWS - shown));
        shown += rows.length;
        cut = rows.length < hunk.lines.length;
        return (
          <div key={`${hunk.oldStart}-${index}`} className="patch-hunk">
            <div className="patch-hunk-head">{`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`}</div>
            {rows.map((line, row) => (
              <div key={row} className="patch-line" data-kind={line.kind}>
                <span className="patch-num" aria-hidden="true">{line.newLine ?? line.oldLine ?? ''}</span>
                <span className="patch-text">{PREFIX[line.kind]}{line.text}</span>
              </div>
            ))}
          </div>
        );
      })}
      {patch.truncated || cut ? <p className="panel-note">{t('workspace.changes.truncated')}</p> : null}
    </div>
  );
});
