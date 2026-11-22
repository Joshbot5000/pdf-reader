import { app, BrowserWindow, Menu, Notification, Tray, screen, clipboard, globalShortcut, nativeImage, desktopCapturer, dialog, ipcMain, nativeTheme, net, protocol, session, shell, systemPreferences, utilityProcess } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { Engine } from './engines';
import { Library } from './store';
import { Models, entry, recommendedLlm } from './models';
import { TranscriptionSession, type SpeechApi } from './pipeline';
import { Intelligence } from './intelligence';
import { normalize } from '../shared/speakers';
import { retime, toHtml, toMarkdown, toSrt, toText } from '../shared/text';
import QRCode from 'qrcode';
import { lanAddresses, servePhone, type PhoneNotes, type PhoneServer, type UploadMeta } from './phone';
import { PeakMeter } from '../shared/vad';
import { CloudError, abortCloud, cloudGenerate, cloudModels } from './cloud';
import { Study } from './study';
import { markdownToDocx } from './docx';
import { ankiExport, pickSession, record, topicStatus, type Practice } from '../shared/law';
import type { RevisionItem } from '../shared/api';
import { roughTokens } from '../shared/text';
import { checkGmail, notesEmail, sendGmail, sendWithMailApp, validEmail } from './mailer';
import { uid } from '../shared/types';
import type { Api, Events } from '../shared/api';
import type { EngineStatus, Meeting, Para, PhoneInfo, Voice } from '../shared/types';

const dataDir = process.env.HARK_DATA_DIR || path.join(app.getPath('userData'), 'library');
const modelsDir = process.env.HARK_MODELS_DIR || path.join(app.getPath('userData'), 'models');
const ramGb = Math.round(os.totalmem() / 2 ** 30);
const ffmpeg = (ffmpegStatic as unknown as string | null)?.replace('app.asar', 'app.asar.unpacked') ?? 'ffmpeg';

