/**
 * The session index: `<userData>/sessions/index.json` holding one
 * `SessionMeta` per desktop session, written atomically.
 *
 * Index and journals live under the SAME sessions directory, so removing a
 * session is one directory deletion plus one index rewrite. Reads are lenient
 * (a missing or corrupt index yields an empty list) and writes are throttled
 * by the caller.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionMeta } from '../../shared/protocol.js';

/** Fill defaults for fields added after the first release (contextEpoch). */
function normalizeMeta(meta: SessionMeta): SessionMeta {
  return {
    ...meta,
    contextEpoch: typeof meta.contextEpoch === 'number' && meta.contextEpoch >= 0 ? meta.contextEpoch : 0,
    usage: meta.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: meta.cost ?? { amount: 0, known: false },
    messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : 0,
  };
}

export class SessionIndexStore {
  private readonly file: string;

  private cache: SessionMeta[] | null = null;

  constructor(sessionsDir: string) {
    this.file = path.join(sessionsDir, 'index.json');
  }

  async list(): Promise<SessionMeta[]> {
    if (this.cache) return [...this.cache];
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(text);
      this.cache = Array.isArray(parsed) ? (parsed as SessionMeta[]).map(normalizeMeta) : [];
    } catch {
      this.cache = [];
    }
    return [...this.cache];
  }

  async upsert(meta: SessionMeta): Promise<void> {
    const list = await this.list();
    const at = list.findIndex((entry) => entry.id === meta.id);
    if (at >= 0) list[at] = meta;
    else list.unshift(meta);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    await this.persist(list);
  }

  async get(id: string): Promise<SessionMeta | null> {
    const list = await this.list();
    return list.find((entry) => entry.id === id) ?? null;
  }

  async remove(id: string): Promise<void> {
    const list = await this.list();
    await this.persist(list.filter((entry) => entry.id !== id));
  }

  async replaceAll(metas: SessionMeta[]): Promise<void> {
    const list = [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
    await this.persist(list);
  }

  private async persist(list: SessionMeta[]): Promise<void> {
    this.cache = list;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(list, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}
