// electron-builder afterPack hook: copy the staged engine into the app's resources as real files.
//
// `extraResources` cannot do this job: electron-builder's copier drops every `node_modules`
// directory it meets (even with an explicit `**/*` filter), which leaves `resources/engine` without
// the engine's dependencies - the app then fails on first launch with "engine not found". The
// packaged `--smoke` run is what caught this; this hook is what fixes it.
const { cpSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const source = join(__dirname, '..', 'build-staging', 'engine');
  if (!existsSync(join(source, 'node_modules'))) {
    throw new Error(`afterPack: ${source} has no node_modules; run "npm run stage" first.`);
  }
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  cpSync(source, join(resources, 'engine'), { recursive: true, verbatimSymlinks: false });
};
