import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import type { Plugin } from 'vite';

const rendererDependencies: Plugin = {
  name: 'helpr-renderer-dependencies',
  apply: 'build',
  generateBundle(_options, bundle) {
    const directories = new Set<string>();
    for (const entry of Object.values(bundle)) {
      if (entry.type !== 'chunk') continue;
      for (const imported of [...entry.imports, ...entry.dynamicImports]) {
        if (!Object.hasOwn(bundle, imported))
          this.error(`Unbundled renderer import: ${imported}`);
      }
      for (const [id, module] of Object.entries(entry.modules)) {
        if (!module.renderedLength) continue;
        // Vite 的 CommonJS 虚拟模块也保留原始路径。
        const file = id.replace(/^\0/, '').split('?')[0];
        const directory = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(
          file,
        )?.[1];
        if (directory) directories.add(path.relative(process.cwd(), directory));
      }
    }
    this.emitFile({
      type: 'asset',
      fileName: 'dependency-inputs.json',
      source: JSON.stringify([...directories].sort()) + '\n',
    });
  },
};

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
    plugins: [react(), rendererDependencies],
    build: {
      outDir: path.resolve('dist/renderer'),
      rollupOptions: { input: path.resolve('app/renderer/index.html') },
    },
  },
});
