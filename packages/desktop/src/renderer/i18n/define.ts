/** Declaring a message area. Kept apart from `index.ts` so area files never import it (no cycle). */
export interface Dict<K extends string> {
  en: Record<K, string>;
  'zh-CN': Record<K, string>;
}

/** The generic ties both languages to the same key set: a missing translation is a type error. */
export function defineDict<K extends string>(dict: Dict<K>): Dict<K> {
  return dict;
}
