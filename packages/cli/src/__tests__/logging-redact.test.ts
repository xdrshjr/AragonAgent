/**
 * Redaction — the one failure in this feature that cannot be undone once it has
 * happened, because by then the user has already pasted the file into an issue.
 *
 * Case 4b is the regression guard for the design's P0-3: the registry backstop
 * must be LIVE. A snapshot taken during `installLogging()` would miss the key a
 * user types into the settings screen, which is both the commonest way a key
 * enters the process and the exact scenario AC-5 describes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactRecord, redactText, REDACTED } from '../logging/redact.js';
import {
  clearSecretsForTest,
  getSecrets,
  registerSecret,
  registerSecretsFrom,
} from '../logging/secret-registry.js';
import { Logger, type LogRecord } from '../logging/logger.js';
import { DEFAULT_LOG_CONFIG } from '../config/schema.js';

const ANTHROPIC_KEY = 'sk-ant-api03-ZZZZfakefakefake0123456789abcdefXYZ';
const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
const GOOGLE_KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-07-27T12:00:00.000+08:00',
    lv: 'info',
    sid: 'testsid1',
    pid: 1,
    scope: 'llm',
    msg: 'request',
    ...overrides,
  };
}

beforeEach(() => clearSecretsForTest());
afterEach(() => clearSecretsForTest());

describe('format-based redaction — three vendors × three positions', () => {
  for (const [vendor, key] of Object.entries({
    anthropic: ANTHROPIC_KEY,
    openai: OPENAI_KEY,
    google: GOOGLE_KEY,
  })) {
    it(`removes a ${vendor} key from msg, a deep data field and an auth header`, () => {
      const out = redactRecord(
        record({
          msg: `request failed with key ${key}`,
          data: {
            nested: { deeper: { value: `prefix ${key} suffix` } },
            headers: { Authorization: `Bearer ${key}` },
          },
        }),
        [],
      );

      const serialised = JSON.stringify(out);
      // No 12-character run of the key may survive anywhere in the record.
      for (let i = 0; i + 12 <= key.length; i += 1) {
        expect(serialised).not.toContain(key.slice(i, i + 12));
      }
      expect(out.msg).toContain(REDACTED);
    });
  }

  it('blanks a credential-looking KEY whatever its value looks like', () => {
    const out = redactRecord(
      record({ data: { api_key: 'plain-text-not-a-vendor-format', apiKey: 'x', token: 'y' } }),
      [],
    );
    expect(out.data).toEqual({ api_key: REDACTED, apiKey: REDACTED, token: REDACTED });
  });

  it('leaves ordinary content alone', () => {
    const out = redactRecord(record({ msg: 'wrote 42 files', data: { toolName: 'bash' } }), []);
    expect(out.msg).toBe('wrote 42 files');
    expect(out.data).toEqual({ toolName: 'bash' });
  });
});

describe('4b — the registry backstop is live, not a startup snapshot (P0-3)', () => {
  it('redacts a key registered AFTER the logger was installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aragon-redact-'));
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, level: 'info' });

    // No vendor prefix, no recognisable shape — the only thing that can catch
    // this is the fact that we hold the literal.
    const custom = 'zq7-endpoint-credential-9f3b2c';
    registerSecret(custom);

    logger.info('llm', 'call', { endpoint: `https://x.test/v1?key=${custom}` });
    logger.flushSync();

    const written = readFileSync(join(dir, findLogFile(dir)), 'utf-8');
    expect(written).not.toContain(custom);
    expect(written).toContain(REDACTED);

    logger.closeSink();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores short values so ordinary text is not shredded', () => {
    registerSecret('off');
    registerSecret('1');
    expect(getSecrets()).toEqual([]);
    expect(redactText('turned off the feature', getSecrets())).toBe('turned off the feature');
  });

  it('registerSecretsFrom skips empty and null entries', () => {
    registerSecretsFrom({ anthropic: ANTHROPIC_KEY, openai: null, google: undefined, other: '' });
    expect(getSecrets()).toEqual([ANTHROPIC_KEY]);
  });
});

describe('4c — a key that is a prefix of another leaves no tail', () => {
  it('replaces the longest match first', () => {
    const short = 'abcdefgh-short-key';
    const long = `${short}-with-a-longer-suffix`;
    registerSecret(short);
    registerSecret(long);

    // Longest-first ordering is what makes this work.
    expect(getSecrets()[0]).toBe(long);
    const out = redactText(`using ${long} now`, getSecrets());
    expect(out).toBe(`using ${REDACTED} now`);
    expect(out).not.toContain('with-a-longer-suffix');
  });
});

describe('bounded traversal', () => {
  it('truncates rather than walking an arbitrarily deep object forever', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    const out = redactRecord(record({ data: deep }), []);
    expect(JSON.stringify(out)).toContain('«truncated»');
  });
});

describe('redactSecrets: false', () => {
  it('writes the record untouched when the user has opted out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aragon-redact-off-'));
    const logger = new Logger({ ...DEFAULT_LOG_CONFIG, dir, redactSecrets: false });
    registerSecret(ANTHROPIC_KEY);

    logger.info('llm', 'call', { apiKey: ANTHROPIC_KEY });
    logger.flushSync();

    // The whole point of the switch, and why setting it prints a warning and
    // has no settings-screen entry.
    expect(readFileSync(join(dir, findLogFile(dir)), 'utf-8')).toContain(ANTHROPIC_KEY);

    logger.closeSink();
    rmSync(dir, { recursive: true, force: true });
  });
});

function findLogFile(dir: string): string {
  const files = readdirSync(dir).filter((f) => f.endsWith('.log'));
  expect(files.length).toBeGreaterThan(0);
  return files[0] as string;
}
