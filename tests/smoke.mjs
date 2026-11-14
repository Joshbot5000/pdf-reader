// Backend smoke test inside real Electron: sample import -> transcript -> summary -> chat -> ask.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-smoke-'));
const app = await electron.launch({ args: ['--no-sandbox', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_MODELS_DIR: process.env.HARK_MODELS_DIR } });
app.process().stderr.on('data', (d) => { const s = String(d); if (!/dbus|GLib|gpu|Gtk|libEGL|viz/i.test(s)) process.stderr.write('[electron] ' + s); });
const page = await app.firstWindow();
const call = (m, ...a) => page.evaluate(([m, a]) => window.hark.call(m, ...a), [m, a]);
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
try {
  await call('saveSettings', { asrModel: 'whisper-base', llmModel: 'qwen-2b', onboarded: true });
  const boot = await call('boot'); log('status', JSON.stringify(boot.status), boot.models.filter((m) => m.installed).map((m) => m.id).join(','));
  await page.evaluate(() => { window.__ev = []; window.hark.on('stream', (e) => window.__ev.push(e)); window.hark.on('live', (e) => window.__live = (window.__live || 0) + 1); });
  const m = await call('importSample'); log('import queued', m.id, m.status);
  let cur;
  for (;;) { cur = (await call('listMeetings')).find((x) => x.id === m.id); if (cur.status !== 'processing') break; await new Promise((r) => setTimeout(r, 1000)); }
  log('transcribed', cur.status, cur.error ?? '', 'speakers', cur.speakers.length, 'words', cur.words, 'audio', cur.hasAudio, 'peaks', cur.peaks.length);
  for (;;) { cur = (await call('listMeetings')).find((x) => x.id === m.id); if (cur.summary || cur.summaryState === 'error') break; await new Promise((r) => setTimeout(r, 1000)); }
  log('summary', cur.summaryState ?? 'ok', cur.summaryError ?? ''); console.log(JSON.stringify(cur.summary, null, 1).slice(0, 1800));
  log('title', cur.title, '| stream events', await page.evaluate(() => window.__ev.length), 'live events', await page.evaluate(() => window.__live));
  const reply = await call('chat', m.id, 'When is the launch and who recruits the beta customers?', 'chat:' + m.id); log('chat:', reply.text);
  const ans = await call('ask', 'What was decided about the password reset email?', 'ask'); log('ask:', ans.text, JSON.stringify(ans.sources?.slice(0, 3)));
  log('search', JSON.stringify((await call('search', 'press release')).slice(0, 1)));
  const media = await page.evaluate(async (id) => { const r = await fetch(`hark-media://audio/${id}`, { headers: { Range: 'bytes=100-299' } }); return [r.status, r.headers.get('content-range'), (await r.arrayBuffer()).byteLength]; }, m.id);
  log('media range', JSON.stringify(media), 'status', JSON.stringify((await call('boot')).status));
} finally { await app.close(); }
