import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { buildActionClauses } from '../ui/interaction-hints.js';

describe('操作提示按实际按键所有权规划', () => {
  it('40 列运行提示完整，不受教学开关影响', () => {
    const text = buildActionClauses({ cols: 40, interactionPhase: 'running', hintsEnabled: false }).join(' | ');
    expect(text).toBe('Enter 入队 | ^J 换行 | Esc×2 中断');
    expect(stringWidth(text)).toBeLessThanOrEqual(39);
  });
  it('可见补全高于启动及普通运行提示', () => {
    for (const interactionPhase of ['starting', 'running'] as const) {
      const text = buildActionClauses({ cols: 100, interactionPhase, completion: 'slash' }).join(' | ');
      expect(text).toContain('Enter 执行命令');
      expect(text).toContain('Esc 关闭补全');
      expect(text).not.toMatch(/入队|中断|发送/);
    }
  });
  it('覆盖层高于补全，启动中不承诺提交', () => {
    const overlay = buildActionClauses({ cols: 80, interactionPhase: 'running', overlay: 'queue', completion: 'slash' }).join(' | ');
    expect(overlay).toContain('Esc 关闭');
    expect(overlay).not.toMatch(/入队|中断|执行命令/);
    const starting = buildActionClauses({ cols: 80, interactionPhase: 'starting' }).join(' | ');
    expect(starting).toContain('启动中');
    expect(starting).not.toMatch(/Enter[： ](?:发送|入队)|发送|入队/);
  });
  it('反馈保留上下文拥有的 Esc，复制清理不虚报正在复制', () => {
    const text = buildActionClauses({ cols: 40, interactionPhase: 'running', completion: 'slash',
      toast: '复制失败：工具超时', copyCleanupPending: true }).join(' | ');
    expect(text).toContain('复制失败');
    expect(text).toContain('Esc 关闭补全');
    expect(text).not.toContain('中断');
    expect(text).not.toContain('正在复制');
  });
  it('闲时更新入口保留，反馈结束后恢复', () => {
    expect(buildActionClauses({ cols: 40, interactionPhase: 'idle', updateAvailable: true }).join(' | ')).toContain('/update');
    expect(buildActionClauses({ cols: 40, interactionPhase: 'idle', updateAvailable: true, toast: '已复制' }).join(' | ')).toContain('已复制');
  });
  it('运行与服务并存时中断和停止服务不混淆', () => {
    const text = buildActionClauses({ cols: 40, interactionPhase: 'running', services: 2 }).join(' | ');
    expect(text).toContain('Esc×2 中断');
    expect(text).toMatch(/(?:Ctrl\+C|\^C).*服务/);
    expect(stringWidth(text)).toBeLessThanOrEqual(39);
  });
  it('确认预备状态不继续显示双击提示', () => {
    expect(buildActionClauses({ cols: 40, interactionPhase: 'running', interruptHint: 'Esc confirm' })
      .join(' | ')).toContain('再按 Esc 中断');
  });
  it('工具确认层 Enter 是拒绝，不提示批准或选择', () => {
    const text = buildActionClauses({ cols: 100, interactionPhase: 'running', overlay: 'confirm' }).join(' | ');
    expect(text).toContain('y 批准');
    expect(text).toContain('Enter 拒绝');
    expect(text).not.toMatch(/Enter 确认|选择|中断/);
  });
  it('方案两种内部状态只承诺始终有效的关闭和滚动', () => {
    const text = buildActionClauses({ cols: 100, interactionPhase: 'running', overlay: 'plan' }).join(' | ');
    expect(text).toContain('Esc 关闭');
    expect(text).toContain('PgUp/PgDn 滚动');
    expect(text).not.toMatch(/Enter 确认|a 批准/);
  });
  it('选区拥有 Ctrl+C，不同时承诺停止服务', () => {
    const text = buildActionClauses({ cols: 100, interactionPhase: 'running', services: 2, selectionPending: true }).join(' | ');
    expect(text).toContain('Ctrl+C 复制');
    expect(text).not.toMatch(/停止服务|停服务/);
  });
  it('模式切换使用宿主实际提供的快捷键', () => {
    const text = buildActionClauses({ cols: 220, interactionPhase: 'idle', modeToggleKey: 'Ctrl+O' }).join(' | ');
    expect(text).toContain('Ctrl+O 切换模式');
    expect(text).not.toContain('Shift+Tab');
  });
  it('复制进度覆盖之前的普通toast，清理期间不虚报仍在复制', () => {
    const base = { cols: 80, interactionPhase: 'running' as const, toast: 'Thinking shown.', copyInFlight: true };
    expect(buildActionClauses(base).join(' | ')).toContain('正在复制');
    const cleanup = buildActionClauses({ ...base, copyCleanupPending: true }).join(' | ');
    expect(cleanup).toContain('复制失败');
    expect(cleanup).not.toContain('正在复制');
  });
});
