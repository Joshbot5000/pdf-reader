/**
 * Who-said-what. Each sentence gets a voice fingerprint (a unit vector); fingerprints that
 * point the same way belong to the same person. Clusters form live while recording and are
 * tidied once at the end.
 */
export type Cluster = { id: string; sum: Float32Array; n: number; dur: number };

export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export const normalize = (v: ArrayLike<number>): Float32Array => {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
};

export const SAME_SPEAKER = 0.42; // similarity above which two fingerprints are one voice
export const SHORT_CLIP = 1.6; // seconds; shorter clips give shaky fingerprints
export const KNOWN_VOICE = 0.5; // similarity needed to recognise a remembered voice

export class SpeakerBook {
  clusters: Cluster[] = [];
  private next = 1;
  constructor(private maxSpeakers = 12) {}

  nearest(vec: ArrayLike<number>): { id: string; sim: number } | null {
    let best: { id: string; sim: number } | null = null;
    for (const c of this.clusters) {
      const sim = cosine(vec, c.sum);
      if (!best || sim > best.sim) best = { id: c.id, sim };
    }
    return best;
  }

  /** Returns the speaker id, or null when the clip is too short to tell (caller keeps the previous speaker). */
  assign(vec: ArrayLike<number>, dur: number): string | null {
    const v = normalize(vec);
    const best = this.nearest(v);
    const short = dur < SHORT_CLIP;
    if (best && best.sim >= SAME_SPEAKER) {
      if (!short || best.sim > 0.6) this.add(best.id, v, dur);
      return best.id;
    }
    if (short) return best && best.sim >= 0.28 ? best.id : null;
    if (this.clusters.length >= this.maxSpeakers) {
      this.add(best!.id, v, dur);
      return best!.id;
    }
    const id = `S${this.next++}`;
    this.clusters.push({ id, sum: Float32Array.from(v), n: 1, dur });
    return id;
  }

  private add(id: string, v: Float32Array, dur: number): void {
    const c = this.clusters.find((x) => x.id === id)!;
    const w = Math.min(dur, 6);
    for (let i = 0; i < v.length; i++) c.sum[i] += v[i] * w;
    c.n++;
    c.dur += dur;
  }

  centroid(id: string): Float32Array | null {
    const c = this.clusters.find((x) => x.id === id);
    return c ? normalize(c.sum) : null;
  }

  /**
   * End-of-recording tidy-up: merge clusters that turned out to be the same voice and fold
   * tiny stray clusters into their closest neighbour. Returns old id -> surviving id.
   */
  refine(): Map<string, string> {
    const map = new Map<string, string>();
    const merge = (from: Cluster, into: Cluster) => {
      for (let i = 0; i < into.sum.length; i++) into.sum[i] += from.sum[i];
      into.n += from.n;
      into.dur += from.dur;
      this.clusters = this.clusters.filter((c) => c !== from);
      map.set(from.id, into.id);
      for (const [k, v] of map) if (v === from.id) map.set(k, into.id);
    };
    for (;;) {
      let pair: [Cluster, Cluster] | null = null;
      let top = 0;
      for (let i = 0; i < this.clusters.length; i++)
        for (let j = i + 1; j < this.clusters.length; j++) {
          const a = this.clusters[i], b = this.clusters[j];
          const sim = cosine(a.sum, b.sum);
          const tiny = Math.min(a.dur, b.dur) < 2.5;
          if (sim > top && sim >= (tiny ? 0.3 : 0.58)) {
            top = sim;
            pair = a.dur >= b.dur ? [b, a] : [a, b];
          }
        }
      if (!pair) break;
      merge(pair[0], pair[1]);
    }
    return map;
  }
}
