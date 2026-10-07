import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { planStatusFields, type StatusLayoutInput } from '../ui/layout/status-layout.js';

const base: StatusLayoutInput = {
  columns: 80, phase: 'tool', activeTool: { name: 'read_file', toolCallId: 't' }, pendingCount: 3,
  context: { occupied: 2100, window: 128000, pct: 2, source: 'estimate', deltaTokens: 0,
    windowKnown: true, windowOverridden: false },
  usageTotal: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30,
    outputTokens: 40, costUsd: 0.0032 }, thinkingLevel: 'xhigh', elapsedMs: 62000,
  tokPerSec: 12, spinner: '*',
};

describe('状态栏完整字段预算', () => {
  it('40 至 200 列始终完整保留核心数量和单位', () => {
    for (let columns = 40; columns <= 200; columns++) {
      const fields = planStatusFields({ ...base, columns });
      expect(fields.map((f) => f.id).slice(0, 3)).toEqual(['phase', 'queue', 'context']);
      expect(fields.find((f) => f.id === 'context')!.text).toMatch(/~2\.1k\/128(?:\.0)?k tok(?:ens)?$/);
      expect(1 + fields.reduce((n, f) => n + f.cells, 0) + 3 * (fields.length - 1)).toBeLessThanOrEqual(columns);
      for (const f of fields) expect(f.cells).toBe(stringWidth(f.text));
    }
  });
  it('未知超长工具名称不挤出上下文和队列，不执行控制序列', () => {
    for (let columns = 40; columns <= 200; columns++) {
      const fields = planStatusFields({ ...base, columns,
        activeTool: { name: '\x1b[31m中文\n'.repeat(500), toolCallId: 't' } });
      expect(fields[0]!.text).toBe('* 工具');
      expect(fields.find((f) => f.id === 'context')!.text).toContain('/128');
      expect(fields.map((f) => f.text).join('')).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  });
  it('极端数据整项降级，非法数据不伪造 0', () => {
    const fields = planStatusFields({ ...base, columns: 40, pendingCount: Number.MAX_VALUE,
      context: { ...base.context, occupied: 1e300, window: 2e300, windowKnown: false } });
    expect(fields.map((f) => f.text).join(' | ')).toContain('/context');
    expect(fields.map((f) => f.text).join(' | ')).toContain('/queue');
    expect(planStatusFields({ ...base, context: { ...base.context, occupied: NaN } })
      .find((f) => f.id === 'context')!.text).toBe('上下文未知');
  });
  it('会话输入包括缓存且费用标记估算', () => {
    const fields = planStatusFields({ ...base, columns: 250 });
    expect(fields.find((f) => f.id === 'usage')!.text).toBe('会话 输入 60 输出 40 tok');
    expect(fields.find((f) => f.id === 'cost')!.text).toBe('会话估算 USD 0.0032');
  });
});
