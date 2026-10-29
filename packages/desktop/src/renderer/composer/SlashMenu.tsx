/** The `/` menu: three groups from the parity matrix; unavailable commands are greyed with their substitute. */

import { Fragment } from 'react';
import { lookupMessage, useT } from '../i18n/index.js';
import type { SlashGroup, SlashItem } from '../lib/chat-slash.js';

export const SLASH_LISTBOX_ID = 'composer-slash-listbox';
export const slashOptionId = (index: number): string => `composer-slash-option-${index}`;

export function SlashMenu(props: {
  items: SlashItem[]; index: number; onHover(index: number): void; onPick(item: SlashItem): void;
}) {
  const t = useT();
  if (props.items.length === 0) {
    return <div className="popup" role="status">{t('chat.slash.none')}</div>;
  }
  let lastGroup: SlashGroup | null = null;
  return (
    <div className="popup" role="listbox" id={SLASH_LISTBOX_ID} aria-label={t('chat.slash.label')}>
      {props.items.map((item, index) => {
        const heading = item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <Fragment key={item.id}>
            {heading ? <div className="popup-group" role="presentation">{t(`chat.slash.group.${item.group}` as const)}</div> : null}
            <div id={slashOptionId(index)} role="option" aria-selected={index === props.index}
              aria-disabled={item.group === 'na'} className="popup-item" data-active={index === props.index ? 'true' : undefined}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => props.onHover(index)}
              onClick={() => props.onPick(item)}>
              <span className="popup-name">/{item.id}</span>
              <span className="popup-hint">{lookupMessage(`slash.${item.id}`) ?? item.target}</span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
