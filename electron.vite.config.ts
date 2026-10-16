import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: path.resolve('app/desktop/main.ts'),
          host: path.resolve('app/desktop/host.ts'),
          records: path.resolve('app/records/process.ts'),
          observer: path.resolve('app/desktop/observer.ts'),
          executor: path.resolve('app/desktop/executor.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs',
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: path.resolve('app/desktop/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'preload.cjs' },
      },
    },
  },
  renderer: {
    root: path.resolve('app/renderer'),
    plugins: [react()],
    build: {
      outDir: path.resolve('dist/renderer'),
      rollupOptions: { input: path.resolve('app/renderer/index.html') },
    },
  },
});
