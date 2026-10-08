/**
 * Settings persistence: `settings.json` (non-secret) + `keys.json` (secret vault).
 *
 * The vault encrypts every API key with Electron `safeStorage` (DPAPI on
 * Windows, Keychain on macOS, libsecret/KWallet on Linux). Where safeStorage
 * is unavailable (bare Linux without a secret service) the vault degrades to
 * plainly-encoded keys and says so via `vaultEncryption`, so the UI can warn
 * instead of pretending.
 *
 * Writes are single-file and atomic (write temp, rename). Nothing here ever
 * logs a key.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type {
  ModelProfile,
  ProfileDraftInput,
  SaveSettingsInput,
  SaveSettingsResult,
  SettingsSnapshot,
} from '../../shared/protocol.js';
import {
  PROFILE_LIMITS,
  defaultProfiles,
  normalizeDraft,
  toStoredProfile,
  validateProfile,
} from './profiles.js';
import { maskKey } from '../../shared/ids.js';

interface StoredSettings {
  version: 1;
  activeProfileId: string;
  defaultCwd: string;
  /** Non-secret profile fields. Secrets live in the vault, keyed by profile id. */
  profiles: Array<Omit<ModelProfile, 'hasKey' | 'keyPreview'>>;
}

interface StoredVault {
  version: 1;
  encryption: 'safeStorage' | 'plain';
  /** base64(safeStorage-encrypted key) or base64(plain key) when encryption is `plain`. */
  entries: Record<string, string>;
}

export class SettingsStore {
  private readonly settingsPath: string;

  private readonly vaultPath: string;

  private settings: StoredSettings | null = null;

  private vault: StoredVault | null = null;

  constructor(userDataDir: string) {
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.vaultPath = path.join(userDataDir, 'keys.json');
  }

  async load(): Promise<void> {
    this.settings = await this.readJson<StoredSettings>(this.settingsPath);
    this.vault = await this.readJson<StoredVault>(this.vaultPath);
  }

  snapshot(): SettingsSnapshot {
    const settings = this.ensureSettings();
    const vault = this.ensureVault();
    return {
      profiles: settings.profiles.map((profile) => {
        const key = vault.entries[profile.id];
        return {
          ...profile,
          hasKey: typeof key === 'string' && key.length > 0,
          keyPreview: '',
        };
      }),
      activeProfileId: settings.activeProfileId,
      defaultCwd: settings.defaultCwd,
    };
  }

  getProfile(id: string): ModelProfile | null {
    return this.snapshot().profiles.find((profile) => profile.id === id) ?? null;
  }

  /** Decrypt a profile key, or null when none is stored. Throws only on corruption. */
  decryptKey(profileId: string): string | null {
    const vault = this.ensureVault();
    const stored = vault.entries[profileId];
    if (typeof stored !== 'string' || stored.length === 0) return null;
    const buffer = Buffer.from(stored, 'base64');
    if (vault.encryption === 'plain') return buffer.toString('utf8');
    try {
      return safeStorage.decryptString(buffer);
    } catch {
      // A key encrypted for another OS user or before a credential reset is
      // unreadable; treating it as absent is safer than crashing the app.
      return null;
    }
  }

  vaultEncryption(): 'safeStorage' | 'plain' {
    return this.ensureVault().encryption;
  }

  /**
   * Validate and persist a whole settings draft. The write is transactional:
   * validation issues mean nothing touches disk.
   */
  async save(input: SaveSettingsInput): Promise<SaveSettingsResult> {
    if (input.profiles.length > PROFILE_LIMITS.maxProfiles) {
      return { ok: false, issues: [], snapshot: null };
    }
    const issues: SaveSettingsResult['issues'] = [];
    const normalized = input.profiles.map((draft) => normalizeDraft(draft));
    normalized.forEach((draft, index) => {
      const siblings = normalized.filter((_, other) => other !== index).map((other) => other.label);
      for (const code of validateProfile(draft, siblings)) issues.push({ profileIndex: index, code });
    });
    const activeExists =
      input.activeProfileId.length === 0 ||
      normalized.length === 0 ||
      normalized.some((_draft, index) => {
        const draft = input.profiles[index];
        return draft.id === input.activeProfileId;
      });
    if (!activeExists) {
      return { ok: false, issues, snapshot: null };
    }
    if (issues.length > 0) {
      return { ok: false, issues, snapshot: null };
    }

    const settings = this.ensureSettings();
    const vault = this.ensureVault();
    const storedProfiles: StoredSettings['profiles'] = [];
    const newVault: StoredVault = { version: 1, encryption: vault.encryption, entries: {} };

    normalized.forEach((draft, index) => {
      const draftInput = input.profiles[index];
      const id = draftInput.id ?? null;
      const stored = toStoredProfile(draft, id);
      storedProfiles.push(stored);

      if (draft.apiKey !== null) {
        newVault.entries[stored.id] = this.encryptForVault(draft.apiKey, newVault);
      } else if (id && vault.entries[id]) {
        newVault.entries[stored.id] = vault.entries[id];
      }
    });

    settings.profiles = storedProfiles;
    settings.activeProfileId = input.activeProfileId;
    settings.defaultCwd = input.defaultCwd;
    this.vault = newVault;

    await this.writeJson(this.settingsPath, settings);
    await this.writeJson(this.vaultPath, newVault);
    return { ok: true, issues: [], snapshot: this.snapshot() };
  }

  private encryptForVault(key: string, vault: StoredVault): string {
    if (vault.encryption === 'plain') return Buffer.from(key, 'utf8').toString('base64');
    return safeStorage.encryptString(key).toString('base64');
  }

  private ensureSettings(): StoredSettings {
    if (this.settings) return this.settings;
    const seeded: StoredSettings = {
      version: 1,
      activeProfileId: defaultProfiles()[0].id,
      defaultCwd: '',
      profiles: defaultProfiles().map(({ hasKey: _hasKey, keyPreview: _keyPreview, ...rest }) => rest),
    };
    this.settings = seeded;
    return seeded;
  }

  private ensureVault(): StoredVault {
    if (this.vault) return this.vault;
    const encryption = safeStorage.isEncryptionAvailable() ? 'safeStorage' : 'plain';
    this.vault = { version: 1, encryption, entries: {} };
    return this.vault;
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      const text = await fs.readFile(file, 'utf8');
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temp, file);
  }
}

/** Masked preview for UI display of a stored key. */
export function previewKey(key: string | null): string {
  return key ? maskKey(key) : '';
}
