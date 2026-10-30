/**
 * The tool voice in two languages (desktop-attachments-and-tool-voice D-13).
 *
 * English is the TUI's own module, delegated to unchanged (so the two surfaces cannot drift);
 * Chinese is a table here with exactly the same keys, parity-tested against the names the TUI
 * module exports (`KNOWN_VOICE_TOOLS`, `PHRASE_VOICE_TOOLS`, `THINKING_WORD_COUNT`). Developer
 * mode never reaches a table: it returns the raw identifiers, as before this feature.
 *
 * Tool names come from the model or an MCP server, so an unregistered one is never translated,
 * only tidied (`humanize` strips control characters and caps the length).
 */

import {
  ACTIVITY_PHRASES,
  pickActivityPhrase,
} from '@aragon-agent/tui/ui/activity-phrases';
import {
  humanize,
  toolGerund,
  toolPhrase,
  toolTitle,
  type PhraseInput,
  type VoiceContext,
  type VoiceMode,
} from '@aragon-agent/tui/ui/tool-voice';
import { sanitizeActivity } from '@aragon-agent/tui/model/team/activity';
import type { Language } from '../i18n/index.js';

export const ZH_TOOL_NAMES: Readonly<Record<string, { title: string; gerund: string }>> = {
  read_file: { title: '读取文件', gerund: '正在读取文件' },
  write_file: { title: '写入文件', gerund: '正在写入文件' },
  edit_file: { title: '编辑文件', gerund: '正在编辑文件' },
  list_dir: { title: '列出文件夹', gerund: '正在浏览文件夹' },
  glob: { title: '查找文件', gerund: '正在查找文件' },
  grep: { title: '搜索文本', gerund: '正在搜索文本' },
  bash: { title: '运行命令', gerund: '正在运行命令' },
  bash_output: { title: '查看输出', gerund: '正在查看输出' },
  bash_kill: { title: '停止命令', gerund: '正在停止命令' },
  job_list: { title: '列出任务', gerund: '正在列出任务' },
  job_wait: { title: '等待任务', gerund: '正在等待任务' },
  task: { title: '委派', gerund: '正在委派' },
  ask_user: { title: '向你提问', gerund: '正在向你提问' },
  submit_plan: { title: '提交计划', gerund: '正在提交计划' },
  todo_write: { title: '更新待办', gerund: '正在更新待办' },
  skill_create: { title: '创建技能', gerund: '正在创建技能' },
  skill_install: { title: '安装技能', gerund: '正在安装技能' },
  team_send: { title: '联系队友', gerund: '正在联系队友' },
  team_wait: { title: '等待来信', gerund: '正在等待来信' },
  gov_dispatch: { title: '派发阶段', gerund: '正在派发阶段' },
  gov_run: { title: '运行治理', gerund: '正在运行治理' },
  gov_scan: { title: '扫描项目', gerund: '正在扫描项目' },
  gov_read: { title: '阅读案卷', gerund: '正在阅读案卷' },
  gov_view: { title: '查看记录', gerund: '正在查看记录' },
  gov_submit_work: { title: '提交成果', gerund: '正在提交成果' },
  gov_submit_review: { title: '提交评审', gerund: '正在提交评审' },
  gov_submit_test: { title: '提交测试', gerund: '正在提交测试' },
  ledger_apply: { title: '给智能体打分', gerund: '正在给智能体打分' },
  ledger_rule: { title: '裁定申诉', gerund: '正在裁定申诉' },
  ledger_settle: { title: '结算分数', gerund: '正在结算分数' },
  ledger_standings: { title: '查看排名', gerund: '正在查看排名' },
};

type Variants = readonly [string, string, string];

export const ZH_TOOL_PHRASES: Readonly<Record<string, { variants: Variants; noun: string }>> = {
  read_file: { variants: ['正在读取', '正在浏览', '正在研读'], noun: '一个文件' },
  write_file: { variants: ['正在写入', '正在起草', '正在落笔于'], noun: '一个文件' },
  edit_file: { variants: ['正在编辑', '正在微调', '正在打磨'], noun: '一个文件' },
  list_dir: { variants: ['正在浏览', '正在探路', '正在逛逛'], noun: '一个文件夹' },
  glob: { variants: ['正在查找', '正在搜罗', '正在撒网寻找'], noun: '文件' },
  grep: { variants: ['正在搜索', '正在搜寻', '正在追踪'], noun: '相关代码' },
  bash: { variants: ['正在运行', '正在启动', '正在拉起'], noun: '一条命令' },
  team_send: { variants: ['正在联系', '正在传话给', '正在呼叫'], noun: '一位队友' },
  team_wait: { variants: ['正在等待', '正在聆听', '正在等候'], noun: '来信' },
};

