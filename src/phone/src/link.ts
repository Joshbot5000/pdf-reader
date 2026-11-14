/** The phone's line to Hark on the Mac: one live connection, the library it mirrors, and a small store. */
import { useSyncExternalStore } from 'react';
import type { ChatMsg, EngineStatus, LiveEvent, Meeting, Para, Source, Speaker, StreamEvent } from '../../shared/types';

export type Stream = { text: string; running: boolean; error?: string; sources?: Source[]; stage?: string };
export type Toast = { id: number; text: string; tone: 'info' | 'alert' };
export type Tab = 'library' | 'tasks' | 'ask';
/** A recording that lives on the phone until the Mac has it. */
export type OutItem = {
  rid: string; createdAt: number; duration: number; template: Meeting['template']; bookmarks: number[]; mime: string; ext: string; bytes: number; name?: string;
  state: 'recording' | 'waiting' | 'sending'; sent?: number; error?: string;
};

export type State = {
  paired: boolean;
  online: boolean;
  booted: boolean;
  meetings: Meeting[];
  transcripts: Record<string, Para[]>;
  liveSpeakers: Record<string, Speaker[]>;
  progress: Record<string, number>;
  streams: Record<string, Stream>;
  status: EngineStatus | null;
  ask: ChatMsg[];
  userName: string;
  notes: boolean;
  outbox: OutItem[];
  tab: Tab;
  open: string | null;
  seek: { t: number; n: number } | null;
  recorder: boolean;
  sheet: null | 'link';
  toasts: Toast[];
};

let state: State = {
  paired: false, online: false, booted: false, meetings: [], transcripts: {}, liveSpeakers: {}, progress: {}, streams: {}, status: null, ask: [],
  userName: '', notes: true, outbox: [], tab: 'library', open: null, seek: null, recorder: false, sheet: null, toasts: [],
};
const subs = new Set<() => void>();
export const get = (): State => state;
export const set = (patch: Partial<State> | ((s: State) => Partial<State>)): void => {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach((f) => f());
};
export function useLink<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((cb) => (subs.add(cb), () => subs.delete(cb)), () => sel(state));
}

let toastId = 1;
export const toast = (text: string, tone: Toast['tone'] = 'info'): void => {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
};

// ---- pairing key. It stays in the address so "Add to Home Screen" carries it into the installed app.
const params = new URLSearchParams(location.search);
const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the key in the address still works */
    }
  },
};
const fromUrl = params.get('k');
if (fromUrl) store.set('hark.k', fromUrl);
export const token = (): string => fromUrl ?? store.get('hark.k') ?? '';
if (token() && !fromUrl) {
  params.set('k', token());
  history.replaceState(null, '', `${location.pathname}?${params}`);
}
state.paired = !!token();
export const withKey = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(token())}`;
export const audioUrl = (id: string): string => withKey(`./audio/${id}`);

if (token()) {
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = withKey('./manifest.webmanifest');
  document.head.appendChild(link);
}

// ---- cache: show the library instantly, and when the Mac is out of reach.
const slim = (m: Meeting): Meeting => ({ ...m, peaks: [], chat: m.chat.slice(-6) });
let cacheTimer = 0;
const saveCache = (): void => {
  clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => store.set('hark.cache', JSON.stringify({ meetings: state.meetings.slice(0, 80).map(slim), userName: state.userName, notes: state.notes })), 600);
};
export function restoreCache(): void {
  try {
    const c = JSON.parse(store.get('hark.cache') ?? 'null');
    if (c) set({ meetings: c.meetings ?? [], userName: c.userName ?? '', notes: c.notes ?? true });
  } catch {
    /* no cache */
  }
}

// ---- connection
let ws: WebSocket | null = null;
let seq = 1;
let retry = 500;
const waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const onlineHooks = new Set<() => void>();
export const whenOnline = (fn: () => void): void => void onlineHooks.add(fn);

export function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("Can't reach Hark on your Mac right now."));
    const id = seq++;
    waits.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, args }));
  });
}
/** Run a call; surface any failure as a toast. */
export const run = <T,>(p: Promise<T>): Promise<T | undefined> =>
  p.catch((e: Error) => {
    toast(e.message, 'alert');
    return undefined;
  });

const sortMeetings = (list: Meeting[]): Meeting[] => [...list].sort((a, b) => b.createdAt - a.createdAt);

async function boot(): Promise<void> {
  const b = await call<{ meetings: Meeting[]; status: EngineStatus; ask: ChatMsg[]; userName: string; notes: boolean }>('boot');
  set({ meetings: sortMeetings(b.meetings), status: b.status, ask: b.ask, userName: b.userName, notes: b.notes, booted: true });
  saveCache();
  const open = state.open;
  if (open && b.meetings.some((m) => m.id === open)) void loadTranscript(open, true);
}

export function connect(): void {
  if (!token()) return;
  const dev = params.get('port');
  const host = dev ? `${location.hostname}:${dev}` : location.host;
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws?k=${encodeURIComponent(token())}`);
  } catch {
    setTimeout(connect, 3000);
    return;
  }
  ws = sock;
  sock.onopen = () => {
    retry = 500;
    set({ online: true });
    void boot().then(() => onlineHooks.forEach((f) => f())).catch(() => undefined);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    set((s) => ({ online: false, streams: Object.fromEntries(Object.entries(s.streams).map(([k, v]) => [k, v.running ? { ...v, running: false, error: 'The connection to your Mac dropped.' } : v])) }));
    for (const w of waits.values()) w.reject(new Error('Lost the connection to your Mac.'));
    waits.clear();
    setTimeout(connect, retry);
    retry = Math.min(retry * 1.7, 6000);
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined) {
      const w = waits.get(msg.id);
      waits.delete(msg.id);
      if (w) msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
      return;
    }
    handle(msg.event, msg.data);
  };
}
// Coming back to the app: reconnect at once instead of waiting out the retry timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token() && (!ws || ws.readyState > 1)) connect();
});

