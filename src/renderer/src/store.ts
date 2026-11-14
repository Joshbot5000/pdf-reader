import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { ChatMsg, DownloadState, EngineStatus, Meeting, ModelInfo, Para, Settings, Source, Speaker } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';

export type View =
  | { name: 'home'; folder?: string; starred?: boolean }
  | { name: 'ask' }
  | { name: 'tasks' }
  | { name: 'record' }
  | { name: 'meeting'; id: string; t?: number; tab?: string };

export type Stream = { text: string; running: boolean; stage?: string; error?: string; sources?: Source[] };
export type Toast = { id: number; text: string; kind: 'info' | 'error' | 'ok' };
export type RecState = { id: string; paused: boolean; elapsed: number; system: boolean };

export type State = {
  ready: boolean;
  platform: string;
  version: string;
  settings: Settings;
  meetings: Meeting[];
  models: ModelInfo[];
  status: EngineStatus;
  downloads: Record<string, DownloadState>;
  view: View;
  transcripts: Record<string, Para[]>;
  liveSpeakers: Record<string, Speaker[]>;
  partial: Record<string, string>;
  progress: Record<string, number>;
  streams: Record<string, Stream>;
  ask: ChatMsg[];
  rec: RecState | null;
  toasts: Toast[];
  palette: boolean;
  settingsOpen: false | 'general' | 'models' | 'voices';
};

let state: State = {
  ready: false, platform: 'darwin', version: '', settings: DEFAULT_SETTINGS, meetings: [], models: [],
  status: { asr: 'missing', llm: 'missing', ramGb: 8 }, downloads: {}, view: { name: 'home' }, transcripts: {}, liveSpeakers: {},
  partial: {}, progress: {}, streams: {}, ask: [], rec: null, toasts: [], palette: false, settingsOpen: false,
};
const listeners = new Set<() => void>();

export const get = (): State => state;
export const set = (patch: Partial<State> | ((s: State) => Partial<State>)): void => {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
};
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

let toastId = 1;
export const toast = (text: string, kind: Toast['kind'] = 'info'): void => {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
};
/** Run an action; surface any failure as a toast instead of an unhandled rejection. */
export const run = async <T,>(p: Promise<T> | (() => Promise<T>)): Promise<T | undefined> => {
  try {
    return await (typeof p === 'function' ? p() : p);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return undefined;
  }
};

export const go = (view: View): void => set({ view, palette: false });

const upsertMeeting = (m: Meeting): void =>
  set((s) => {
    const i = s.meetings.findIndex((x) => x.id === m.id);
    const meetings = i >= 0 ? s.meetings.map((x) => (x.id === m.id ? m : x)) : [m, ...s.meetings];
    return { meetings: meetings.sort((a, b) => b.createdAt - a.createdAt) };
  });

export async function loadTranscript(id: string, force = false): Promise<void> {
  if (!force && state.transcripts[id]) return;
  const paras = await api.getTranscript(id);
  set((s) => ({ transcripts: { ...s.transcripts, [id]: paras } }));
}

export async function boot(): Promise<void> {
  const b = await api.boot();
  set({
    ready: true, platform: b.platform, version: b.version, settings: b.settings, meetings: b.meetings, models: b.models, status: b.status, ask: b.ask,
    downloads: Object.fromEntries(b.downloads.map((d) => [d.id, d])),
  });
  window.hark.on('meeting', upsertMeeting);
  window.hark.on('meetingDeleted', (id) =>
    set((s) => ({ meetings: s.meetings.filter((m) => m.id !== id), view: s.view.name === 'meeting' && s.view.id === id ? { name: 'home' } : s.view })),
  );
  window.hark.on('status', (status) => set({ status }));
  window.hark.on('models', (models) => set({ models }));
  window.hark.on('download', (d) =>
    set((s) => {
      const downloads = { ...s.downloads, [d.id]: d };
      if (d.done || d.error === 'Cancelled') delete downloads[d.id];
      return { downloads };
    }),
  );
  window.hark.on('live', (e) => {
    if (e.type === 'partial') set((s) => ({ partial: { ...s.partial, [e.meetingId]: e.text } }));
    else if (e.type === 'progress') set((s) => ({ progress: { ...s.progress, [e.meetingId]: e.progress } }));
    else
      set((s) => {
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
  });
  window.hark.on('stream', (e) =>
    set((s) => {
      const cur = s.streams[e.streamId] ?? { text: '', running: true };
      const next: Stream = {
        ...cur,
        text: cur.text + (e.delta ?? ''),
        stage: e.stage ?? (e.delta ? undefined : cur.stage),
        sources: e.sources ?? cur.sources,
        running: !(e.done || e.error),
        error: e.error,
      };
      return { streams: { ...s.streams, [e.streamId]: next } };
    }),
  );
}

export const startStream = (id: string): void => set((s) => ({ streams: { ...s.streams, [id]: { text: '', running: true } } }));
export const clearStream = (id: string): void =>
  set((s) => {
    const streams = { ...s.streams };
    delete streams[id];
    return { streams };
  });

export const saveSettings = async (patch: Partial<Settings>): Promise<void> => {
  set((s) => ({ settings: { ...s.settings, ...patch } }));
  const settings = await api.saveSettings(patch);
  set({ settings });
};

export const speakersOf = (m: Meeting, s: State): Speaker[] => (m.status === 'ready' ? m.speakers : s.liveSpeakers[m.id] ?? m.speakers);
