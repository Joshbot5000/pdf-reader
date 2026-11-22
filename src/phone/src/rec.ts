/**
 * Recording on the phone. Audio is written to the phone's own storage every few seconds as it is
 * captured, so nothing is lost if the app is closed or the Mac is out of reach. Finished recordings
 * wait in an outbox and are sent to Hark on the Mac as soon as it can be reached.
 */
import { useEffect, useState } from 'react';
import { call, get, loadTranscript, openMeeting, set, toast, token, whenOffline, whenOnline, withKey, type LocalNotes, type OutItem } from './link';
import { chat as groqChat, groqKey, summarize as groqSummarize, transcribe as groqTranscribe } from './groq';
import type { ChatMsg, Meeting, Summary } from '../../shared/types';
import type { TemplateId } from '../../shared/types';

export const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

// ---------------------------------------------------------------- storage

let dbp: Promise<IDBDatabase> | null = null;
const db = (): Promise<IDBDatabase> =>
  (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('hark-outbox', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('recs', { keyPath: 'rid' });
      req.result.createObjectStore('chunks', { keyPath: ['rid', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage is unavailable'));
  }));
const done = <T,>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));
const putRec = async (r: OutItem): Promise<void> => void (await done((await db()).transaction('recs', 'readwrite').objectStore('recs').put(r)));
const putChunk = async (rid: string, seq: number, blob: Blob): Promise<void> => void (await done((await db()).transaction('chunks', 'readwrite').objectStore('chunks').put({ rid, seq, blob })));
const range = (rid: string): IDBKeyRange => IDBKeyRange.bound([rid, 0], [rid, Number.MAX_SAFE_INTEGER]);
const chunksOf = async (rid: string): Promise<Blob[]> => (await done<{ blob: Blob }[]>((await db()).transaction('chunks').objectStore('chunks').getAll(range(rid)))).map((c) => c.blob);
async function drop(rid: string): Promise<void> {
  const tx = (await db()).transaction(['recs', 'chunks'], 'readwrite');
  tx.objectStore('recs').delete(rid);
  tx.objectStore('chunks').delete(range(rid));
  await new Promise<void>((resolve, reject) => ((tx.oncomplete = () => resolve()), (tx.onerror = () => reject(tx.error))));
}

const patch = (rid: string, p: Partial<OutItem>): OutItem | undefined => {
  let next: OutItem | undefined;
  set((s) => ({ outbox: s.outbox.map((o) => (o.rid === rid ? (next = { ...o, ...p }) : o)) }));
  return next;
};

/** Load anything still waiting from a previous session (including a recording cut short by the app closing). */
export async function restoreOutbox(): Promise<void> {
  try {
    const recs = await done<OutItem[]>((await db()).transaction('recs').objectStore('recs').getAll());
    const outbox: OutItem[] = [];
    for (const r of recs) {
      if (r.state !== 'waiting') {
        const blobs = await chunksOf(r.rid);
        r.bytes = blobs.reduce((n, b) => n + b.size, 0);
        if (!r.bytes) {
          await drop(r.rid);
          continue;
        }
        r.state = 'waiting';
        delete r.sent;
        await putRec(r);
      }
      outbox.push(r);
    }
    set({ outbox: outbox.sort((a, b) => b.createdAt - a.createdAt) });
    // Ask the phone not to clear this storage under pressure.
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* storage blocked: recording will warn when started */
  }
  whenOnline(() => void flush());
  // Mac out of reach: do the work here instead (if a Groq key is set).
  whenOffline(() => void processPending());
  // Anything interrupted mid-way (the app was closed) picks up where it left off.
  for (const o of get().outbox) if (o.local?.state === 'working') void processLocal(o.rid, true);
  setTimeout(() => !get().online && void processPending(), 4000);
}

// ---------------------------------------------------------------- working without the Mac

