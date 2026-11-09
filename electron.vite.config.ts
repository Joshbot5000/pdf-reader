import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** Copy pdf.js runtime data (fonts, CMaps, ICC profiles, wasm decoders) into the renderer's public dir. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    buildStart() {
      const src = resolve(__dirname, 'node_modules/pdfjs-dist');
      const dest = resolve(__dirname, 'src/renderer/public/pdfjs');
      for (const dir of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
        if (existsSync(resolve(src, dir))) cpSync(resolve(src, dir), resolve(dest, dir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [pdfjsAssets()],
    build: {
      target: 'chrome140',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
