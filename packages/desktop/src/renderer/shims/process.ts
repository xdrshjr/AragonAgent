/**
 * `node:process` for the sandboxed renderer. The view model reads two things from it
 * (`env` for opt-in debug flags and `platform`); nothing else is promised. A missing symbol
 * fails loudly at the call site rather than here, which is what keeps this shim honest.
 */
const shim = {
  env: {} as Record<string, string | undefined>,
  platform: 'browser',
  versions: {} as Record<string, string>,
  argv: [] as string[],
  cwd: () => '/',
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
};
export default shim;
export const { env, platform, versions, argv, cwd, nextTick } = shim;
