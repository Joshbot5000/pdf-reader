/**
 * Audio in, attributed transcript out. The same session serves live recording (audio arrives
 * as it is spoken) and file import (audio arrives as fast as it can be decoded).
 */
import { EventEmitter } from 'node:events';
import { Segmenter, PeakMeter, type Segment } from '../shared/vad';
import { KNOWN_VOICE, SAME_SPEAKER, SHORT_CLIP, SpeakerBook, cosine } from '../shared/speakers';
import { joinWords, splitSentences } from '../shared/text';
import { SPEAKER_COLORS, uid } from '../shared/types';
import type { Para, Speaker, Voice, Word } from '../shared/types';

export type SpeechApi = {
  transcribe(pcm: Float32Array, language: string, words: boolean): Promise<{ text: string; words: Word[] }>;
  embedSpeaker(pcm: Float32Array): Promise<number[]>;
};

export type SessionOptions = { language: string; live: boolean; voices: Voice[]; diarize: boolean };

const SR = 16000;
const NON_SPEECH = /^[\[(（♪*].*[\])）♪*]$|^♪+$/;

export class TranscriptionSession extends EventEmitter {
  paras: Para[] = [];
  speakers: Speaker[] = [];
  readonly peaks = new PeakMeter();
  private seg = new Segmenter();
  private book = new SpeakerBook();
  private work: Promise<void> = Promise.resolve();
  private pendingJobs = 0;
  private partialBusy = false;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private lastPartialEnd = 0;
  private lastText = '';
  private repeats = 0;
  private ended = false;
  failed: Error | null = null;

  constructor(private api: SpeechApi, private opts: SessionOptions) {
    super();
    if (opts.live) this.partialTimer = setInterval(() => void this.partial(), 1200);
  }

  get duration(): number {
    return this.seg.time;
  }

  /** Utterances waiting to be transcribed (used to pace file imports). */
  get backlog(): number {
    return this.pendingJobs;
  }

  push(pcm: Float32Array): void {
    if (this.ended) return;
    this.peaks.push(pcm);
    for (const s of this.seg.push(pcm)) this.enqueue(s);
  }

  /** Close the current utterance now (pause button). */
  cut(): void {
    for (const s of this.seg.flush()) this.enqueue(s);
  }

