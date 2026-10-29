/**
 * `{{variable}}` placeholders in a library prompt. Pure.
 *
 * A name is a short word-ish token; anything else between double braces (a JSON snippet, a
 * template literal) is left untouched, so a prompt about templating is not mistaken for a form.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_ .-]{0,39}?)\s*\}\}/g;

/** The distinct variable names, in order of first appearance. */
export function extractVariables(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER)) seen.add(match[1]!.trim());
  return [...seen];
}

/** Replace every placeholder with its value; a name with no value becomes empty text. */
export function fillVariables(content: string, values: Readonly<Record<string, string>>): string {
  return content.replace(PLACEHOLDER, (_whole, name: string) => values[name.trim()] ?? '');
}
