/**
 * The cloud engine: Groq's large models for notes, tutoring and revision, when the user has
 * chosen it and a key is set. Only text is sent (the transcript or a question), never audio.
 * Groq's free plan allows a limited number of tokens per minute for each model, so a strong model
 * does the legal reasoning and a quicker one the simple jobs, and limits are waited out.
 */
import { net } from 'electron';

export type Tier = 'strong' | 'fast';
export type CloudParams = {
  streamId: string; system: string; history?: { role: 'user' | 'assistant'; text: string }[]; prompt: string;
  maxTokens?: number; temperature?: number; prefix?: string; tier?: Tier; json?: boolean;
};

const BASE = (): string => process.env.HARK_GROQ_URL || 'https://api.groq.com/openai/v1';
const STRONG = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
const FAST = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'];

let cached: { key: string; at: number; strong: string; fast: string } | null = null;

export class CloudError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'limit' | 'too-large' | 'other') {
    super(message);
  }
}

async function request(key: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await net.fetch(`${BASE()}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new CloudError("Couldn't reach Groq (is this Mac online?).", 'network');
  }
}

/** Which models this key can use, looked up rather than assumed (Groq retires models over time). */
export async function cloudModels(key: string): Promise<{ strong: string; fast: string }> {
  if (cached && cached.key === key && Date.now() - cached.at < 6 * 36e5) return cached;
  const res = await request(key, '/models');
  if (res.status === 401) throw new CloudError('Groq rejected the key. Check it in Settings → AI models.', 'auth');
  if (!res.ok) throw new CloudError(`Groq answered ${res.status}.`, 'other');
  const ids = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
  const pick = (list: string[]) => list.find((m) => ids.includes(m)) ?? ids.find((m) => !/whisper|guard|orpheus|tts|allam|safeguard/i.test(m)) ?? '';
  const strong = pick(STRONG), fast = pick(FAST) || strong;
  if (!strong) throw new CloudError('This Groq key has no text model available.', 'other');
  cached = { key, at: Date.now(), strong, fast };
  return cached;
}

const aborts = new Map<string, AbortController>();
export const abortCloud = (streamId: string): void => {
  for (const [id, a] of aborts) if (id === streamId || id.startsWith(`${streamId}:`)) a.abort();
};

/**
 * One request, streamed: `onDelta` receives the answer as it is written (never the model's private reasoning).
 * Rate limits are waited out (reported through `onWait`); a request too large for the per-minute
 * allowance is reported as 'too-large' so the caller can send it in parts.
 */
export async function cloudGenerate(key: string, p: CloudParams, onDelta: (d: string) => void, onWait: (secs: number) => void): Promise<string> {
  const models = await cloudModels(key);
  const model = p.tier === 'fast' ? models.fast : models.strong;
  const reasoning = /gpt-oss|qwen3/.test(model);
  const system = p.prefix ? `${p.system}\n\nBegin your reply with exactly "${p.prefix.trim()}".` : p.system;
  const body = {
    model, stream: true, temperature: p.temperature ?? 0.3,
    // Reasoning models spend part of their allowance thinking; keep that light and leave room for it.
    max_tokens: (p.maxTokens ?? 800) + (reasoning ? 700 : 0),
    ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : /qwen3/.test(model) ? { reasoning_format: 'hidden' } : {}),
    ...(p.json ? { response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'system', content: system }, ...(p.history ?? []).map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: p.prompt }],
  };
  const ctrl = new AbortController();
  aborts.set(p.streamId, ctrl);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await request(key, '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      if (res.ok && res.body) {
        let text = '';
        let buf = '';
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
              if (delta) (text += delta), onDelta(delta);
            } catch {
              /* a keep-alive or partial line */
            }
          }
        }
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (p.prefix && !text.startsWith(p.prefix.trim())) text = `${p.prefix}${text}`;
        return text;
      }
      let msg = '';
      try {
        msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        /* no body */
      }
      if (res.status === 401) throw new CloudError('Groq rejected the key. Check it in Settings → AI models.', 'auth');
      if (res.status === 413 || /request too large|reduce your message size/i.test(msg)) throw new CloudError(`That is too much text for Groq's free plan in one go. ${msg}`, 'too-large');
      if (res.status === 429 && attempt < 6) {
        const secs = Math.min(65, Math.max(2, Math.ceil(parseFloat(res.headers.get('retry-after') ?? '') || parseFloat(msg.match(/try again in ([\d.]+)s/i)?.[1] ?? '') || 15)));
        onWait(secs);
        await new Promise((r) => setTimeout(r, secs * 1000));
        if (ctrl.signal.aborted) throw new CloudError('Stopped', 'other');
        continue;
      }
      if (res.status === 429) throw new CloudError(`Groq's free plan limit has been reached for now; try again later. ${msg}`, 'limit');
      throw new CloudError(`Groq answered ${res.status}${msg ? `: ${msg}` : ''}`, 'other');
    }
  } finally {
    aborts.delete(p.streamId);
  }
}
