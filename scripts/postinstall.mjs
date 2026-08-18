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
