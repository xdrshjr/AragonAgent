import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  mergeRendererWindows,
  migrateLegacyInspectorWidth,
  clampNumber,
  defaultDesktopState,
  normalizeDesktopState,
  rememberWorkspace,
  serializeDesktopState,
  workspaceGroupKey,
} from '../desktop-state.js';

describe('normalizeDesktopState', () => {
  it('turns garbage into a complete default state without throwing', () => {
    for (const input of [null, undefined, 42, 'x', [], { windows: 'no', maxLiveHosts: 'many' }]) {
      const state = normalizeDesktopState(input);
      expect(state.maxLiveHosts).toBe(LIMITS.maxLiveHosts.fallback);
      expect(state.windows).toEqual([]);
      expect(state.language).toBe('auto');
    }
  });

  it('clamps every numeric field into its documented range', () => {
    const state = normalizeDesktopState({
      maxLiveHosts: 500, parkAfterIdleMinutes: -3,
      windows: [{ bounds: { width: 5, height: 99999 }, sidebarWidth: 10, inspectorWidth: 9999 }],
    });
    expect(state.maxLiveHosts).toBe(LIMITS.maxLiveHosts.max);
    expect(state.parkAfterIdleMinutes).toBe(LIMITS.parkAfterIdleMinutes.min);
    const window = state.windows[0]!;
    expect(window.bounds.width).toBe(LIMITS.windowWidth.min);
    expect(window.bounds.height).toBe(LIMITS.windowHeight.max);
    expect(window.sidebarWidth).toBe(LIMITS.sidebarWidth.min);
    expect(window.inspectorWidth).toBe(LIMITS.inspectorWidth.max);
  });

  it('keeps fields it does not know and writes them back (forward compatibility)', () => {
    const state = normalizeDesktopState({ future: { a: 1 }, language: 'zh-CN' });
    expect(state.language).toBe('zh-CN');
    expect(serializeDesktopState(state)).toMatchObject({ future: { a: 1 }, language: 'zh-CN', schema: 1 });
  });

  it('is idempotent: normalising its own output changes nothing', () => {
    const once = normalizeDesktopState({ recentWorkspaces: ['a', 'a', 'b'], maxLiveHosts: 3 });
    expect(normalizeDesktopState(serializeDesktopState(once))).toEqual(once);
  });

  it('bounds list sizes and de-duplicates', () => {
    const many = Array.from({ length: 80 }, (_unused, index) => `/w/${index}`);
    expect(normalizeDesktopState({ recentWorkspaces: many }).recentWorkspaces).toHaveLength(LIMITS.recentWorkspaces);
    expect(normalizeDesktopState({ recentWorkspaces: ['x', 'x', ''] }).recentWorkspaces).toEqual(['x']);
  });
});

describe('clampNumber', () => {
  it('rounds, clamps and falls back for non-numbers', () => {
    const range = { min: 2, max: 12, fallback: 6 };
    expect(clampNumber(7.6, range)).toBe(8);
    expect(clampNumber(Number.NaN, range)).toBe(6);
    expect(clampNumber('9', range)).toBe(6);
    expect(clampNumber(Infinity, range)).toBe(6);
  });
});

describe('rememberWorkspace', () => {
  it('moves a repeated workspace to the front instead of duplicating it', () => {
    let state = defaultDesktopState();
    state = rememberWorkspace(state, '/a');
    state = rememberWorkspace(state, '/b');
    state = rememberWorkspace(state, '/a');
    expect(state.recentWorkspaces).toEqual(['/a', '/b']);
  });
});

describe('workspaceGroupKey', () => {
  it('groups the same Windows folder spelled several ways under one key', () => {
    const keys = ['D:\\Work\\Repo', 'd:/work/repo', 'D:/Work/Repo/'].map((path) => workspaceGroupKey(path, true));
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps case-different folders apart on a case-sensitive volume', () => {
    expect(workspaceGroupKey('/work/Repo', false)).not.toBe(workspaceGroupKey('/work/repo', false));
  });
});

