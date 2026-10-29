import React, { useLayoutEffect, useState } from 'react';
import { Text } from 'ink';
import { displayWidth } from './composer-rows.js';

export interface PromptCaretProps {
  text: string;
  active: boolean;
  reducedMotion: boolean;
  colorLevel: 0 | 1 | 2 | 3;
  color?: string;
  resetKey: object;
}

function monochromeMarker(text: string): string {
  // Ink's output grid advances for combining marks, even though they have no
  // terminal width. Retain them in both phases so its cell count stays stable.
  const replace = (marker: string): string => Array.from(text, (point) => {
    const width = displayWidth(point);
    return width > 0 ? marker.repeat(width) : point;
  }).join('');
  const underline = replace('_');
  return underline === text ? replace('^') : underline;
}

/** The only blinking state belongs to this leaf, never to the editor. */
export function PromptCaret({
  text, active, reducedMotion, colorLevel, color, resetKey,
}: PromptCaretProps): React.ReactElement {
  const [visible, setVisible] = useState(true);
  useLayoutEffect(() => {
    setVisible(true);
    if (!active || reducedMotion) return;
    const timer = setInterval(() => setVisible((previous) => !previous), 500);
    return () => clearInterval(timer);
  }, [resetKey, active, reducedMotion]);

  const bright = active && (reducedMotion || visible);
  let content = text;
  if (bright && colorLevel === 0) {
    content = monochromeMarker(text);
  }
  return <Text color={color} inverse={bright && colorLevel > 0}>{content}</Text>;
}