function handle(event: string, data: any): void {
  if (event === 'meeting') {
    const m = data as Meeting;
    set((s) => ({ meetings: s.meetings.some((x) => x.id === m.id) ? s.meetings.map((x) => (x.id === m.id ? m : x)) : sortMeetings([m, ...s.meetings]) }));
    saveCache();
  } else if (event === 'meetingDeleted') {
    set((s) => ({ meetings: s.meetings.filter((m) => m.id !== data), open: s.open === data ? null : s.open }));
    saveCache();
  } else if (event === 'status') set({ status: data });
  else if (event === 'live') {
    const e = data as LiveEvent;
    if (e.type === 'progress') set((s) => ({ progress: { ...s.progress, [e.meetingId]: e.progress } }));
    else if (e.type === 'paras')
      set((s) => {
        // Only keep transcripts the phone is actually looking at.
        if (s.open !== e.meetingId && !s.transcripts[e.meetingId]) return { liveSpeakers: { ...s.liveSpeakers, [e.meetingId]: e.speakers } };
        let paras = e.paras;
        if (!e.replace) {
          const cur = s.transcripts[e.meetingId] ?? [];
          const byId = new Map(e.paras.map((p) => [p.id, p]));
          paras = cur.map((p) => byId.get(p.id) ?? p);
          const known = new Set(cur.map((p) => p.id));
          for (const p of e.paras) if (!known.has(p.id)) paras.push(p);
        }
        return { transcripts: { ...s.transcripts, [e.meetingId]: paras }, liveSpeakers: { ...s.liveSpeakers, [e.meetingId]: e.speakers } };
      });
  } else if (event === 'stream') {
    const e = data as StreamEvent;
    set((s) => {
      const cur = s.streams[e.streamId] ?? { text: '', running: true };
      return {
        streams: {
          ...s.streams,
          [e.streamId]: { ...cur, text: cur.text + (e.delta ?? ''), stage: e.stage ?? (e.delta ? undefined : cur.stage), sources: e.sources ?? cur.sources, running: !(e.done || e.error), error: e.error },
        },
      };
    });
  }
}

export const startStream = (id: string): void => set((s) => ({ streams: { ...s.streams, [id]: { text: '', running: true } } }));
export const clearStream = (id: string): void =>
  set((s) => {
    const streams = { ...s.streams };
    delete streams[id];
    return { streams };
  });

export async function loadTranscript(id: string, force = false): Promise<void> {
  if (!force && state.transcripts[id]) return;
  const paras = await run(call<Para[]>('getTranscript', id));
  if (paras) set((s) => ({ transcripts: { ...s.transcripts, [id]: paras } }));
}

export const openMeeting = (id: string, t?: number): void => {
  set((s) => ({ open: id, seek: t !== undefined ? { t, n: (s.seek?.n ?? 0) + 1 } : null }));
  history.pushState({ hark: 'meeting' }, '');
  void loadTranscript(id, true);
};
export const closeMeeting = (): void => {
  if (history.state?.hark) history.back();
  else set({ open: null });
};
window.addEventListener('popstate', () => set({ open: null, sheet: null }));

export const speakersOf = (m: Meeting, s: State): Speaker[] => (m.status === 'ready' ? m.speakers : s.liveSpeakers[m.id] ?? m.speakers);
export const haptic = (ms = 8): void => void navigator.vibrate?.(ms);
