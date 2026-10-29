/**
 * One transcript entry, wrapped so its rendered height reaches the height store
 * (tui-render-performance L3).
 *
 * IT MUST NOT CONSTRAIN HEIGHT. The natural height IS the value being measured;
 * a `height` prop here would make every entry report back whatever it was told,
 * and the spacers would encode a fiction.
 *
 * Ink computes yoga layout in `onRender`, which React runs BEFORE layout
 * effects, so the measurement below reflects the commit that just happened —
 * the same mechanism `ScrollViewport.tsx:87-88` and `AppShell.tsx:100-102`
 * already document and rely on.
 */

import React, { useLayoutEffect, useRef } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';
import type { HeightKey } from './virtual-window.js';

export interface MeasuredEntryProps {
  heightKey: HeightKey;
  onMeasure: (key: HeightKey, rows: number) => void;
  children: React.ReactNode;
}

export function MeasuredEntry({
  heightKey,
  onMeasure,
  children,
}: MeasuredEntryProps): React.ReactElement {
  const ref = useRef<DOMElement>(null);

  // No dependency array on purpose: the entry's content can change without the
  // key changing identity in a way this component can see, and `report` is a
  // no-op when the measurement is unchanged — so an unconditional effect costs
  // one `getComputedHeight()` read and cannot miss a resize.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    onMeasure(heightKey, measureElement(node).height);
  });

  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  );
}
