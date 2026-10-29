/** The width of an element in CSS px, kept current with a ResizeObserver (page zoom included). */

import { useEffect, useState, type RefObject } from 'react';

export function useBodyWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => ref.current?.clientWidth ?? 0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
