import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import nkzw from '@nkzw/oxlint-config';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const testWorkers = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 6)));

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 10 * 1024,
  },
  fmt: {
    experimentalSortImports: {
      newlinesBetween: false,
    },
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    ignorePatterns: [
      'coverage/',
      'dist/',
      'index.html',
      'pnpm-lock.yaml',
      'core/__generated__/',
      'core/node_modules/',
    ],
    singleQuote: true,
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: [
      'bin/',
      'dist/',
      'electron/',
      'core/node_modules/',
      'vite.config.ts.timestamp-*',
    ],
    options: { typeAware: true, typeCheck: true },
  },
  plugins: [react({ compiler: true })],
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(__dirname, 'node_modules/react') },
      { find: /^react\/(.*)$/, replacement: `${resolve(__dirname, 'node_modules/react')}/$1` },
      { find: /^react-dom$/, replacement: resolve(__dirname, 'node_modules/react-dom') },
      {
        find: /^react-dom\/(.*)$/,
        replacement: `${resolve(__dirname, 'node_modules/react-dom')}/$1`,
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  run: {
    tasks: {
      'test:all': {
        command: 'vp check && vp test',
      },
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    include: ['core/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    maxWorkers: testWorkers,
    setupFiles: ['./core/__tests__/setup.ts'],
  },
  worker: {
    format: 'es',
  },
});
