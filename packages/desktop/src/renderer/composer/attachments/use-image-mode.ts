/**
 * How the pictures in this message will be sent: as pictures (`inline`) or as file paths (`path`).
 *
 * The user's explicit choice on the capability banner wins, then the default that follows the
 * model's capability (`no` -> path, otherwise inline). The choice belongs to the message in
 * progress: it is forgotten when the message is sent or its last picture is removed.
 */

import { useSyncExternalStore } from 'react';
import type { ImageMode } from '../../../shared/attachments.js';
import {
  getModeChoice,
  isHintDismissed,
  subscribeAttachments,
} from './attachment-draft-store.js';
import { useImageInput, type ImageInputState } from './image-input.js';

export interface ImageModeState {
  mode: ImageMode;
  /** The explicit choice, or null when the default applies. */
  choice: ImageMode | null;
  hintDismissed: boolean;
  input: ImageInputState;
}

export function defaultMode(support: 'yes' | 'no' | 'unknown'): ImageMode {
  return support === 'no' ? 'path' : 'inline';
}

export function useImageMode(sessionId: string): ImageModeState {
  const input = useImageInput(sessionId);
  const stored = useSyncExternalStore(
    subscribeAttachments, () => getModeChoice(sessionId), () => getModeChoice(sessionId),
  );
  // A model that reads images makes an earlier "send paths" choice moot: it was made for another model.
  const choice = input.support === 'yes' ? null : stored;
  const hintDismissed = useSyncExternalStore(
    subscribeAttachments, () => isHintDismissed(sessionId), () => isHintDismissed(sessionId),
  );
  return { mode: choice ?? defaultMode(input.support), choice, hintDismissed, input };
}