protocol.registerSchemesAsPrivileged([{ scheme: 'hark-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }]);

let win: BrowserWindow | null = null;
let phone: PhoneServer | null = null;
let mini: BrowserWindow | null = null;
let phoneError = '';
const PHONE_EVENTS = new Set<string>(['meeting', 'meetingDeleted', 'live', 'stream', 'status']);
const send = <K extends keyof Events>(event: K, data: Events[K]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(`hark:${event}`, data);
  if (mini && !mini.isDestroyed() && (event === 'live' || event === 'meeting')) mini.webContents.send(`hark:${event}`, data);
  if (phone && PHONE_EVENTS.has(event)) phone.broadcast(event, data);
};

const lib = new Library(dataDir);
lib.onChange = (m) => send('meeting', m);
if (!lib.hasSettings()) lib.saveSettings({ llmModel: recommendedLlm(ramGb) });

const models = new Models(modelsDir, (url, init) => net.fetch(url, init));
models.on('progress', (s) => send('download', s));
models.on('installed', (id: string) => {
  send('models', models.list(ramGb));
  const s = lib.settings();
  if (id === s.asrModel || id === 'speaker') void warmSpeech();
  if (id === s.llmModel) void ensureLlm().catch(() => undefined);
  refreshStatus();
});
models.on('failed', () => send('models', models.list(ramGb)));

// ---------------------------------------------------------------- engines

const engineLog = path.join(dataDir, 'engines.log');
const fork = (script: string, name: string) => {
  const child = utilityProcess.fork(path.join(__dirname, script), [], { serviceName: `Hark ${name}`, stdio: 'pipe' });
  // Engine output goes to a small log file next to the library, for troubleshooting.
  const log = (d: Buffer) => {
    try {
      if (fs.existsSync(engineLog) && fs.statSync(engineLog).size > 2e6) fs.rmSync(engineLog);
      fs.appendFileSync(engineLog, `[${name}] ${d}`);
    } catch {
      /* logging must never break the app */
    }
    if (process.env.HARK_DEBUG) process.stderr.write(`[${name}] ${d}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  return child;
};
const speech = new Engine(fork as never, 'speech.js', 'speech');

/**
 * The language model prefers a plain Node.js runtime when one is installed. Electron replaces
 * the system memory allocator with one that refuses very large single allocations, which some
 * llama.cpp code paths make when loading multi-gigabyte models. If no Node is found (or it
 * fails), the engine runs as an Electron utility process instead.
 */
function findNode(): string | null {
  const home = os.homedir();
  const hint = path.join(process.resourcesPath ?? '', 'node-path.txt');
  const nvm = path.join(home, '.nvm/versions/node');
  const candidates = [
    process.env.HARK_NODE,
    fs.existsSync(hint) ? fs.readFileSync(hint, 'utf8').trim() : undefined,
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'node.exe' : 'node')),
    '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
    path.join(home, '.volta/bin/node'),
    ...(fs.existsSync(nvm) ? fs.readdirSync(nvm).sort().reverse().map((v) => path.join(nvm, v, 'bin/node')) : []),
  ];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-v'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && parseInt(r.stdout.replace('v', ''), 10) >= 20) return c;
  }
  return null;
}

let llmHost: 'node' | 'electron' = process.env.HARK_LLM_HOST === 'electron' ? 'electron' : 'node';
let nodeBin: string | null | undefined;
const forkLlm = (script: string, name: string) => {
  if (nodeBin === undefined) nodeBin = findNode();
  if (llmHost === 'electron' || !nodeBin) {
    llmHost = 'electron';
    return fork(script, name);
  }
  const child = spawn(nodeBin, [path.join(__dirname, script)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const log = (d: Buffer) => {
    try {
      fs.appendFileSync(engineLog, `[${name}] ${d}`);
    } catch {
      /* ignore */
    }
    if (process.env.HARK_DEBUG) process.stderr.write(`[${name}] ${d}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  child.on('error', () => undefined);
  return { postMessage: (m: unknown) => child.connected && child.send(m as never), on: (ev: string, cb: (...a: any[]) => void) => child.on(ev, cb), kill: () => child.kill() };
};
const llm = new Engine(forkLlm as never, 'llm.js', 'language');

const status: EngineStatus = { asr: 'missing', llm: 'missing', ramGb };
let llmInfo: { gpu: string; contextSize: number } | null = null;
let llmLoaded = '';
let asrLoaded = '';

function refreshStatus(patch: Partial<EngineStatus> = {}): void {
  const s = lib.settings();
  Object.assign(status, patch);
  if (!models.installed(s.asrModel)) status.asr = 'missing';
  else if (status.asr === 'missing') status.asr = 'idle';
  if (!models.installed(s.llmModel)) status.llm = 'missing';
  else if (status.llm === 'missing') status.llm = 'idle';
  // Writing through Groq: notes and study tools work even without the model on this Mac.
  const cloud = useCloud() && cloudModel ? cloudModel : undefined;
  send('status', { ...status, cloud, ...(cloud && status.llm === 'missing' ? { llm: 'ready' as const } : {}) });
}

speech.onStart = async () => {
  await speech.raw('init', { modelsDir });
  asrLoaded = '';
};
speech.on('exit', () => {
  asrLoaded = '';
  refreshStatus({ asr: 'idle' });
});
llm.on('exit', () => {
  llmLoaded = '';
  llmInfo = null;
  refreshStatus({ llm: 'idle' });
});
llm.on('chunk', (c: { streamId: string; delta: string }) => send('stream', c));

async function ensureAsr(): Promise<void> {
  const id = lib.settings().asrModel;
  if (!models.installed(id)) throw new Error('The speech model has not been downloaded yet. Open Settings → AI models.');
  if (asrLoaded === id && speech.running) return;
  refreshStatus({ asr: 'loading', asrError: undefined });
  try {
    await speech.call('loadAsr', { repo: entry(id).repo });
    asrLoaded = id;
    refreshStatus({ asr: 'ready' });
  } catch (err) {
    refreshStatus({ asr: 'error', asrError: String((err as Error).message) });
    throw err;
  }
}

const warmSpeech = (): Promise<void> => ensureAsr().catch(() => undefined);

async function ensureLlm(): Promise<{ gpu: string; contextSize: number }> {
  const id = lib.settings().llmModel;
  if (!models.installed(id)) throw new Error('The AI model has not been downloaded yet. Open Settings → AI models.');
  if (llmLoaded === id && llm.running && llmInfo) return llmInfo;
  refreshStatus({ llm: 'loading', llmError: undefined });
  const contextSize = ramGb >= 30 ? 16384 : ramGb >= 14 ? 12288 : 8192;
  const load = () => llm.call<{ gpu: string; contextSize: number }>('load', { modelPath: process.env.HARK_LLM_FILE || models.llmPath(id), contextSize });
  try {
    try {
      llmInfo = await load();
    } catch (err) {
      // The engine died while loading: try once more in the other kind of host process.
      if (!/stopped unexpectedly/.test(String(err))) throw err;
      llmHost = llmHost === 'node' ? 'electron' : 'node';
      llmInfo = await load();
    }
    llmLoaded = id;
    refreshStatus({ llm: 'ready', gpu: llmInfo!.gpu });
    return llmInfo!;
  } catch (err) {
    refreshStatus({ llm: 'error', llmError: String((err as Error).message) });
    throw err;
  }
}

const speechApi: SpeechApi = {
  transcribe: async (pcm, language, words) => {
    await ensureAsr();
    return speech.call('transcribe', { pcm, language, words });
  },
  embedSpeaker: (pcm) => speech.call('embedSpeaker', { pcm }),
};

// On a Mac with little memory, the language model is only held while it is being used, so other
// apps (Jarvis, say) are not squeezed while Hark sits idle.
const lowMemory = ramGb <= 10 || !!process.env.HARK_LOW_MEMORY;
const llmIdleMs = Number(process.env.HARK_LLM_IDLE_MS) || 3 * 60e3;
let llmBusy = 0;
let llmUsedAt = Date.now();
if (lowMemory)
  setInterval(() => {
    if (llm.running && llmLoaded && !llmBusy && Date.now() - llmUsedAt > llmIdleMs) {
      llmLoaded = '';
      llmInfo = null;
      void llm.call('unload').then(() => refreshStatus({ llm: 'idle' })).catch(() => undefined);
    }
  }, Math.min(30e3, llmIdleMs)).unref();

const stopped = new Set<string>();
const llmApi: ConstructorParameters<typeof Intelligence>[1] = {
    generate: async (p) => {
      if (useCloud()) {
        try {
          const out = await cloudGenerate(groqKey(), p, (delta) => send('stream', { streamId: p.streamId, delta }), (secs) => send('stream', { streamId: p.streamId.split(':')[0] + (p.streamId.includes(':') ? `:${p.streamId.split(':')[1]}` : ''), stage: `Groq's free plan is pacing requests: waiting ${secs} s` }));
          cloudDown = '';
          return out;
        } catch (err) {
          // Offline, or Groq unavailable: carry on with the model on this Mac, if there is one.
          if (!(err instanceof CloudError) || !['network', 'other'].includes(err.kind) || err.message === 'Stopped' || !models.installed(lib.settings().llmModel)) throw err;
          cloudDown = err.message;
          cloudDownAt = Date.now();
          refreshStatus();
        }
      }
      llmBusy++;
      try {
        await ensureLlm();
        return await llm.call<string>('generate', p);
      } finally {
        llmBusy--;
        llmUsedAt = Date.now();
      }
    },
    tokens: async (text) => {
      if (useCloud()) return roughTokens(text);
      await ensureLlm();
      return llm.call<number>('tokens', { text });
    },
    // Groq's free plan allows about 8,000 tokens a minute per model, so long lectures go in parts of that size.
    contextSize: async () => (useCloud() ? 6400 : (await ensureLlm()).contextSize),
    modelName: () => (useCloud() && cloudModel ? `Groq ${cloudModel.replace(/^.*\//, '')}` : entry(lib.settings().llmModel).name),
};
const intel = new Intelligence(
  lib,
  llmApi,
  { embedText: (texts) => speech.call('embedText', { texts }), available: () => models.installed('embed') },
  (e) => send('stream', e),
  (id) => stopped.has(id),
);

const study = new Study(lib, llmApi, (e) => send('stream', e), (id) => stopped.has(id));
const practiceFile = path.join(dataDir, 'practice.json');
const readPractice = (): Practice => {
  try {
    return JSON.parse(fs.readFileSync(practiceFile, 'utf8')) as Practice;
  } catch {
    return {};
  }
};
const writePractice = (p: Practice): void => {
  fs.writeFileSync(`${practiceFile}.tmp`, JSON.stringify(p));
  fs.renameSync(`${practiceFile}.tmp`, practiceFile);
};

// ---------------------------------------------------------------- capture & import

type Live = { session: TranscriptionSession; blob: fs.WriteStream | null; lastSave: number };
const live = new Map<string, Live>();

const runFfmpeg = (args: string[]): Promise<{ code: number; err: string }> =>
  new Promise((resolve) => {
    let err = '';
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args]);
    p.stderr.on('data', (d) => (err = (err + d).slice(-6000)));
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? -1, err }));
  });

