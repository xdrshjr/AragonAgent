/**
 * The Electron half of the session supervisor: forks a `utilityProcess` for each host and
 * wraps it in the `HostProcess` shape the (Electron-free) supervisor is written against.
 *
 * The host entry is an ES module that statically imports the engine; where it lives differs
 * between development (`dist/host/entry.js`, resolving the workspace) and the installed app
 * (`resources/engine/host/entry.js`, resolving `resources/engine/node_modules`) - so `entry`
 * and `cwd` are injected, and the host gets the home root through its environment as well as
 * its `init` message (it refuses to run if the two disagree).
 */

import { utilityProcess } from 'electron';
import type { HostControlMsg } from '../shared/port-protocol.js';
import type { CatalogLauncher, CatalogProcess } from './skills-catalog.js';
import type { HostLauncher, HostProcess } from './session-supervisor.js';

export interface ElectronLauncherOptions {
  entry: string;
  cwd: string;
  homeRoot: string;
  env: NodeJS.ProcessEnv;
  onStdout?: (line: string, pid: number | undefined) => void;
}

/** The host's environment: ours, minus anything that would make it behave as plain Node. */
export function hostEnvironment(options: Pick<ElectronLauncherOptions, 'env' | 'homeRoot'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.ARAGON_HOME = options.homeRoot;
  // The desktop app updates the engine itself; a host must never start a second updater.
  env.ARAGON_UPDATE = 'off';
  return env;
}

export function createElectronLauncher(options: ElectronLauncherOptions): HostLauncher & CatalogLauncher {
  const forkHost = (args: string[]): HostProcess => {
      const child = utilityProcess.fork(options.entry, args, {
        cwd: options.cwd,
        serviceName: 'aragon-session-host',
        stdio: 'pipe',
        env: hostEnvironment(options),
      });
      child.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk.toString('utf8'), child.pid));
      child.stderr?.on('data', (chunk: Buffer) => options.onStdout?.(chunk.toString('utf8'), child.pid));
      const wrapped: HostProcess = {
        get pid() { return child.pid; },
        postMessage: (message, transfer) => child.postMessage(message, transfer as never),
        on(event: 'message' | 'exit', listener: never): void {
          if (event === 'message') child.on('message', listener as (message: HostControlMsg) => void);
          else child.on('exit', listener as (code: number | null) => void);
        },
        kill: () => child.kill(),
      };
      return wrapped;
  };
  return {
    fork: () => forkHost([]),
    // The same entry in `--catalog` mode: answers one skills question, then exits.
    forkCatalog: () => forkHost(['--catalog']) as unknown as CatalogProcess,
  };
}
