/**
 * Everything the main process does with `config.json`, in one place, over the engine's
 * `host/settings` facade. It owns NO policy about the file's contents: the facade enforces the
 * compare-and-swap, key masking and unknown-key preservation, and this class only decides what
 * the app does with the answer (import state vs onboarding vs a read-only error page).
 *
 * A damaged config is never repaired here. The desktop refuses every write until the file
 * parses again, exactly as the terminal refuses to reset a corrupt file.
 */

import { copyFileSync, existsSync } from 'node:fs';
import type { Engine } from './engine-loader.js';
import {
  describeActiveModel,
  hasUsableMainModel,
  type ConfigPatchResultDto,
  type ConfigViewResultDto,
} from '../shared/config-view.js';
import type {
  ConnectionDraftDto,
  ConnectionTestResultDto,
  ModelOptionDto,
} from '../shared/ipc-contract.js';

export type StartupConfigState =
  | { kind: 'ready'; recognised: { profiles: number; model: string } | null }
  | { kind: 'onboarding' }
  | { kind: 'broken'; path: string; error: string; hasBackup: boolean };

export interface ConfigServiceOptions {
  /**
   * Test harness only (a non-release build started with `--e2e-fault`): every write fails the way
   * a full or read-only disk does. The engine's facade reports both as `write_failed`, so the
   * injected result is the REAL failure shape, not a special one the UI has never seen.
   */
  writeFault?: 'enospc' | 'eacces' | null;
}

export class ConfigService {
  constructor(private readonly engine: Engine, private readonly options: ConfigServiceOptions = {}) {}

  get path(): string {
    return this.engine.paths.getConfigPath();
  }

  get backupPath(): string {
    return this.engine.paths.getConfigBackupPath();
  }

  /** Masked view; the compare-and-swap `revision` rides along. */
  read(): ConfigViewResultDto {
    return this.engine.settings.readConfigView() as unknown as ConfigViewResultDto;
  }

  /** Cheap revision probe for the watcher: it must not build a view. */
  readRevision(): { revision: string; ok: boolean } {
    const { revision, ok } = this.engine.settings.readConfigView();
    return { revision, ok };
  }

  patch(baseRevision: string, patch: Record<string, unknown>): ConfigPatchResultDto {
    if (this.options.writeFault) return { ok: false, code: 'write_failed', revision: baseRevision };
    return this.engine.settings.patchConfig({
      baseRevision,
      patch: patch as never,
    }) as ConfigPatchResultDto;
  }

  /**
   * Classify the config at launch (spec 3.5.2). "Recognised" is deliberately judged on a
   * usable main model rather than on the file existing: an empty file is onboarding, and a
   * terminal user who configured a model must never see onboarding.
   */
  classify(): StartupConfigState {
    const result = this.read();
    if (!result.ok) {
      return {
        kind: 'broken',
        path: result.path,
        error: result.error ?? 'read_failed',
        hasBackup: existsSync(this.backupPath),
      };
    }
    if (!hasUsableMainModel(result.view)) return { kind: 'onboarding' };
    const view = result.view!;
    return {
      kind: 'ready',
      recognised: { profiles: view.modelProfiles?.entries.length ?? 0, model: describeActiveModel(view) },
    };
  }

  /** The one place a stored key is returned in the clear; callers log the audit line. */
  revealKey(provider: string, profileId?: string): string | null {
    return this.engine.settings.revealApiKey(provider, profileId);
  }

  async testConnection(draft: ConnectionDraftDto, signal?: AbortSignal): Promise<ConnectionTestResultDto> {
    return this.engine.settings.testConnection(draft, signal);
  }

  async discoverModels(
    draft: Omit<ConnectionDraftDto, 'model'>,
    signal?: AbortSignal,
  ): Promise<ModelOptionDto[]> {
    const models = await this.engine.settings.discoverModels(draft, signal);
    return models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    }));
  }

  /**
   * Restore `config.json.bak` over a broken file. The broken file is kept beside it first
   * (`.broken-<ts>`) so nothing the user typed is lost.
   */
  restoreBackup(now: () => number = Date.now): boolean {
    if (!existsSync(this.backupPath)) return false;
    try {
      if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.broken-${now()}`);
      copyFileSync(this.backupPath, this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Make every stored key known to the log redactor. Call at boot and after each change. */
  registerSecrets(): void {
    this.engine.settings.registerConfigSecrets();
  }
}