function newSession(m: Meeting, isLive: boolean): TranscriptionSession {
  const s = lib.settings();
  const sess = new TranscriptionSession(speechApi, {
    language: s.language,
    live: isLive,
    voices: s.rememberVoices ? lib.voices() : [],
    diarize: models.installed('speaker'),
  });
  sess.on('paras', (paras: Para[], replace: boolean) => {
    send('live', { type: 'paras', meetingId: m.id, paras, speakers: sess.speakers, duration: sess.duration, replace });
    const l = live.get(m.id);
    if (l && Date.now() - l.lastSave > 15000) {
      // Crash safety: keep what has been transcribed so far on disk.
      l.lastSave = Date.now();
      lib.saveTranscript(m.id, sess.paras);
      lib.update(m.id, { speakers: sess.speakers, duration: sess.duration });
    }
  });
  sess.on('partial', (text: string) => send('live', { type: 'partial', meetingId: m.id, text }));
  sess.on('error', () => undefined);
  return sess;
}

const defaultTitle = (m: Meeting): string => {
  const d = new Date(m.createdAt);
  const part = d.getHours() < 5 ? 'Late-night' : d.getHours() < 12 ? 'Morning' : d.getHours() < 17 ? 'Afternoon' : 'Evening';
  return `${part} conversation, ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
};

async function finish(m: Meeting, sess: TranscriptionSession, audio: Promise<boolean>): Promise<void> {
  try {
    await sess.end();
    const hasAudio = await audio;
    if (!lib.has(m.id)) return;
    lib.saveTranscript(m.id, sess.paras);
    lib.saveVoiceprints(m.id, sess.voiceprints());
    if (!sess.paras.length && sess.failed) throw sess.failed;
    lib.update(m.id, {
      status: 'ready', progress: undefined, duration: sess.duration, peaks: sess.peaks.compact(), speakers: sess.speakers, hasAudio,
      title: m.titleAuto && m.source === 'mic' ? defaultTitle(m) : m.title,
    });
    send('live', { type: 'paras', meetingId: m.id, paras: sess.paras, speakers: sess.speakers, duration: sess.duration, replace: true });
    void afterTranscript(m.id);
  } catch (err) {
    if (lib.has(m.id)) lib.update(m.id, { status: 'error', progress: undefined, error: err instanceof Error ? err.message : String(err) });
  }
}

async function afterTranscript(id: string): Promise<void> {
  await intel.index(id).catch(() => undefined);
  const m = lib.get(id);
  const s = lib.settings();
  // Emailing the notes needs notes, so it writes them even if automatic notes are switched off.
  if ((s.autoSummary || s.emailNotes) && canWrite() && m.words >= 25) {
    await intel.summarize(id, `sum:${id}`).catch(() => undefined);
  }
  // Lectures: find the cases, statutes and exam points, and write full notes, ready for revision.
  if (s.autoStudy && lib.has(id) && lib.get(id).template === 'lecture' && canWrite() && lib.get(id).words >= 150) {
    await study.legal(id, `legal:${id}`).catch(() => undefined);
    if (lib.has(id) && !study.get(id).notes) await study.notes(id, 'detailed', `notes:${id}`).catch(() => undefined);
  }
  if (lib.has(id) && lib.get(id).summary && !win?.isFocused()) tell('Notes ready', `“${lib.get(id).title}” has been transcribed and written up.`);
  if (s.emailNotes && lib.has(id) && lib.get(id).summary) await emailNotes(id).catch(() => undefined);
}

// ---------------------------------------------------------------- email

/** Use Groq for writing? Only when chosen, a key is set, and it has not just failed. */
let cloudDown = '';
let cloudModel = '';
let cloudDownAt = 0;
/** Can notes and study tools be written right now (through Groq, or the model on this Mac)? */
const canWrite = (): boolean => useCloud() || models.installed(lib.settings().llmModel);
const useCloud = (): boolean => {
  if (lib.settings().aiEngine === 'local' || !groqKey()) return false;
  // After a failure, try the cloud again a minute later rather than on every call.
  if (cloudDown && Date.now() - cloudDownAt < 60e3) return false;
  return true;
};
const checkCloud = async (): Promise<void> => {
  if (lib.settings().aiEngine === 'local' || !groqKey()) return void (cloudModel = '');
  try {
    cloudModel = (await cloudModels(groqKey())).strong;
    cloudDown = '';
  } catch (err) {
    cloudDown = (err as Error).message;
    cloudDownAt = Date.now();
  }
  refreshStatus();
};

const groqFile = path.join(dataDir, 'groq.json');
/** The Groq key the phone uses when the Mac is out of reach. Kept here so it reaches every paired phone. */
const groqKey = (): string => {
  try {
    return String(JSON.parse(fs.readFileSync(groqFile, 'utf8')).key ?? '');
  } catch {
    return '';
  }
};

const mailSecretFile = path.join(dataDir, 'mail-secret.json');
const mailPassword = (): string => {
  try {
    return String(JSON.parse(fs.readFileSync(mailSecretFile, 'utf8')).pass ?? '');
  } catch {
    return '';
  }
};

/** Where the notes go: the chosen address, or the sending Gmail address itself. */
const emailTarget = (): string => {
  const s = lib.settings();
  return (s.emailTo.trim() || (s.emailVia === 'gmail' ? s.emailFrom.trim() : '')).trim();
};

async function deliver(mail: ReturnType<typeof notesEmail>): Promise<string> {
  const s = lib.settings();
  const to = emailTarget();
  if (!validEmail(to)) throw new Error('Add the address to send notes to, in Settings → Email.');
  if (s.emailVia === 'mail') await sendWithMailApp(to, mail);
  else {
    if (!validEmail(s.emailFrom) || !mailPassword()) throw new Error('Add your Gmail address and app password in Settings → Email.');
    await sendGmail({ from: s.emailFrom.trim(), pass: mailPassword() }, to, mail);
  }
  return to;
}

const sending = new Set<string>();
/** Email one conversation's notes. Failures are kept on the conversation and retried later. */
async function emailNotes(id: string): Promise<Meeting> {
  if (sending.has(id)) return lib.get(id);
  sending.add(id);
  try {
    const to = await deliver(notesEmail(lib.get(id)));
    return lib.update(id, { emailedAt: Date.now(), emailedTo: to, emailError: undefined });
  } catch (err) {
    if (lib.has(id)) lib.update(id, { emailError: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    sending.delete(id);
  }
}

// A send that failed (no internet, Mac asleep) is tried again, for up to two days.
setInterval(() => {
  if (!lib.settings().emailNotes) return;
  for (const m of lib.list()) {
    if (m.summary && !m.emailedAt && m.emailError && Date.now() - m.createdAt < 2 * 864e5 && !/Settings/.test(m.emailError)) void emailNotes(m.id).catch(() => undefined);
  }
}, Number(process.env.HARK_EMAIL_RETRY_MS) || 10 * 60e3).unref();

/** Bookmarks made while recording become highlights on the paragraph being spoken. */
function applyBookmarks(id: string): void {
  const cur = lib.has(id) ? lib.get(id) : null;
  if (!cur?.bookmarks.length) return;
  const paras = lib.transcript(id);
  for (const t of cur.bookmarks) {
    const p = paras.find((x) => t >= x.s - 0.5 && t <= x.e + 2) ?? [...paras].reverse().find((x) => x.s <= t);
    if (p) p.hl = true;
  }
  lib.saveTranscript(id, paras);
  send('live', { type: 'paras', meetingId: id, paras, speakers: cur.speakers, duration: cur.duration, replace: true });
}

let importChain: Promise<void> = Promise.resolve();

/**
 * A recording cut short by a crash, power loss or force-quit leaves its audio in audio.rec.webm
 * (written every two seconds while recording). Re-attach it and transcribe the whole thing again,
 * so nothing said is lost even if the live transcript stopped early.
 */
function recoverInterrupted(): void {
  for (const m of lib.list()) {
    const raw = path.join(lib.folder(m.id), 'audio.rec.webm');
    if (live.has(m.id) || !fs.existsSync(raw)) continue;
    if (fs.statSync(raw).size < 2000) {
      fs.rmSync(raw, { force: true });
      continue;
    }
    lib.update(m.id, { status: 'processing', progress: 0, error: undefined, recovered: true });
    importChain = importChain.then(async () => {
      if (!lib.has(m.id)) return;
      try {
        await runImport(lib.get(m.id), raw);
        fs.rmSync(raw, { force: true });
        tell('Recording recovered', `“${lib.get(m.id).title}” was interrupted. Hark has rescued the audio and transcribed it in full.`);
      } catch (err) {
        // Keep the raw file: it can still be recovered later or exported by hand.
        if (lib.has(m.id)) lib.update(m.id, { status: 'error', progress: undefined, error: `The recording was interrupted and could not be transcribed yet (${err instanceof Error ? err.message : String(err)}). The audio is safe in its folder; Hark will try again next time it opens.` });
      }
    });
  }
}

/** A system notification (if switched on). */
function tell(title: string, body: string): void {
  if (!lib.settings().notify || !Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch {
    /* notifications are a courtesy */
  }
}

// ---------------------------------------------------------------- menu bar and shortcut

let tray: Tray | null = null;
let trayTimer: ReturnType<typeof setInterval> | null = null;
let recStartedAt = 0;
const recording = (): boolean => [...live.keys()].some((id) => lib.has(id) && lib.get(id).status === 'recording');

function updateTray(): void {
  if (!tray) return;
  const on = recording();
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // The menu bar shows a red dot and the time while recording, so it is never silent.
  tray.setTitle(on ? ` ● ${mmss((Date.now() - recStartedAt) / 1000)}` : '');
  tray.setToolTip(on ? 'Hark is recording' : 'Hark');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      on ? { label: 'Stop recording', click: () => send('command', 'stop-record') } : { label: 'Start recording', accelerator: lib.settings().recordShortcut || undefined, click: () => (showWindow(), send('command', 'record')) },
      { label: 'Open Hark', click: showWindow },
      { label: mini && !mini.isDestroyed() ? 'Hide live transcript' : 'Show live transcript', click: () => (toggleMini(), updateTray()) },
      { type: 'separator' },
      { label: 'Quit Hark', role: 'quit' },
    ]),
  );
  if (on && !trayTimer) trayTimer = setInterval(updateTray, 1000);
  if (!on && trayTimer) (clearInterval(trayTimer), (trayTimer = null));
}

function showWindow(): void {
  if (!win) createWindow();
  else (win.isMinimized() && win.restore(), win.show(), win.focus());
}

/** The floating live-transcript window, on top of every app and every Space. */
function toggleMini(show = !(mini && !mini.isDestroyed())): boolean {
  if (!show) {
    mini?.close();
    mini = null;
    return false;
  }
  if (mini && !mini.isDestroyed()) return mini.show(), true;
  mini = new BrowserWindow({
    width: 380, height: 230, minWidth: 260, minHeight: 120, alwaysOnTop: true, frame: false, resizable: true, skipTaskbar: true, fullscreenable: false,
    backgroundColor: '#101219', title: 'Hark live transcript', show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const wa = (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()).workArea;
  mini.setPosition(wa.x + wa.width - 400, wa.y + 40);
  mini.once('ready-to-show', () => mini?.showInactive());
  mini.on('closed', () => (mini = null));
  if (process.env.ELECTRON_RENDERER_URL) void mini.loadURL(`${process.env.ELECTRON_RENDERER_URL}#mini`);
  else void mini.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'mini' });
  return true;
}

