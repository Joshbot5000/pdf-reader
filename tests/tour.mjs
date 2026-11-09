// Screenshot tour of the real app: `xvfb-run -a node tests/tour.mjs <out-dir> [light|dark]`
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tenancyAgreement } from './sample-docs.mjs';

const out = process.argv[2] ?? 'screenshots';
const theme = process.argv[3] ?? 'dark';
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'pdf-reader-tour-'));
const userData = join(dir, 'profile');
mkdirSync(userData);
writeFileSync(join(userData, 'state.json'), JSON.stringify({ settings: { theme }, recent: [] }));
const pdf = join(dir, 'Tenancy agreement.pdf');
writeFileSync(pdf, await tenancyAgreement());
writeFileSync(join(dir, 'Tenancy agreement (revised).pdf'), await tenancyAgreement({ revised: true }));

const app = await electron.launch({
  executablePath: electronPath,
  args: ['--no-sandbox', 'out/main/index.js'],
  env: { ...process.env, PDF_READER_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  colorScheme: theme === 'light' ? 'light' : 'dark', // Playwright otherwise forces light
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1440, height: 900 });
const shot = async (name) => {
  await win.waitForTimeout(450);
  await win.screenshot({ path: join(out, `${theme}-${name}.png`) });
  console.log('shot', name);
};

await win.waitForSelector('.home-inner');
await shot('01-home');
await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('file:openRequest', p), pdf);
await win.waitForSelector('.page .textLayer span');
await shot('02-edit');
await win.fill('#search', 'tenant');
await win.waitForSelector('.hit.current');
await shot('03-search');
await win.click('.rail-btn[data-mode="organize"]');
await win.waitForSelector('.tile canvas');
await win.click('.tile >> nth=1', { modifiers: ['Control'] });
await shot('04-organize');
await win.click('.rail-btn[data-mode="sign"]');
await win.click('.sig-add >> nth=0');
await win.click('.tab[data-tab="type"]');
await win.fill('.sig-name', 'Jordan Ellis');
await shot('05-signature-modal');
await win.keyboard.press('Escape');
await win.click('.rail-btn[data-mode="redact"]');
await win.click('button:has-text("Personal info")');
await win.click('.modal .btn-primary');
await win.waitForSelector('.redact-mark');
await shot('06-redact');
await win.click('.rail-btn[data-mode="prepare"]');
await shot('07-prepare');
await win.click('.rail-btn[data-mode="brand"]');
await win.fill('.side-body input[placeholder*="Solicitors"]', 'Landon & Co. Solicitors');
await win.fill('.side-body input[placeholder*="agreements"]', 'landon.co.uk/agreements');
await shot('08-brand');
await win.click('.rail-btn[data-mode="edit"]');
await win.click('.ai-cta');
await win.waitForSelector('#assistant .chat');
await shot('09-assistant');
await win.click('#assistant .tab:has-text("Spaces")');
await shot('10-spaces');
await win.click('#assistant .assistant-head .btn');
await win.keyboard.press('Control+k');
await win.fill('.palette-input', 'rot');
await shot('11-palette');
await win.keyboard.press('Escape');
await win.click('.rail-btn[data-mode="compare"]');
await shot('12-compare');
await app.close();
console.log(errors.length ? `Renderer errors:\n${errors.join('\n')}` : 'No renderer errors');
