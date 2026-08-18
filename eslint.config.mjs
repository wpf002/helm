import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/release/**', '**/node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused args are how you document an ignored callback parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The IPC boundary hands us `unknown` and validates it by hand; that is
      // the point. Explicit `any` is still banned.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // The renderer must never reach past the preload bridge. check-boundaries.sh
    // is the CI gate; this makes it fail in the editor too.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'Renderer must cross the preload bridge.' },
            { name: 'path', message: 'Renderer must cross the preload bridge.' },
            { name: 'child_process', message: 'Renderer must cross the preload bridge.' },
            { name: 'node-pty', message: 'Renderer must cross the preload bridge.' },
            { name: 'electron', message: 'Renderer must cross the preload bridge.' },
            { name: '@helm/engine', message: 'Renderer must cross the preload bridge.' },
            { name: '@helm/shell', message: 'Renderer must cross the preload bridge.' },
          ],
          patterns: ['node:*'],
        },
      ],
    },
  },
  {
    // engine must stay runnable from a plain node script.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'electron', message: 'engine must not import Electron.' }] },
      ],
    },
  },
);
