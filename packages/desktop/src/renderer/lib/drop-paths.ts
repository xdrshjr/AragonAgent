/**
 * Turning a dropped file's absolute path into the text the composer inserts. Pure.
 *
 * A file inside the session's working directory becomes its relative path with forward slashes -
 * the same form the `@` mention menu produces - so the model sees one spelling for one file. A
 * file outside it keeps its absolute path, ALWAYS quoted, and is reported as outside so the UI can
 * say so: the agent can still be pointed at it, but not by accident.
 *
 * Nothing here touches the file. The path is text; the engine reads the file itself.
 */

import type { PlatformName } from '../../shared/ipc-contract.js';

export interface DroppedPath {
  /** What goes into the composer (no trailing space). */
  text: string;
  outside: boolean;
}

const caseInsensitive = (platform: PlatformName): boolean => platform === 'win32' || platform === 'darwin';

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

const quote = (path: string): string => `"${path.replace(/"/g, '\\"')}"`;

export function describeDroppedPath(absolutePath: string, cwd: string, platform: PlatformName): DroppedPath {
  const file = normalise(absolutePath);
  const root = normalise(cwd);
  const fold = (value: string): string => (caseInsensitive(platform) ? value.toLowerCase() : value);
  const prefix = root === '' ? '' : `${fold(root)}/`;
  if (prefix !== '' && fold(file).startsWith(prefix) && file.length > prefix.length) {
    const relative = file.slice(prefix.length);
    return { text: /\s/.test(relative) ? quote(relative) : relative, outside: false };
  }
  return { text: quote(file), outside: true };
}
