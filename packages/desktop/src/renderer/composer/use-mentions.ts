import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import type { AttachmentDraft } from './attachments/attachment-draft-store.js';
import type { MentionState } from './MentionMenu.js';

/** Typing pauses this long before a search goes out (a keystroke per request would flood the host). */
export const MENTION_DEBOUNCE_MS = 120;

/**
 * The attachments an `@query` can point at: by reference name (`@im` finds image1) or by file
 * name. Failed ones are left out - there is nothing to reference.
 */
export function filterAttachmentMentions(items: readonly AttachmentDraft[], query: string): AttachmentDraft[] {
  const needle = query.toLowerCase();
  return items.filter((item) => item.status !== 'error'
    && (needle === '' || item.ref.startsWith(needle) || item.name.toLowerCase().includes(needle)));
}

const IDLE: MentionState = { status: 'idle', paths: [], truncated: false };

interface SearchValue { paths: string[]; truncated: boolean }

function isSearchValue(value: unknown): value is SearchValue {
  const candidate = value as SearchValue | null;
  return typeof candidate === 'object' && candidate !== null && Array.isArray(candidate.paths);
}

/**
 * Debounced `files.search`. Every request carries a sequence number and only the NEWEST one may
 * write state, so a slow answer for "src/a" can never overwrite the results for "src/ab".
 */
export function useMentionSearch(sessionId: string, query: string | null): MentionState {
  const t = useT();
  const [state, setState] = useState<MentionState>(IDLE);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    if (query === null) {
      setState(IDLE);
      return undefined;
    }
    const mine = sequence.current;
    setState((current) => ({ status: 'loading', paths: current.paths, truncated: current.truncated }));
    const timer = setTimeout(() => {
      void sessionStore.command(sessionId, { c: 'files.search', query }).then((result) => {
        if (mine !== sequence.current) return; // a newer query superseded this answer
        if (!result.ok) {
          setState({ status: 'error', paths: [], truncated: false, message: describeFailure(t, result) });
        } else if (isSearchValue(result.value)) {
          setState({ status: 'ready', paths: result.value.paths, truncated: result.value.truncated === true });
        } else {
          setState({ status: 'ready', paths: [], truncated: false });
        }
      });
    }, MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, query, t]);

  return state;
}
