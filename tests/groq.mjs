// The phone working without the Mac: it records, transcribes and writes notes through Groq (a stand-in here),
// then hands everything to the Mac when it is back, which keeps the notes as they are and emails them.
// Usage: HARK_MODELS_DIR=... node tests/groq.mjs   (under xvfb-run on Linux)
import { _electron as electron, chromium } from 'playwright-core';
import http from 'node:http'; import net from 'node:net';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const KEY = 'gsk_test_key';
const groqCalls = [];
const SUMMARY = `TITLE: Launch moved to the seventeenth\nOVERVIEW: The team agreed to move the app launch to 17 March so payments can be tested properly.\nKEY POINTS:\n- Onboarding completion rose from 58% to 71%\n- Billing tickets fell by 12%\nACTION ITEMS:\n- Sarah: Write the beta plan (due: Wednesday)\nDECISIONS:\n- Launch on 17 March\nOPEN QUESTIONS:\n- Do we need a press release?\nCHAPTERS:\n- [0:00] Launch date: Moving the launch.\nTOPICS: launch, onboarding, billing`;
const groq = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST' };
  if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
  let body = [];
  req.on('data', (d) => body.push(d));
  req.on('end', () => {
    body = Buffer.concat(body);
    const url = new URL(req.url, 'http://x');
    groqCalls.push({ path: url.pathname, auth: req.headers.authorization, size: body.length, text: body.toString('latin1') });
    if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
    const send = (o) => res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    if (url.pathname === '/models') return send({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'whisper-large-v3-turbo' }, { id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }] });
    if (url.pathname === '/audio/transcriptions') return send({ text: 'x', duration: 8.2, segments: [{ start: 0, end: 3.1, text: ' Okay, the launch moves to the seventeenth of March.' }, { start: 3.2, end: 5.0, text: ' Payments need two weeks of testing.' }, { start: 7.0, end: 8.2, text: ' Sarah will write the beta plan by Wednesday.' }] });
    if (url.pathname === '/chat/completions') {
      const j = JSON.parse(body.toString('utf8'));
      const q = j.messages[1].content;
      return send({ choices: [{ message: { content: /Question:/.test(q) ? 'Sarah is writing the beta plan [0:07].' : SUMMARY } }] });
    }
    res.writeHead(404, cors).end('{}');
  });
});
await new Promise((r) => groq.listen(0, '127.0.0.1', r));
const GROQ = `http://127.0.0.1:${groq.address().port}`;

// A stand-in mail server, to see the Mac email the phone's notes.
const received = [];
const smtp = net.createServer((sock) => {
  let data = null; sock.write('220 ok\r\n'); let buf = '';
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (data !== null) { if (line === '.') { received.push(data.join('\n')); data = null; sock.write('250 ok\r\n'); } else data.push(line); continue; }
    const up = line.toUpperCase();
    if (up.startsWith('EHLO')) sock.write('250-x\r\n250 AUTH PLAIN\r\n'); else if (up.startsWith('AUTH')) sock.write('235 ok\r\n'); else if (up === 'DATA') { data = []; sock.write('354 go\r\n'); } else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n'); } });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-groq-'));
