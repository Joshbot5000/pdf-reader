// Builds app.html (the page body, also what the Claude artifact publishes) and
// index.html (standalone, installable web app). Run: node weatherglass/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const rd = f => readFileSync(new URL(f, dir), 'utf8');
const js = ['world.js', 'audio.js', 'main.js'].map(f => rd('src/' + f)).join('\n');
const app = rd('src/head.html') + rd('src/body.html') +
  '<script>\n(() => {\n\'use strict\';\nconst FRAG = `' + rd('src/scene.glsl') + '`;\n' + js + '\n})();\n</script>\n';
writeFileSync(new URL('app.html', dir), app);
const head = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Weatherglass">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#05070d">
<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="icon-180.png"><link rel="icon" href="icon-192.png">
<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);box-sizing:border-box}
*,*::before,*::after{box-sizing:border-box}body{margin:0}[hidden]{display:none!important}</style>
</head><body>
`;
const tail = `<script>if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){navigator.serviceWorker.register('sw.js').catch(()=>{});}</script>\n</body></html>\n`;
writeFileSync(new URL('index.html', dir), head + app + tail);
console.log('wrote app.html (' + (app.length / 1024 | 0) + ' KB) and index.html');
