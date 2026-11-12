// Wraps app.html (the page body) into a standalone index.html you can open directly
// or add to a phone home screen. Run: node weatherglass/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const body = readFileSync(new URL('app.html', dir), 'utf8');
const head = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#05070d">
<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);box-sizing:border-box}
*,*::before,*::after{box-sizing:border-box}body{margin:0}[hidden]{display:none!important}</style>
</head><body>
`;
writeFileSync(new URL('index.html', dir), head + body + '</body></html>\n');
console.log('wrote weatherglass/index.html');
