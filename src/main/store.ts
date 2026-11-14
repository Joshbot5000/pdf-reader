/** The library on disk: one folder per conversation, plain JSON, nothing leaves the machine. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, uid } from '../shared/types';
import type { ChatMsg, Meeting, Para, SearchHit, Settings, Voice } from '../shared/types';
import { speakerName } from '../shared/text';

export type VectorChunk = { s: number; e: number; text: string; paraId: string; v: number[] };

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (file: string, data: unknown): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};

export class Library {
  private meetings = new Map<string, Meeting>();
  private transcripts = new Map<string, Para[]>();
  private vectorCache = new Map<string, VectorChunk[]>();
  private root: string;
  /** Called whenever a conversation's metadata changes, so the window can stay in sync. */
  onChange: ((m: Meeting) => void) | null = null;

  constructor(readonly dir: string) {
    this.root = path.join(dir, 'conversations');
    fs.mkdirSync(this.root, { recursive: true });
    for (const id of fs.readdirSync(this.root)) {
      const m = readJson<Meeting | null>(path.join(this.root, id, 'meeting.json'), null);
      if (!m) continue;
      // Anything still "in progress" was interrupted by a quit or crash: keep what was captured.
      if (m.status === 'recording' || m.status === 'processing') {
        const has = this.transcript(id).length > 0;
        m.status = has ? 'ready' : 'error';
        if (!has) m.error = 'This recording was interrupted before anything was transcribed.';
        m.progress = undefined;
      }
      if (m.summaryState === 'running') m.summaryState = undefined;
      this.meetings.set(id, m);
    }
  }

  folder(id: string): string {
    return path.join(this.root, id);
  }

  audioPath(id: string): string {
    return path.join(this.folder(id), 'audio.webm');
  }

  list(): Meeting[] {
    return [...this.meetings.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Meeting {
    const m = this.meetings.get(id);
    if (!m) throw new Error('Conversation not found');
    return m;
  }

  has(id: string): boolean {
    return this.meetings.has(id);
  }

  create(init: Partial<Meeting>): Meeting {
    const id = uid();
    const m: Meeting = {
      id, title: 'Untitled conversation', titleAuto: true, createdAt: Date.now(), duration: 0, source: 'mic', status: 'recording',
      speakers: [], chat: [], notes: '', peaks: [], words: 0, preview: '', template: 'meeting', bookmarks: [], hasAudio: false,
      ...init,
    };
    fs.mkdirSync(this.folder(id), { recursive: true });
    this.meetings.set(id, m);
    this.persist(id);
    return m;
  }

  update(id: string, patch: Partial<Meeting>): Meeting {
    const m = Object.assign(this.get(id), patch);
    this.persist(id);
    return m;
  }

  private persist(id: string): void {
    const m = this.meetings.get(id)!;
    writeJson(path.join(this.folder(id), 'meeting.json'), m);
    this.onChange?.(m);
  }

  remove(id: string): void {
    this.meetings.delete(id);
    this.transcripts.delete(id);
    this.vectorCache.delete(id);
    fs.rmSync(this.folder(id), { recursive: true, force: true });
  }

  transcript(id: string): Para[] {
    let t = this.transcripts.get(id);
    if (!t) {
      t = readJson<Para[]>(path.join(this.root, id, 'transcript.json'), []);
      this.transcripts.set(id, t);
    }
    return t;
  }

  saveTranscript(id: string, paras: Para[]): void {
    this.transcripts.set(id, paras);
    writeJson(path.join(this.folder(id), 'transcript.json'), paras);
    const m = this.meetings.get(id);
    if (m) {
      m.words = paras.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
      m.preview = paras.map((p) => p.text).join(' ').slice(0, 220);
      this.persist(id);
    }
  }

  vectors(id: string): VectorChunk[] {
    let v = this.vectorCache.get(id);
    if (!v) {
      v = readJson<VectorChunk[]>(path.join(this.root, id, 'vectors.json'), []);
      this.vectorCache.set(id, v);
    }
    return v;
  }

  saveVectors(id: string, v: VectorChunk[]): void {
    this.vectorCache.set(id, v);
    writeJson(path.join(this.folder(id), 'vectors.json'), v);
  }

  voiceprints(id: string): Record<string, number[]> {
    return readJson(path.join(this.root, id, 'voiceprints.json'), {});
  }

  saveVoiceprints(id: string, v: Record<string, number[]>): void {
    writeJson(path.join(this.folder(id), 'voiceprints.json'), v);
  }

  settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(path.join(this.dir, 'settings.json'), {}) };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const s = { ...this.settings(), ...patch };
    writeJson(path.join(this.dir, 'settings.json'), s);
    return s;
  }

  hasSettings(): boolean {
    return fs.existsSync(path.join(this.dir, 'settings.json'));
  }

  voices(): Voice[] {
    return readJson<Voice[]>(path.join(this.dir, 'voices.json'), []);
  }

  saveVoices(v: Voice[]): void {
    writeJson(path.join(this.dir, 'voices.json'), v);
  }

  askHistory(): ChatMsg[] {
    return readJson<ChatMsg[]>(path.join(this.dir, 'ask.json'), []);
  }

  saveAskHistory(msgs: ChatMsg[]): void {
    writeJson(path.join(this.dir, 'ask.json'), msgs.slice(-60));
  }

  /** Exact-phrase / all-words search over every transcript and title. */
  search(query: string, limit = 40): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const hits: (SearchHit & { score: number })[] = [];
    for (const m of this.list()) {
      if (m.title.toLowerCase().includes(q)) {
        hits.push({ meetingId: m.id, title: m.title, date: m.createdAt, paraId: '', t: 0, speaker: '', snippet: m.summary?.overview || m.preview, score: 3 });
      }
      for (const p of this.transcript(m.id)) {
        const low = p.text.toLowerCase();
        const phrase = low.indexOf(q);
        if (phrase < 0 && !terms.every((t) => low.includes(t))) continue;
        const at = phrase >= 0 ? phrase : low.indexOf(terms[0]);
        const from = Math.max(0, at - 60);
        const snippet = (from > 0 ? '…' : '') + p.text.slice(from, at + q.length + 100) + (at + q.length + 100 < p.text.length ? '…' : '');
        // Jump to the matching word rather than the top of the paragraph.
        const before = p.text.slice(0, at).split(/\s+/).filter(Boolean).length;
        const t = p.words[Math.min(before, p.words.length - 1)]?.s ?? p.s;
        hits.push({ meetingId: m.id, title: m.title, date: m.createdAt, paraId: p.id, t, speaker: speakerName(m.speakers, p.sp), snippet, score: phrase >= 0 ? 2 : 1 });
      }
    }
    return hits.sort((a, b) => b.score - a.score || b.date - a.date).slice(0, limit).map(({ score: _s, ...h }) => h);
  }
}
