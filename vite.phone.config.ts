import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone app: a small web app that Hark serves to a paired phone.
export default defineConfig({
  root: resolve(__dirname, 'src/phone'),
  base: './',
  plugins: [react()],
  build: { outDir: resolve(__dirname, 'out/phone'), emptyOutDir: true, target: ['es2020', 'safari15'], minify: !process.env.HARK_NOMINIFY },
});
