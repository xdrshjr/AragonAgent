import React, { useCallback, useEffect, useState } from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Box, Text, render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { AppShell } from '../ui/layout/AppShell.js';
import { ScrollViewport } from '../ui/layout/ScrollViewport.js';
import { Composer } from '../ui/Composer.js';
import { PromptInput } from '../ui/PromptInput.js';
import { TodoPanel } from '../ui/TodoPanel.js';
import { TeamPanel } from '../ui/TeamPanel.js';
import { buildTodoRailLayout } from '../ui/layout/todo-layout.js';
import { buildTeamPanelLayout } from '../ui/layout/team-panel.js';
import { buildFrameBudget } from '../ui/layout/budget.js';
import { getTheme } from '../ui/theme.js';
import type { TodoSnapshot } from '../todo/types.js';
import type { TeamSnapshot } from '../team/types.js';
import { App } from '../ui/App.js';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import type { Agent } from '@aragon-agent/core';

vi.mock('tinyglobby', () => ({ glob: async () => ['alpha\n文😀.ts', 'alpha-two.ts'] }));

const caps = { colorLevel: 0 as const, unicode: false };
const theme = getTheme('auto', caps);
const delay = (ms = 80) => new Promise<void>(resolve => setTimeout(resolve, ms));
const plan: TodoSnapshot = {
  items: Array.from({ length: 20 }, (_, i) => ({
    content: `Step ${i}`, activeForm: 'ANCHOR working',
    status: i < 9 ? 'completed' : i === 9 ? 'in_progress' : 'pending',
  })), total: 20, doneCount: 9, activeIndex: 9, updatedAt: 1,
};
const team: TeamSnapshot = {
  dispatchId: 'd', active: true, requested: 8, startedAt: 1, messageCount: 1,
  lastMessage: { from: 'a', to: 'b', subject: 'mail', body: '', at: 1 },
  runs: Array.from({ length: 8 }, (_, i) => ({
    label: `a${i}`, description: 'work', tier: 'main', phase: 'thinking', turns: 0,
    toolCalls: 0, filesTouched: [], messagesSent: 0, usage: { inputTokens: 0, outputTokens: 0 },
  })),
};
const commands = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, description: 'command' }));

function terminal(cols = 100, rows = 20) {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols, rows, isTTY: true,
    write: (text: string) => { if (text.includes('\n')) frames.push(stripAnsi(text)); return true; },
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  return { stdout, stdin, frames, options: {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  } };
}

