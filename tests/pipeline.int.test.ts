/** Integration: real models, real audio. Needs HARK_MODELS_DIR with models installed; skipped otherwise. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptionSession, type SpeechApi } from '../src/main/pipeline';
import { speechHandlers as h } from '../src/workers/speechCore';
import { Models, CATALOG } from '../src/main/models';

const dir = process.env.HARK_MODELS_DIR;
const wavPath = process.env.HARK_TEST_WAV;
const asrId = process.env.HARK_ASR ?? 'whisper-base';

const readWav = (file: string): Float32Array => {
  const b = fs.readFileSync(file);
  const at = b.indexOf('data') + 8;
  const i16 = new Int16Array(b.buffer.slice(b.byteOffset + at, b.byteOffset + b.length - ((b.length - at) % 2)));
  return Float32Array.from(i16, (v) => v / 32768);
};

describe.skipIf(!dir || !wavPath)('pipeline with real models', () => {
  it('downloads missing models, transcribes and separates three speakers', async () => {
    const models = new Models(dir!, (url, init) => fetch(url, init));
    for (const id of [asrId, 'speaker', 'embed']) {
      if (!models.installed(id)) await models.download(id);
      expect(models.installed(id), id).toBe(true);
    }
    await h.init({ modelsDir: dir! });
    await h.loadAsr({ repo: CATALOG.find((c) => c.id === asrId)!.repo });
    const api: SpeechApi = {
      transcribe: (pcm, language, words) => h.transcribe({ pcm, language, words }) as never,
      embedSpeaker: (pcm) => h.embedSpeaker({ pcm }) as never,
    };
    const audio = readWav(wavPath!);
    const session = new TranscriptionSession(api, { language: 'en', live: false, voices: [], diarize: true });
    const t0 = Date.now();
    for (let i = 0; i < audio.length; i += 4000) {
      session.push(audio.subarray(i, i + 4000));
      while (session.backlog > 3) await session.idle();
    }
    await session.end();
    const secs = (Date.now() - t0) / 1000;
    const out = session.paras.map((p) => `${p.sp} [${p.s.toFixed(1)}-${p.e.toFixed(1)}] ${p.text}`).join('\n');
    fs.writeFileSync(path.join(dir!, '..', `pipeline-${asrId}.txt`), `${secs}s for ${session.duration.toFixed(0)}s audio\n${out}\n`);
    console.log(`${secs}s for ${session.duration.toFixed(0)}s of audio; speakers=${session.speakers.length} paras=${session.paras.length}`);
    expect(session.speakers.length).toBe(3);
    const text = session.paras.map((p) => p.text).join(' ').toLowerCase();
    expect(text).toContain('password reset');
    expect(text).toMatch(/seventeenth|17th/);
    // Ground truth: speaker turns alternate M H G H M G M H G M H.
    const truth = JSON.parse(fs.readFileSync(wavPath!.replace('.wav', '.f32.json'), 'utf8')) as [string, number, number][];
    const label = new Map<string, string>();
    let right = 0, total = 0;
    for (const p of session.paras) {
      const mid = (p.s + p.e) / 2;
      const turn = truth.find((t) => mid >= t[1] - 0.3 && mid <= t[2] + 0.3);
      if (!turn) continue;
      if (!label.has(p.sp)) label.set(p.sp, turn[0]);
      total++;
      if (label.get(p.sp) === turn[0]) right++;
    }
    console.log(`speaker attribution ${right}/${total}`);
    expect(right / total).toBeGreaterThan(0.9);
    const vecs = (await h.embedText({ texts: ['launch date for the app', 'when do we ship the product', 'my cat likes tuna'] })) as number[][];
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(vecs[0], vecs[1])).toBeGreaterThan(dot(vecs[0], vecs[2]));
  }, 600_000);
});
