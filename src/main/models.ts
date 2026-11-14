/** The on-device model catalogue and the downloader that fetches them once, on first run. */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { DownloadState, ModelInfo, ModelKind } from '../shared/types';

type Entry = {
  id: string;
  kind: ModelKind;
  name: string;
  blurb: string;
  repo: string;
  /** [path in repo, bytes] */
  files: [string, number][];
  minRam?: number;
};

const WHISPER_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
const small = (names: string[]): [string, number][] => names.map((n) => [n, 0.5e6]);

export const CATALOG: Entry[] = [
  {
    id: 'whisper-base', kind: 'asr', name: 'Swift', blurb: 'Fastest. Great for clear audio and older machines.',
    repo: 'onnx-community/whisper-base_timestamped',
    files: [...small(WHISPER_FILES), ['onnx/encoder_model_quantized.onnx', 23.0e6], ['onnx/decoder_model_merged_quantized.onnx', 53.5e6]],
  },
  {
    id: 'whisper-small', kind: 'asr', name: 'Sharp', blurb: 'Noticeably more accurate with accents, names and noisy rooms.',
    repo: 'onnx-community/whisper-small_timestamped',
    files: [...small(WHISPER_FILES), ['onnx/encoder_model_quantized.onnx', 92.2e6], ['onnx/decoder_model_merged_quantized.onnx', 156.8e6]],
  },
  {
    id: 'speaker', kind: 'support', name: 'Voice fingerprints', blurb: 'Tells speakers apart and recognises voices you have named.',
    repo: 'onnx-community/wespeaker-voxceleb-resnet34-LM',
    files: [...small(['config.json', 'preprocessor_config.json']), ['onnx/model.onnx', 26.5e6]],
  },
  {
    id: 'embed', kind: 'support', name: 'Semantic search', blurb: 'Finds moments by meaning across every conversation.',
    repo: 'Xenova/all-MiniLM-L6-v2',
    files: [...small(['config.json', 'tokenizer.json', 'tokenizer_config.json']), ['onnx/model_quantized.onnx', 23e6]],
  },
  {
    id: 'qwen-2b', kind: 'llm', name: 'Light', blurb: 'Quick summaries on any machine. Best for 8 GB of memory.',
    repo: 'unsloth/Qwen3.5-2B-GGUF', files: [['Qwen3.5-2B-Q4_K_M.gguf', 1280.8e6]],
  },
  {
    id: 'qwen-4b', kind: 'llm', name: 'Balanced', blurb: 'Sharper reasoning and better long-meeting notes. Best for 16 GB.',
    repo: 'unsloth/Qwen3.5-4B-GGUF', files: [['Qwen3.5-4B-Q4_K_M.gguf', 2740.9e6]], minRam: 12,
  },
  {
    id: 'qwen-9b', kind: 'llm', name: 'Max', blurb: 'The most capable notes and answers. For 24 GB or more.',
    repo: 'unsloth/Qwen3.5-9B-GGUF', files: [['Qwen3.5-9B-Q4_K_M.gguf', 5680.5e6]], minRam: 22,
  },
];

export const entry = (id: string): Entry => {
  const e = CATALOG.find((c) => c.id === id);
  if (!e) throw new Error(`Unknown model ${id}`);
  return e;
};

export const recommendedLlm = (ramGb: number): string => (ramGb >= 30 ? 'qwen-9b' : ramGb >= 14 ? 'qwen-4b' : 'qwen-2b');

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export class Models extends EventEmitter {
  private active = new Map<string, AbortController>();
  private states = new Map<string, DownloadState>();

  constructor(readonly dir: string, private fetcher: Fetcher, private base = 'https://huggingface.co') {
    super();
    fs.mkdirSync(dir, { recursive: true });
  }

  fileDir(e: Entry): string {
    return e.kind === 'llm' ? path.join(this.dir, 'llm') : path.join(this.dir, 'hf', ...e.repo.split('/'));
  }

  /** Absolute path of a model's main file (the GGUF for language models). */
  llmPath(id: string): string {
    const e = entry(id);
    return path.join(this.fileDir(e), e.files[0][0]);
  }

  installed(id: string): boolean {
    const e = entry(id);
    return e.files.every(([f]) => fs.existsSync(path.join(this.fileDir(e), f)));
  }

  list(ramGb: number): ModelInfo[] {
    const rec = recommendedLlm(ramGb);
    return CATALOG.map((e) => ({
      id: e.id, kind: e.kind, name: e.name, blurb: e.blurb,
      bytes: e.files.reduce((n, f) => n + f[1], 0),
      installed: this.installed(e.id),
      recommended: e.id === rec || e.id === 'whisper-small',
      minRam: e.minRam,
    }));
  }

  downloads(): DownloadState[] {
    return [...this.states.values()];
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  remove(id: string): void {
    const e = entry(id);
    this.cancel(id);
    for (const [f] of e.files) {
      for (const p of [path.join(this.fileDir(e), f), path.join(this.fileDir(e), f) + '.part']) fs.rmSync(p, { force: true });
    }
  }

  /** Download every missing file of a model. Interrupted downloads resume where they stopped. */
  async download(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const e = entry(id);
    const abort = new AbortController();
    this.active.set(id, abort);
    const total = e.files.reduce((n, f) => n + f[1], 0);
    const state: DownloadState = { id, received: 0, total };
    this.states.set(id, state);
    const dir = this.fileDir(e);
    let lastEmit = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 200) return;
      lastEmit = now;
      this.emit('progress', { ...state });
    };
    try {
      let before = 0;
      for (const [file, size] of e.files) {
        const dest = path.join(dir, file);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const part = dest + '.part';
          let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
          const res = await this.fetcher(`${this.base}/${e.repo}/resolve/main/${file}`, {
            headers: have ? { Range: `bytes=${have}-` } : {},
            signal: abort.signal,
          });
          if (res.status === 416) have = 0; // stale partial: start over
          else if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${file}`);
          if (res.status === 200) have = 0;
          if (res.status !== 416) {
            const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
            const reader = res.body!.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
                have += value.length;
                state.received = before + have;
                report();
              }
            } finally {
              await new Promise<void>((r) => out.end(() => r()));
            }
            fs.renameSync(part, dest);
          } else {
            fs.rmSync(part, { force: true });
            throw new Error('Download could not resume, please retry');
          }
        }
        before += size;
        state.received = before;
        report();
      }
      state.received = total;
      state.done = true;
    } catch (err) {
      state.error = abort.signal.aborted ? 'Cancelled' : err instanceof Error ? err.message : String(err);
    } finally {
      this.active.delete(id);
      report(true);
      if (state.done || state.error === 'Cancelled') this.states.delete(id);
      this.emit(state.done ? 'installed' : 'failed', id);
    }
  }
}
