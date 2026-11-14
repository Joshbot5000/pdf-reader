// Drives the phone app against the real desktop app: pair, record on the "phone", send it to the Mac,
// then read notes, play back, chat and ask. Usage: node tests/phone.mjs <outDir>
import { _electron as electron, chromium } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const out = path.resolve(process.argv[2] ?? 'scratch/phone-shots'); fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-phone-'));
const mic = path.join(data, 'mic.wav');
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', 'resources/sample-meeting.ogg', '-ar', '48000', '-ac', '1', mic]);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: process.env.HARK_ASR ?? 'whisper-base', llmModel: process.env.HARK_LLM ?? 'qwen-2b', onboarded: true, userName: 'Josh' }));
const PORT = 7790 + Math.floor(Math.random() * 100);
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const results = []; const check = (name, ok, extra = '') => { results.push(ok); log(ok ? 'PASS' : 'FAIL', name, extra); };

const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_PHONE_PORT: String(PORT) } });
const desk = await app.firstWindow();
await desk.waitForSelector('.home', { timeout: 30000 });
const token = JSON.parse(fs.readFileSync(path.join(data, 'phone.json'), 'utf8')).token;
const base = `http://localhost:${PORT}`;

// --- the door is locked without the key
const s = async (p, init) => (await fetch(base + p, init)).status;
check('audio needs the key', (await s('/audio/abc')) === 401);
check('upload needs the key', (await s('/upload?rid=x', { method: 'POST', body: 'x' })) === 401);
check('wrong key refused', (await s('/upload?rid=x&k=nope', { method: 'POST', body: 'x' })) === 401);
check('health is open', (await s('/health')) === 200);
const man = await (await fetch(`${base}/manifest.webmanifest?k=${token}`)).json();
check('installed app keeps the key', man.start_url === `./?k=${token}`);