const mic = path.join(data, 'mic.wav');
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', 'resources/sample-meeting.ogg', '-t', '20', '-ar', '48000', '-ac', '1', mic]);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: 'whisper-base', llmModel: 'qwen-2b', onboarded: true, emailNotes: true, emailVia: 'gmail', emailFrom: 'hark-test@example.com', emailTo: 'notes@example.com' }));
fs.writeFileSync(path.join(data, 'mail-secret.json'), JSON.stringify({ pass: 'abcdefghijklmnop' }));
const PORT = 7790 + Math.floor(Math.random() * 100);
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_PHONE_PORT: String(PORT), HARK_GROQ_URL: GROQ, HARK_SMTP_HOST: '127.0.0.1', HARK_SMTP_PORT: String(smtp.address().port), HARK_SMTP_SECURE: '0' } });
const desk = await app.firstWindow();
const results = []; const check = (name, ok, extra = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const mac = (method, ...args) => desk.evaluate(([m, a]) => window.hark.call(m, ...a).then((r) => ({ r }), (e) => ({ e: String(e.message) })), [method, args]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`] });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
await ctx.addInitScript((g) => localStorage.setItem('hark.groqBase', g), GROQ);
const page = await ctx.newPage(); const errs = [];
page.on('console', (m) => m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errs.push(m.text())); page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
const out = process.env.OUT ?? os.tmpdir(); let n = 0;
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `g${String(++n).padStart(2, '0')}-${name}.png`) }); };
try {
  await desk.waitForSelector('.home', { timeout: 30000 });
  let r = await mac('saveGroqKey', 'gsk_wrong');
  check('the Mac checks the Groq key with Groq and refuses a wrong one', /rejected/.test(r.e ?? ''), r.e);
  r = await mac('saveGroqKey', KEY);
  check('the Mac keeps a working key, privately', !r.e && (fs.statSync(path.join(data, 'groq.json')).mode & 0o077) === 0, r.e);
  const token = JSON.parse(fs.readFileSync(path.join(data, 'phone.json'), 'utf8')).token;
  await page.goto(`http://localhost:${PORT}/?k=${token}`);
  await page.waitForSelector('.pill.ok', { timeout: 15000 });
  await page.waitForFunction((k) => localStorage.getItem('hark.groqKey') === k, KEY, { timeout: 10000 });
  check('the paired phone receives the key from the Mac', true);

  // ---- the Mac goes out of reach
  await mac('saveSettings', { phone: false });
  await page.waitForSelector('.pill.off', { timeout: 15000 });
  await page.click('.fab'); await page.waitForSelector('.rec-dot'); await page.waitForTimeout(8000);
  await page.click('[aria-label="Flag this moment"]'); await page.waitForTimeout(1500);
  await page.click('[aria-label="Stop and save"]');
  await page.waitForSelector('.card .on-phone', { timeout: 30000 });
  await page.waitForFunction(() => /Launch moved to the seventeenth/.test(document.body.innerText), null, { timeout: 30000 });
  await shot('home-offline');
  check('with the Mac off, the phone transcribes and writes the notes itself', groqCalls.some((c) => c.path === '/audio/transcriptions' && /whisper-large-v3-turbo/.test(c.text) && c.size > 5000) && groqCalls.some((c) => c.path === '/chat/completions' && /llama-3\.3-70b-versatile/.test(c.text)), groqCalls.map((c) => c.path).join(' '));
  await page.click('.card >> text=Launch moved to the seventeenth');
  await page.waitForSelector('.summary .overview');
  check('the notes open on the phone, in the same layout as the Mac\'s', /17 March/.test(await page.textContent('.summary .overview')) && (await page.locator('.summary .task').count()) === 1 && /Written on this phone/.test(await page.textContent('.m-body')));
  await shot('notes-offline');
  await page.click('.seg >> text=Transcript');
  check('the transcript is there, with the flagged moment highlighted', (await page.locator('.feed .turn').count()) >= 2 && (await page.locator('.turn.hl').count()) >= 1, `${await page.locator('.feed .turn').count()} paragraphs`);
  await page.locator('.turn > p').first().click(); await page.waitForTimeout(1200);
  const playing = await page.evaluate(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 0; });
  check('the recording plays from the phone itself', playing);
  await page.click('.play').catch(() => {});
  await page.click('.seg >> text=Chat'); await page.fill('.composer input', 'Who is writing the beta plan?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant .md', { timeout: 15000 });
  check('you can ask questions about it on the phone', /Sarah/.test(await page.locator('.msg.assistant').last().innerText()));
  await shot('chat-offline');

  // ---- the Mac comes back
  await mac('saveSettings', { phone: true });
  await page.waitForSelector('.pill.ok', { timeout: 20000 }).catch(() => {});
  let m;
  for (let i = 0; i < 80 && !m?.emailedAt; i++) { await page.waitForTimeout(500); m = (await mac('listMeetings')).r.find((x) => x.source === 'phone'); }
  check('when the Mac is back, the phone hands everything over', !!m && m.status === 'ready' && m.hasAudio, m && `${m.title} [${m.status}, audio ${m.hasAudio}]`);
  const paras = m ? (await mac('getTranscript', m.id)).r : [];
  check('the Mac keeps the phone\'s notes and transcript as they are (no second transcription)', m?.title === 'Launch moved to the seventeenth' && m.summary?.decisions[0] === 'Launch on 17 March' && paras.length >= 2 && /seventeenth of March/.test(paras[0].text) && m.chat.length === 2 && m.peaks.length > 10);
  check('and emails the notes', !!m?.emailedAt && received.some((x) => /Subject: Notes: Launch moved to the seventeenth/.test(x)), `${received.length} email(s)`);
  await page.waitForFunction(() => !document.querySelector('.on-phone'), null, { timeout: 10000 }).catch(() => {});
  check('the phone now shows it from the Mac (no duplicate left behind)', (await page.locator('.on-phone').count()) === 0 && await page.evaluate(() => !!document.querySelector('.meeting .m-title')) && /Launch moved/.test(await page.textContent('.m-title')));
  await page.click('[aria-label="Back"]').catch(() => {});
  await shot('home-synced');
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' || '));
} catch (e) { await shot('failure').catch(() => {}); check('run completed', false, String(e.stack ?? e).slice(0, 500) + ' :: ' + errs.slice(0, 2).join(' || ')); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close(); await app.close().catch(() => {}); groq.close(); smtp.close(); process.exit(results.every(Boolean) ? 0 : 1);
