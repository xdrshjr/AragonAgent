/** Bounded, ANSI-coloured text for bash output (live tails and stored previews). */

import { memo, useMemo } from 'react';
import { parseAnsi } from '../../lib/chat-ansi.js';

function lastCarriageSegment(line: string): string {
  // A bare CR rewrites the line (progress bars): keep what the terminal would end up showing.
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
  const at = clean.lastIndexOf('\r');
  return at === -1 ? clean : clean.slice(at + 1);
}

export const AnsiOutput = memo(function AnsiOutput(props: {
  /** Either whole text (split on newlines) or already-split rows. */
  text?: string;
  rows?: readonly string[];
  /** Show only the last `tail` rows (the live view). Omit for everything. */
  tail?: number;
  label: string;
}) {
  const lines = useMemo(() => {
    const all = props.rows ? [...props.rows] : (props.text ?? '').split('\n');
    const kept = props.tail ? all.slice(-props.tail) : all;
    return kept.map(lastCarriageSegment);
  }, [props.rows, props.text, props.tail]);
  return (
    <pre className="ansi selectable" aria-label={props.label} tabIndex={0}>
      {lines.map((line, row) => (
        <div key={row} className="ansi-line">
          {parseAnsi(line).map((run, index) => (
            run.fg === null && !run.bold && !run.dim
              ? run.text
              : (
                <span key={index} className={`ansi-fg-${run.fg ?? 'd'}${run.bold ? ' ansi-bold' : ''}${run.dim ? ' ansi-dim' : ''}`}>
                  {run.text}
                </span>
              )
          ))}
          {line === '' ? '​' : null}
        </div>
      ))}
    </pre>
  );
});
