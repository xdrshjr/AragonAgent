/**
 * The Node implementation of core's `SkillHost` port (spec §11.3 / D1).
 *
 * This file is the ONLY reason `@aragon-agent/core` can stay free of `node:*`:
 * every filesystem touch the skills engine needs arrives through here.
 *
 * ERROR CONTRACT (§10.1): these methods deliberately let fs exceptions escape.
 * Swallowing ENOENT / EACCES here would turn "your skill directory is
 * unreadable" into "your skill silently has no content"; the callers that must
 * not throw (the `skill` tool's `execute()`) catch it themselves and produce a
 * diagnosable message.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import type { SkillHost, SkillPlatform } from '@aragon-agent/core';

/**
 * Which shell family the `bash` tool will actually use here (D-G14).
 *
 * THE SINGLE PLACE `process.platform` is read for skills rendering. Core takes
 * `platform` as a parameter instead of looking it up, which is what allows one
 * machine's test run to cover both branches of the Level 3 guidance — a renderer
 * that read `process` could only ever be snapshot-tested on the OS it ran on.
 */
export const currentPlatform = (): SkillPlatform =>
  process.platform === 'win32' ? 'win32' : 'posix';

export function createNodeSkillHost(): SkillHost {
  return {
    readTextFile(path: string): string {
      return readFileSync(path, 'utf-8');
    },

    listDir(path: string): Array<{ name: string; isDirectory: boolean; bytes: number }> {
      return readdirSync(path, { withFileTypes: true }).map((entry) => {
        let bytes = 0;
        if (entry.isFile()) {
          try {
            bytes = statSync(join(path, entry.name)).size;
          } catch {
            // A file that vanished between readdir and stat is reported as 0
            // bytes rather than aborting the whole listing.
            bytes = 0;
          }
        }
        return { name: entry.name, isDirectory: entry.isDirectory(), bytes };
      });
    },

    exists(path: string): boolean {
      return existsSync(path);
    },

    join(...parts: string[]): string {
      return join(...parts);
    },

    relative(from: string, to: string): string {
      return relative(from, to);
    },

    isAbsolute(p: string): boolean {
      return isAbsolute(p);
    },
  };
}