const working = new Set<string>();
const setLocal = async (rid: string, p: Partial<LocalNotes>): Promise<OutItem | undefined> => {
  const cur = get().outbox.find((o) => o.rid === rid);
  if (!cur?.local) return undefined;
  const next = patch(rid, { local: { ...cur.local, ...p } });
  if (next) await putRec(next).catch(() => undefined);
  return next;
};

/** Transcribe and write notes for everything waiting, through Groq, because the Mac can't be reached. */
export async function processPending(): Promise<void> {
  if (!groqKey()) return;
  for (const o of [...get().outbox].reverse()) if (o.state === 'waiting' && !o.local) await processLocal(o.rid);
}

/** One recording, done entirely on the phone with Groq. */
export async function processLocal(rid: string, resume = false): Promise<void> {
  const item = get().outbox.find((o) => o.rid === rid);
  if (!item || working.has(rid) || !groqKey() || (item.local && !resume && item.local.state !== 'error')) return;
  working.add(rid);
  try {
    const keep = item.local;
    const title = keep?.title ?? (item.name?.replace(/\.[^.]+$/, '') || `Recording, ${new Date(item.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
    const start: OutItem = { ...item, local: { state: 'working', stage: 'Transcribing', title, titleAuto: keep?.titleAuto ?? !item.name, duration: item.duration, paras: keep?.paras ?? [], chat: keep?.chat ?? [], starred: keep?.starred } };
    patch(rid, { local: start.local });
    await putRec(start);
    let local = start.local!;
    if (!local.paras.length) {
      const audio = new Blob(await chunksOf(rid), { type: item.mime });
      const out = await groqTranscribe(audio, item.ext, get().language, (stage) => void setLocal(rid, { stage }));
      // Moments flagged while recording are highlighted, as on the Mac.
      for (const t of item.bookmarks) {
        const p = out.paras.find((x) => t >= x.s - 0.5 && t <= x.e + 2) ?? [...out.paras].reverse().find((x) => x.s <= t);
        if (p) p.hl = true;
      }
      local = (await setLocal(rid, { paras: out.paras, duration: out.duration || item.duration, stage: 'Writing the notes' }))?.local ?? local;
    }
    if (!local.paras.length) return void (await setLocal(rid, { state: 'ready', stage: undefined, error: undefined }));
    const summary = await groqSummarize(local.paras, item.template, (stage) => void setLocal(rid, { stage }));
    await setLocal(rid, { state: 'ready', stage: undefined, error: undefined, summary, title: local.titleAuto && summary.title ? summary.title : local.title });
  } catch (err) {
    await setLocal(rid, { state: 'error', stage: undefined, error: (err as Error).message });
  } finally {
    working.delete(rid);
    if (get().online) void flush();
  }
}

/** The same actions the Mac offers on a conversation, for ones that live on the phone. */
async function localOp(method: string, rid: string, args: unknown[]): Promise<unknown> {
  const o = get().outbox.find((x) => x.rid === rid);
  if (!o?.local) throw new Error('That conversation is no longer on this phone (it has gone to your Mac).');
  const l = o.local;
  switch (method) {
    case 'updateMeeting': {
      const p = args[0] as Partial<Meeting>;
      await setLocal(rid, { ...(p.title !== undefined ? { title: p.title, titleAuto: false } : {}), ...(p.starred !== undefined ? { starred: p.starred } : {}) });
      return null;
    }
    case 'setSummary':
      return setLocal(rid, { summary: args[0] as Summary });
    case 'deleteMeeting':
      return discard(rid);
    case 'summarize':
      await setLocal(rid, { summary: undefined, state: 'working' });
      return processLocal(rid, true);
    case 'chat': {
      const q = String(args[0]);
      const answer = await groqChat(l.paras, l.chat, q);
      const at = Date.now();
      const msgs: ChatMsg[] = [...l.chat, { id: `u${at}`, role: 'user', text: q, at }, { id: `a${at}`, role: 'assistant', text: answer, at }];
      await setLocal(rid, { chat: msgs });
      return msgs[msgs.length - 1];
    }
    case 'clearChat':
      return setLocal(rid, { chat: [] });
    case 'emailNotes':
      throw new Error(get().macEmails ? 'This one will be emailed as soon as your Mac receives it.' : 'Emails are sent by your Mac: switch them on in Hark on the Mac (Settings → Email).');
    default:
      throw new Error("That needs your Mac, which can't be reached right now.");
  }
}

/** Do something to a conversation, wherever it lives. */
export const meetingCall = <T = unknown,>(method: string, id: string, ...args: unknown[]): Promise<T> =>
  (id.startsWith('local:') ? localOp(method, id.slice(6), args) : call(method, id, ...args)) as Promise<T>;

/** Where to play a conversation's audio from: the Mac, or (for ones made here) the phone itself. */
export function useAudioSrc(id: string, macUrl: string): string {
  const [src, setSrc] = useState(id.startsWith('local:') ? '' : macUrl);
  useEffect(() => {
    if (!id.startsWith('local:')) return void setSrc(macUrl);
    const o = get().outbox.find((x) => `local:${x.rid}` === id);
    if (!o) return;
    let url = '';
    void chunksOf(o.rid).then((c) => setSrc((url = URL.createObjectURL(new Blob(c, { type: o.mime })))));
    return () => URL.revokeObjectURL(url);
  }, [id, macUrl]);
  return src;
}

// ---------------------------------------------------------------- sending

let flushing = false;
export async function flush(): Promise<void> {
  if (flushing || !get().online) return;
  flushing = true;
  try {
    for (;;) {
      // Notes still being written on the phone are finished first, then go to the Mac with the audio.
      const next = get().outbox.filter((o) => o.state === 'waiting' && !o.error && o.local?.state !== 'working' && !working.has(o.rid)).pop();
      if (!next || !get().online) break;
      if (!(await send(next))) break;
    }
  } finally {
    flushing = false;
  }
}

export const retry = (rid: string): void => {
  patch(rid, { error: undefined });
  void flush();
};

export async function discard(rid: string): Promise<void> {
  set((s) => ({ outbox: s.outbox.filter((o) => o.rid !== rid) }));
  await drop(rid).catch(() => undefined);
}

async function send(item: OutItem): Promise<boolean> {
  item = get().outbox.find((o) => o.rid === item.rid) ?? item;
  patch(item.rid, { state: 'sending', sent: 0, error: undefined });
  try {
    const body = new Blob(await chunksOf(item.rid), { type: item.mime });
    if (!body.size) throw new Error('This recording is empty.');
    const q = new URLSearchParams({ rid: item.rid, t: String(item.createdAt), tpl: item.template, ext: item.ext, marks: item.bookmarks.join(',') });
    if (item.name) q.set('name', item.name);
    if (item.local?.state === 'ready') {
      // Hand over what the phone already worked out, so the Mac keeps exactly these notes.
      const l = item.local;
      const res = await fetch(withKey(`./attach?rid=${encodeURIComponent(item.rid)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: l.title, titleAuto: l.titleAuto, duration: l.duration, paras: l.paras, summary: l.summary, chat: l.chat, starred: l.starred }) }).catch(() => null);
      if (!res) throw new Error('offline');
      if (!res.ok) throw new Error(`Hark on your Mac refused the notes (${res.status}).`);
    }
    const meetingId = await new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', withKey(`./upload?${q}`));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => patch(item.rid, { sent: e.loaded / Math.max(1, e.total) });
      xhr.onload = () => {
        let r: { meetingId?: string; error?: string } = {};
        try {
          r = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status === 200 && r.meetingId) resolve(r.meetingId);
        else reject(new Error(r.error ?? `Hark on your Mac refused the recording (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error('offline'));
      xhr.ontimeout = () => reject(new Error('offline'));
      xhr.send(body);
    });
    // Straight into the conversation it became, if the user is still on the home screen (or was reading it here).
    // The view moves to the Mac's copy first, so it never points at something that has gone.
    if (get().open === `local:${item.rid}`) (set({ open: meetingId }), void loadTranscript(meetingId, true));
    await discard(item.rid);
    if (!get().open && !get().recorder && !item.local) openMeeting(meetingId);
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    // A dropped connection is not an error worth showing: it simply waits for the Mac.
    patch(item.rid, { state: 'waiting', sent: undefined, error: msg === 'offline' ? undefined : msg });
    if (msg === 'offline') void processPending();
    return msg !== 'offline';
  }
}

// ---------------------------------------------------------------- recording

export type RecState = { on: boolean; paused: boolean; startedAt: number; elapsed: number; marks: number[]; error: string };
type Listener = () => void;
const recSubs = new Set<Listener>();
let rec: RecState = { on: false, paused: false, startedAt: 0, elapsed: 0, marks: [], error: '' };
const setRec = (p: Partial<RecState>): void => {
  rec = { ...rec, ...p };
  recSubs.forEach((f) => f());
};
export const recState = (): RecState => rec;
export const subscribeRec = (f: Listener): (() => void) => (recSubs.add(f), () => recSubs.delete(f));

let media: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let current: OutItem | null = null;
let seqNo = 0;
let writes: Promise<void> = Promise.resolve();
let ranAt = 0; // when the current un-paused stretch began
let banked = 0; // seconds recorded before the current stretch
let wake: { release(): Promise<void> } | null = null;
let ticker = 0;
const time = new Uint8Array(1024);
const freq = new Uint8Array(64);

export const elapsed = (): number => banked + (rec.on && !rec.paused ? (performance.now() - ranAt) / 1000 : 0);

/** Loudness and spectrum of what the microphone hears, for the orb. */
export const levels = (): { level: number; bands: Uint8Array } => {
  if (!analyser || rec.paused) return { level: 0, bands: freq.fill(0) };
  analyser.getByteTimeDomainData(time);
  let sum = 0;
  for (let i = 0; i < time.length; i++) sum += ((time[i] - 128) / 128) ** 2;
  analyser.getByteFrequencyData(freq);
  return { level: Math.min(1, Math.sqrt(sum / time.length) * 4.5), bands: freq };
};

const keepAwake = async (): Promise<void> => {
  try {
    wake = (await (navigator as any).wakeLock?.request('screen')) ?? null;
  } catch {
    wake = null;
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec.on) void keepAwake();
});
// A reload or swipe-away mid-recording: what was captured is already saved; it shows up in the outbox next time.
window.addEventListener('pagehide', () => {
  if (rec.on && current) void putRec({ ...current, duration: elapsed(), bookmarks: rec.marks });
});

const newId = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export async function startRecording(template: TemplateId): Promise<boolean> {
  if (rec.on) return true;
  setRec({ error: '' });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (err) {
    const name = (err as DOMException).name;
    setRec({ error: name === 'NotAllowedError' ? 'Hark needs the microphone. Allow it in your browser settings for this site, then try again.' : name === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not be opened (${name}).` });
    return false;
  }
  try {
    await db();
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    setRec({ error: 'This browser is blocking storage (private browsing?), so a recording could not be kept safely.' });
    return false;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  media = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const real = media.mimeType || mime || 'audio/mp4';
  current = { rid: newId(), createdAt: Date.now(), duration: 0, template, bookmarks: [], mime: real, ext: /mp4|aac|m4a/.test(real) ? 'm4a' : /ogg/.test(real) ? 'ogg' : 'webm', bytes: 0, state: 'recording' };
  seqNo = 0;
  writes = putRec(current);
  const item = current;
  media.ondataavailable = (e) => {
    if (!e.data.size) return;
    const n = seqNo++;
    item.bytes += e.data.size;
    item.duration = elapsed();
    writes = writes.then(() => putChunk(item.rid, n, e.data)).then(() => (n % 6 === 0 ? putRec({ ...item, bookmarks: rec.marks }) : undefined)).catch(() => setRec({ error: 'Your phone is out of storage. Stop now to keep what has been recorded.' }));
  };
  // A phone call or another app taking the microphone ends the track: keep what we have.
  stream.getAudioTracks()[0].onended = () => rec.on && void stopRecording();
  try {
    const AC: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    ctx.createMediaStreamSource(stream).connect(analyser);
    void ctx.resume();
  } catch {
    analyser = null; // the orb just stays calm
  }
  media.start(4000);
  banked = 0;
  ranAt = performance.now();
  void keepAwake();
  setRec({ on: true, paused: false, startedAt: item.createdAt, elapsed: 0, marks: [] });
  ticker = window.setInterval(() => setRec({ elapsed: elapsed() }), 250);
  return true;
}

