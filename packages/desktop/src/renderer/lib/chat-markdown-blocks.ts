/**
 * Split markdown into top-level blocks so a streaming message re-parses only its LAST block.
 *
 * Blocks end at a blank line that is outside a code fence. A block that begins with indentation
 * is a continuation (a list item's second paragraph, an indented code line) and is merged into
 * the previous one, because rendering it alone would change its meaning. Concatenating the
 * blocks with their separators gives the input back, so splitting never loses text.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitMarkdownBlocks(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: string; size: number } | null = null;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };

  for (const line of lines) {
    const opener = FENCE.exec(line);
    if (fence) {
      const closes = opener && opener[1]![0] === fence.char && opener[1]!.length >= fence.size
        && line.trim() === opener[1];
      if (closes) fence = null;
      current.push(line);
      continue;
    }
    if (opener) fence = { char: opener[1]![0]!, size: opener[1]!.length };
    if (line.trim() === '') {
      // The blank line stays with the block it follows, so re-joining is lossless.
      current.push(line);
      flush();
      continue;
    }
    const continuation = /^( {2,}|\t)/.test(line) && current.length === 0 && blocks.length > 0;
    if (continuation) {
      const previous = blocks.pop()!;
      current = [previous];
    }
    current.push(line);
  }
  flush();
  return blocks;
}
