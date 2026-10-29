/**
 * `desktop-state.json`: the ONLY file the desktop owns, and the terminal never reads.
 *
 * It sits in the home root rather than Electron's `userData` so one `ARAGON_HOME` moves or
 * isolates everything (tests, portable mode). Nothing the terminal cares about belongs here;
 * nothing here may be written into `config.json`.
 *
 * Unknown fields survive a round trip (forward compatibility) and every number is clamped,
 * so a hand-edited or newer-version file can neither crash a launch nor push a window
 * off-screen.
 */

import { isChromeTheme, type ChromeTheme } from './window-chrome.js';

export const DESKTOP_STATE_SCHEMA = 1;
export const DESKTOP_STATE_FILE = 'desktop-state.json';

export type LanguageSetting = 'auto' | 'en' | 'zh-CN';
export type InspectorTab = 'changes' | 'plan' | 'agents' | 'jobs' | 'context' | 'governance';

export interface WindowState {
  id: string;
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
  /** Page zoom factor, [ZOOM_MIN, ZOOM_MAX]; absent means 1. */
  zoom?: number;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  openSessions: string[];
  activeSession: string | null;
  /** The theme the window chrome was last painted for; owned by the main process (see mergeRendererWindows). */
  chromeTheme?: ChromeTheme;
}

export interface DesktopState {
  schema: number;
  windows: WindowState[];
  recentWorkspaces: string[];
  language: LanguageSetting;
  enterToSend: boolean;
  maxLiveHosts: number;
  parkAfterIdleMinutes: number;
  dismissedHints: string[];
  update: {
    channel: 'stable' | 'beta';
    lastCheckedAt: number;
    skippedVersion: string | null;
    /** Check for updates in the background. Off means no network request at all. */
    enabled: boolean;
    /** A user override of the build's feed; must still pass the build-time host list. */
    feedUrl: string | null;
  };
  /** "Always allow this tool for this session". Ends with the session; never crosses sessions. */
  sessionAllowedTools: Record<string, string[]>;
  /** Fields this build does not know, kept verbatim. */
  extras: Record<string, unknown>;
}

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.6;

/** Clamp a zoom factor to the supported range, to two decimals; anything not finite is 1. */
export function clampZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100;
}

export const LIMITS = {
  sidebarWidth: { min: 200, max: 420, fallback: 260 },
  inspectorWidth: { min: 320, max: 640, fallback: 400 },
  windowWidth: { min: 640, max: 10_000, fallback: 1280 },
  windowHeight: { min: 480, max: 10_000, fallback: 820 },
  maxLiveHosts: { min: 2, max: 12, fallback: 6 },
  parkAfterIdleMinutes: { min: 0, max: 24 * 60, fallback: 15 },
  recentWorkspaces: 20,
  windows: 8,
  openSessions: 24,
} as const;

const KNOWN_KEYS = new Set([
  'schema', 'windows', 'recentWorkspaces', 'language', 'enterToSend', 'maxLiveHosts',
  'parkAfterIdleMinutes', 'dismissedHints', 'update', 'sessionAllowedTools',
]);
const INSPECTOR_TABS: readonly InspectorTab[] = ['changes', 'plan', 'agents', 'jobs', 'context', 'governance'];

export function clampNumber(value: unknown, range: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) if (typeof item === 'string' && item.length > 0) seen.add(item);
  return [...seen].slice(0, max);
};

function normalizeWindow(raw: unknown, index: number): WindowState | null {
  if (!isRecord(raw)) return null;
  const bounds = isRecord(raw.bounds) ? raw.bounds : {};
  const x = typeof bounds.x === 'number' && Number.isFinite(bounds.x) ? Math.round(bounds.x) : undefined;
  const y = typeof bounds.y === 'number' && Number.isFinite(bounds.y) ? Math.round(bounds.y) : undefined;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `w${index + 1}`,
    bounds: {
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      width: clampNumber(bounds.width, LIMITS.windowWidth),
      height: clampNumber(bounds.height, LIMITS.windowHeight),
    },
    maximized: raw.maximized === true,
    // normalizeWindow rebuilds the object field by field, so a field not listed here is dropped.
    ...(typeof raw.zoom === 'number' && Number.isFinite(raw.zoom) ? { zoom: clampZoom(raw.zoom) } : {}),
    sidebarWidth: clampNumber(raw.sidebarWidth, LIMITS.sidebarWidth),
    inspectorWidth: clampNumber(raw.inspectorWidth, LIMITS.inspectorWidth),
    inspectorOpen: raw.inspectorOpen === true,
    inspectorTab: INSPECTOR_TABS.includes(raw.inspectorTab as InspectorTab)
      ? (raw.inspectorTab as InspectorTab) : 'changes',
    openSessions: stringList(raw.openSessions, LIMITS.openSessions),
    activeSession: typeof raw.activeSession === 'string' ? raw.activeSession : null,
    ...(isChromeTheme(raw.chromeTheme) ? { chromeTheme: raw.chromeTheme } : {}),
  };
}

/** The inspector's width before v1.3; six Chinese tab labels do not fit in it. */
export const LEGACY_INSPECTOR_WIDTH = 340;

