/** Human-readable views; never the authoritative serialized working memory. */
import type { CompactionMemory, MemoryItem } from './memory.js';

function itemText(item: MemoryItem): string {
  const status = item.status ? `[${item.status}] ` : '';
  const sources = item.sources
    .map((source) => `${source.messageId} (${source.role}): ${JSON.stringify(source.excerpt)}`)
    .join('; ');
  return `- ${status}${item.text}\n  Sources (model extracted): ${sources}`;
}

/** Render fixed sections and active chain tails, retaining full chains in JSON only. */
export function renderMemoryMarkdown(memory: CompactionMemory): string {
  const superseded = new Set(
    memory.items.flatMap((item) => item.supersedes ? [item.supersedes] : []),
  );
  const active = memory.items.filter((item) => !superseded.has(item.id));
  const select = (...sections: MemoryItem['section'][]) => active
    .filter((item) => sections.includes(item.section))
    .map(itemText)
    .join('\n');
  const requirements = memory.userMessages.map((entry) => {
    const content = entry.message.content;
    return `- ${entry.id}: ${typeof content === 'string'
      ? content
      : content.map((part) => part.type === 'text' ? part.text : '[image retained]').join('\n')}`;
  }).join('\n');
  const sections: Array<[string, string]> = [
    ['Goal', `Original task retained verbatim in anchor (${memory.originalTask.sourceId}).`],
    ['User requirements', requirements],
    ['Global context', select('global')],
    ['Decisions', select('decisions')],
    ['Files and facts', select('files', 'facts')],
    ['Tasks', select('tasks')],
    ['Verification', select('verification')],
    ['Pitfalls', select('pitfalls')],
    ['Next steps', select('next')],
    [
      'Coverage',
      `Generation: ${memory.generation}`
        + `\nSummarized messages: ${memory.coverage.summarizedMessages}`
        + `\nClipped tool results: ${memory.coverage.clippedToolResults.length}`
        + `\nLegacy incomplete: ${memory.coverage.legacyIncomplete}`
        + memory.coverage.clippedToolResults
          .map((clip) => `\n- ${clip.messageId}: ${clip.omittedChars} characters omitted`)
          .join('')
        + (memory.legacySummary
          ? `\n\nLegacy reference (unverified):\n${memory.legacySummary}`
          : ''),
    ],
  ];
  return sections.map(([title, body]) => `## ${title}\n${body || '(none)'}`).join('\n\n');
}