/** Same order as the TUI's `ACTIVITY_PHRASES`; index parity is what lets the pick logic be shared. */
export const ZH_THINKING_WORDS: readonly string[] = [
  '组装中', '酝酿中', '校准中', '琢磨中', '撰写中',
  '运算中', '调制中', '施法中', '思量中', '嚼透中',
  '提炼中', '推演中', '起草中', '挖掘中', '参悟中',
  '发酵中', '打磨中', '觅食中', '萌芽中', '梳理中',
  '孵化中', '推断中', '腌制中', '漫步中', '沉思中',
  '遐想中', '捣鼓中', '渗透中', '斟酌中', '钻研中',
  '反刍中', '谋划中', '雕琢中', '慢炖中', '勾勒中',
  '探洞中', '浸泡中', '缝合中', '召唤中', '修补中',
  '铺展中', '理顺中', '编织中', '削磨中', '驯服中',
];

const VARIANT_COUNT = 3;

/** An unregistered tool: keep the (tidied) name, add only a verb around it. */
export function humanizeZh(tool: string): string {
  return `调用 ${humanize(tool)}`;
}

const zh = (lang: Language, mode: VoiceMode): boolean => lang === 'zh-CN' && mode === 'friendly';

export function voiceTitle(tool: string, mode: VoiceMode, lang: Language): string {
  if (!zh(lang, mode)) return toolTitle(tool, mode);
  return ZH_TOOL_NAMES[tool]?.title ?? humanizeZh(tool);
}

export function voiceGerund(tool: string, mode: VoiceMode, lang: Language): string {
  if (!zh(lang, mode)) return toolGerund(tool, mode);
  return ZH_TOOL_NAMES[tool]?.gerund ?? `正在${humanizeZh(tool)}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function objectOf(input: PhraseInput): string {
  const args = input.args ?? {};
  const pick = (value: string | undefined, narrow: (v: string) => string): string => {
    const v = (value ?? '').trim();
    return v.length === 0 ? '' : input.wide ? v : narrow(v);
  };
  switch (input.tool) {
    case 'read_file': case 'write_file': case 'edit_file': return pick(args.path, basename);
    case 'list_dir': return pick(args.path ?? '.', basename);
    case 'glob': case 'grep': return pick(args.pattern, basename);
    case 'bash': return pick(args.command, (v) => basename(v.split(/\s+/)[0] ?? v));
    case 'team_send': return (args.to ?? '').trim();
    case 'team_wait': return (args.from ?? '').trim();
    default: return '';
  }
}

/** The in-progress phrase. Variant choice is the TUI's rule: seeded, 0 under reduced motion. */
export function voicePhrase(input: PhraseInput, voice: VoiceContext, lang: Language): string {
  if (!zh(lang, voice.mode)) return toolPhrase(input, voice);
  const entry = ZH_TOOL_PHRASES[input.tool];
  if (entry === undefined) return sanitizeActivity(voiceGerund(input.tool, 'friendly', lang), input.budget);
  const variant = voice.reducedMotion
    ? 0
    : ((input.variantSeed % VARIANT_COUNT) + VARIANT_COUNT) % VARIANT_COUNT;
  const chosen = entry.variants[variant]!.length + 4 > input.budget ? entry.variants[0] : entry.variants[variant]!;
  return sanitizeActivity(`${chosen} ${objectOf(input) || entry.noun}`, input.budget);
}

/** The "thinking" word for a run at a moment; `rotate` false holds one word (reduced motion). */
export function voiceThinkingWord(
  startedAt: number, now: number, voice: VoiceContext, lang: Language, offset = 0,
): string {
  const word = pickActivityPhrase(startedAt, now, !voice.reducedMotion, offset);
  if (lang !== 'zh-CN') return word;
  const at = ACTIVITY_PHRASES.indexOf(word);
  return ZH_THINKING_WORDS[at] ?? word;
}
