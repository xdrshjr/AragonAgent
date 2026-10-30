import { describe, expect, it } from 'vitest';
import { KNOWN_VOICE_TOOLS, PHRASE_VOICE_TOOLS, THINKING_WORD_COUNT } from '@aragon-agent/tui/ui/tool-voice';
import { ACTIVITY_PHRASES } from '@aragon-agent/tui/ui/activity-phrases';
import {
  ZH_THINKING_WORDS,
  ZH_TOOL_NAMES,
  ZH_TOOL_PHRASES,
  humanizeZh,
  voiceGerund,
  voicePhrase,
  voiceThinkingWord,
  voiceTitle,
} from '../tool-voice-i18n.js';
import { makeVoice } from '../voice.js';

const friendly = makeVoice('friendly', false);
const still = makeVoice('friendly', true);
const input = (tool: string, seed = 0, args = {}) => ({ tool, args, wide: true, variantSeed: seed, budget: 80 });

describe('Chinese tool voice parity with the TUI tables', () => {
  it('has exactly the tools the TUI knows, for titles and gerunds', () => {
    expect(Object.keys(ZH_TOOL_NAMES).sort()).toEqual([...KNOWN_VOICE_TOOLS].sort());
    for (const entry of Object.values(ZH_TOOL_NAMES)) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.gerund.length).toBeGreaterThan(0);
    }
  });

  it('has exactly the phrase tools the TUI knows, with three distinct variants each', () => {
    expect(Object.keys(ZH_TOOL_PHRASES).sort()).toEqual([...PHRASE_VOICE_TOOLS].sort());
    for (const entry of Object.values(ZH_TOOL_PHRASES)) {
      expect(new Set(entry.variants).size).toBe(3);
    }
  });

  it('has one Chinese thinking word per English one, all distinct', () => {
    expect(ZH_THINKING_WORDS).toHaveLength(THINKING_WORD_COUNT);
    expect(ZH_THINKING_WORDS).toHaveLength(ACTIVITY_PHRASES.length);
    expect(new Set(ZH_THINKING_WORDS).size).toBe(ZH_THINKING_WORDS.length);
  });
});

describe('voice functions', () => {
  it('english delegates to the TUI and developer returns the raw identifier', () => {
    expect(voiceTitle('read_file', 'friendly', 'en')).toBe('Read file');
    expect(voiceTitle('read_file', 'developer', 'zh-CN')).toBe('read_file');
    expect(voiceGerund('read_file', 'developer', 'en')).toBe('read_file');
  });

  it('chinese titles, gerunds and phrases come from the table', () => {
    expect(voiceTitle('grep', 'friendly', 'zh-CN')).toBe('搜索文本');
    expect(voiceGerund('bash', 'friendly', 'zh-CN')).toBe('正在运行命令');
    expect(voicePhrase(input('grep', 0, { pattern: 'retry' }), friendly, 'zh-CN')).toBe('正在搜索 retry');
    expect(voicePhrase(input('grep', 1, { pattern: 'retry' }), friendly, 'zh-CN')).toBe('正在搜寻 retry');
  });

  it('reduced motion pins variant 0 in both languages', () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      const set = new Set([0, 1, 2, 3, 4].map((seed) => voicePhrase(input('bash', seed, { command: 'ls' }), still, lang)));
      expect(set.size).toBe(1);
    }
  });

  it('falls back to the noun when the tool has no object', () => {
    expect(voicePhrase(input('read_file'), friendly, 'zh-CN')).toBe('正在读取 一个文件');
  });

  it('thinking words follow the English pick and hold still under reduced motion', () => {
    const at = (now: number, voice = friendly) => voiceThinkingWord(10_000, now, voice, 'zh-CN');
    expect(ZH_THINKING_WORDS).toContain(at(10_000));
    expect(at(10_000)).not.toBe(at(14_100));
    expect(at(10_000, still)).toBe(at(50_000, still));
    expect(voiceThinkingWord(10_000, 10_000, friendly, 'en')).toBe(ACTIVITY_PHRASES[10 % ACTIVITY_PHRASES.length]);
  });
});

describe('unregistered tools are tidied, never trusted', () => {
  it('humanizes an MCP-style name without underscores', () => {
    expect(humanizeZh('skill_find')).toBe('调用 Skill find');
    expect(voiceTitle('skill_find', 'friendly', 'zh-CN')).toBe('调用 Skill find');
    expect(voiceGerund('skill_find', 'friendly', 'zh-CN')).toBe('正在调用 Skill find');
  });

  it('strips control characters and caps the length', () => {
    const hostile = `evil\u001b[31m_tool\u0000${'x'.repeat(500)}`;
    for (const text of [humanizeZh(hostile), voiceTitle(hostile, 'friendly', 'zh-CN'), voiceTitle(hostile, 'friendly', 'en')]) {
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(text).not.toContain('_');
      expect(text.length).toBeLessThan(80);
    }
  });
});
