// Drives the real app end to end and saves screenshots. Usage: node tests/tour.mjs <outDir> [dark|light]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const out = path.resolve(process.argv[2] ?? 'scratch/shots'); const theme = process.argv[3] ?? 'dark';
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-tour-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: process.env.HARK_ASR ?? 'whisper-base', llmModel: process.env.HARK_LLM ?? 'qwen-2b', theme }));
const app = await electron.launch({
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve('scratch/mic48.wav')}%noloop`, '.'],
  env: { ...process.env, HARK_DATA_DIR: data },
});
const errors = [];
const page = await app.firstWindow();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.setViewportSize({ width: 1440, height: 900 });
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
let n = 0; const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, `${String(++n).padStart(2, '0')}-${name}.png`) }); log('shot', name); };
const step = process.env.HARK_STEPS ?? 'all';
try {
  await page.waitForSelector('.onboard-card');
  await shot('welcome');
  await page.fill('.name-in', 'Josh');
  await page.click('text=Set up');
  await page.waitForSelector('.dl-list, .choices'); await shot('setup');
  await page.click('text=See it work on a sample');
  await page.waitForSelector('.meeting');
  await page.waitForSelector('.feed .turn', { timeout: 60000 }); await shot('transcribing');
  await page.waitForSelector('.player', { timeout: 120000 }); log('transcript ready');
  await page.waitForSelector('.writing', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(6000); await shot('notes-streaming');
  await page.waitForSelector('.sum-foot', { timeout: 240000 }); await shot('conversation');
  log('title:', await page.inputValue('.m-title input'), '| hints:', await page.locator('.hint').count(), '| actions:', await page.locator('.summary .task').count(), '| chapters:', await page.locator('.chapters button').count());
  // playback + word highlight
  await page.click('.play'); await page.waitForTimeout(2500);
  log('playing: now-word =', await page.locator('.w.now').first().textContent().catch(() => null), '| time =', await page.locator('.player .time').first().textContent());
  await page.locator('.chapters button').nth(1).click().catch(() => {}); await page.waitForTimeout(900); await shot('playing');
  await page.click('.play');
  // name a speaker (accept hint if offered, else rename manually)
  if (await page.locator('.hint .btn').count()) { await page.locator('.hint .btn').first().click(); await page.waitForTimeout(500); }
  await page.locator('.who').first().click(); await page.fill('.rename input', 'Michael'); await shot('speaker-menu'); await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  log('speakers:', (await page.locator('.who').allTextContents()).slice(0, 4).join(', '));
  await page.locator('.turn').nth(1).hover(); await page.locator('.turn').nth(1).locator('.turn-tools button').first().click(); await page.waitForTimeout(300);
  // chat
  await page.click('.tabs >> text=Chat'); await page.fill('.chat .composer textarea', 'When is the launch, and who is recruiting the beta customers?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.chat .msg.assistant .md', { timeout: 120000 }); await page.waitForFunction(() => !document.querySelector('.chat .send.stop'), null, { timeout: 120000 }); await shot('chat');
  log('chat answer:', (await page.locator('.chat .msg.assistant').last().innerText()).replace(/\n/g, ' ').slice(0, 220));
  await page.click('.tabs >> text=Insights'); await shot('insights');
  await page.click('.tabs >> text=Notes');
  // home, palette, tasks
  await page.click('.back'); await page.waitForSelector('.home'); await shot('home');
  await page.keyboard.press('Control+K').catch(() => {}); await page.evaluate(() => window.dispatchEvent(new Event('x')));
  if (!(await page.locator('.palette').count())) await page.click('.nav >> text=Search');
  await page.fill('.palette input', 'press release'); await page.waitForSelector('.palette-list mark', { timeout: 5000 }); await shot('search');
  await page.keyboard.press('Enter'); await page.waitForSelector('.meeting'); await page.waitForTimeout(700);
  log('search jump: flashed para =', (await page.locator('.turn.flash, .turn.speaking').first().innerText().catch(() => '')).slice(0, 60).replace(/\n/g, ' '));
  await page.click('.nav >> text=Action items'); await page.waitForSelector('.tasks'); await page.locator('.tasks .check').first().click().catch(() => {}); await shot('tasks');
  // ask across library
  await page.click('.nav >> text=Ask Hark'); await page.waitForSelector('.ask'); await shot('ask-empty');
  await page.fill('.ask .composer textarea', 'What is slowing down the password reset email?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.ask .msg.assistant .md', { timeout: 120000 }); await page.waitForFunction(() => !document.querySelector('.ask .send.stop'), null, { timeout: 120000 }); await shot('ask');
  log('ask answer:', (await page.locator('.ask .msg.assistant').last().innerText()).replace(/\n/g, ' ').slice(0, 260));
  // settings
  await page.click('.engine'); await page.waitForSelector('.modal'); await shot('settings-models');
  await page.click('.modal aside >> text=Voices'); await shot('settings-voices'); await page.keyboard.press('Escape');
  if (step !== 'norec') {
    // live recording from the (fake) microphone
    await page.click('.rec-btn'); await page.waitForSelector('.recorder', { timeout: 20000 }); await page.waitForTimeout(1500); await shot('recording-start');
    await page.waitForSelector('.rec-feed .turn:not(.partial)', { timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.rec-feed .turn:not(.partial)').length >= 3, null, { timeout: 90000 }); await shot('recording-live');
    log('live: turns =', await page.locator('.rec-feed .turn:not(.partial)').count(), '| speakers:', [...new Set(await page.locator('.rec-feed .turn-head b').allTextContents())].join(', '), '| timer', await page.locator('.rec-time').textContent());
    await page.keyboard.press('Control+B');
    await page.click('text=Catch me up'); await page.waitForSelector('.catch .md li', { timeout: 120000 }); await page.waitForTimeout(3000); await shot('catch-me-up');
    await page.click('.round.stop'); await page.waitForSelector('.meeting', { timeout: 30000 }); await page.waitForSelector('.player', { timeout: 180000 });
    log('recording saved:', await page.inputValue('.m-title input'), '| turns', await page.locator('.feed .turn').count(), '| who:', [...new Set(await page.locator('.who').allTextContents())].join(', '));
    await page.waitForSelector('.sum-foot', { timeout: 240000 }); await shot('recorded-conversation');
    log('recorded title:', await page.inputValue('.m-title input'));
    const dur = await page.evaluate(() => new Promise((r) => { const a = document.querySelector('audio'); const done = () => r([a.duration, a.seekable.length ? a.seekable.end(0) : 0]); if (a.readyState >= 1) done(); else a.onloadedmetadata = done; }));
    log('recorded audio duration/seekable:', JSON.stringify(dur));
    await page.click('.back'); await page.waitForSelector('.home'); await shot('home-two');
  }
  log('console errors:', errors.length ? errors.slice(0, 8).join(' || ') : 'none');
} catch (e) {
  await page.screenshot({ path: path.join(out, 'FAILED.png') }).catch(() => {});
  console.log('TOUR FAILED:', String(e.message).split('\n')[0]); console.log('console errors:', errors.slice(0, 8).join(' || '));
  process.exitCode = 1;
} finally { await app.close(); }
