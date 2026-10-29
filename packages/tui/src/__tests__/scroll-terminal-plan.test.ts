import { describe, expect, it } from 'vitest';
import { resolveTerminalPlan, type TerminalPlanInput } from '../ui/terminal-plan.js';

const BASE: TerminalPlanInput = {
  scrollMode: 'native',
  configMouse: true,
  configMouseSelect: true,
  configPaste: true,
  configKeyboardEnhancement: true,
  configDiffRender: true,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  platform: 'linux',
  vtInputSupported: true,
};

/** The pre-feature expressions from `cli.tsx::runInteractive`, copied verbatim (I-S9). */
function legacy(input: TerminalPlanInput) {
  const wantMouse =
    input.configMouse && !!input.stdoutIsTTY && !!input.stdinIsTTY && input.vtInputSupported;
  const wantPaste = input.configPaste && !!input.stdinIsTTY;
  const wantEnhancedKeys =
    input.configKeyboardEnhancement &&
    !!input.stdinIsTTY &&
    (input.platform !== 'win32' || input.vtInputSupported);
  const wantSelect = wantMouse && input.configMouseSelect;
  return { wantMouse, wantPaste, wantEnhancedKeys, wantSelect };
}

describe('resolveTerminalPlan', () => {
  it('native never enters the alternate screen or asks for mouse reports', () => {
    for (const mouse of [true, false]) {
      for (const select of [true, false]) {
        const plan = resolveTerminalPlan({
          ...BASE, configMouse: mouse, configMouseSelect: select,
        });
        expect(plan.altScreen).toBe(false);
        expect(plan.mouseReporting).toBe(false);
        expect(plan.dragSelect).toBe(false);
        expect(plan.differ).toBe('scrollback');
      }
    }
  });

  it('native with diffRender off keeps the scrollback writer and rewrites every frame', () => {
    const plan = resolveTerminalPlan({ ...BASE, configDiffRender: false });
    expect(plan.differ).toBe('scrollback');
    expect(plan.fullEveryFrame).toBe(true);
    expect(resolveTerminalPlan(BASE).fullEveryFrame).toBe(false);
  });

  it('keeps paste and keyboard enhancement identical across both modes', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      for (const vt of [true, false]) {
        const native = resolveTerminalPlan({ ...BASE, platform, vtInputSupported: vt });
        const app = resolveTerminalPlan({
          ...BASE, platform, vtInputSupported: vt, scrollMode: 'app',
        });
        expect(native.bracketedPaste).toBe(app.bracketedPaste);
        expect(native.enhancedKeys).toBe(app.enhancedKeys);
      }
    }
  });

  it('app reproduces the legacy expressions for every input combination', () => {
    const bools = [true, false];
    for (const configMouse of bools)
      for (const configMouseSelect of bools)
        for (const configPaste of bools)
          for (const configKeyboardEnhancement of bools)
            for (const configDiffRender of bools)
              for (const stdinIsTTY of bools)
                for (const stdoutIsTTY of bools)
                  for (const vtInputSupported of bools)
                    for (const platform of ['win32', 'linux'] as const) {
                      const input: TerminalPlanInput = {
                        scrollMode: 'app', configMouse, configMouseSelect, configPaste,
                        configKeyboardEnhancement, configDiffRender, stdinIsTTY, stdoutIsTTY,
                        platform, vtInputSupported,
                      };
                      const plan = resolveTerminalPlan(input);
                      const old = legacy(input);
                      expect(plan.altScreen).toBe(true);
                      expect(plan.mouseReporting).toBe(old.wantMouse);
                      expect(plan.dragSelect).toBe(old.wantSelect);
                      expect(plan.bracketedPaste).toBe(old.wantPaste);
                      expect(plan.enhancedKeys).toBe(old.wantEnhancedKeys);
                      expect(plan.differ).toBe(configDiffRender ? 'fullscreen' : 'none');
                      expect(plan.fullEveryFrame).toBe(false);
                    }
  });

  it('on win32 without VT input native still gates keyboard enhancement', () => {
    const plan = resolveTerminalPlan({ ...BASE, platform: 'win32', vtInputSupported: false });
    expect(plan.enhancedKeys).toBe(false);
    expect(plan.bracketedPaste).toBe(true);
  });
});
