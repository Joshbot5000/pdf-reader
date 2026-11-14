/**
 * Speech engine (logic): speech-to-text (Whisper), voice fingerprints (WeSpeaker) and text embeddings
 * for search (MiniLM). All three run on the CPU through ONNX Runtime, entirely offline.
 */
import path from 'node:path';

type Tx = typeof import('@huggingface/transformers');
let tx: Tx;
let asr: any = null;
let asrRepo = '';
let spk: { processor: any; model: any } | null = null;
let embedder: any = null;
let chain: Promise<unknown> = Promise.resolve();

/** Run jobs one at a time: the models share the same CPU cores. */
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

const SPEAKER_REPO = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const EMBED_REPO = 'Xenova/all-MiniLM-L6-v2';

export const speechHandlers = {
  async init({ modelsDir }: { modelsDir: string }) {
    tx = await import('@huggingface/transformers');
    tx.env.allowRemoteModels = false;
    tx.env.allowLocalModels = true;
    tx.env.localModelPath = path.join(modelsDir, 'hf') + path.sep;
    return true;
  },

  loadAsr: ({ repo }: { repo: string }) =>
    queued(async () => {
      if (asr && asrRepo === repo) return true;
      if (asr) await asr.dispose?.().catch(() => undefined);
      asr = null;
      asr = await tx.pipeline('automatic-speech-recognition', repo, {
        dtype: { encoder_model: process.env.HARK_ENC ?? 'q8', decoder_model_merged: process.env.HARK_DEC ?? 'q8' } as never,
        device: 'cpu',
      });
      asrRepo = repo;
      return true;
    }),

  transcribe: ({ pcm, language, words }: { pcm: Float32Array; language: string; words: boolean }) =>
    queued(async () => {
      if (!asr) throw new Error('Speech model is not loaded');
      const audio = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
      const out = await asr(audio, {
        language,
        task: 'transcribe',
        return_timestamps: words ? 'word' : false,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const chunks: { text: string; timestamp: [number, number | null] }[] = out.chunks ?? [];
      const dur = audio.length / 16000;
      // Whisper splits "58%" or "half-tested" into pieces; a piece with no leading space belongs to the previous word.
      const list: { t: string; s: number; e: number }[] = [];
      for (const c of chunks) {
        const t = c.text.trim();
        if (!t) continue;
        const s = c.timestamp[0] ?? 0;
        const e = Math.min(dur, c.timestamp[1] ?? dur);
        const prev = list[list.length - 1];
        if (prev && !/^\s/.test(c.text)) {
          prev.t += t;
          prev.e = Math.max(prev.e, e);
        } else list.push({ t, s, e });
      }
      return { text: String(out.text ?? '').trim(), words: list };
    }),

  embedSpeaker: ({ pcm }: { pcm: Float32Array }) =>
    queued(async () => {
      if (!spk) {
        const processor = await tx.AutoProcessor.from_pretrained(SPEAKER_REPO);
        const model = await tx.AutoModel.from_pretrained(SPEAKER_REPO, { dtype: 'fp32', device: 'cpu' });
        spk = { processor, model };
      }
      let audio = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
      if (audio.length > 16000 * 8) audio = audio.subarray(0, 16000 * 8);
      const out = await spk.model(await spk.processor(audio));
      const t = out.embeddings ?? out.last_hidden_state;
      return Array.from(t.data as Float32Array);
    }),

  embedText: ({ texts }: { texts: string[] }) =>
    queued(async () => {
      if (!embedder) embedder = await tx.pipeline('feature-extraction', EMBED_REPO, { dtype: 'q8', device: 'cpu' });
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = await embedder(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
        out.push(...(t.tolist() as number[][]));
      }
      return out;
    }),
};