  async idle(): Promise<void> {
    await this.work;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.partialTimer) clearInterval(this.partialTimer);
    this.cut();
    await this.work;
    this.finalize();
  }

  /** Voice fingerprint per speaker, for remembering people across conversations. */
  voiceprints(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const s of this.speakers) {
      const c = this.book.centroid(s.id);
      if (c) out[s.id] = Array.from(c, (x) => Math.round(x * 1e4) / 1e4);
    }
    return out;
  }

  private enqueue(s: Segment): void {
    this.pendingJobs++;
    this.work = this.work
      .then(() => this.process(s))
      .catch((err) => {
        this.failed = err instanceof Error ? err : new Error(String(err));
        this.emit('error', this.failed);
      })
      .finally(() => {
        this.pendingJobs--;
      });
  }

  private async partial(): Promise<void> {
    if (this.partialBusy || this.pendingJobs > 0 || this.ended) return;
    const p = this.seg.pending();
    if (!p || p.end - p.start < 1 || p.end - this.lastPartialEnd < 0.8) return;
    this.partialBusy = true;
    try {
      const { text } = await this.api.transcribe(p.pcm, this.opts.language, false);
      this.lastPartialEnd = p.end;
      if (!this.ended && this.pendingJobs === 0 && this.seg.pending()) this.emit('partial', clean(text));
    } catch {
      /* interim text is best-effort */
    } finally {
      this.partialBusy = false;
    }
  }

  private async process(s: Segment): Promise<void> {
    const res = await this.api.transcribe(s.pcm, this.opts.language, true);
    const dur = s.end - s.start;
    let words = res.words
      .filter((w) => !NON_SPEECH.test(w.t))
      .map((w) => ({ t: w.t, s: clamp(w.s, 0, dur), e: clamp(Math.max(w.e, w.s + 0.02), 0, dur) }));
    if (!words.length && clean(res.text)) {
      // No timings came back: spread the words evenly.
      const toks = clean(res.text).split(/\s+/);
      words = toks.map((t, i) => ({ t, s: (i / toks.length) * dur, e: ((i + 1) / toks.length) * dur }));
    }
    this.emit('partial', '');
    if (!words.length) return;

    // Whisper sometimes loops on the same line over noise: drop obvious repeats.
    const text = joinWords(words);
    if (text === this.lastText) {
      if (++this.repeats >= 2) return;
    } else {
      this.repeats = 0;
      this.lastText = text;
    }

    const sentences = splitSentences(words);
    const ids = await this.identifyAll(s.pcm, sentences);
    const changed: Para[] = [];
    sentences.forEach((sent, i) => {
      const sp = ids[i];
      const abs = sent.map((w) => ({ t: w.t, s: round(s.start + w.s), e: round(s.start + w.e) }));
      const last = this.paras[this.paras.length - 1];
      if (last && last.sp === sp && abs[0].s - last.e < 2 && last.words.length < 90) {
        last.words.push(...abs);
        last.e = abs[abs.length - 1].e;
        last.text = joinWords(last.words);
        if (!changed.includes(last)) changed.push(last);
      } else {
        const p: Para = { id: uid(), sp, s: abs[0].s, e: abs[abs.length - 1].e, text: joinWords(abs), words: abs };
        this.paras.push(p);
        changed.push(p);
      }
    });
    this.recognise();
    this.emit('paras', changed, false);
  }

  /**
   * Decide who spoke each sentence of one utterance. Long sentences get a reliable voice
   * fingerprint and are settled first. Short ones ("Great.", "Sounds good.") are judged against
   * the voices already known, and otherwise lean on timing: a short remark after a pause that
   * runs straight into the next sentence belongs to whoever speaks next.
   */
  private async identifyAll(pcm: Float32Array, sentences: Word[][]): Promise<string[]> {
    const before = this.paras[this.paras.length - 1]?.sp;
    if (!this.opts.diarize) return sentences.map(() => this.ensureSpeaker('S1'));
    const total = pcm.length / SR;
    const info = await Promise.all(
      sentences.map(async (sent) => {
        const a = sent[0].s, b = sent[sent.length - 1].e;
        // Fingerprint at least 0.8 s of audio, centred on the sentence.
        const extra = Math.max(0.05, (0.8 - (b - a)) / 2);
        const from = Math.max(0, Math.floor((a - extra) * SR));
        const to = Math.min(pcm.length, Math.ceil((b + extra) * SR));
        let vec: number[] | null = null;
        if (to - from >= SR * 0.4) vec = await this.api.embedSpeaker(pcm.subarray(from, to)).catch(() => null);
        return { a, b, dur: b - a, vec };
      }),
    );
    const ids: (string | null)[] = sentences.map(() => null);
    info.forEach((s, i) => {
      if (s.vec && s.dur >= SHORT_CLIP) ids[i] = this.book.assign(s.vec, s.dur);
    });
    for (let i = info.length - 1; i >= 0; i--) {
      if (ids[i]) continue;
      const s = info[i];
      let prev = before;
      for (let j = i - 1; j >= 0; j--) if (ids[j]) { prev = ids[j]!; break; }
      const next = ids[i + 1] ?? null;
      const gapBefore = i > 0 ? s.a - info[i - 1].b : s.a + (this.paras.length ? 0.3 : 0);
      const gapAfter = i + 1 < info.length ? info[i + 1].a - s.b : total - s.b + 0.6;
      let id: string | null = null;
      if (s.vec) {
        const best = this.book.nearest(s.vec);
        const prevC = prev ? this.book.centroid(prev) : null;
        const simPrev = prevC ? cosine(s.vec, prevC) : -1;
        if (best && best.sim >= SAME_SPEAKER) id = best.id;
        else if (best && best.id !== prev && best.sim >= 0.25 && best.sim >= simPrev + 0.1) id = best.id;
        else if (next && next !== prev && gapAfter < 0.6 && (gapBefore >= 0.45 || simPrev < 0.15)) id = next;
      } else if (next && next !== prev && gapAfter < gapBefore) id = next;
      id ??= prev ?? next ?? (s.vec ? this.book.assign(s.vec, SHORT_CLIP) : 'S1');
      ids[i] = id;
    }
    return ids.map((id) => this.ensureSpeaker(id ?? 'S1'));
  }

  private ensureSpeaker(id: string): string {
    if (!this.speakers.some((s) => s.id === id)) {
      const used = new Set(this.speakers.map((s) => s.color));
      let color = 0;
      while (used.has(color) && color < SPEAKER_COLORS) color++;
      this.speakers.push({ id, name: `Speaker ${this.speakers.length + 1}`, color: color % SPEAKER_COLORS });
    }
    return id;
  }

  /** Put names to voices the user has named before. */
  private recognise(): void {
    if (!this.opts.voices.length) return;
    const taken = new Set(this.speakers.map((s) => s.voiceId).filter(Boolean));
    for (const sp of this.speakers) {
      if (sp.voiceId) continue;
      const c = this.book.clusters.find((x) => x.id === sp.id);
      if (!c || c.dur < 3) continue;
      let best: Voice | null = null;
      let top = KNOWN_VOICE;
      for (const v of this.opts.voices) {
        if (taken.has(v.id) || v.vec.length !== c.sum.length) continue;
        const sim = cosine(c.sum, v.vec);
        if (sim > top) {
          top = sim;
          best = v;
        }
      }
      if (best) {
        sp.name = best.name;
        sp.voiceId = best.id;
        sp.named = true;
        taken.add(best.id);
      }
    }
  }

  private finalize(): void {
    const map = this.book.refine();
    const resolve = (id: string) => map.get(id) ?? id;
    const merged: Para[] = [];
    for (const p of this.paras) {
      p.sp = resolve(p.sp);
      const last = merged[merged.length - 1];
      if (last && last.sp === p.sp && p.s - last.e < 2 && last.words.length < 90) {
        last.words.push(...p.words);
        last.e = p.e;
        last.text = joinWords(last.words);
      } else merged.push(p);
    }
    this.paras = merged;
    const alive = new Set(merged.map((p) => p.sp));
    this.speakers = this.speakers.filter((s) => alive.has(s.id));
    this.recognise();
    let n = 1;
    for (const s of this.speakers) if (!s.named) s.name = `Speaker ${n++}`;
    this.emit('paras', this.paras, true);
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round = (v: number): number => Math.round(v * 100) / 100;
const clean = (t: string): string => t.replace(/[\[(][^\])]{0,40}[\])]/g, '').replace(/\s+/g, ' ').trim();