// --- desktop pairing panel
await desk.setViewportSize({ width: 1440, height: 900 });
await desk.evaluate(() => window.dispatchEvent(new Event('x')));
const info = await desk.evaluate(() => window.hark.call('phoneInfo'));
check('pairing info', info.running && info.port === PORT && info.qr.startsWith('data:image/png'), `lan=${info.lan[0]}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--headless=new', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errors = [];
// Refused connections are expected while the test deliberately takes the Mac out of reach.
page.on('console', (m) => m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Priya' : undefined));
let n = 0; const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`) }); };
try {
  await page.goto(base + '/'); await page.waitForSelector('.gate'); await shot('unpaired');
  await page.goto(`${base}/?k=${token}`);
  await page.waitForSelector('.pill.ok', { timeout: 10000 }); await page.waitForSelector('.empty h3'); await shot('home-empty');
  check('paired and connected', true);

  // --- record on the phone
  await page.click('.fab'); await page.waitForSelector('.rec-dot'); await page.waitForTimeout(9000);
  await page.click('[aria-label="Flag this moment"]'); await page.waitForTimeout(2500); await shot('recording');
  await page.click('[aria-label="Pause"]'); await page.waitForTimeout(1200);
  const paused = await page.textContent('.rec-time'); await page.waitForTimeout(1500);
  check('pause holds the clock', paused === await page.textContent('.rec-time'), paused);
  await page.click('[aria-label="Resume"]'); await page.waitForTimeout(24000);
  await page.click('.tpls >> text=Meeting');
  await page.click('[aria-label="Stop and save"]');
  await page.waitForSelector('.meeting', { timeout: 20000 }); await shot('transcribing');
  check('recording reached the Mac and opened', true, await page.textContent('.m-title'));
  await page.click('.seg >> text=Transcript');
  await page.waitForSelector('.feed .turn', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.progress'), null, { timeout: 180000 });
  const turns = await page.locator('.feed .turn').count();
  check('transcript arrived', turns > 0, `${turns} turns, ${await page.locator('.turn.hl').count()} flagged; first: ${(await page.locator('.turn > p').first().textContent()).slice(0, 80)}`);
  await shot('transcript');
  await page.click('.seg >> text=Notes');
  await page.waitForSelector('.summary .overview', { timeout: 300000 }); await shot('notes');
  check('notes written', true, `${await page.locator('.summary .task').count()} actions, ${await page.locator('.chapters button').count()} chapters; title: ${await page.textContent('.m-title')}`);

  // --- playback from the Mac
  await page.click('.seg >> text=Transcript');
  await page.locator('.turn > p').nth(1).click(); await page.waitForTimeout(3500);
  const playing = await page.evaluate(() => { const a = document.querySelector('audio'); return { t: a.currentTime, paused: a.paused, d: a.duration }; });
  check('audio plays on the phone', !playing.paused && playing.t > 1, JSON.stringify(playing));
  await shot('playing'); await page.click('.play');
  // name a speaker
  await page.locator('.who').first().click(); await page.waitForTimeout(800);
  check('speaker renamed', (await page.locator('.who').first().textContent()) === 'Priya');

  // --- chat about it
  await page.click('.seg >> text=Chat'); await page.fill('.composer input', 'What was this conversation about, in one sentence?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant .md', { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 180000 }); await shot('chat');
  check('chat answered', true, (await page.locator('.msg.assistant').last().innerText()).replace(/\n/g, ' ').slice(0, 160));

  // --- back home, tasks, ask
  await page.click('[aria-label="Back"]'); await page.waitForSelector('.card:not(.out)'); await shot('home');
  await page.click('.tabbar >> text="Tasks"'); await shot('tasks');
  if (await page.locator('.task').count()) { await page.locator('.task').first().click(); await page.waitForTimeout(700); check('task ticked on the Mac', (await desk.evaluate(() => window.hark.call('listMeetings'))).some((m) => m.summary?.actions.some((a) => a.done))); }
  await page.click('.tabbar >> text="Ask"'); await page.fill('.composer input', 'What did people agree to do?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant .md', { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 180000 }); await shot('ask');
  check('ask answered', true, (await page.locator('.msg.assistant').last().innerText()).replace(/\n/g, ' ').slice(0, 160));

  // --- Mac out of reach: the phone keeps the recording and sends it when the Mac is back
  await page.click('.tabbar >> text="Library"');
  await desk.evaluate(() => window.hark.call('saveSettings', { phone: false }));
  await page.waitForSelector('.pill.off', { timeout: 10000 });
  await page.click('.fab'); await page.waitForSelector('.rec-dot'); await page.waitForTimeout(8000);
  await page.click('[aria-label="Stop and save"]');
  await page.waitForSelector('.card.out'); await shot('offline-outbox');
  check('offline recording kept on the phone', (await page.textContent('.card.out')).includes('Waiting for your Mac'));
  await page.reload(); await page.waitForSelector('.card.out');
  check('still there after the app restarts', true);
  await desk.evaluate(() => window.hark.call('saveSettings', { phone: true }));
  await page.waitForSelector('.meeting', { timeout: 30000 });
  check('sent automatically when the Mac is back', (await page.locator('.card.out').count()) === 0);
  await page.waitForFunction(() => !document.querySelector('.progress'), null, { timeout: 120000 });

  // --- desktop sees it all
  const ms = await desk.evaluate(() => window.hark.call('listMeetings'));
  check('library has both phone recordings', ms.filter((m) => m.source === 'phone').length === 2, ms.map((m) => `${m.title} [${m.status}, ${Math.round(m.duration)}s, audio=${m.hasAudio}]`).join(' | '));
  await desk.evaluate(() => window.dispatchEvent(new Event('x')));
  await desk.keyboard.press('Control+,').catch(() => {});
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
} catch (err) {
  await shot('failure').catch(() => {});
  check('run completed', false, String(err).slice(0, 400) + ' :: ' + errors.slice(0, 3).join(' || '));
} finally {
  await browser.close(); await app.close().catch(() => {});
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
