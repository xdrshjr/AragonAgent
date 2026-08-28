'use strict';

const INSECURE_TLS_WARNING =
  "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' " +
  'makes TLS connections and HTTPS requests insecure by disabling ' +
  'certificate verification.';

const FILTER_STATE_KEY = Symbol.for('@aragon-agent/cli.insecure-tls-warning-filter');

function installInsecureTlsWarningFilter(target = process) {
  const existingState = target[FILTER_STATE_KEY];
  if (existingState) return existingState.restore;

  const originalEmitWarning = target.emitWarning;
  let installedState;

  function wrappedEmitWarning(warning) {
    const message =
      typeof warning === 'string'
        ? warning
        : warning instanceof Error
          ? warning.message
          : undefined;

    if (
      target.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' &&
      message === INSECURE_TLS_WARNING
    ) {
      return;
    }

    return Reflect.apply(originalEmitWarning, target, arguments);
  }

  function restore() {
    if (
      target[FILTER_STATE_KEY] !== installedState ||
      target.emitWarning !== wrappedEmitWarning
    ) {
      return;
    }

    target.emitWarning = originalEmitWarning;
    delete target[FILTER_STATE_KEY];
  }

  installedState = {
    originalEmitWarning,
    wrappedEmitWarning,
    restore,
  };
  target[FILTER_STATE_KEY] = installedState;
  target.emitWarning = wrappedEmitWarning;
  return restore;
}

module.exports = {
  INSECURE_TLS_WARNING,
  installInsecureTlsWarningFilter,
};

installInsecureTlsWarningFilter();
