// Native-dependency fixup. Runs from the root postinstall.
//
// Replaces `electron-builder install-app-deps`, which could not work here:
// .npmrc sets node-linker=hoisted, so electron resolves to the workspace root
// while the postinstall ran with cwd apps/desktop — electron-builder then
// cannot compute the electron version and exits 1, failing the whole install.
//
// The rebuild it would have performed is also unnecessary. node-pty 1.1.0 is
// N-API (node-addon-api ^7), and N-API is ABI-stable across runtimes: the same
// prebuilt pty.node loads under both Node (MODULE_VERSION 137) and Electron 32
// (MODULE_VERSION 128). Verified, not assumed.
//
// What actually breaks is subtler: node-pty ships a `spawn-helper` executable
// alongside the prebuilt binary, and package extraction does not preserve its
// executable bit. Without +x, pty.spawn() fails at runtime with the opaque
// "posix_spawnp failed." — module load succeeds, so it looks like an ABI issue
// and isn't.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let ptyRoot;
try {
  ptyRoot = dirname(require.resolve('node-pty/package.json'));
} catch {
  console.log('[postinstall] node-pty not installed, nothing to fix');
  process.exit(0);
}

const prebuilds = join(ptyRoot, 'prebuilds');
if (!existsSync(prebuilds)) {
  console.log('[postinstall] node-pty has no prebuilds/, nothing to fix');
  process.exit(0);
}

let fixed = 0;
for (const platform of readdirSync(prebuilds)) {
  const helper = join(prebuilds, platform, 'spawn-helper');
  if (!existsSync(helper)) continue;
  const mode = statSync(helper).mode;
  if ((mode & 0o111) === 0o111) continue;
  chmodSync(helper, 0o755);
  console.log(`[postinstall] chmod +x ${platform}/spawn-helper`);
  fixed++;
}

console.log(
  fixed > 0
    ? `[postinstall] fixed ${fixed} spawn-helper binary(ies)`
    : '[postinstall] spawn-helper already executable',
);

// ---------------------------------------------------------------------------
// Brand the dev Electron binary.
//
// `pnpm dev` launches node_modules/electron/dist/Electron.app directly, and the
// Dock reads that bundle's Info.plist — so the tile says "Electron" and wears
// Electron's icon no matter what app.setName() does at runtime. The packaged
// build has its own bundle and is unaffected. Rewriting the dev bundle's name
// and icon is the only way to make a dev run identify as Helm.
//
// Editing the bundle invalidates its signature, so it is re-signed ad-hoc
// afterwards or macOS refuses to launch it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

if (process.platform === 'darwin') {
  const electronApp = join(
    process.cwd(),
    'node_modules/electron/dist/Electron.app',
  );
  const plist = join(electronApp, 'Contents/Info.plist');
  const iconSrc = join(process.cwd(), 'apps/desktop/build/icon.icns');
  const iconDest = join(electronApp, 'Contents/Resources/electron.icns');

  if (existsSync(plist)) {
    try {
      const current = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleName', plist], {
        encoding: 'utf8',
      }).trim();

      if (current !== 'Helm') {
        for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
          try {
            execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} Helm`, plist]);
          } catch {
            execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string Helm`, plist]);
          }
        }
        if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDest);

        // The Dock and Activity Monitor take the process name from the
        // executable's filename, so LSDisplayName alone still leaves a dev run
        // showing "Electron". Add a Helm-named copy of the launcher (it is a
        // small stub; the frameworks hold the weight), point the bundle and
        // the electron package's path.txt at it, and leave the original in
        // place so electron-builder can still find Electron.app when packaging.
        const macOs = join(electronApp, 'Contents/MacOS');
        copyFileSync(join(macOs, 'Electron'), join(macOs, 'Helm'));
        chmodSync(join(macOs, 'Helm'), 0o755);
        try {
          execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable Helm', plist]);
        } catch {
          /* key always exists in Electron's plist */
        }
        writeFileSync(
          join(process.cwd(), 'node_modules/electron/path.txt'),
          'Electron.app/Contents/MacOS/Helm',
        );

        // Re-sign: the edits above break the existing signature.
        execFileSync('codesign', ['--force', '--sign', '-', electronApp], { stdio: 'ignore' });
        console.log('[postinstall] branded the dev Electron bundle as Helm');
      } else {
        if (existsSync(iconSrc)) copyFileSync(iconSrc, iconDest);
        console.log('[postinstall] dev Electron bundle already branded');
      }
    } catch (error) {
      // Never fail an install over cosmetics.
      console.log(`[postinstall] could not brand dev bundle: ${String(error).split('\n')[0]}`);
    }
  }
}
