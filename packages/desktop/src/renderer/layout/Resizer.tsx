/** A drag handle that resizes a side panel; double-click restores its default width. */

import { useRef, useState } from 'react';

export function Resizer(props: {
  onDrag(deltaX: number): void;
  onReset(): void;
  label: string;
  /** Which edge of the panel the handle sits on: dragging right grows a panel by its `right` edge, shrinks it by its `left`. */
  edge?: 'left' | 'right';
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);
  const sign = props.edge === 'left' ? -1 : 1;
  return (
    <div className={props.className ? `resizer ${props.className}` : 'resizer'} role="separator" aria-orientation="vertical"
      aria-label={props.label} data-dragging={dragging}
      onDoubleClick={props.onReset}
      onPointerDown={(event) => {
        last.current = event.clientX;
        setDragging(true);
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        props.onDrag(sign * (event.clientX - last.current));
        last.current = event.clientX;
      }}
      onPointerUp={() => setDragging(false)} />
  );
}
