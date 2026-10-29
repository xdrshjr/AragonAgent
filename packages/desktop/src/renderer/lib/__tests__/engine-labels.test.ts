import { describe, expect, it } from 'vitest';
import { COMPACTION_REASON_CODES } from '@aragon-agent/tui/model/compaction/reason-text';
import { POSTURES_FULL } from '@aragon-agent/tui/model/governance/posture';
import { catalogueKeys, setLanguage, translate } from '../../i18n/index.js';
import {
  COMPACTION_MODE_KEYS, COMPACTION_PHASE_KEYS, COMPACTION_TRIGGER_KEYS, POSTURE_KEYS,
  modeLabel, phaseLabel, postureLabel, reasonLabel, triggerLabel,
} from '../engine-labels.js';

describe('engine labels', () => {
  it('has wording for every rejection code the engine can produce, in both languages', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const keys = new Set(catalogueKeys(language));
      const missing = COMPACTION_REASON_CODES.filter((code) => !keys.has(`engine.compaction.reason.${code}`));
      expect(missing, language).toEqual([]);
    }
    expect(COMPACTION_REASON_CODES.length).toBeGreaterThanOrEqual(15); // not vacuous
  });

  it('has no reason key for a code the engine no longer has', () => {
    const known = new Set(COMPACTION_REASON_CODES);
    const stale = catalogueKeys('en')
      .filter((key) => key.startsWith('engine.compaction.reason.'))
      .map((key) => key.slice('engine.compaction.reason.'.length).replace(/\.action$/, ''))
      .filter((code) => !known.has(code));
    expect(stale).toEqual([]);
  });

  it('localises postures, phases, triggers and modes without leaking engine English in zh-CN', () => {
    setLanguage('zh-CN');
    try {
      expect(POSTURES_FULL.map((posture) => postureLabel(translate, posture))).toEqual(['构建', '计划', '治理', '计划+治理']);
      expect(phaseLabel(translate, 'summarizing')).toBe('正在生成摘要');
      expect(triggerLabel(translate, 'manual')).toBe('由你手动触发');
      expect(modeLabel(translate, 'truncated')).toBe('已截断');
      expect(reasonLabel('timeout: after 30s')).toEqual({ text: '摘要模型超时', action: '重试' });
    } finally {
      setLanguage('en');
    }
  });

  it('keeps the engine wording for a code nobody has translated', () => {
    expect(reasonLabel('brand_new_gate: detail').text).toBe('brand_new_gate: detail');
  });

  it('covers every member of the engine unions (the tables are Records, this pins their sizes)', () => {
    expect(Object.keys(POSTURE_KEYS)).toHaveLength(POSTURES_FULL.length);
    expect(Object.keys(COMPACTION_PHASE_KEYS)).toHaveLength(5);
    expect(Object.keys(COMPACTION_TRIGGER_KEYS)).toHaveLength(3);
    expect(Object.keys(COMPACTION_MODE_KEYS)).toHaveLength(4);
  });
});
