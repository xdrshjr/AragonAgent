// The Electron fuse plan: ONE table, used twice - to tell electron-builder what to flip when it
// packs, and by `verify-bundle` to check what is actually written into the finished binary.
//
// The check reads the fuse WIRE from the executable (not this table, not the builder config), so
// a build whose configuration was silently ignored fails verification instead of shipping.
//
//   runAsNode                         off  Hosts are `utilityProcess.fork`; nothing needs
//                                          ELECTRON_RUN_AS_NODE, and with it on, anything that can
//                                          set an environment variable can turn the app into a
//                                          general-purpose Node.
//   enableNodeOptionsEnvironmentVariable  off  NODE_OPTIONS must not inject code into the app.
//   enableNodeCliInspectArguments     off  EXCEPT the e2e flavor: Playwright drives Electron over
//                                          the inspector, so that one build needs it on.
//   enableCookieEncryption            on
//   onlyLoadAppFromAsar               on   The ENTRY must come from app.asar. (The engine is a plain
//                                          directory the host processes are forked from by path;
//                                          this fuse is about the app's entry, not about them.)
//                                          Without it, a `resources/app/` directory would beat the
//                                          asar - and its integrity check - entirely.
//   enableEmbeddedAsarIntegrityValidation  on, Windows and macOS only (Electron does not support it
//                                          elsewhere). It protects app.asar and NOT resources/engine.
//
// If onlyLoadAppFromAsar breaks loading the engine, the documented fallback is `false` with the
// word "hardened" removed from the README - see README, "Hardening".

/** electron-builder `electronFuses` key -> value, for one build. */
export function fusePlan(flavor, platform) {
  const plan = {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: flavor === 'e2e',
    onlyLoadAppFromAsar: true,
  };
  if (platform === 'win32' || platform === 'darwin') plan.enableEmbeddedAsarIntegrityValidation = true;
  else plan.enableEmbeddedAsarIntegrityValidation = false;
  return plan;
}

/** `-c.electronFuses.<key>=<value>` flags for electron-builder. */
export function fuseFlags(flavor, platform) {
  return Object.entries(fusePlan(flavor, platform)).map(([key, value]) => `-c.electronFuses.${key}=${value}`);
}

/**
 * The expected fuse wire for the verifier: fuse NAME in `@electron/fuses` `FuseV1Options` -> boolean.
 * `enableEmbeddedAsarIntegrityValidation` is omitted on Linux (the fuse exists but is meaningless).
 */
export function expectedWire(flavor, platform) {
  const plan = fusePlan(flavor, platform);
  const wire = {
    RunAsNode: plan.runAsNode,
    EnableCookieEncryption: plan.enableCookieEncryption,
    EnableNodeOptionsEnvironmentVariable: plan.enableNodeOptionsEnvironmentVariable,
    EnableNodeCliInspectArguments: plan.enableNodeCliInspectArguments,
    OnlyLoadAppFromAsar: plan.onlyLoadAppFromAsar,
  };
  if (platform === 'win32' || platform === 'darwin') {
    wire.EnableEmbeddedAsarIntegrityValidation = plan.enableEmbeddedAsarIntegrityValidation;
  }
  return wire;
}