describe('真实组件响应式布局', () => {
  it.each([
    ['fullscreen', 120], ['fullscreen', 60],
  ] as const)('新任务通过真实 Store 清空 %s/%i 的面板并由新计划恢复', async (mode, cols) => {
    const config = {
      ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false, submitCount: 0,
      startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
      reducedMotion: true, skills: { ...DEFAULT_CONFIG.skills, enabled: false },
      team: { ...DEFAULT_CONFIG.team, enabled: false },
      fast: { ...DEFAULT_CONFIG.fast, enabled: false },
      compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
      todo: { ...DEFAULT_CONFIG.todo, followThrough: 'off' },
      apiKeys: { anthropic: 'test' },
    } as CliConfig;
    const controller = new AgentController(config);
    const engine = (controller as unknown as { agent: Agent }).agent;
    const prompt = vi.spyOn(engine, 'prompt').mockResolvedValue(undefined);
    const t = terminal(cols, 30);
    const view = render(<App controller={controller} version="test" />, t.options);
    const visibleCount = cols === 120 ? 'TODO' : '9/20';
    try {
      await delay();
      controller.restoreTodos(plan.items);
      await delay();
      expect(t.frames.at(-1)).toContain(visibleCount);
      t.stdin.write('a new simple task'); await delay();
      t.stdin.write('\r'); await delay();
      expect(prompt).toHaveBeenCalledExactlyOnceWith('a new simple task');
      expect(controller.getTodoSnapshot()).toBeNull();
      expect(t.frames.at(-1)!.split('\n').at(-1)).not.toContain(visibleCount);
      t.stdout.columns = cols + 1;
      t.stdout.emit('resize'); await delay();
      expect(t.frames.at(-1)!.split('\n').at(-1)).not.toContain(visibleCount);
      const tool = controller.listTools().find((item) => item.name === 'todo_write')!;
      await tool.execute('bad', { todos: [] }, {} as never);
      await tool.execute('short', { todos: [{ content: 'one', status: 'pending' }] }, {} as never);
      await delay();
      expect(controller.getTodoSnapshot()).toBeNull();
      const fresh = ['new-a', 'new-b', 'new-c'].map((content) => ({ content, status: 'pending' }));
      await tool.execute('fresh', { todos: fresh }, {} as never);
      await delay();
      expect(controller.getTodoSnapshot()?.total).toBe(3);
      expect(t.frames.at(-1)).toContain('0/3');
      expect(t.frames.at(-1)!.split('\n').at(-1)).not.toContain('9/20');
    } finally {
      view.unmount(); view.cleanup(); prompt.mockRestore(); controller.dispose();
    }
  });

  it('文件候选隐藏时保留原始输入，可见时接受原始文件名', async () => {
    const t = terminal(76);
    const submit = vi.fn((_text: string) => ({ accepted: true }));
    const report = vi.fn();
    const node = (height: number) => <PromptInput isActive running={false} history={[]}
      commands={[]} cwd={process.cwd()} theme={theme} caps={caps} onSubmit={submit}
      popupMaxHeight={height} onPopupRowsChange={report} />;
    const view = render(node(2), t.options);
    try {
      await delay(); t.stdin.write('@alpha'); await delay(180);
      t.stdin.write('\u001b[B'); t.stdin.write('\t'); await delay();
      t.stdin.write('\r'); await delay();
      expect(submit).toHaveBeenLastCalledWith('@alpha');
      view.rerender(node(3));
      t.stdin.write('@alpha'); await delay(180);
      expect(report).toHaveBeenLastCalledWith(3);
      expect(t.frames.at(-1)).toContain('alpha 文');
      t.stdin.write('\t'); await delay();
      t.stdin.write('\r'); await delay();
      expect(submit).toHaveBeenLastCalledWith('alpha\n文😀.ts');
      expect(report).toHaveBeenLastCalledWith(0);
    } finally { view.unmount(); view.cleanup(); }
  });
  it('团队、菜单及 resize 保留底栏、锚点和滚动视口实例', async () => {
    let mounts = 0;
    let layoutRows = 0;
    let offset = 0;
    function Transcript() {
      useEffect(() => { mounts++; }, []);
      return <Box flexDirection="column">{Array.from({ length: 60 }, (_, i) =>
        <Text key={i}>Transcript line {i}</Text>)}</Box>;
    }
    function Harness({ cols, rows, teamOn, nonce = 0 }: {
      cols: number; rows: number; teamOn: boolean; nonce?: number;
    }) {
      const [popupRows, setPopupRows] = useState(0);
      const [draftRows, setDraftRows] = useState(1);
      const frame = buildFrameBudget({ rows, cols, draftRows, popupRows, statusExpanded: false });
      const budget = frame.viewportRows;
      const teamLayout = buildTeamPanelLayout({ snapshot: teamOn ? team : null,
        terminalRows: rows, availableRows: budget });
      const layout = buildTodoRailLayout({  cols: cols - 1, viewportBudget: budget,
        teamRows: teamLayout.rowCount, popupRows: 0, composerBaseRows: 0, itemCount: 20,
        panelEnabled: true, overlayOpen: false });
      layoutRows = layout.rows;
      const reportOffset = useCallback((n: number) => { offset = n; }, []);
      const rail = layout.visible && <TodoPanel snapshot={plan} width={layout.width}
        rows={layout.rows} running={false} reducedMotion theme={theme} caps={caps} />;
      const footer = <>
        {teamOn && <TeamPanel snapshot={team} layout={teamLayout} rows={rows}
          cols={layout.contentCols} reducedMotion theme={theme} caps={caps} now={1} />}
      </>;
      const composer = <Composer isActive cols={cols - 1} terminalRows={rows} running={false} history={[]}
          commands={commands} cwd={process.cwd()} showHint={rows >= 20} submitCount={0}
          hintsEnabled agentMode="build" theme={theme} caps={caps} onSubmit={() => ({ accepted: true })}
          onDraftRows={setDraftRows} popupMaxHeight={frame.popupMaxHeight}
          onPopupRowsChange={setPopupRows} />;
      return <AppShell rows={rows} cols={cols} header={<Text>HEADER</Text>}
        viewport={<ScrollViewport cols={layout.contentCols} theme={theme} caps={caps}
          showScrollIndicator rail={rail} footer={footer}
          intent={nonce ? { kind: 'pageUp', nonce } : undefined}
          onScrolledLinesChange={reportOffset}>
          <Transcript /></ScrollViewport>}
        composer={composer} composerSlotRows={frame.composerSlotRows}
        viewportRows={budget} statusRows={1} status={<Text>STATUS</Text>} />;
    }
    const t = terminal();
    const view = render(<Harness cols={100} rows={20} teamOn />, t.options);
    try {
      await delay();
      expect(layoutRows).toBe(14);
      expect(t.frames.at(-1)).toContain('ANCHOR');
      expect(t.frames.at(-1)).toContain('9/20');
      view.rerender(<Harness cols={100} rows={20} teamOn={false} nonce={1} />);
      await delay();
      expect(offset).toBeGreaterThan(0);
      t.stdin.write('/');
      await delay();
      expect(layoutRows).toBe(5);
      t.stdin.write('\u001b');
      await delay();
      expect(layoutRows).toBe(14);
      for (const cols of [75, 76, 100, 200]) {
        t.stdout.columns = cols;
        view.rerender(<Harness cols={cols} rows={20} teamOn={false} nonce={1} />);
        await delay();
        const frame = t.frames.at(-1)!;
        expect(frame).toContain('STATUS');
        for (const line of frame.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(cols);
      }
      expect(mounts).toBe(1);
      expect(offset).toBeGreaterThan(0);
      for (const frame of t.frames) {
        expect(frame).toContain('STATUS');
        expect(frame.split('\n').length).toBeLessThanOrEqual(19);
      }
    } finally { view.unmount(); view.cleanup(); }
  });

  it('隐藏候选不拦截提交，inactive 与卸载报告零，重挂无残留', async () => {
    const t = terminal();
    const submit = vi.fn((_text: string) => ({ accepted: true }));
    const reports = vi.fn();
    const node = (height: number, active = true) => <React.StrictMode>
      <PromptInput isActive={active} running={false} history={[]} commands={commands}
        cwd={process.cwd()} theme={theme} caps={caps} onSubmit={submit}
        popupMaxHeight={height} onPopupRowsChange={reports} />
    </React.StrictMode>;
    const view = render(node(0), t.options);
    try {
      await delay();
      for (const height of [0, 1, 2]) {
        view.rerender(node(height));
        t.stdin.write('/c'); await delay();
        t.stdin.write('\t'); await delay();
        t.stdin.write('\r'); await delay();
        expect(submit).toHaveBeenLastCalledWith('/c');
        expect(reports).toHaveBeenLastCalledWith(0);
      }
      view.rerender(node(3));
      t.stdin.write('/c'); await delay();
      expect(reports).toHaveBeenLastCalledWith(3);
      t.stdin.write('\u001b[Z'); await delay();
      view.rerender(node(3, false)); await delay();
      expect(reports).toHaveBeenLastCalledWith(0);
      view.rerender(node(3)); await delay();
      expect(reports).toHaveBeenLastCalledWith(3);
      const count = reports.mock.calls.length;
      await delay();
      expect(reports).toHaveBeenCalledTimes(count);
      view.rerender(<Text>unmounted</Text>); await delay();
      expect(reports).toHaveBeenLastCalledWith(0);
      view.rerender(node(3)); await delay();
      expect(reports).toHaveBeenLastCalledWith(0);
    } finally { view.unmount(); view.cleanup(); }
  });
});
