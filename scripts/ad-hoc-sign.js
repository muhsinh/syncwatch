// electron-builder afterPack hook: ad-hoc sign the macOS app.
// Apple Silicon refuses to launch an app whose (Electron-supplied) signature no longer matches its contents.
// Ad-hoc signing needs no Apple Developer account; users still approve the first launch via right-click > Open.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
