// A recording interrupted by a crash: its audio is rescued and transcribed in full when Hark next opens.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-recover-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: 'whisper-base', llmModel: 'qwen-2b', onboarded: true, autoSummary: false, notify: true }));
// What a crash leaves behind: a meeting still marked "recording", a short transcript, and the raw audio.
const id = 'crashtest01';
const dir = path.join(data, 'conversations', id); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({ id, title: 'Recording…', titleAuto: true, createdAt: Date.now() - 6e5, duration: 12, source: 'mic', status: 'recording', speakers: [], chat: [], notes: '', peaks: [], words: 5, preview: 'Okay, let us get started.', template: 'lecture', bookmarks: [], hasAudio: false }));
fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify([{ id: 'p0', sp: 'S1', s: 0, e: 3, text: 'Okay, let us get started.', words: [] }]));
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', 'resources/sample-meeting.ogg', '-c:a', 'libopus', '-b:a', '48k', '-f', 'webm', path.join(dir, 'audio.rec.webm')]);
const results = []; const check = (n, ok, x = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', n, x ? `— ${x}` : ''); };
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_PHONE_PORT: String(7500 + Math.floor(Math.random() * 99)) } });
const page = await app.firstWindow();
try {
  await page.waitForSelector('.home', { timeout: 30000 });
  let m;
  for (let i = 0; i < 200; i++) { m = (await page.evaluate(() => window.hark.call('listMeetings'))).find((x) => x.id === id); if (m.recovered && (m.status === 'ready' || m.status === 'error')) break; await page.waitForTimeout(1500); }
  const paras = await page.evaluate((i) => window.hark.call('getTranscript', i), id);
  check('an interrupted recording is rescued and transcribed in full', m.status === 'ready' && m.recovered && m.hasAudio && m.duration > 100 && paras.length > 3, `${m.status}, ${Math.round(m.duration)} s, ${paras.length} paragraphs, audio ${m.hasAudio}`);
  check('the raw file is tidied away once safe', !fs.existsSync(path.join(dir, 'audio.rec.webm')) && fs.existsSync(path.join(dir, 'audio.webm')));
  check('the menu bar shortcut is registered', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+R')));
} catch (e) { check('run completed', false, String(e).slice(0, 300)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close().catch(() => {}); process.exit(results.every(Boolean) ? 0 : 1);