/**
 * v1.3 raised the inspector's default from 340 to 400. A stored 340 is almost certainly the old
 * default rather than a choice, so it is lifted to the new default - on LOAD only. `normalizeWindow`
 * also runs on every renderer patch, and migrating there would rewrite a width the user just dragged
 * to 340 while the screen still showed 340. A user who really chose 340 gets 60px more, and can drag
 * it back.
 */
export function migrateLegacyInspectorWidth(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.windows)) return input;
  return {
    ...input,
    windows: input.windows.map((window) => (
      isRecord(window) && window.inspectorWidth === LEGACY_INSPECTOR_WIDTH
        ? { ...window, inspectorWidth: LIMITS.inspectorWidth.fallback }
        : window
    )),
  };
}

export function defaultDesktopState(): DesktopState {
  return {
    schema: DESKTOP_STATE_SCHEMA,
    windows: [],
    recentWorkspaces: [],
    language: 'auto',
    enterToSend: true,
    maxLiveHosts: LIMITS.maxLiveHosts.fallback,
    parkAfterIdleMinutes: LIMITS.parkAfterIdleMinutes.fallback,
    dismissedHints: [],
    update: { channel: 'stable', lastCheckedAt: 0, skippedVersion: null, enabled: true, feedUrl: null },
    sessionAllowedTools: {},
    extras: {},
  };
}

/** Turn whatever was parsed from disk into a complete, clamped state. Never throws. */
export function normalizeDesktopState(input: unknown): DesktopState {
  const base = defaultDesktopState();
  if (!isRecord(input)) return base;
  const update = isRecord(input.update) ? input.update : {};
  const allowed: Record<string, string[]> = {};
  if (isRecord(input.sessionAllowedTools)) {
    for (const [id, tools] of Object.entries(input.sessionAllowedTools)) allowed[id] = stringList(tools, 64);
  }
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (!KNOWN_KEYS.has(key)) extras[key] = value;
  const windows = Array.isArray(input.windows)
    ? input.windows.map(normalizeWindow).filter((window): window is WindowState => window !== null)
    : [];
  return {
    schema: DESKTOP_STATE_SCHEMA,
    windows: windows.slice(0, LIMITS.windows),
    recentWorkspaces: stringList(input.recentWorkspaces, LIMITS.recentWorkspaces),
    language: input.language === 'en' || input.language === 'zh-CN' ? input.language : 'auto',
    enterToSend: input.enterToSend !== false,
    maxLiveHosts: clampNumber(input.maxLiveHosts, LIMITS.maxLiveHosts),
    parkAfterIdleMinutes: clampNumber(input.parkAfterIdleMinutes, LIMITS.parkAfterIdleMinutes),
    dismissedHints: stringList(input.dismissedHints, 200),
    update: {
      channel: update.channel === 'beta' ? 'beta' : 'stable',
      lastCheckedAt: typeof update.lastCheckedAt === 'number' ? update.lastCheckedAt : 0,
      skippedVersion: typeof update.skippedVersion === 'string' ? update.skippedVersion : null,
      enabled: update.enabled !== false,
      feedUrl: typeof update.feedUrl === 'string' && update.feedUrl.length > 0 && update.feedUrl.length <= 2048 ? update.feedUrl : null,
    },
    sessionAllowedTools: allowed,
    extras,
  };
}

/** The JSON object to persist: known fields plus the preserved extras. */
export function serializeDesktopState(state: DesktopState): Record<string, unknown> {
  const { extras, ...known } = state;
  return { ...extras, ...known };
}

/**
 * A `windows` patch from the RENDERER. It owns the panel layout; the MAIN process owns the geometry
 * (bounds, maximized, zoom) and the chrome theme, which it reads from the live window. The renderer's copy of those three
 * is whatever it read at mount, so letting it write them back would undo every move, resize and zoom
 * since - and, because `normalizeWindow` rebuilds the object, silently drop `zoom` altogether.
 */
export function mergeRendererWindows(current: readonly WindowState[], incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  return incoming.map((raw, index) => {
    const held = current[index];
    if (!held || !isRecord(raw)) return raw;
    const { bounds, maximized, zoom, chromeTheme } = held;
    const { chromeTheme: _renderer, ...layout } = raw;
    return {
      ...layout, bounds, maximized,
      ...(zoom === undefined ? {} : { zoom }),
      ...(chromeTheme === undefined ? {} : { chromeTheme }),
    };
  });
}

/** Add a workspace to the recent list: most recent first, de-duplicated, bounded. */
export function rememberWorkspace(state: DesktopState, path: string): DesktopState {
  const rest = state.recentWorkspaces.filter((entry) => entry !== path);
  return { ...state, recentWorkspaces: [path, ...rest].slice(0, LIMITS.recentWorkspaces) };
}

/**
 * The key sessions are grouped under in the sidebar. Windows and macOS volumes are case
 * insensitive and mix `/` with `\`, so the same folder reached two ways must land in one
 * group; the display label keeps the user's own spelling.
 */
export function workspaceGroupKey(path: string, caseInsensitive: boolean): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^[A-Za-z]:/.test(unified) ? unified[0]!.toLowerCase() + unified.slice(1) : unified;
  return caseInsensitive ? drive.toLowerCase() : drive;
}
