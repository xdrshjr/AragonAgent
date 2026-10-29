/** The `@` menu: file paths from the host's bounded search. */

import { useT } from '../i18n/index.js';

export const MENTION_LISTBOX_ID = 'composer-mention-listbox';
export const mentionOptionId = (index: number): string => `composer-mention-option-${index}`;

export type MentionState =
  | { status: 'idle' | 'loading'; paths: string[]; truncated: boolean }
  | { status: 'ready'; paths: string[]; truncated: boolean }
  | { status: 'error'; paths: string[]; truncated: boolean; message: string };

export function MentionMenu(props: {
  state: MentionState; index: number; onHover(index: number): void; onPick(path: string): void;
}) {
  const t = useT();
  const { state } = props;
  if (state.status === 'error') return <div className="popup" role="alert">{state.message}</div>;
  if (state.paths.length === 0) {
    return <div className="popup" role="status">{state.status === 'ready' ? t('chat.mention.none') : t('chat.mention.searching')}</div>;
  }
  return (
    <div className="popup" role="listbox" id={MENTION_LISTBOX_ID} aria-label={t('chat.mention.label')}>
      {state.paths.map((path, index) => (
        <div key={path} id={mentionOptionId(index)} role="option" aria-selected={index === props.index}
          className="popup-item" data-active={index === props.index ? 'true' : undefined}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => props.onHover(index)}
          onClick={() => props.onPick(path)}>
          <span className="popup-name popup-path" title={path}>{path}</span>
        </div>
      ))}
      {state.truncated ? <div className="popup-foot" role="presentation">{t('chat.mention.truncated')}</div> : null}
    </div>
  );
}
