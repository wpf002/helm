import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The workspace packages are ESM (`"type": "module"`) but main and preload are
 * emitted as CommonJS — Electron refuses to load an ESM preload while sandbox
 * is enabled, and sandbox is non-negotiable. A CJS bundle cannot `require()` an
 * ESM dependency, so @helm/* is excluded from externalization and bundled in.
 *
 * node-pty stays external: it is a native module and must be loaded from
 * node_modules at runtime, not inlined.
 */
const WORKSPACE = ['@helm/shared', '@helm/engine', '@helm/shell'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE })],
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts' },
        external: ['electron', 'node-pty', /^node:/],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE })],
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts' },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
