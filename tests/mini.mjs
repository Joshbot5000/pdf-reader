// The floating live-transcript window: opens on top, shows the transcript as it is written, bookmarks and stops.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-mini-'));
const mic = path.join(data, 'mic.wav');
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', 'resources/sample-meeting.ogg', '-t', '40', '-ar', '48000', '-ac', '1', mic]);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: 'whisper-base', llmModel: 'qwen-2b', onboarded: true, aiEngine: 'local', notify: false }));
const app = await electron.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}%noloop`, '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_PHONE_PORT: '7534' } });
const page = await app.firstWindow(); await page.waitForSelector('.home', { timeout: 30000 });
const results = []; const check = (n, ok, x = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', n, x ? `— ${x}` : ''); };
try {
  await page.click('.rec-btn'); await page.waitForSelector('.rec-controls', { timeout: 30000 });
  await page.click('text=Floating transcript');
  let mini;
  for (let i = 0; i < 30 && !mini; i++) { mini = app.windows().find((w) => w.url().endsWith('#mini')); await page.waitForTimeout(500); }
  const merrs = []; mini.on('pageerror', (e) => merrs.push(e.message)); mini.on('console', (m) => merrs.push(m.type() + ': ' + m.text()));
  await mini.waitForSelector('.mini', { timeout: 15000 });
  check('the floating window opens, on top of other apps', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isAlwaysOnTop() && w.webContents.getURL().endsWith('#mini'))));

  await mini.waitForFunction(() => document.querySelectorAll('.mini-feed p:not(.dim)').length >= 1, null, { timeout: 60000 });
  check('it shows the transcript as it is written, with the timer', /\d+:\d\d/.test(await mini.textContent('.mini-head b')), (await mini.textContent('.mini-feed')).slice(0, 120));
  await mini.click('[title="Bookmark this moment"]'); await page.waitForTimeout(500);
  const marks = (await page.evaluate(() => window.hark.call('listMeetings')))[0].bookmarks.length;
  check('bookmark from the floating window', marks === 1);
  await mini.screenshot({ path: path.join(os.tmpdir(), 'hark-mini.png') });
  await mini.click('[title="Stop recording"]');
  await page.waitForFunction(async () => (await window.hark.call('listMeetings'))[0].status !== 'recording', null, { timeout: 20000 });
  check('stop from the floating window', true);
} catch (e) { check('run completed', false, String(e).slice(0, 300)); }
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close(); process.exit(0);
