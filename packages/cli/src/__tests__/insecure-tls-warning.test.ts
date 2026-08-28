import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const INSECURE_TLS_WARNING =
  "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' " +
  'makes TLS connections and HTTPS requests insecure by disabling ' +
  'certificate verification.';

const preloadPath = fileURLToPath(
  new URL('../../runtime/insecure-tls-warning.cjs', import.meta.url),
);

interface ChildEnvironment {
  NODE_TLS_REJECT_UNAUTHORIZED?: string;
}

function runChild(script: string, environment: ChildEnvironment = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  Object.assign(env, environment);

  return spawnSync(process.execPath, ['--require', preloadPath, '--eval', script], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
  });
}

describe('insecure TLS warning preload', () => {
  it('suppresses the built-in warning when the opt-in is set after preload', () => {
    const result = runChild(`
      const https = require('node:https');
      const net = require('node:net');

      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      process.emitWarning('control-warning');

      const server = net.createServer((socket) => socket.destroy());
      const timer = setTimeout(() => {
        server.close();
        process.exit(2);
      }, 2000);

      function finish() {
        clearTimeout(timer);
        server.close();
      }

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const request = https.get({
          host: '127.0.0.1',
          port: address.port,
        }, (response) => {
          response.resume();
          finish();
        });
        request.on('error', finish);
      });
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('control-warning');
    expect(result.stderr).not.toContain(INSECURE_TLS_WARNING);
  });

  it('preserves an equal warning when the opt-in is absent', () => {
    const result = runChild(
      `process.emitWarning(${JSON.stringify(INSECURE_TLS_WARNING)});`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(INSECURE_TLS_WARNING);
  });

  it('preserves an equal warning for every non-opt-in value', () => {
    for (const value of ['', '1', 'false']) {
      const result = runChild(
        `process.emitWarning(${JSON.stringify(INSECURE_TLS_WARNING)});`,
        { NODE_TLS_REJECT_UNAUTHORIZED: value },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(INSECURE_TLS_WARNING);
    }
  });

  it('suppresses exact Error messages but preserves near matches', () => {
    const result = runChild(
      `
        process.emitWarning(new Error(${JSON.stringify(INSECURE_TLS_WARNING)}));
        process.emitWarning(${JSON.stringify(`${INSECURE_TLS_WARNING}!`)});
      `,
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    );

    expect(result.status, result.stderr).toBe(0);
    const normalizedStderr = result.stderr.replaceAll('\r\n', '\n');
    expect(normalizedStderr).not.toContain(`Error: ${INSECURE_TLS_WARNING}\n`);
    expect(result.stderr).toContain(`${INSECURE_TLS_WARNING}!`);
  });

  it('is idempotent across real module re-evaluation and injected targets', () => {
    const result = runChild(`
      const preloadPath = ${JSON.stringify(preloadPath)};
      const firstModule = require(preloadPath);
      const firstWrappedEmitWarning = process.emitWarning;
      delete require.cache[require.resolve(preloadPath)];
      const secondModule = require(preloadPath);
      if (process.emitWarning !== firstWrappedEmitWarning) process.exit(3);

      process.emitWarning('control-warning');

      const target = {
        env: {},
        emitWarning() {},
      };
      const firstRestore = firstModule.installInsecureTlsWarningFilter(target);
      const secondRestore = secondModule.installInsecureTlsWarningFilter(target);
      if (firstRestore !== secondRestore) process.exit(4);
      process.stdout.write('idempotent');
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('idempotent');
    expect(result.stderr.match(/control-warning/g)).toHaveLength(1);
  });

  it('restores only when it still owns the installed wrapper and state', () => {
    const result = runChild(`
      const warningFilter = require(${JSON.stringify(preloadPath)});
      const stateKey = Symbol.for('@aragon-agent/cli.insecure-tls-warning-filter');

      const original = function original() {};
      const stateTarget = { env: {}, emitWarning: original };
      const stateRestore = warningFilter.installInsecureTlsWarningFilter(stateTarget);
      const installedWrapper = stateTarget.emitWarning;
      const foreignState = { restore() {} };
      stateTarget[stateKey] = foreignState;
      stateRestore();
      if (stateTarget.emitWarning !== installedWrapper || stateTarget[stateKey] !== foreignState) {
        process.exit(5);
      }

      const target = { env: {}, emitWarning: original };
      const restore = warningFilter.installInsecureTlsWarningFilter(target);
      const installedState = target[stateKey];
      const laterWrapper = function laterWrapper() {};
      target.emitWarning = laterWrapper;
      restore();
      if (target.emitWarning !== laterWrapper || target[stateKey] !== installedState) {
        process.exit(6);
      }

      const cleanTarget = { env: {}, emitWarning: original };
      const cleanRestore = warningFilter.installInsecureTlsWarningFilter(cleanTarget);
      cleanRestore();
      cleanRestore();
      if (cleanTarget.emitWarning !== original || stateKey in cleanTarget) process.exit(7);
      process.stdout.write('ownership-safe');
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('ownership-safe');
  });

  it('forwards warning type and code overload arguments unchanged', () => {
    const result = runChild(
      "process.emitWarning('forwarded-warning', 'AragonTestWarning', 'ARAGON_TEST');",
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('[ARAGON_TEST] AragonTestWarning: forwarded-warning');
  });
});
