/**
 * Streaming voice-activity segmenter. Audio goes in as 16 kHz mono chunks of any size;
 * utterances come out cut at natural pauses, so each one can be transcribed on its own.
 * Energy-based with an adaptive noise floor: no model needed, costs nothing to run.
 */
export type Segment = { start: number; end: number; pcm: Float32Array };

export type VadOptions = { sampleRate?: number; maxLen?: number; minSilence?: number; minSpeech?: number; pad?: number };

const FRAME_SEC = 0.02;

export class Segmenter {
  private sr: number;
  private frame: number;
  private maxLen: number;
  private minSilence: number;
  private minSpeech: number;
  private pad: number;

  private buf: Float32Array[] = [];
  private bufStart = 0; // absolute sample index of buf[0][0]
  private bufLen = 0;
  private carry = new Float32Array(0); // samples not yet framed
  private consumed = 0; // absolute samples framed so far

  private floor = 0.002;
  private inSpeech = false;
  private speechStart = 0; // absolute sample
  private lastVoiced = 0; // absolute sample just after the last voiced frame
  private voicedRun = 0;
  private voicedFrames = 0;
  private frameLog: { at: number; rms: number }[] = []; // frames of the current utterance
  private recentMin: number[] = [];

  constructor(o: VadOptions = {}) {
    this.sr = o.sampleRate ?? 16000;
    this.frame = Math.round(this.sr * FRAME_SEC);
    this.maxLen = o.maxLen ?? 24;
    this.minSilence = o.minSilence ?? 0.6;
    this.minSpeech = o.minSpeech ?? 0.3;
    this.pad = o.pad ?? 0.22;
  }

  /** Seconds of audio seen so far. */
  get time(): number {
    return (this.consumed + this.carry.length) / this.sr;
  }

  push(chunk: Float32Array): Segment[] {
    const out: Segment[] = [];
    if (!chunk.length) return out;
    this.buf.push(chunk);
    this.bufLen += chunk.length;

    let data: Float32Array;
    if (this.carry.length) {
      data = new Float32Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    } else data = chunk;

    let i = 0;
    for (; i + this.frame <= data.length; i += this.frame) {
      let sum = 0;
      for (let j = i; j < i + this.frame; j++) sum += data[j] * data[j];
      const seg = this.step(Math.sqrt(sum / this.frame));
      if (seg) out.push(seg);
    }
    this.carry = data.slice(i);
    if (!this.inSpeech) this.trim(this.consumed - Math.round(this.sr * 0.5));
    return out;
  }

  /** Close whatever is in progress (end of recording). */
  flush(): Segment[] {
    if (!this.inSpeech) return [];
    const seg = this.close(Math.min(this.consumed, this.lastVoiced + Math.round(this.pad * this.sr)));
    return seg ? [seg] : [];
  }

  /** The utterance currently being spoken, for interim "live" text. */
  pending(): Segment | null {
    if (!this.inSpeech) return null;
    return { start: this.speechStart / this.sr, end: this.consumed / this.sr, pcm: this.slice(this.speechStart, this.consumed) };
  }

  private step(rms: number): Segment | null {
    const at = this.consumed;
    this.consumed += this.frame;
    const hi = Math.max(0.0075, this.floor * 3.4);
    const lo = Math.max(0.005, this.floor * 2.1);

    if (!this.inSpeech) {
      if (rms > hi) {
        this.voicedRun++;
        if (this.voicedRun >= 3) {
          this.inSpeech = true;
          const begin = at - (this.voicedRun - 1) * this.frame - Math.round(this.pad * this.sr);
          this.speechStart = Math.max(this.bufStart, begin, 0);
          this.lastVoiced = this.consumed;
          this.voicedFrames = this.voicedRun;
          this.frameLog = [];
          this.recentMin = [];
        }
      } else {
        this.voicedRun = 0;
        this.floor = Math.min(0.05, this.floor * 0.97 + rms * 0.03);
      }
      return null;
    }

    this.frameLog.push({ at, rms });
    if (rms > lo) {
      this.lastVoiced = this.consumed;
      this.voicedFrames++;
    }
    // If the quietest frame over the last 3 s is well above the floor, the room just got noisier.
    this.recentMin.push(rms);
    if (this.recentMin.length >= 150) {
      const min = Math.min(...this.recentMin);
      if (min > this.floor * 1.5) this.floor = Math.min(0.05, min);
      this.recentMin = [];
    }

    const silence = (this.consumed - this.lastVoiced) / this.sr;
    if (silence >= this.minSilence) {
      return this.close(this.lastVoiced + Math.round(this.pad * this.sr));
    }
    if ((this.consumed - this.speechStart) / this.sr >= this.maxLen) {
      // No pause for a long time: cut at the quietest moment of the last few seconds.
      const from = this.consumed - Math.round(this.sr * 7);
      let best = this.frameLog[this.frameLog.length - 1];
      for (const f of this.frameLog) if (f.at >= from && f.rms < best.rms) best = f;
      const cut = best.at + Math.round(this.frame / 2);
      const seg = this.close(cut, true);
      // Keep going from the cut point as a new utterance.
      this.inSpeech = true;
      this.speechStart = cut;
      this.lastVoiced = this.consumed;
      this.voicedFrames = Math.round((this.consumed - cut) / this.frame);
      this.frameLog = this.frameLog.filter((f) => f.at >= cut);
      this.recentMin = [];
      return seg;
    }
    return null;
  }

  private close(end: number, forced = false): Segment | null {
    const start = this.speechStart;
    end = Math.max(start, Math.min(end, this.bufStart + this.bufLen));
    const voiced = this.voicedFrames * FRAME_SEC;
    this.inSpeech = false;
    this.voicedRun = 0;
    this.voicedFrames = 0;
    if (!forced && voiced < this.minSpeech) return null;
    if (end - start < this.sr * 0.2) return null;
    return { start: start / this.sr, end: end / this.sr, pcm: this.slice(start, end) };
  }

  private slice(from: number, to: number): Float32Array {
    from = Math.max(from, this.bufStart);
    to = Math.min(to, this.bufStart + this.bufLen);
    const out = new Float32Array(Math.max(0, to - from));
    let pos = this.bufStart;
    for (const c of this.buf) {
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + c.length);
      if (b > a) out.set(c.subarray(a - pos, b - pos), a - from);
      pos += c.length;
      if (pos >= to) break;
    }
    return out;
  }

  private trim(before: number): void {
    while (this.buf.length > 1 && this.bufStart + this.buf[0].length <= before) {
      const c = this.buf.shift()!;
      this.bufStart += c.length;
      this.bufLen -= c.length;
    }
  }
}

/** Peak level per bucket, for drawing waveforms. */
export class PeakMeter {
  peaks: number[] = [];
  private acc = 0;
  private n = 0;
  constructor(private bucket = 1600) {}
  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.abs(chunk[i]);
      if (v > this.acc) this.acc = v;
      if (++this.n >= this.bucket) {
        this.peaks.push(Math.round(Math.min(1, this.acc) * 100) / 100);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  /** At most `max` buckets, keeping the tallest peak of each group. */
  compact(max = 1200): number[] {
    if (this.peaks.length <= max) return this.peaks.slice();
    const step = this.peaks.length / max;
    const out: number[] = [];
    for (let i = 0; i < max; i++) {
      let m = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, this.peaks[j] ?? 0);
      out.push(m);
    }
    return out;
  }
}
