// Extra end-to-end checks: (A) in-app model download with pause/resume, (B) a conversation too long for one context window.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const which = process.argv[2] ?? 'both';
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = async (data, models) => {
  const app = await electron.launch({ args: ['--no-sandbox', '--ignore-certificate-errors', '.'], env: { ...process.env, HARK_DATA_DIR: data, HARK_MODELS_DIR: models } });
  const page = await app.firstWindow();
  return { app, page, call: (m, ...a) => page.evaluate(([m, a]) => window.hark.call(m, ...a), [m, a]) };
};
let failed = false; const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failed = true; };

if (which !== 'long') {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-models-'));
  const { app, page, call } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'hark-dl-')), models);
  try {
    await page.evaluate(() => { window.__dl = []; window.hark.on('download', (d) => window.__dl.push(d)); });
    check((await call('listModels')).every((m) => !m.installed), 'fresh machine: nothing installed');
    await call('downloadModel', 'speaker');
    for (let i = 0; i < 120 && !(await call('listModels')).find((m) => m.id === 'speaker').installed; i++) await sleep(500);
    const f = path.join(models, 'hf/onnx-community/wespeaker-voxceleb-resnet34-LM/onnx/model.onnx');
    check(fs.existsSync(f) && fs.statSync(f).size > 26e6, `speaker model downloaded (${fs.existsSync(f) ? fs.statSync(f).size : 0} bytes)`);
    // pause mid-way, then resume
    await call('downloadModel', 'whisper-base');
    const part = path.join(models, 'hf/onnx-community/whisper-base_timestamped/onnx/decoder_model_merged_quantized.onnx.part');
    for (let i = 0; i < 200 && !(fs.existsSync(part) && fs.statSync(part).size > 3e6); i++) await sleep(100);
    await call('cancelDownload', 'whisper-base'); await sleep(800);
    const paused = fs.existsSync(part) ? fs.statSync(part).size : -1;
    check(paused > 0 && !(await call('listModels')).find((m) => m.id === 'whisper-base').installed, `paused with ${paused} bytes kept`);
    await call('downloadModel', 'whisper-base');
    for (let i = 0; i < 240 && !(await call('listModels')).find((m) => m.id === 'whisper-base').installed; i++) await sleep(500);
    const dec = part.replace('.part', '');
    check(fs.existsSync(dec) && fs.statSync(dec).size === 53712708, `resumed to completion (${fs.existsSync(dec) ? fs.statSync(dec).size : 0} bytes)`);
    const evs = await page.evaluate(() => window.__dl.length); check(evs > 5, `progress events streamed (${evs})`);
    // the freshly downloaded models actually work
    await call('saveSettings', { asrModel: 'whisper-base' });
    const m = await call('importSample');
    let cur; for (let i = 0; i < 180; i++) { cur = (await call('listMeetings')).find((x) => x.id === m.id); if (cur.status !== 'processing') break; await sleep(1000); }
    check(cur.status === 'ready' && cur.speakers.length === 3 && cur.words > 200, `sample transcribed with downloaded models: ${cur.status} ${cur.error ?? ''} speakers=${cur.speakers.length} words=${cur.words}`);
  } finally { await app.close(); }
}