function makeTray(): void {
  try {
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png')).resize({ width: 18, height: 18 });
    tray = new Tray(icon);
    updateTray();
  } catch {
    /* no menu bar on this system */
  }
}

let shortcut = '';
function setShortcut(accel: string): void {
  if (accel === shortcut) return;
  if (shortcut) globalShortcut.unregister(shortcut);
  shortcut = '';
  if (!accel) return;
  try {
    if (globalShortcut.register(accel, () => (recording() ? send('command', 'stop-record') : (showWindow(), send('command', 'record'))))) shortcut = accel;
  } catch {
    /* not a valid shortcut: leave it off */
  }
}

async function runImport(m: Meeting, file: string): Promise<void> {
  await ensureAsr();
  const probe = await runFfmpeg(['-i', file]);
  const d = probe.err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const total = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  if (!/Stream #.*Audio/.test(probe.err)) throw new Error('No audio track was found in this file.');
  const audio = runFfmpeg(['-y', '-i', file, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', lib.audioPath(m.id)]).then((r) => r.code === 0);
  const sess = newSession(m, false);
  live.set(m.id, { session: sess, blob: null, lastSave: Date.now() });
  try {
    const dec = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
    dec.stderr.resume();
    let rest: Buffer = Buffer.alloc(0);
    let lastProgress = 0;
    for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
      if (!lib.has(m.id)) {
        dec.kill();
        return;
      }
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      rest = buf.subarray(usable);
      const pcm = new Float32Array(usable / 4);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readFloatLE(i * 4);
      sess.push(pcm);
      // Decoding is far faster than transcription: wait here so memory stays flat.
      while (sess.backlog > 3) await sess.idle();
      if (sess.failed) throw sess.failed;
      if (total && Date.now() - lastProgress > 500) {
        lastProgress = Date.now();
        send('live', { type: 'progress', meetingId: m.id, progress: Math.min(0.99, sess.duration / total) });
      }
    }
    await finish(m, sess, audio);
  } finally {
    live.delete(m.id);
  }
}

function queueImport(file: string, source: 'import' | 'sample', title?: string): Meeting {
  const m = lib.create({ source, status: 'processing', progress: 0, title: title ?? path.basename(file).replace(/\.[^.]+$/, ''), titleAuto: source === 'sample' });
  importChain = importChain.then(() =>
    lib.has(m.id)
      ? runImport(m, file).catch((err) => {
          if (lib.has(m.id)) lib.update(m.id, { status: 'error', progress: undefined, error: err instanceof Error ? err.message : String(err) });
        })
      : undefined,
  );
  return m;
}

// ---------------------------------------------------------------- phone

/** A recording sent from the phone: transcribe it like an import, but treat it as the user's own recording. */
/** A recording the phone already transcribed and wrote up (with Groq): keep its notes exactly, just file the audio. */
async function adoptPhone(m: Meeting, file: string, n: PhoneNotes): Promise<void> {
  const audio = await runFfmpeg(['-y', '-i', file, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', lib.audioPath(m.id)]);
  // A waveform for the player, from the audio itself.
  const peaks = new PeakMeter();
  const dec = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
  dec.stderr.resume();
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    rest = buf.subarray(usable);
    peaks.push(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable)));
  }
  if (!lib.has(m.id)) return;
  const speakers = [{ id: 'S1', name: 'Speaker 1', color: 0 }];
  lib.saveTranscript(m.id, n.paras);
  lib.update(m.id, {
    status: 'ready', progress: undefined, duration: n.duration || m.duration, speakers, peaks: peaks.compact(), hasAudio: audio.code === 0,
    summary: n.summary, chat: n.chat ?? [], starred: n.starred, title: n.title || m.title, titleAuto: n.titleAuto,
  });
  send('live', { type: 'paras', meetingId: m.id, paras: n.paras, speakers, duration: n.duration, replace: true });
  await intel.index(m.id).catch(() => undefined);
  // No notes came with it (Groq could not write them): write them here as usual.
  const s = lib.settings();
  if (!n.summary && (s.autoSummary || s.emailNotes) && canWrite() && lib.get(m.id).words >= 25) await intel.summarize(m.id, `sum:${m.id}`).catch(() => undefined);
  if (s.emailNotes && lib.has(m.id) && lib.get(m.id).summary) await emailNotes(m.id).catch(() => undefined);
}

function queuePhone(file: string, meta: UploadMeta): Meeting {
  const createdAt = Math.min(meta.createdAt, Date.now());
  const init = { createdAt } as Meeting;
  const m = lib.create({
    source: 'phone', status: 'processing', progress: 0, createdAt, template: meta.template, bookmarks: meta.bookmarks,
    title: meta.name?.replace(/\.[^.]+$/, '') || defaultTitle(init), titleAuto: true,
  });
  importChain = importChain.then(async () => {
    try {
      if (lib.has(m.id)) await (meta.notes?.paras.length ? adoptPhone(m, file, meta.notes) : runImport(m, file));
      applyBookmarks(m.id);
      fs.rmSync(file, { force: true });
    } catch (err) {
      // Keep the upload on disk if transcription failed, so nothing recorded is ever lost.
      if (lib.has(m.id)) lib.update(m.id, { status: 'error', progress: undefined, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return m;
}

const phoneAudioJobs = new Map<string, Promise<string | null>>();
/** Phones cannot all play the library's WebM audio, so they get an AAC copy, made once and kept. */
function phoneAudio(id: string): Promise<string | null> {
  if (!lib.has(id) || !fs.existsSync(lib.audioPath(id))) return Promise.resolve(null);
  const out = path.join(lib.folder(id), 'audio.phone.m4a');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(lib.audioPath(id)).mtimeMs) return Promise.resolve(out);
  let job = phoneAudioJobs.get(id);
  if (!job) {
    const tmp = `${out}.tmp.m4a`;
    job = runFfmpeg(['-y', '-i', lib.audioPath(id), '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', tmp])
      .then((r) => {
        if (r.code !== 0) return null;
        fs.renameSync(tmp, out);
        return out;
      })
      .finally(() => phoneAudioJobs.delete(id));
    phoneAudioJobs.set(id, job);
  }
  return job;
}

const PHONE_PORT = Number(process.env.HARK_PHONE_PORT) || 7718;

async function startPhone(): Promise<void> {
  if (phone || !lib.settings().phone) return;
  phoneError = '';
  try {
    phone = await servePhone(
      {
        dataDir,
        uiDir: path.join(__dirname, '../phone'),
        hasMeeting: (id) => lib.has(id),
        audioFile: phoneAudio,
        upload: queuePhone,
        api: {
          boot: async () => ({
            meetings: lib.list(), status: { ...status }, ask: lib.askHistory(), version: app.getVersion(),
            userName: lib.settings().userName, theme: lib.settings().theme, notes: canWrite(),
            groqKey: groqKey(), emailNotes: lib.settings().emailNotes, language: lib.settings().language,
          }),
          getTranscript: api.getTranscript, updateMeeting: api.updateMeeting, deleteMeeting: api.deleteMeeting, updatePara: api.updatePara,
          renameSpeaker: api.renameSpeaker, dismissHint: api.dismissHint, setSummary: api.setSummary, summarize: api.summarize,
          emailNotes: api.emailNotes, chat: api.chat, clearChat: api.clearChat, ask: api.ask, clearAsk: api.clearAsk, abort: api.abort, search: api.search,
        },
      },
      PHONE_PORT,
    );
  } catch (err) {
    phone = null;
    phoneError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${PHONE_PORT} is being used by another app.` : String((err as Error).message);
  }
}

function stopPhone(): void {
  phone?.close();
  phone = null;
}

// ---------------------------------------------------------------- API

const saveWithDialog = async (name: string, ext: string, write: (file: string) => Promise<void> | void): Promise<string | null> => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: `${name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'conversation'}.${ext}` });
  if (r.canceled || !r.filePath) return null;
  await write(r.filePath);
  return r.filePath;
};

const api: Api = {
  boot: async () => ({
    settings: lib.settings(), meetings: lib.list(), models: models.list(ramGb), status: { ...status }, downloads: models.downloads(),
    platform: process.platform, version: app.getVersion(), ask: lib.askHistory(),
  }),
  listMeetings: async () => lib.list(),
  getTranscript: async (id) => live.get(id)?.session.paras ?? lib.transcript(id),
  updateMeeting: async (id, patch) => lib.update(id, { ...patch, ...(patch.title !== undefined ? { titleAuto: false } : {}) }),
  deleteMeeting: async (id) => {
    const l = live.get(id);
    if (l) {
      live.delete(id);
      l.blob?.destroy();
      void l.session.end().catch(() => undefined);
    }
    lib.remove(id);
    send('meetingDeleted', id);
  },
  updatePara: async (id, paraId, patch) => {
    const paras = lib.transcript(id);
    const p = paras.find((x) => x.id === paraId);
    if (!p) throw new Error('Paragraph not found');
    if (patch.text !== undefined && patch.text.trim() !== p.text) {
      p.text = patch.text.trim();
      p.words = retime(p.text, p.s, p.e);
    }
    if (patch.hl !== undefined) p.hl = patch.hl || undefined;
    if (patch.note !== undefined) p.note = patch.note.trim() || undefined;
    if (patch.sp !== undefined) p.sp = patch.sp;
    if (patch.tag !== undefined) p.tag = patch.tag || undefined;
    const kept = paras.filter((x) => x.text);
    lib.saveTranscript(id, kept);
    return kept;
  },
  renameSpeaker: async (id, speakerId, name) => {
    const m = lib.get(id);
    const sp = m.speakers.find((s) => s.id === speakerId);
    name = name.trim();
    if (!sp || !name) return m;
    const old = sp.name;
    if (m.summary && old !== name && /^Speaker \d+$/.test(old)) {
      // Notes written before the rename say "Speaker 2": swap in the real name.
      const re = new RegExp(`\\b${old}\\b`, 'g');
      m.summary = JSON.parse(JSON.stringify(m.summary).replace(re, name.replace(/["\\]/g, '')));
    }
    if (m.nameHints) delete m.nameHints[speakerId];
    sp.name = name;
    sp.named = true;
    const print = lib.voiceprints(id)[speakerId];
    if (print && lib.settings().rememberVoices) {
      // Remember this voice so it is recognised in future conversations.
      const voices = lib.voices();
      const existing = voices.find((v) => v.id === sp.voiceId) ?? voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        const mixed = existing.vec.length === print.length ? existing.vec.map((x, i) => x * existing.samples + print[i]) : print;
        existing.vec = Array.from(normalize(mixed));
        existing.samples = Math.min(existing.samples + 1, 8);
        existing.name = name;
        sp.voiceId = existing.id;
      } else {
        const v: Voice = { id: uid(), name, color: sp.color, vec: print, samples: 1 };
        voices.push(v);
        sp.voiceId = v.id;
      }
      lib.saveVoices(voices);
    }
    return lib.update(id, { speakers: m.speakers });
  },
  mergeSpeakers: async (id, from, into) => {
    const m = lib.get(id);
    const paras = lib.transcript(id);
    for (const p of paras) if (p.sp === from) p.sp = into;
    lib.saveTranscript(id, paras);
    return { meeting: lib.update(id, { speakers: m.speakers.filter((s) => s.id !== from) }), paras };
  },
  setSummary: async (id, summary) => lib.update(id, { summary }),
  dismissHint: async (id, speakerId) => {
    const m = lib.get(id);
    if (m.nameHints) delete m.nameHints[speakerId];
    return lib.update(id, { nameHints: m.nameHints });
  },

  recStart: async ({ template }) => {
    await ensureAsr();
    const m = lib.create({ source: 'mic', status: 'recording', template, title: 'Recording…' });
    const blob = fs.createWriteStream(path.join(lib.folder(m.id), 'audio.rec.webm'));
    live.set(m.id, { session: newSession(m, true), blob, lastSave: Date.now() });
    recStartedAt = Date.now();
    updateTray();
    tell('Recording', 'Hark is recording. Stop it from the menu bar or the app.');
    return m;
  },
  recAudio: (id, pcm) => {
    live.get(id)?.session.push(pcm instanceof Float32Array ? pcm : new Float32Array(pcm as ArrayLike<number>));
  },
  recBlob: (id, bytes) => {
    live.get(id)?.blob?.write(Buffer.from(bytes));
  },
  recPause: async (id) => live.get(id)?.session.cut(),
  recBookmark: async (id, t) => {
    const m = lib.get(id);
    lib.update(id, { bookmarks: [...m.bookmarks, Math.round(t * 10) / 10] });
  },
  recStop: async (id) => {
    const l = live.get(id);
    const m = lib.get(id);
    if (!l) return m;
    lib.update(id, { status: 'processing', duration: l.session.duration, title: defaultTitle(m) });
    setTimeout(updateTray, 50);
    tell('Recording stopped', `${Math.round(l.session.duration / 60)} min saved. Hark is finishing the transcript and notes.`);
    const raw = path.join(lib.folder(id), 'audio.rec.webm');
    const audio = new Promise<void>((r) => (l.blob ? l.blob.end(() => r()) : r())).then(async () => {
      if (!fs.existsSync(raw) || fs.statSync(raw).size < 200) return false;
      // The recorder writes a stream with no duration or seek index; rewrap it so playback can jump around.
      const r = await runFfmpeg(['-y', '-i', raw, '-c', 'copy', lib.audioPath(id)]);
      if (r.code === 0) fs.rmSync(raw, { force: true });
      else fs.renameSync(raw, lib.audioPath(id));
      return true;
    });
    void finish(m, l.session, audio).finally(() => {
      live.delete(id);
      applyBookmarks(id);
    });
    return lib.get(id);
  },
  recDiscard: async (id) => api.deleteMeeting(id),

  importFiles: async (paths) => {
    if (!paths?.length) {
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio & video', extensions: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'mov', 'mkv', 'm4v', 'wma', 'aiff', 'caf', '3gp'] }],
      });
      paths = r.canceled ? [] : r.filePaths;
    }
    if (paths.length) await ensureAsr();
    return paths.map((p) => queueImport(p, 'import'));
  },
  importSample: async () => {
    await ensureAsr();
    return queueImport(path.join(app.getAppPath(), 'resources', 'sample-meeting.ogg'), 'sample', 'Sample: weekly product sync');
  },

  summarize: async (id, streamId, template) => {
    stopped.delete(streamId);
    await intel.summarize(id, streamId, template);
  },
  chat: (id, question, streamId, mode, passage) => intel.chat(id, question, streamId, mode, passage),
  clearChat: async (id) => lib.update(id, { chat: [] }),
  ask: (question, streamId) => intel.ask(question, streamId),
  clearAsk: async () => lib.saveAskHistory([]),
  catchUp: async (id, streamId) => {
    const l = live.get(id);
    return intel.catchUp(l?.session.paras ?? lib.transcript(id), l?.session.speakers ?? lib.get(id).speakers, streamId);
  },
  abort: async (streamId) => {
    stopped.add(streamId);
    abortCloud(streamId);
    if (llm.running) await llm.call('abort', { streamId }).catch(() => undefined);
  },
  search: async (q) => lib.search(q),

  exportMeeting: async (id, format) => {
    const m = lib.get(id);
    const paras = lib.transcript(id);
    if (format === 'audio') return saveWithDialog(m.title, 'webm', (f) => fs.copyFileSync(lib.audioPath(id), f));
    if (format === 'pdf')
      return saveWithDialog(m.title, 'pdf', async (f) => {
        const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
        try {
          await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toHtml(m, paras))}`);
          fs.writeFileSync(f, await w.webContents.printToPDF({ pageSize: 'A4', margins: { top: 0.7, bottom: 0.7, left: 0.75, right: 0.75 } }));
        } finally {
          w.destroy();
        }
      });
    if (format === 'docx') return saveWithDialog(m.title, 'docx', async (f) => fs.writeFileSync(f, await markdownToDocx(toMarkdown(m, paras), m.title)));
    const text = format === 'md' ? toMarkdown(m, paras) : format === 'srt' ? toSrt(paras, m.speakers) : toText(m, paras);
    return saveWithDialog(m.title, format, (f) => fs.writeFileSync(f, text));
  },
  copyText: async (text) => clipboard.writeText(text),

  saveSettings: async (patch) => {
    const before = lib.settings();
    const s = lib.saveSettings(patch);
    if (patch.theme) nativeTheme.themeSource = s.theme;
    if (patch.recordShortcut !== undefined) setShortcut(s.recordShortcut);
    if (patch.aiEngine !== undefined) void checkCloud();
    if (patch.phone !== undefined) {
      if (s.phone) await startPhone();
      else stopPhone();
    }
    if (patch.asrModel && patch.asrModel !== before.asrModel) void warmSpeech();
    if (patch.llmModel && patch.llmModel !== before.llmModel) {
      if (llm.running) void llm.call('unload').catch(() => undefined);
      llmLoaded = '';
    }
    refreshStatus();
    return s;
  },
  listModels: async () => models.list(ramGb),
  downloadModel: async (id) => {
    void models.download(id);
  },
  cancelDownload: async (id) => models.cancel(id),
  removeModel: async (id) => {
    models.remove(id);
    refreshStatus();
    return models.list(ramGb);
  },
  listVoices: async () => lib.voices(),
  deleteVoice: async (id) => {
    const v = lib.voices().filter((x) => x.id !== id);
    lib.saveVoices(v);
    return v;
  },
  openDataFolder: async () => {
    await shell.openPath(dataDir);
  },
  micAccess: async () => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  },
  emailNotes: (id) => emailNotes(id),
  saveEmailPassword: async (pass) => {
    const clean = pass.replace(/\s+/g, '');
    if (!clean) {
      fs.rmSync(mailSecretFile, { force: true });
      return { saved: false };
    }
    const from = lib.settings().emailFrom.trim();
    if (!validEmail(from)) throw new Error('Enter your Gmail address first.');
    await checkGmail({ from, pass: clean });
    fs.writeFileSync(mailSecretFile, JSON.stringify({ pass: clean }), { mode: 0o600 });
    return { saved: true };
  },
  emailStatus: async () => ({ hasPassword: !!mailPassword() }),
  saveGroqKey: async (key) => {
    const k = key.trim();
    if (!k) return void (fs.rmSync(groqFile, { force: true }), void checkCloud());
    // Checked with Groq before it is kept.
    const res = await net.fetch(`${process.env.HARK_GROQ_URL || 'https://api.groq.com/openai/v1'}/models`, { headers: { Authorization: `Bearer ${k}` } }).catch(() => null);
    if (!res) throw new Error("Couldn't reach Groq to check the key. Is this Mac online?");
    if (res.status === 401) throw new Error('Groq rejected that key. Copy it again from console.groq.com → API Keys.');
    if (!res.ok) throw new Error(`Groq answered ${res.status}.`);
    fs.writeFileSync(groqFile, JSON.stringify({ key: k }), { mode: 0o600 });
    void checkCloud();
  },
  groqStatus: async () => ({ hasKey: !!groqKey() }),
  testEmail: async () => {
    const now = Date.now();
    const sample = {
      title: 'Test from Hark', createdAt: now, duration: 0, speakers: [], template: 'meeting',
      summary: { title: 'Test from Hark', overview: 'If you can read this, Hark will email you the notes from each conversation as soon as they are written.', keyPoints: ['Emailing notes is set up and working.'], actions: [], decisions: [], questions: [], chapters: [], topics: [], cards: [], template: 'meeting' },
    } as unknown as Meeting;
    await deliver(notesEmail(sample));
  },
  studyGet: async (id) => study.get(id),
  studyNotes: (id, style, streamId) => (stopped.delete(streamId), study.notes(id, style, streamId)),
  studyLegal: (id, streamId) => (stopped.delete(streamId), study.legal(id, streamId)),
  studyRevision: (id, kind, opts, streamId) => (stopped.delete(streamId), study.revision(id, kind, opts, streamId)),
  studySave: async (id, patch) => study.save(id, patch),
  practice: async (key, right, topic, lectureId) => {
    const p = readPractice();
    record(p, key, right, topic, lectureId);
    writePractice(p);
  },
  revisionOverview: async () => {
    const practice = readPractice();
    const items: RevisionItem[] = [];
    const confusing: { meetingId: string; title: string; paraId: string; t: number; text: string }[] = [];
    const confusedTopics: Record<string, number> = {};
    const untested: { id: string; title: string }[] = [];
    let lectures = 0;
    for (const m of lib.list()) {
      const pack = study.get(m.id);
      const fallback = pack.legal?.topics[0] ?? m.title;
      const lectureTopics = pack.legal?.topics ?? [];
      // A question's own topic, folded into the closest of the lecture's topics (by shared words).
      const fold = (t: string): string => {
        if (!t || !lectureTopics.length) return t || fallback;
        const words = (x: string) => new Set(x.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).map((w) => w.replace(/s$/, '')));
        const mine = words(t);
        let best = '', score = 0;
        for (const lt of lectureTopics) {
          const n = [...words(lt)].filter((w) => mine.has(w)).length;
          if (n > score) (score = n), (best = lt);
        }
        return lectureTopics.includes(t) ? t : best || fallback;
      };
      const mine: RevisionItem[] = [
        ...(pack.cards ?? []).map((c): RevisionItem => ({ key: `${m.id}:${c.id}`, kind: 'card', topic: fold(c.topic), lectureId: m.id, lecture: m.title, front: c.front, back: c.back })),
        ...(pack.sbaqs ?? []).map((q): RevisionItem => ({ key: `${m.id}:${q.id}`, kind: 'sbaq', topic: fold(q.topic), lectureId: m.id, lecture: m.title, sbaq: q })),
        ...(pack.shortQs ?? []).map((q): RevisionItem => ({ key: `${m.id}:${q.id}`, kind: 'short', topic: fold(q.topic), lectureId: m.id, lecture: m.title, q: q.q, a: q.a })),
      ];
      if (mine.length) lectures++;
      if (mine.length && !mine.some((x) => practice[x.key])) untested.push({ id: m.id, title: m.title });
      items.push(...mine);
      for (const p of lib.transcript(m.id))
        if (p.tag === 'confusing') {
          confusing.push({ meetingId: m.id, title: m.title, paraId: p.id, t: p.s, text: p.text.slice(0, 220) });
          confusedTopics[fallback] = (confusedTopics[fallback] ?? 0) + 1;
        }
    }
    const topics = topicStatus(items, practice, confusedTopics);
    const weak = new Set(topics.filter((t) => t.state === 'needs').map((t) => t.topic));
    return { topics, session: pickSession(items, practice, weak, 15), practice, confusing, totals: { items: items.length, due: items.filter((x) => practice[x.key] && practice[x.key].due <= Date.now()).length, lectures, untestedLectures: untested } };
  },
  caseBank: async () => lib.list().flatMap((m) => (study.get(m.id).legal?.cases ?? []).map((c) => ({ c, meetingId: m.id, title: m.title, date: m.createdAt }))),
  exportStudy: async (id, what) => {
    if (what === 'all-anki') {
      const cards = lib.list().flatMap((m) => (study.get(m.id).cards ?? []).map((c) => ({ ...c, topic: c.topic || m.title })));
      if (!cards.length) throw new Error('There are no flashcards yet.');
      return saveWithDialog('Hark flashcards', 'txt', (f) => fs.writeFileSync(f, ankiExport(cards, 'Hark')));
    }
    const m = lib.get(id);
    const pack = study.get(id);
    if (what === 'anki') {
      if (!pack.cards?.length) throw new Error('This lecture has no flashcards yet.');
      return saveWithDialog(`${m.title} flashcards`, 'txt', (f) => fs.writeFileSync(f, ankiExport(pack.cards!, `Hark::${m.title}`)));
    }
    if (!pack.notes) throw new Error('Write the notes first.');
    if (what === 'notes-docx') return saveWithDialog(`${m.title} notes`, 'docx', async (f) => fs.writeFileSync(f, await markdownToDocx(pack.notes!.text, m.title)));
    return saveWithDialog(`${m.title} notes`, 'md', (f) => fs.writeFileSync(f, pack.notes!.text));
  },
  toggleMini: async (show) => {
    const on = toggleMini(show);
    updateTray();
    return on;
  },
  miniCommand: async (cmd) => {
    if (cmd === 'show') return showWindow();
    send('command', cmd);
  },
  phoneInfo: async () => {
    const s = lib.settings();
    const lan = lanAddresses();
    const port = phone?.port ?? PHONE_PORT;
    const link = s.phoneLink.trim().replace(/\/+$/, '');
    const secure = /^https:\/\/[^\s/]+/.test(link);
    const base = secure ? link : lan[0] ? `http://${lan[0]}:${port}` : '';
    const url = phone && base ? `${base}/?k=${phone.token}` : '';
    const info: PhoneInfo = { enabled: s.phone, running: !!phone, port, lan, url, secure, connected: phone?.clients() ?? 0, qr: '', error: phoneError || undefined };
    if (url) info.qr = await QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#0a0b10ff', light: '#ffffffff' } });
    return info;
  },
};