describe('mergeRendererWindows (two writers, one window entry)', () => {
  const held = normalizeDesktopState({
    windows: [{ bounds: { x: 100, y: 80, width: 1100, height: 760 }, maximized: true, zoom: 1.25, sidebarWidth: 260 }],
  }).windows;

  it('geometry and zoom are taken from the current state, never from the renderer', () => {
    const merged = mergeRendererWindows(held, [{
      id: 'w1', bounds: { width: 1280, height: 820 }, maximized: false, sidebarWidth: 333, inspectorOpen: true,
    }]) as Array<Record<string, unknown>>;
    expect(merged[0]).toMatchObject({ bounds: { x: 100, y: 80, width: 1100, height: 760 }, maximized: true, zoom: 1.25, sidebarWidth: 333, inspectorOpen: true });
  });

  it('after normalisation the zoom is still there (the renderer never sends one)', () => {
    const merged = mergeRendererWindows(held, [{ id: 'w1', sidebarWidth: 300 }]);
    expect(normalizeDesktopState({ windows: merged }).windows[0]?.zoom).toBe(1.25);
  });

  it('a window the main process has not saved yet is passed through, and non-arrays are untouched', () => {
    const raw = [{ id: 'w1', sidebarWidth: 300 }];
    expect(mergeRendererWindows([], raw)).toEqual(raw);
    expect(mergeRendererWindows(held, 'nope')).toBe('nope');
  });
});

describe('window chrome theme (v1.3)', () => {
  const base = { bounds: { width: 1000, height: 700 } };

  it('survives normalisation (normalizeWindow rebuilds the object field by field)', () => {
    expect(normalizeDesktopState({ windows: [{ ...base, chromeTheme: 'warm' }] }).windows[0]?.chromeTheme).toBe('warm');
  });

  it('an unknown or missing value reads as absent', () => {
    expect(normalizeDesktopState({ windows: [base] }).windows[0]?.chromeTheme).toBeUndefined();
    expect(normalizeDesktopState({ windows: [{ ...base, chromeTheme: '#fff' }] }).windows[0]?.chromeTheme).toBeUndefined();
  });

  it('the renderer cannot overwrite it, and cannot erase it by omission', () => {
    const held = normalizeDesktopState({ windows: [{ ...base, chromeTheme: 'dark' }] }).windows;
    const forged = mergeRendererWindows(held, [{ id: 'w1', chromeTheme: 'light', sidebarWidth: 300 }]) as Array<Record<string, unknown>>;
    expect(forged[0]?.chromeTheme).toBe('dark');
    const omitted = mergeRendererWindows(held, [{ id: 'w1', sidebarWidth: 300 }]) as Array<Record<string, unknown>>;
    expect(omitted[0]?.chromeTheme).toBe('dark');
  });
});

describe('inspector width (v1.3)', () => {
  const window = (inspectorWidth: number) => ({ bounds: { width: 1000, height: 700 }, inspectorWidth });

  it('clamps to [320, 640] with a default of 400', () => {
    expect(LIMITS.inspectorWidth).toMatchObject({ min: 320, max: 640, fallback: 400 });
    expect(normalizeDesktopState({ windows: [window(300)] }).windows[0]?.inspectorWidth).toBe(320);
    expect(normalizeDesktopState({ windows: [window(999)] }).windows[0]?.inspectorWidth).toBe(640);
  });

  it('the LOAD path lifts the old default 340 to 400', () => {
    const loaded = normalizeDesktopState(migrateLegacyInspectorWidth({ windows: [window(340)] }));
    expect(loaded.windows[0]?.inspectorWidth).toBe(400);
  });

  it('the patch path does NOT: a width the user just dragged to 340 stays 340', () => {
    expect(normalizeDesktopState({ windows: [window(340)] }).windows[0]?.inspectorWidth).toBe(340);
  });

  it('leaves other widths and malformed input alone', () => {
    expect(normalizeDesktopState(migrateLegacyInspectorWidth({ windows: [window(520)] })).windows[0]?.inspectorWidth).toBe(520);
    expect(migrateLegacyInspectorWidth(null)).toBeNull();
    expect(migrateLegacyInspectorWidth({ windows: 'x' })).toEqual({ windows: 'x' });
  });
});
