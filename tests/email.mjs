// End to end: a recording is transcribed, summarised, and its notes emailed, against a stand-in mail server.
// Usage: HARK_MODELS_DIR=... node tests/email.mjs   (run under xvfb-run on Linux)
import { _electron as electron } from 'playwright-core';
import net from 'node:net';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// ---- a small stand-in mail server: accepts one app password, records every message
const PASS = 'abcdefghijklmnop';
const received = [];
const smtp = net.createServer((sock) => {
  let data = null, from = '', to = [], authed = false, stage = '';
  sock.write('220 stand-in ESMTP\r\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data !== null) {
        if (line === '.') { received.push({ from, to, raw: data.join('\n') }); data = null; sock.write('250 queued\r\n'); }
        else data.push(line.startsWith('..') ? line.slice(1) : line);
        continue;
      }
      if (stage === 'user') { stage = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
      if (stage === 'pass') { stage = ''; authed = Buffer.from(line, 'base64').toString() === PASS; sock.write(authed ? '235 ok\r\n' : '535 5.7.8 Username and Password not accepted\r\n'); continue; }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO')) sock.write('250-stand-in\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (up.startsWith('AUTH PLAIN')) { const p = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\0'); authed = p[2] === PASS; sock.write(authed ? '235 ok\r\n' : '535 5.7.8 Username and Password not accepted\r\n'); }
      else if (up.startsWith('AUTH LOGIN')) { stage = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (up.startsWith('MAIL FROM')) { if (!authed) sock.write('530 auth first\r\n'); else { from = line.slice(10); to = []; sock.write('250 ok\r\n'); } }
      else if (up.startsWith('RCPT TO')) { to.push(line.slice(8)); sock.write('250 ok\r\n'); }
      else if (up === 'DATA') { data = []; sock.write('354 go\r\n'); }
      else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const smtpPort = smtp.address().port;

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-email-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: 'whisper-base', llmModel: process.env.HARK_LLM ?? 'qwen-2b', onboarded: true, emailNotes: true, emailVia: 'gmail', emailFrom: 'hark-test@example.com', emailTo: 'notes@example.com' }));
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_PHONE_PORT: String(7600 + Math.floor(Math.random() * 99)), HARK_SMTP_HOST: '127.0.0.1', HARK_SMTP_PORT: String(smtpPort), HARK_SMTP_SECURE: '0', HARK_EMAIL_RETRY_MS: '4000' } });
const page = await app.firstWindow();
const results = []; const check = (name, ok, extra = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const call = (method, ...args) => page.evaluate(([m, a]) => window.hark.call(m, ...a).then((r) => ({ r }), (e) => ({ e: String(e.message) })), [method, args]);
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
// Quoted-printable bodies hold UTF-8 bytes: decode them as bytes, then as UTF-8.
const decode = (raw) => { const body = raw.split(/\n\n/).slice(1).join('\n\n').replace(/=\n/g, ''); const bytes = []; for (let i = 0; i < body.length; i++) { if (body[i] === '=' && /^[0-9A-F]{2}$/.test(body.slice(i + 1, i + 3))) { bytes.push(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...Buffer.from(body[i], 'utf8')); } return Buffer.from(bytes).toString('utf8'); };
try {
  await page.waitForSelector('.home', { timeout: 30000 });
  let r = await call('saveEmailPassword', 'wrong password here');
  check('a wrong app password is refused, with how to fix it', /Gmail refused the password.*app password/.test(r.e ?? ''), (r.e ?? '').slice(0, 140));
  r = await call('saveEmailPassword', 'abcd efgh ijkl mnop');
  check('the right app password is accepted and stored privately', r.r?.saved && (fs.statSync(path.join(data, 'mail-secret.json')).mode & 0o077) === 0 && !/abcdefgh/.test(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')));
  r = await call('testEmail');
  check('a test email arrives', !r.e && received.length === 1 && /notes@example\.com/.test(received[0].to[0]) && /Subject: Notes: Test from Hark/.test(received[0].raw), r.e);

  // ---- the real thing: transcribe the sample, write notes, email them
  const m = (await call('importSample')).r;
  log('transcribing and writing notes…');
  let cur;
  for (let i = 0; i < 400; i++) {
    cur = (await call('listMeetings')).r.find((x) => x.id === m.id);
    if (cur?.emailedAt || cur?.emailError || cur?.summaryState === 'error') break;
    await page.waitForTimeout(1500);
  }
  log('notes:', cur?.summary?.title, '| emailed:', !!cur?.emailedAt, cur?.emailError ?? '');
  const mail = received[received.length - 1];
  const text = mail ? decode(mail.raw) : '';
  check('the notes are emailed automatically once written', cur?.emailedAt && cur.emailedTo === 'notes@example.com' && received.length === 2);
  check('the email carries the title, key points as bullets, and actions', new RegExp(`Subject: Notes: ${cur?.title?.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(mail?.raw ?? '') && /KEY POINTS\n• .+\n• .+/.test(text) && cur.summary.keyPoints.every((k) => text.includes(k.replace(/\*\*/g, '').slice(0, 25))), text.split('\n').slice(0, 14).join(' | ').slice(0, 400));
  check('it has a formatted version too', /Content-Type: text\/html/i.test(mail?.raw ?? '') && /<li/.test(text));
  fs.writeFileSync(path.join(process.env.OUT ?? os.tmpdir(), 'hark-email.txt'), text);
  const html = text.slice(text.indexOf('<!doctype html>'), text.indexOf('</html>') + 7);
  if (html.length > 100) { const shot = await app.evaluate(async ({ BrowserWindow }, h) => { const w = new BrowserWindow({ show: false, width: 720, height: 900, webPreferences: { javascript: false } }); await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(h)); const img = await w.webContents.capturePage(); w.destroy(); return img.toPNG().toString('base64'); }, html); fs.writeFileSync(path.join(process.env.OUT ?? os.tmpdir(), 'hark-email.png'), Buffer.from(shot, 'base64')); }

  // ---- no internet: kept, and retried
  smtp.close(); await new Promise((res) => setTimeout(res, 300));
  r = await call('emailNotes', m.id);
  cur = (await call('listMeetings')).r.find((x) => x.id === m.id);
  check('if it cannot be sent, the reason is kept on the conversation', /Couldn't reach Gmail/.test(r.e ?? '') && /Couldn't reach Gmail/.test(cur.emailError ?? ''), r.e);
  await page.click(`.card >> text=${cur.title.slice(0, 18)}`).catch(() => {});
  await page.waitForSelector('.email-state', { timeout: 10000 }).catch(() => {});
  check('the conversation shows its email state and a send button', (await page.locator('.email-state').innerText().catch(() => '')).match(/Email/), await page.locator('.email-state').innerText().catch(() => ''));
} catch (e) { check('run completed', false, String(e.stack ?? e).slice(0, 400)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close().catch(() => {}); smtp.close(); process.exit(results.every(Boolean) ? 0 : 1);