ipcMain.handle('hark', (_e, method: keyof Api, ...args: unknown[]) => {
  const fn = api[method] as ((...a: unknown[]) => unknown) | undefined;
  if (typeof fn !== 'function') throw new Error(`Unknown call ${String(method)}`);
  return fn(...args);
});
ipcMain.on('hark-send', (_e, method: 'recAudio' | 'recBlob', ...args: unknown[]) => {
  if (method === 'recAudio' || method === 'recBlob') (api[method] as (...a: unknown[]) => void)(...args);
});

// ---------------------------------------------------------------- window

function serveMedia(request: Request): Response {
  const id = new URL(request.url).pathname.replace(/^\/+/, '').split('/')[0];
  if (!/^[a-z0-9]+$/.test(id) || !lib.has(id)) return new Response('Not found', { status: 404 });
  const file = lib.audioPath(id);
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
  const size = fs.statSync(file).size;
  const range = request.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
  const start = range?.[1] ? +range[1] : 0;
  const end = Math.min(range?.[2] ? +range[2] : size - 1, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const stream = fs.createReadStream(file, { start, end });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      stream.on('data', (d) => c.enqueue(new Uint8Array(d as Buffer)));
      stream.on('end', () => c.close());
      stream.on('error', (e) => c.error(e));
    },
    cancel() {
      stream.destroy();
    },
  });
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': 'audio/webm', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

