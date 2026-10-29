import { comboParts } from '../lib/settings-shortcuts.js';
import { Kbd } from '../ui/primitives.js';

/** `mod+shift+b` drawn as key caps, with the platform's own names (Cmd on macOS, Ctrl elsewhere). */
export function KeyCombo({ combo, isMac }: { combo: string; isMac: boolean }) {
  return <span className="keys">{comboParts(combo, isMac).map((part, index) => <Kbd key={`${part}-${index}`}>{part}</Kbd>)}</span>;
}
