import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The two AI engines run as separate utility processes so a heavy model never freezes the window.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          speech: resolve(__dirname, 'src/workers/speech.ts'),
          llm: resolve(__dirname, 'src/workers/llm.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { target: 'chrome140', minify: !process.env.HARK_NOMINIFY, rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