export function togglePause(): void {
  if (!media || !rec.on) return;
  if (rec.paused) {
    media.resume();
    ranAt = performance.now();
    setRec({ paused: false });
  } else {
    banked = elapsed();
    media.pause();
    setRec({ paused: true, elapsed: banked });
  }
}

export const setTemplate = (t: TemplateId): void => {
  if (current) current.template = t;
};

export const bookmark = (): void => setRec({ marks: [...rec.marks, Math.round(elapsed() * 10) / 10] });

function teardown(): void {
  clearInterval(ticker);
  stream?.getTracks().forEach((t) => t.stop());
  void ctx?.close().catch(() => undefined);
  void wake?.release().catch(() => undefined);
  stream = null;
  ctx = null;
  analyser = null;
  wake = null;
  media = null;
}

/** Finish the recording. `keep: false` throws it away. */
export async function stopRecording(keep = true): Promise<void> {
  const m = media;
  const item = current;
  if (!m || !item || !rec.on) return;
  const total = elapsed();
  const marks = rec.marks;
  setRec({ on: false, paused: false, elapsed: total });
  current = null;
  await new Promise<void>((resolve) => {
    m.onstop = () => resolve();
    try {
      m.stop();
    } catch {
      resolve();
    }
    setTimeout(resolve, 3000);
  });
  teardown();
  await writes.catch(() => undefined);
  if (!keep || !item.bytes) {
    await drop(item.rid).catch(() => undefined);
    if (keep) toast('Nothing was recorded.', 'alert');
    return;
  }
  const finished: OutItem = { ...item, duration: total, bookmarks: marks, state: 'waiting' };
  await putRec(finished).catch(() => undefined);
  set((s) => ({ outbox: [finished, ...s.outbox] }));
  if (get().online) void flush();
  else if (groqKey()) (toast('Your Mac is out of reach, so this phone is writing the notes. They go to your Mac later.'), void processLocal(finished.rid));
  else toast('Saved on your phone. It will be sent when your Mac is in reach.');
}

/** Hand an existing audio or video file (a voice memo, say) to Hark. */
export async function addFile(file: File, template: TemplateId): Promise<void> {
  if (!token()) return;
  const ext = (file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? (file.type.includes('mp4') ? 'm4a' : 'bin')).toLowerCase();
  const item: OutItem = { rid: newId(), createdAt: file.lastModified || Date.now(), duration: 0, template, bookmarks: [], mime: file.type || 'application/octet-stream', ext, bytes: file.size, name: file.name, state: 'waiting' };
  try {
    await putRec(item);
    await putChunk(item.rid, 0, file);
  } catch {
    toast('That file could not be kept on the phone. Is storage full?', 'alert');
    return;
  }
  set((s) => ({ outbox: [item, ...s.outbox] }));
  if (get().online) void flush();
  else void processLocal(item.rid);
}
