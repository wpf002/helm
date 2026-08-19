import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // The engine is Electron-free by design, which is what makes it testable
    // here at all — these run in plain node with no window.
    testTimeout: 20_000,
  },
});
