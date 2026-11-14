/**
 * Language engine: a local LLM through llama.cpp (Metal on Apple Silicon, CPU elsewhere).
 * One model, one context; requests are answered one at a time and streamed back.
 */
import { emit, serve } from './rpc';

type Lib = typeof import('node-llama-cpp');
let lib: Lib;
let llama: any = null;
let model: any = null;
let context: any = null;
let sequence: any = null;
let loadedPath = '';
let chain: Promise<unknown> = Promise.resolve();
const aborts = new Map<string, AbortController>();

const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

type Turn = { role: 'user' | 'assistant'; text: string };
type GenParams = { streamId: string; system: string; history?: Turn[]; prompt: string; maxTokens?: number; temperature?: number };

async function unload(): Promise<void> {
  await context?.dispose?.().catch(() => undefined);
  await model?.dispose?.().catch(() => undefined);
  context = model = sequence = null;
  loadedPath = '';
}

serve({
  load: ({ modelPath, contextSize }: { modelPath: string; contextSize: number }) =>
    queued(async () => {
      if (model && loadedPath === modelPath) return { gpu: String(llama.gpu || 'cpu'), contextSize: context.contextSize };
      lib ??= await import('node-llama-cpp');
      llama ??= await lib.getLlama({ build: 'never', logLevel: lib.LlamaLogLevel.error });
      await unload();
      model = await llama.loadModel({ modelPath });
      context = await model.createContext({ contextSize: { min: 2048, max: contextSize } });
      sequence = context.getSequence();
      loadedPath = modelPath;
      return { gpu: String(llama.gpu || 'cpu'), contextSize: context.contextSize as number };
    }),

  unload: () => queued(unload),

  tokens: ({ text }: { text: string }) => {
    if (!model) throw new Error('Language model is not loaded');
    return model.tokenize(text).length as number;
  },

  generate: (p: GenParams) => {
    const abort = new AbortController();
    aborts.set(p.streamId, abort);
    return queued(async () => {
      if (!model) throw new Error('Language model is not loaded');
      if (abort.signal.aborted) return '';
      const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: p.system, autoDisposeSequence: false });
      try {
        if (p.history?.length) {
          session.setChatHistory([
            { type: 'system', text: p.system },
            ...p.history.map((t) => (t.role === 'user' ? { type: 'user' as const, text: t.text } : { type: 'model' as const, response: [t.text] })),
          ]);
        }
        const text: string = await session.prompt(p.prompt, {
          maxTokens: p.maxTokens ?? 1024,
          temperature: p.temperature ?? 0.3,
          budgets: { thoughtTokens: 0 },
          signal: abort.signal,
          stopOnAbortSignal: true,
          onTextChunk: (delta: string) => emit('chunk', { streamId: p.streamId, delta }),
        });
        return text.trim();
      } finally {
        aborts.delete(p.streamId);
        session.dispose();
      }
    });
  },

  abort: ({ streamId }: { streamId: string }) => {
    for (const [id, a] of aborts) if (id === streamId || id.startsWith(streamId + ':')) a.abort();
    return true;
  },
});
