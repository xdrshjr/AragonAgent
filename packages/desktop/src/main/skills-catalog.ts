/**
 * "Which skills are installed?" for the Settings page, answered WITHOUT a session.
 *
 * Skills are user- and project-level state, but the engine that knows how to discover them lives
 * only in the host entry (the main process bundle deliberately contains no engine - layering L6-L9,
 * and `electron-builder.yml` strips `node_modules`). So the main process forks a throwaway
 * `--catalog` process, asks one question and lets it exit. The answer's shape is the same
 * `SkillInfoDto` a live host would give; the page cannot tell the difference.
 *
 * This is the path that only fails in an INSTALLED build (module not found), which is why the
 * product-state E2E in the spec insists on running it there.
 */

import type { HostControlMsg, MainControlMsg, SkillInfoDto } from '../shared/port-protocol.js';

export interface CatalogProcess {
  postMessage(message: MainControlMsg): void;
  on(event: 'message', listener: (message: HostControlMsg) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(): boolean;
}

export interface CatalogLauncher {
  forkCatalog(): CatalogProcess;
}

export type CatalogResult =
  | { ok: true; skills: SkillInfoDto[] }
  | { ok: false; reason: 'timeout' | 'exited' | 'failed'; message: string };

export const CATALOG_TIMEOUT_MS = 5000;

export function queryInstalledSkills(
  launcher: CatalogLauncher,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<CatalogResult> {
  return new Promise((resolve) => {
    const child = launcher.forkCatalog();
    let settled = false;
    const finish = (result: CatalogResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The child exits on its own after answering; this covers the paths where it did not.
      try { child.kill(); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout', message: 'The skills listing did not answer in time.' }),
      options.timeoutMs ?? CATALOG_TIMEOUT_MS,
    );
    child.on('message', (message) => {
      if (message.kind === 'skills') finish({ ok: true, skills: message.skills });
      else if (message.kind === 'fatal') finish({ ok: false, reason: 'failed', message: message.message });
    });
    child.on('exit', (code) =>
      finish({ ok: false, reason: 'exited', message: `The skills listing process exited (${code ?? 'signal'}).` }));
    child.postMessage({ v: 1, kind: 'skills-query', cwd });
  });
}
