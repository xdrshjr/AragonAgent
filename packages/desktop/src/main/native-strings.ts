/**
 * Strings for dialogs the MAIN process shows (renderer-crash recovery, session export). The
 * renderer's own dictionaries are unreachable from here - the renderer is exactly what may be
 * dead - so this is a deliberately tiny second table. `native-strings.test.ts` asserts both
 * languages have identical keys.
 */

import type { LanguageSetting } from '../shared/desktop-state.js';

export type NativeLocale = 'en' | 'zh';

const EN = {
  'crash.title': 'AragonAgent stopped responding',
  'crash.message': 'The window crashed or failed to load repeatedly.',
  'crash.detail': 'Your sessions are still running in the background and nothing was lost. Reload the window to continue.',
  'crash.reload': 'Reload',
  'crash.openLogs': 'Open log folder',
  'crash.quit': 'Quit',
  'hang.title': 'The window is not responding',
  'hang.message': 'AragonAgent is busy or stuck.',
  'hang.detail': 'You can keep waiting, or reload the window. Your sessions keep running either way.',
  'hang.wait': 'Keep waiting',
  'hang.reload': 'Reload',
  'export.title': 'Export conversation',
  'export.filter': 'Markdown',
} as const;

export type NativeKey = keyof typeof EN;

const ZH: Record<NativeKey, string> = {
  'crash.title': 'AragonAgent 已停止响应',
  'crash.message': '窗口多次崩溃或加载失败。',
  'crash.detail': '会话仍在后台运行，没有丢失任何内容。重新加载窗口即可继续。',
  'crash.reload': '重新加载',
  'crash.openLogs': '打开日志目录',
  'crash.quit': '退出',
  'hang.title': '窗口无响应',
  'hang.message': 'AragonAgent 正忙或已卡住。',
  'hang.detail': '可以继续等待，也可以重新加载窗口。无论哪种，会话都会继续运行。',
  'hang.wait': '继续等待',
  'hang.reload': '重新加载',
  'export.title': '导出对话',
  'export.filter': 'Markdown',
};

export const NATIVE_TABLES = { en: EN as Record<NativeKey, string>, zh: ZH } as const;

/** `auto` follows the OS locale (`zh*` -> zh, anything else -> en). */
export function resolveNativeLocale(setting: LanguageSetting, osLocale: string): NativeLocale {
  if (setting === 'en') return 'en';
  if (setting === 'zh-CN') return 'zh';
  return osLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function nativeText(locale: NativeLocale, key: NativeKey): string {
  return NATIVE_TABLES[locale][key] ?? NATIVE_TABLES.en[key];
}