if (which !== 'dl') {
  // Build a ~75 minute "conversation" straight on disk: 12 agenda items, each with its own facts.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-long-'));
  const id = 'longmeeting1'; const dir = path.join(data, 'conversations', id); fs.mkdirSync(dir, { recursive: true });
  const projects = ['Falcon', 'Harbour', 'Juniper', 'Lighthouse', 'Meridian', 'Nimbus', 'Orchard', 'Pelican', 'Quartz', 'Riverbend', 'Saffron', 'Tundra'];
  const owners = ['Amara', 'Ben', 'Chidi', 'Daniela', 'Ewan', 'Farah'];
  const paras = []; let t = 0; let n = 0;
  const say = (sp, text) => { const dur = text.split(' ').length / 2.6; const words = text.split(' ').map((w, i, a) => ({ t: w, s: t + (i / a.length) * dur, e: t + ((i + 1) / a.length) * dur })); paras.push({ id: 'p' + n++, sp, s: t, e: t + dur, text, words }); t += dur + 0.8; };
  projects.forEach((p, i) => {
    const owner = owners[i % owners.length], budget = 12000 + i * 3500, week = 3 + i;
    say('S1', `Right, next on the agenda is Project ${p}. ${owner}, can you take us through where things stand and what you need from the rest of us this month?`);
    for (let k = 0; k < 9; k++) {
      say('S2', `Sure. On ${p}, workstream ${k + 1} is ${k % 3 === 0 ? 'ahead of plan' : k % 3 === 1 ? 'on track' : 'slightly behind'}. We ran ${20 + i + k} customer interviews, and the strongest theme was that people want the ${['reporting', 'billing', 'search', 'mobile', 'sharing'][k % 5]} flow to be simpler. The team spent most of the sprint on the ${['database migration', 'design review', 'pricing page', 'accessibility audit', 'load testing'][(k + i) % 5]}, which took longer than anyone expected because of dependencies on the platform group.`);
      say('S3', `Thanks. From the finance side, I want to understand whether that changes the forecast for ${p}. Last quarter we assumed a steady run rate, and if the ${['migration', 'audit', 'review'][k % 3]} slips again we will need to revisit the hiring plan and tell the steering group before the end of the month.`);
      say('S1', `Understood. Let's not solve that here. Keep going, and flag anything that needs a decision from this group today rather than later in the week.`);
    }
    say('S2', `The key numbers for ${p}: the budget is ${budget.toLocaleString('en-GB')} pounds, and we are targeting delivery in week ${week} of the quarter.`);
    say('S1', `Okay, decision: we approve the ${budget.toLocaleString('en-GB')} pound budget for ${p}. ${owner}, please send the updated ${p} plan to the steering group by Friday of week ${week - 1}.`);
    say('S2', `Will do. I'll send the ${p} plan by then.`);
  });
  const speakers = [{ id: 'S1', name: 'Priya', color: 0, named: true }, { id: 'S2', name: 'Speaker 2', color: 1 }, { id: 'S3', name: 'Speaker 3', color: 2 }];
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(paras));
  fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({ id, title: 'Quarterly portfolio review', titleAuto: true, createdAt: Date.now(), duration: t, source: 'import', status: 'ready', speakers, chat: [], notes: '', peaks: [], words: paras.reduce((x, p) => x + p.words.length, 0), preview: '', template: 'meeting', bookmarks: [], hasAudio: false }));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ asrModel: 'whisper-base', llmModel: process.env.HARK_LLM ?? 'qwen-2b', onboarded: true }));
  const { app, page, call } = await launch(data, process.env.HARK_MODELS_DIR);
  try {
    const words = paras.reduce((x, p) => x + p.words.length, 0);
    log(`long conversation: ${(t / 60).toFixed(0)} min, ${words} words, ${paras.length} turns`);
    await page.evaluate(() => { window.__stages = []; window.hark.on('stream', (e) => e.stage && window.__stages.push(e.stage)); });
    await call('summarize', id, 'sum:' + id);
    const m = (await call('listMeetings')).find((x) => x.id === id); const s = m.summary;
    const stages = await page.evaluate(() => window.__stages); log('stages:', stages.join(' | '));
    check(stages.some((x) => /part \d+ of \d+/.test(x)), 'read in several parts');
    const all = JSON.stringify(s);
    const covered = projects.filter((p) => all.includes(p));
    log('title:', s.title, '| overview:', s.overview.slice(0, 200)); log(`key points ${s.keyPoints.length}, actions ${s.actions.length}, decisions ${s.decisions.length}, chapters ${s.chapters.length} [${s.chapters.map((c) => Math.round(c.t / 60) + 'm').join(',')}]`);
    log('sample action:', JSON.stringify(s.actions[0] ?? null));
    check(covered.length >= 8, `notes cover the whole conversation: ${covered.length}/12 projects named (${projects.filter((p) => !covered.includes(p)).join(', ') || 'none missing'})`);
    check(covered.includes('Falcon') && covered.includes('Tundra'), 'both the first and the last agenda item are present');
    check(s.actions.length >= 4 && s.chapters.length >= 3, 'actions and chapters extracted');
    check(s.chapters.some((c) => c.t > t * 0.5), 'chapters reach the second half');
    const r = await call('chat', id, 'What budget was approved for Project Meridian, and who owns it?', 'chat:' + id);
    log('chat:', r.text.replace(/\n/g, ' ').slice(0, 260));
    check(/26,?000/.test(r.text), 'chat finds a fact from the middle of a long conversation (26,000)');
    check(/Ewan/.test(r.text), 'and its owner (Ewan)');
  } finally { await app.close(); }
}
console.log(failed ? 'EXTRA: FAILURES' : 'EXTRA: ALL PASSED'); process.exit(failed ? 1 : 0);
