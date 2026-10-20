import { describe, expect, it } from 'vitest';
import type { ModelCandidate, ProbeTarget } from '../agent/model-probe.js';
import { PROBE_LIMITS } from '../agent/model-probe-limits.js';
import { createProfileEditor } from '../ui/overlays/model-profile-state.js';
import { canProbe, editorProbeTarget, editorRows, focusableRows, latencyLabel,
  probeLines, probeTone, rankCandidates, visibleProbeViews, windowLabel, clipName,
  resultRowCount, type ProbeDiscoveryPhase,
  type ProbeTestPhase } from '../ui/overlays/model-probe-view.js';

const profile = { id: 'p1', name: 'Sonnet', provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', baseUrl: null, apiKey: 'disk-key',
  contextWindow: null };
const target = (over: Partial<ProbeTarget> = {}): ProbeTarget => ({ provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', baseUrl: null, apiKey: 'disk-key', ...over });
const candidate = (id: string, over: Partial<ModelCandidate> = {}): ModelCandidate =>
  ({ id, name: id, supportsTools: true, ...over });
const fakeProbe = {
  test: async () => ({ ok: true, targetId: '', latencyMs: 0 }),
  discover: async () => ({ ok: true, connectionId: '', models: [], truncated: false }),
  targetFingerprint: (item: ProbeTarget) => `${item.provider}|${item.model}|${item.apiKey}`,
  connectionFingerprint: (item: ProbeTarget) => `${item.provider}|${item.apiKey}`,
};

describe('editorRows 是编辑器行的唯一真相', () => {
  it('字段索引 0..6 不变，apiKey 恒为 6', () => {
    const rows = editorRows({ editor: createProfileEditor(profile), retain: false,
      probe: { kind: 'idle', reason: 'no_result' }, target: target() });
    const fields = rows.filter((row) => row.kind === 'field');
    expect(fields.map((row) => row.kind === 'field' && row.field)).toEqual(['name', 'provider',
      'model', 'contextWindow', 'baseUrl', 'credentialMode', 'apiKey']);
    const focusable = focusableRows(rows);
    expect(focusable[6]).toMatchObject({ kind: 'field', field: 'apiKey' });
  });
  it('保留 Target 行与 Fast-only 的窗口作用域提示', () => {
    const rows = editorRows({ editor: createProfileEditor(profile), retain: false,
      probe: { kind: 'idle', reason: 'no_result' }, target: target(), fastOnly: true });
    const notes = rows.filter((row) => row.kind === 'note').map((row) => row.label);
    expect(notes).toContain('Target: anthropic Default URL');
    expect(notes).toContain('Window applies when this profile is bound as Main.');
  });
  it('两个动作行固定在表单末尾，retain 影响的是动作块之前的那一行', () => {
    const editor = createProfileEditor(profile);
    editor.endpointChanged = true;
    const rows = editorRows({ editor, retain: true, probe: { kind: 'idle', reason: 'no_result' },
      target: target() });
    const actions = rows.filter((row) => row.kind === 'action');
    expect(actions.map((row) => row.kind === 'action' && row.action)).toEqual(['retain', 'test',
      'discover', 'apply', 'cancel']);
    expect(focusableRows(rows)).toHaveLength(12);
  });
  it('probe 缺省时两个动作行显示 unavailable', () => {
    const rows = editorRows({ editor: createProfileEditor(profile), retain: false,
      probe: { kind: 'idle', reason: 'unavailable' }, target: target() });
    const values = rows.filter((row) => row.kind === 'action')
      .map((row) => row.kind === 'action' && row.value);
    expect(values).toEqual(['(unavailable)', '(unavailable)', '', '']);
  });
  it('没有 key 时测试行显示 (no key)', () => {
    const rows = editorRows({ editor: createProfileEditor(profile), retain: false,
      probe: { kind: 'idle', reason: 'no_key' }, target: target({ apiKey: null }) });
    expect(rows.map((row) => row.kind === 'action' && row.value))
      .toContain('(no key)');
  });
  it('结果行排在动作行之后且计入 resultRowCount', () => {
    const rows = editorRows({ editor: createProfileEditor(profile), retain: false,
      probe: { kind: 'result', outcome: { ok: true, targetId: 't', latencyMs: 812,
        reply: 'OK', usage: { inputTokens: 18, outputTokens: 4 } } }, target: target() });
    const kinds = rows.map((row) => row.kind);
    expect(kinds.lastIndexOf('action')).toBeLessThan(kinds.indexOf('result'));
    expect(resultRowCount(rows)).toBe(2);
  });
});

describe('probeLines 最多两行且第二行永远是怎么做', () => {
  const ok = { ok: true, targetId: 't', latencyMs: 812, reply: 'OK',
    usage: { inputTokens: 18, outputTokens: 4 } };
  it('成功后给出耗时、用量与回复', () => {
    const lines = probeLines({ kind: 'result', outcome: ok }, target());
    expect(lines[0]).toBe('Last test: anthropic:claude-sonnet-4-5-20250929 OK in 812 ms'
      + ' | 18 in / 4 out');
    expect(lines[1]).toBe('Reply: "OK"');
  });
  it('usage 缺失时整段省略计数', () => {
    const lines = probeLines({ kind: 'result', outcome: { ...ok, usage: undefined } }, target());
    expect(lines[0]).not.toContain('in /');
    expect(lines[0]).not.toContain('undefined');
  });
  it('401 的失败给出 Fix 第二行', () => {
    const lines = probeLines({ kind: 'result', outcome: { ok: false, targetId: 't',
      latencyMs: 12, kind: 'auth', detail: 'Key rejected by anthropic (HTTP 401).' } }, target());
    expect(lines[0]).toBe('Last test: FAILED - Key rejected by anthropic (HTTP 401).');
    expect(lines[1]).toBe('Fix: edit API key, or set Credential mode to Shared.');
  });
  it('model 不被接受时指向 Discover，并附可达数', () => {
    const lines = probeLines({ kind: 'result', outcome: { ok: false, targetId: 't',
      latencyMs: 12, kind: 'model_not_found', detail: 'The provider did not accept model "x".',
      availableModels: 42 } }, target());
    expect(lines[1]).toBe('Fix: choose Discover models. This key can reach 42 models.');
    expect(lines).toHaveLength(2);
  });
  it('网络失败只有一行（第一行已含处置建议）', () => {
    const lines = probeLines({ kind: 'result', outcome: { ok: false, targetId: 't',
      latencyMs: 12, kind: 'network', detail: 'Could not reach host.' } }, target());
    expect(lines).toHaveLength(1);
  });
  it('空闲态三种原因各一行', () => {
    expect(probeLines({ kind: 'idle', reason: 'no_result' }, target()))
      .toEqual(['Not tested for this profile yet.']);
    expect(probeLines({ kind: 'idle', reason: 'no_key' }, target()))
      .toEqual(['No key yet: set API key, or use Credential mode Shared.']);
    expect(probeLines({ kind: 'idle', reason: 'unavailable' }, target()))
      .toEqual(['Connection test is unavailable in this session.']);
  });
  it('进行中不占结果行', () => {
    expect(probeLines({ kind: 'testing' }, target())).toEqual([]);
    expect(probeTone({ kind: 'testing' })).toBe('muted');
  });
  it('成功与失败的语气不同', () => {
    expect(probeTone({ kind: 'result', outcome: ok })).toBe('ok');
    expect(probeTone({ kind: 'result', outcome: { ...ok, ok: false } })).toBe('fail');
  });
});

describe('visibleProbeViews 只承认当前目标的结果', () => {
  const noDiscovery: ProbeDiscoveryPhase = { phase: 'idle' };
  const tested = (targetId: string): ProbeTestPhase => ({ phase: 'tested',
    outcome: { ok: true, targetId, latencyMs: 1 } });
  it('指纹不匹配时退化为未测试', () => {
    expect(visibleProbeViews(tested('other'), noDiscovery, target(), fakeProbe as never).test)
      .toEqual({ kind: 'idle', reason: 'no_result' });
  });
  it('指纹匹配时保留结果', () => {
    const probe = { ...fakeProbe, targetFingerprint: () => 't' };
    expect(visibleProbeViews(tested('t'), noDiscovery, target(), probe as never).test.kind)
      .toBe('result');
  });
  it('换 key 后旧结果消失', () => {
    const probe = { ...fakeProbe, targetFingerprint: (item: ProbeTarget) => `${item.apiKey}` };
    expect(visibleProbeViews(tested('t'), noDiscovery, target({ apiKey: 'new' }),
      probe as never).test.kind).toBe('idle');
  });
  it('没有端口时只有 unavailable', () => {
    expect(visibleProbeViews({ phase: 'idle' }, noDiscovery, target(), undefined).test)
      .toEqual({ kind: 'idle', reason: 'unavailable' });
  });
  it('发现结果按 connectionId 绑定，与模型无关', () => {
    const discovery: ProbeDiscoveryPhase = { phase: 'discovered', outcome: { ok: true,
      connectionId: 'c', models: [], truncated: false } };
    const probe = { ...fakeProbe, connectionFingerprint: () => 'c' };
    const views = visibleProbeViews({ phase: 'idle' }, discovery, target({ model: 'switched' }),
      probe as never);
    expect(views.discovery.kind).toBe('discovery');
  });
  it('运行一次测试再打开列表，两个槽位互不改写（AC-27）', () => {
    const probe = { ...fakeProbe, targetFingerprint: () => 't',
      connectionFingerprint: () => 'c' };
    const discovery: ProbeDiscoveryPhase = { phase: 'discovered', outcome: { ok: true,
      connectionId: 'c', models: [], truncated: false } };
    const views = visibleProbeViews(tested('t'), discovery, target(), probe as never);
    expect(views.test.kind).toBe('result');
    expect(views.discovery.kind).toBe('discovery');
  });
  it('canProbe 只拦没有 key 与没有端口的两种', () => {
    expect(canProbe({ kind: 'idle', reason: 'no_key' })).toBe(false);
    expect(canProbe({ kind: 'idle', reason: 'unavailable' })).toBe(false);
    expect(canProbe({ kind: 'idle', reason: 'no_result' })).toBe(true);
    expect(canProbe({ kind: 'testing' })).toBe(true);
  });
});

describe('候选排序与标签', () => {
  it('去重、去空并让当前模型排在最前', () => {
    const ranked = rankCandidates([candidate('a'), candidate('b-current'), candidate('a'),
      candidate('')], 'b-current');
    expect(ranked.map((item) => item.id)).toEqual(['b-current', 'a']);
  });
  it('没有当前模型时保持供应商顺序', () => {
    expect(rankCandidates([candidate('z'), candidate('y')], '').map((item) => item.id))
      .toEqual(['z', 'y']);
  });
  it('耗时格式在一秒处换单位', () => {
    expect(latencyLabel(812)).toBe('812 ms');
    expect(latencyLabel(1400)).toBe('1.4 s');
    expect(latencyLabel(Number.NaN)).toBe('0 ms');
  });
  it('窗口标签降级为 auto', () => {
    expect(windowLabel(200_000)).toBe('200K');
    expect(windowLabel(1_000_000)).toBe('1M');
    expect(windowLabel(1_500_000)).toBe('1.5M');
    expect(windowLabel(undefined)).toBe('auto');
    expect(windowLabel(0)).toBe('auto');
  });
  it('名字裁剪到上限且保留省略号', () => {
    const long = 'x'.repeat(PROBE_LIMITS.maxNameChars + 10);
    expect(clipName(long)).toHaveLength(PROBE_LIMITS.maxNameChars);
    expect(clipName(long).endsWith('...')).toBe(true);
    expect(clipName('short')).toBe('short');
  });
});

describe('ASCII 纪律', () => {
  it('所有探测文案不含非 ASCII 字节', () => {
    const lines = [
      ...probeLines({ kind: 'idle', reason: 'no_result' }, target()),
      ...probeLines({ kind: 'idle', reason: 'no_key' }, target()),
      ...probeLines({ kind: 'idle', reason: 'unavailable' }, target()),
      ...probeLines({ kind: 'result', outcome: { ok: true, targetId: 't', latencyMs: 812,
        reply: 'OK', usage: { inputTokens: 1, outputTokens: 1 } } }, target()),
      ...probeLines({ kind: 'result', outcome: { ok: false, targetId: 't', latencyMs: 1,
        kind: 'auth', detail: 'Key rejected.' } }, target()),
    ];
    const rows = editorRows({ editor: createProfileEditor(profile), retain: true,
      probe: { kind: 'idle', reason: 'no_result' }, target: target(), fastOnly: true });
    const labels = rows.map((row) => (row.kind === 'field' || row.kind === 'action'
      ? `${row.label} ${row.value}` : row.label));
    for (const line of [...lines, ...labels]) {
      // Real bytes, not a tautology: every code point must fit in one ASCII byte.
      const bytes = [...Buffer.from(line, 'utf8')];
      expect(bytes.every((byte) => byte < 0x80)).toBe(true);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });
});

describe('草稿目标的 key 解析', () => {
  it('keep 模式用原档案的 key，而不是空的输入框', () => {
    const editor = createProfileEditor(profile);
    expect(editorProbeTarget(editor, {}).apiKey).toBe('disk-key');
  });
  it('shared 模式用共享 key', () => {
    const editor = createProfileEditor({ ...profile, apiKey: null });
    expect(editorProbeTarget(editor, { anthropic: 'env-key' }).apiKey).toBe('env-key');
  });
  it('replace 模式用刚输入的 key', () => {
    const editor = createProfileEditor(profile);
    editor.credentialMode = 'replace';
    editor.apiKey = 'typed-key';
    expect(editorProbeTarget(editor, { anthropic: 'env-key' }).apiKey).toBe('typed-key');
  });
});