function buildMenu(): void {
  const cmd = (label: string, accelerator: string, command: string) => ({ label, accelerator, click: () => send('command', command) });
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, cmd('Settings…', 'Cmd+,', 'settings'), { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
      {
        label: 'File',
        submenu: [cmd('New Recording', 'CmdOrCtrl+N', 'record'), cmd('Import Audio or Video…', 'CmdOrCtrl+O', 'import'), { type: 'separator' as const }, ...(mac ? [] : [cmd('Settings…', 'Ctrl+,', 'settings')]), mac ? { role: 'close' as const } : { role: 'quit' as const }],
      },
      { role: 'editMenu' as const },
      {
        label: 'View',
        submenu: [cmd('Search Everything', 'CmdOrCtrl+K', 'palette'), cmd('Ask Hark', 'CmdOrCtrl+J', 'ask'), { type: 'separator' as const }, { role: 'togglefullscreen' as const }, { role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }])],
      },
      { role: 'windowMenu' as const },
    ]),
  );
}

function createWindow(): void {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 980, minHeight: 640, show: false,
    backgroundColor: '#0a0b10', title: 'Hark',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 18, y: 18 } : undefined,
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(() => {
    nativeTheme.themeSource = lib.settings().theme;
    protocol.handle('hark-media', serveMedia);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'clipboard-sanitized-write', 'display-capture'].includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'clipboard-sanitized-write'].includes(permission));
    // "Capture computer audio": hand the page the system's audio output (what Zoom, Meet or a video is playing).
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then(
        (sources) => cb(sources.length ? { video: sources[0], audio: 'loopback' } : {}),
        () => cb({}),
      );
    });
    buildMenu();
    createWindow();
    refreshStatus();
    void startPhone();
    makeTray();
    setShortcut(lib.settings().recordShortcut);
    setTimeout(recoverInterrupted, 1500);
    void checkCloud();
    // Load the speech model right away so the first recording starts instantly; the language model shortly after.
    void warmSpeech();
    if (!lowMemory) setTimeout(() => !useCloud() && void ensureLlm().catch(() => undefined), 4000);
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    // Keep whatever has been transcribed of an in-progress recording.
    for (const [id, l] of live) {
      if (!lib.has(id)) continue;
      lib.saveTranscript(id, l.session.paras);
      lib.update(id, { speakers: l.session.speakers, duration: l.session.duration });
    }
    stopPhone();
    globalShortcut.unregisterAll();
    speech.stop();
    llm.stop();
  });
}
