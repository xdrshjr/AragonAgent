/**
 * An in-memory stand-in for the main process's config service: it keeps a revision, answers
 * `config:get`, and applies `config:patch` as a compare-and-swap with the host's own merge rule
 * (a patched section is merged into the stored one, everything else is replaced).
 */

import { DEFAULT_CONFIG } from '@aragon-agent/tui/model/config/schema';
import type { ConfigViewDto, ConfigViewResultDto } from '../../../shared/config-view.js';
import { useConfig } from '../../store/config-store.js';
import { useDrafts } from '../../lib/settings-drafts.js';
import { fail, installBridge, ok, type TestBridge } from './test-bridge.js';

export function makeView(overrides: Record<string, unknown> = {}): ConfigViewDto {
  return { ...structuredClone(DEFAULT_CONFIG), apiKeys: {}, modelProfiles: null, ...overrides } as unknown as ConfigViewDto;
}

const isSection = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the host does to a stored library before the renderer sees it: keys become `{present, tail}`. */
function maskProfiles(library: Record<string, unknown>, keys: Map<string, string>): unknown {
  const entries = (library.entries as Array<Record<string, unknown>>).map(({ apiKey, ...rest }) => {
    const key = typeof apiKey === 'string' && apiKey !== '' ? apiKey : null;
    if (key) keys.set(String(rest.id), key);
    return { ...rest, key: { present: key !== null, tail: key ? key.slice(-4) : '', source: key ? 'file' : 'none' } };
  });
  return { ...library, entries };
}

export interface ConfigServer {
  bridge: TestBridge;
  /** The clear keys the "disk" holds, by profile id (the renderer only ever sees them masked). */
  keys: Map<string, string>;
  patches: Array<{ baseRevision: string; patch: Record<string, unknown> }>;
  view(): ConfigViewDto;
  revision(): string;
  /** Another process saves: the revision moves under the page. */
  writeElsewhere(change: Record<string, unknown>): void;
}

export async function startConfigServer(
  initial: ConfigViewDto = makeView(),
  extra: Parameters<typeof installBridge>[0] = {},
  storedKeys: Record<string, string> = {},
): Promise<ConfigServer> {
  const keys = new Map<string, string>(Object.entries(storedKeys));
  let current = initial;
  let counter = 1;
  const patches: ConfigServer['patches'] = [];
  const result = (): ConfigViewResultDto => ({
    ok: true, revision: `r${counter}`, path: '/home/.aragon-agent/config.json', view: current,
    unknownKeys: [], terminalOnlyKeys: ['mouse', 'scrollMode'],
  });
  const merge = (patch: Record<string, unknown>): void => {
    const next = { ...(current as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'modelProfiles') {
        next[key] = maskProfiles(value as Record<string, unknown>, keys);
        continue;
      }
      next[key] = isSection(value) && isSection(next[key]) && key !== 'modelProfiles' ? { ...(next[key] as object), ...value } : value;
    }
    current = next as unknown as ConfigViewDto;
    counter += 1;
  };
  const bridge = installBridge({
    'config:get': () => ok(result()),
    'config:patch': (arg: { baseRevision: string; patch: Record<string, unknown> }) => {
      patches.push(arg);
      if (arg.baseRevision !== `r${counter}`) return ok({ ok: false as const, code: 'conflict', revision: `r${counter}` });
      merge(arg.patch);
      return ok({ ok: true as const, revision: `r${counter}`, changedKeys: Object.keys(arg.patch) });
    },
    'config:reveal-key': (arg: { profileId?: string }) => {
      const key = arg.profileId ? keys.get(arg.profileId) : undefined;
      return key ? ok({ key }) : fail('not_found', 'no such key');
    },
    ...extra,
  });
  useDrafts.getState().discardAll();
  useConfig.setState({ result: null, conflict: null, startup: 'unknown', staleOnDisk: false });
  await useConfig.getState().refresh();
  return {
    bridge, keys, patches, view: () => current, revision: () => `r${counter}`,
    writeElsewhere: (change) => merge(change),
  };
}
